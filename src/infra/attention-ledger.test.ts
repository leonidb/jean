// Attention phase 4 — the minimal delivery ledger (docs/attention.md
// "Observability"). Two facts per event and no more: how it reached the agent
// (`deliveredVia`: wake | piggyback | heartbeat | fetch) and what cleared it
// (`clearedBy`). Live on GET /events, materialized onto the `ack` event so the
// answer to "did this ever actually get delivered, and how" comes out of the
// event log instead of a day of watchdog archaeology.
//
// ── WHAT THE TRANSITION DID TO THIS FILE (task 045) ──
//
// The ledger itself is untouched; what changed is every fixture that produced a
// delivery, because the delivery paths moved:
//
//   - `wake` is now earned by PRIORITY, not by catching the sensei idle. A
//     worker's reply no longer pushes (S3), so the three cases that used one to
//     provoke a wake now use a human's message — the sender that outranks the
//     sensei's threshold.
//   - `fetch` is a NEW via, and it is why the reads in this file stay
//     unaddressed (see `pending()` below). Under S5 an agent gets its ack codes
//     by reading its mailbox, so that read is a delivery too.
//   - The `auto-clear` case is gone with the mechanism; the CONCURRENT ACKS case
//     asserted the exact inverse of what fold-decides now guarantees. Both are
//     recorded at the foot of this file rather than silently dropped.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'
import { connectAgent } from './test-helpers.ts'

const TEST_PORT = 8824
const DATA_DIR = '/tmp/jean-test-attention-ledger'
let server: Subprocess

beforeAll(async () => {
  try {
    rmSync(DATA_DIR, { recursive: true })
  } catch {}
  mkdirSync(DATA_DIR, { recursive: true })
  server = Bun.spawn(['bun', 'run', 'src/infra/server.ts'], {
    env: {
      ...process.env,
      JEAN_PORT: String(TEST_PORT),
      JEAN_DATA_DIR: DATA_DIR,
      // Park the quiet clock and the supervisor far away: this file is about
      // WHICH via gets stamped, so a timer firing mid-case would stamp a real
      // delivery the assertions have no reason to expect. (OLD:
      // `JEAN_STALL_NUDGE_MS`, which no longer names anything — a test setting a
      // dead env var configures nothing and silently measures the defaults.)
      JEAN_NUDGE_INTERVAL_MS: String(600_000),
      JEAN_REMINDER_AFTER_MS: String(600_000),
    },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(`http://127.0.0.1:${TEST_PORT}/`)
      break
    } catch {
      await Bun.sleep(100)
    }
  }
})

afterAll(() => {
  server.kill()
})

const BASE = `http://127.0.0.1:${TEST_PORT}`
const WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`

type LedgerEntry = { deliveredVia?: string; clearedBy?: string }
type PendingEvent = {
  id: number
  type: string
  code: string
  deliveredVia?: string
  data: { text?: string; agent?: string }
}

/** Read pending WITHOUT identifying a reader — an OBSERVER read, which is the
 *  only kind that stamps nothing.
 *
 *  Two ways this file's own instrument would otherwise write the fact it is
 *  measuring: a headered read stamps the piggyback (the header rides on the
 *  response, after the body is built), and an ADDRESSED read — `?for=` or the
 *  `x-jean-agent` header — is the S5 fetch rung and stamps `fetch`. The second
 *  is new at the transition, and it is exactly how the first version of this
 *  rewrite went wrong: with the stamp unconditional, three cases here reported
 *  `deliveredVia: 'fetch'` for events whose real delivery was a wake, because
 *  the test's own `pending()` got there first. */
async function pending(): Promise<PendingEvent[]> {
  return ((await (await fetch(`${BASE}/events`)).json()) as { events: PendingEvent[] }).events
}

/** Ack by `{id, code}` pairs — the one form S5 leaves. OLD: `{ids}`, which is
 *  gone for the same reason `upToId` is: an id is knowable from the cheap
 *  summary rung, a code is not, so only the pair form proves a read. */
async function ackIds(ids: number[]) {
  const byId = new Map((await pending()).map((e) => [e.id, e.code]))
  await fetch(`${BASE}/events/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairs: ids.map((id) => ({ id, code: byId.get(id) })) }),
  })
}

/** The most recent `ack` event's ledger, from history. */
async function lastAck(): Promise<{ auto?: string; ledger?: Record<string, LedgerEntry> } | undefined> {
  const hist = (await (await fetch(`${BASE}/history?last=40`)).json()) as {
    events: Array<{ type: string; data: { auto?: string; ledger?: Record<string, LedgerEntry> } }>
  }
  return hist.events.filter((e) => e.type === 'ack').at(-1)?.data
}

async function drain() {
  const ids = (await pending()).map((e) => e.id)
  if (ids.length > 0) await ackIds(ids)
}

describe('attention phase 4 — delivery ledger', () => {
  test('wake: a pushed event is stamped deliveredVia:wake and acks with clearedBy:ack', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    // OLD: a worker's reply, sent right after posting `/agent-idle`, on the
    // premise that an idle sensei gets nudged for anything pending. Both halves
    // died: `/agent-idle` arms nothing, and a worker's reply is below the
    // sensei's push threshold (S3). A HUMAN is the sender that outranks it —
    // which is the same fact the old fixture was relying on by accident, since
    // what it really needed was simply "an event that provokes a push".
    using human = await connectAgent(WS_URL, 'led-human-1', 'user')
    void sensei
    await Bun.sleep(150) // let the register events land before draining
    await drain()

    human.ws.send(JSON.stringify({ type: 'reply', from: 'led-human-1', text: 'nudged into existence' }))
    await Bun.sleep(250)

    const event = (await pending()).find((e) => e.data?.text === 'nudged into existence')
    expect(event).toBeDefined()
    expect(event?.deliveredVia).toBe('wake') // the push carried it

    await ackIds([event?.id as number])
    const ack = await lastAck()
    expect(ack?.ledger?.[String(event?.id)]).toEqual({ deliveredVia: 'wake', clearedBy: 'ack' })
    await drain()
  })

  test('piggyback: an event that no wake carried is stamped when the sensei reads the inbox line — and first delivery wins', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using worker = await connectAgent(WS_URL, 'led-w2', 'worker')
    using human = await connectAgent(WS_URL, 'led-human-2', 'user')
    await Bun.sleep(150) // let the register events land before draining
    await drain()

    // OLD: two worker replies, the first nudging and thereby marking the sensei
    // non-idle so the second was suppressed. The gate is gone, so "an event no
    // wake carried" has to be produced by the mechanism that actually declines
    // to push now: PRIORITY. The human's message pushes…
    human.ws.send(JSON.stringify({ type: 'reply', from: 'led-human-2', text: 'woke it' }))
    await Bun.sleep(250)
    // …and the worker's reply, below the threshold, does not — so it sits in the
    // mailbox undelivered, which is precisely the state the piggyback exists for.
    worker.ws.send(JSON.stringify({ type: 'reply', from: 'led-w2', text: 'arrived mid-turn' }))
    await Bun.sleep(200)
    expect((await pending()).find((e) => e.data?.text === 'arrived mid-turn')?.deliveredVia).toBeUndefined()

    // Any sensei infra call carries the inbox line — that IS its delivery.
    const res = await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': 'sensei' } })
    expect(res.headers.get('x-jean-inbox')).toBeTruthy()
    await Bun.sleep(50)

    const after = await pending()
    expect(after.find((e) => e.data?.text === 'arrived mid-turn')?.deliveredVia).toBe('piggyback')
    // First delivery wins: the woken event stays 'wake' despite riding along.
    expect(after.find((e) => e.data?.text === 'woke it')?.deliveredVia).toBe('wake')

    await ackIds(after.map((e) => e.id))
    const ack = await lastAck()
    const vias = Object.values(ack?.ledger ?? {}).map((l) => l.deliveredVia)
    expect(vias).toContain('wake')
    expect(vias).toContain('piggyback')
    expect(Object.values(ack?.ledger ?? {}).every((l) => l.clearedBy === 'ack')).toBe(true)
    await drain()
    void sensei
  })

  test('fetch: reading a mailbox IS a delivery — and an observer read is not', async () => {
    // NEW AT THE TRANSITION, and it replaces the `auto-clear` case in this file
    // (see the foot). It exists because `fetch` is the via that most events now
    // arrive by — under S5 an agent cannot ack without reading — so a ledger
    // that missed it would answer "delivery unknown" for very nearly the whole
    // log, which is the failure the ledger was built to end.
    //
    // The negative half is the one that had to be found the hard way: with the
    // stamp unconditional, ANY read of the queue recorded a delivery to nobody,
    // and first-delivery-wins made whichever observer looked first the recorded
    // carrier — a `jean status` overwriting the real answer.
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using worker = await connectAgent(WS_URL, 'led-w4', 'worker')
    void sensei
    await Bun.sleep(150)
    await drain()

    // START THE SENSEI'S QUIET CLOCK (H7, ruled 2026-08-11): registering is
    // not activity, so a fresh session that never speaks reads as long-quiet
    // and the arrival below would be wake-pushed at once — the ruling's
    // desired behavior, but not this case's subject. One identity-carrying
    // call is the agent's own act; it makes "nothing pushes" reachable again.
    await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': 'sensei' } })

    worker.ws.send(JSON.stringify({ type: 'reply', from: 'led-w4', text: 'below the threshold' }))
    await Bun.sleep(200)

    // OBSERVER READ: no identity, so no claim about who received anything.
    const unstamped = (await pending()).find((e) => e.data?.text === 'below the threshold')
    expect(unstamped).toBeDefined()
    expect(unstamped?.deliveredVia).toBeUndefined()

    // ADDRESSED READ: the sensei fetching its own mailbox. That is the S5 fetch
    // rung, and the response is where the ack code comes from.
    const fetched = (await (await fetch(`${BASE}/events?for=sensei`)).json()) as { events: PendingEvent[] }
    expect(fetched.events.some((e) => e.data?.text === 'below the threshold')).toBe(true)

    const after = (await pending()).find((e) => e.data?.text === 'below the threshold')
    expect(after?.deliveredVia).toBe('fetch')
    await drain()
  })
})

// ── RETIRED HERE, RECORDED HERE (task 045) ─────────────────────────────
//
// `auto-clear: answering a human records clearedBy:auto-clear (and keeps the
// phase-3 auto:reply tag)` — PRE-DECLARED CASUALTY (task 043 part 3: "auto-clear
// ledger cases"). Answering a human no longer clears their message: S5 makes
// `{id, code}` pairs THE ONLY clearing path, because auto-clear decided on the
// sensei's behalf that a reply meant the question was handled. `clearedBy` is
// still on every entry — the two surviving cases above assert it — and
// `ClearedBy` keeps `'auto-clear'` in its union for the historical logs that
// will carry it forever.
//
// `CONCURRENT ACKS: twenty simultaneous acks for one id produce exactly ONE ack
// event` — RETIRED WITH ITS QUESTION, and it is worth being precise about why,
// because this one was INVERTED rather than deleted. Its subject was the ack
// claim: a synchronous membership check plus an in-flight reservation, so that
// exactly one writer could own an id. Fold-decides (task 041, ruled) deletes the
// claim — every ack appends, the pending reducer's `filter` is already
// idempotent, and N concurrent acks now write N events ON PURPOSE. So the
// assertion `acksForId.length === 1` is not a property this system has any more;
// it is the negation of one.
//
// What replaced it is NOT nothing: `src/scenarios/ack-concurrency.wiring.test.ts`
// asserts the new truth on all four of the fronts this case cared about — both
// callers told the id is cleared, TWO ack events in the log, the FIRST in log
// order carrying the ledger, and the queue unharmed. The half that mattered most
// — "the delivery fact is not overwritten by a later empty ack" — survives there
// as the first-in-log reading rule, which is the same guarantee reached from the
// reading side instead of the writing side.
//
// The 'heartbeat' path is asserted in stall-watchdog.test.ts, on the server that
// already exercises it — same coverage, one fewer spawn.
