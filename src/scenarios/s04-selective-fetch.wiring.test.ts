/**
 * SCENARIO 4 (completed) — SELECTIVE FETCH: the summary's keys are directly
 * fetchable, and fetching a subset takes custody of exactly that subset.
 * LEVEL: wiring (the real in-process factory over HTTP/WS).
 *
 * CANON (S4, verbatim): "An agent with many pending events can read the
 * summary view without fetching bodies, then fetch and ack any subset as a
 * group." Selective ACK has existed since the transition; selective FETCH did
 * not — `GET /events?for=` returned the ENTIRE mailbox, stamping and taking
 * delivery-custody of everything, so the summary could sequence but never
 * exempt. RULED (Leonid, 2026-08-11, task 051): the summary is the
 * full-picture surface and the intended pattern is summary → drill down to
 * specific events → handle → ack; "workers need to be able to fetch by IDs."
 *
 * THE SELECTORS (build decision, recorded on task 051): `?ids=` for explicit
 * ids, `?from=` for the summary's blocking key (per-sender), `?type=` for the
 * summary's queued key (per-type as the summary coalesces it — `worker:reply`,
 * `trigger:<id>`, `playbook`, …). One selector per request; selectors need an
 * addressed read. The keys are SHARED with the summary by construction
 * (`inboxGroupOf`, one classification for both surfaces) — what the summary
 * shows is what a selector accepts, or the drill-down has a translation gap.
 *
 * TWO MECHANISMS, DELIBERATELY NOT SYMMETRIC (the sharp point, per the
 * sensei's correction on dispatch):
 *   - the per-event DELIVERY STAMP scopes to exactly what was returned — a
 *     selective fetch must not mark events it did not return (task 045's
 *     ledger lesson). Pinned below via headerless reads, where the boundary
 *     piggyback cannot confound the ledger.
 *   - ANNOUNCEMENT DISCHARGE is whole-state and RULED (immediate push,
 *     announcement discharge, activity-clock backstop): seeing the inbox by
 *     any rung discharges "you have mail". NOT asserted per-event here, and
 *     nothing in this file may be read as pinning per-event discharge — see
 *     task 046's rung-asymmetry warning.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { InfraPorts } from '../infra/ports.ts'
import { createInfraServer, type InfraHandle } from '../infra/server.ts'
import { type ConnectedAgent, connectAgent } from '../infra/test-helpers.ts'

const ROOT = '/tmp/jean-scenarios-s04-selective-fetch'
const REGISTRY_PATH = resolve(ROOT, 'registry.json')
const SENSEI = 'sensei'
const WORKER = 'builder'
const HUMAN = 'chat-human'

const noSpawn = (async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
  timedOut: false,
})) as unknown as InfraPorts['spawn']

let handle: InfraHandle
let base: string
let ws: string
/** Kept disconnected through the ledger cases — a connected sensei gets wake
 *  pushes, whose whole-mailbox 'wake' stamps would confound the fetch-stamp
 *  pins. Reconnected for the live-summary bijection cases. */
let sensei: ConnectedAgent | undefined
let humanReplyId: number
let workerReply1: number
let workerReply2: number
const savedRegistry = process.env.JEAN_REGISTRY_PATH

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  process.env.JEAN_REGISTRY_PATH = REGISTRY_PATH
  // Park the quiet clock far away: no mid-test nudges, so any delivery mark in
  // the ledger cases can only come from the fetch under test.
  process.env.JEAN_NUDGE_INTERVAL_MS = String(10 * 60_000)
  handle = await createInfraServer({
    dataDir: ROOT,
    port: 0,
    enforceSingleInstance: false,
    writeRuntimeFiles: false,
    ports: { spawn: noSpawn },
  })
  base = `http://127.0.0.1:${handle.port}`
  ws = `ws://127.0.0.1:${handle.port}/ws`

  // Register the sensei once (mailbox owner + universal rule), then take the
  // session down so nothing can be pushed or piggybacked while seeding.
  const s = await connectAgent(ws, SENSEI, 'sensei')
  s.ws.close()
  await Bun.sleep(200)

  // Seed a mixed mailbox: one blocking group (the human), one queued group
  // (two worker replies → `worker:reply`).
  using human = await connectAgent(ws, HUMAN, 'user')
  using worker = await connectAgent(ws, WORKER, 'worker')
  human.ws.send(JSON.stringify({ type: 'reply', from: HUMAN, text: 'is it done?' }))
  worker.ws.send(JSON.stringify({ type: 'reply', from: WORKER, text: 'progress 1' }))
  worker.ws.send(JSON.stringify({ type: 'reply', from: WORKER, text: 'progress 2' }))
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if ((await observed()).filter((e) => e.type === 'reply').length >= 3) break
    await Bun.sleep(50)
  }
  const events = await observed()
  humanReplyId = idOf(events, 'is it done?')
  workerReply1 = idOf(events, 'progress 1')
  workerReply2 = idOf(events, 'progress 2')
})

afterAll(async () => {
  delete process.env.JEAN_NUDGE_INTERVAL_MS
  sensei?.ws.close()
  await handle?.stop()
  if (savedRegistry === undefined) delete process.env.JEAN_REGISTRY_PATH
  else process.env.JEAN_REGISTRY_PATH = savedRegistry
})

type WireEvent = {
  id: number
  type: string
  code?: string
  deliveredVia?: string
  data: { text?: string; agent?: string }
}

/** OBSERVER read of the whole queue — no identity, no stamps, no discharge. */
const observed = async () => ((await (await fetch(`${base}/events/pending`)).json()) as { events: WireEvent[] }).events

const idOf = (events: WireEvent[], text: string): number => {
  const hit = events.find((e) => e.type === 'reply' && e.data.text === text)
  if (!hit) throw new Error(`seed event not found: ${text}`)
  return hit.id
}

/** Addressed fetch via ?for= and NO header — the reader is named, but the
 *  boundary piggyback (which stamps and discharges for the header caller)
 *  stays out of the picture, so the ledger shows this handler's marks only. */
const fetchAs = async (reader: string, params = '') => await fetch(`${base}/events?for=${reader}${params}`)

type FetchBody = { events: WireEvent[]; missing?: number[] }

describe('S4 — fetch by ids: exactly these events, with codes', () => {
  test('a one-id fetch returns that event alone, code attached — and the rest of the mailbox is not returned', async () => {
    const res = await fetchAs(SENSEI, `&ids=${workerReply1}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as FetchBody
    expect(body.events.map((e) => e.id)).toEqual([workerReply1])
    expect(body.events[0]?.code).toBeTruthy()
    expect(body.missing).toEqual([])
  })

  test('THE LEDGER PIN (task 045 lesson): the selective fetch stamped ONLY what it returned', async () => {
    // Arranges its own stamp (a repeat of the one-id fetch — idempotent, the
    // ledger is first-write-wins) rather than leaning on the previous case's
    // side effect, so the pin survives reordering (codex pass). The fetched
    // reply's mark must read 'fetch'; the human's blocking reply — same
    // mailbox, not returned — must have NO delivery mark at all. Before this
    // task the same request stamped the whole mailbox.
    await fetchAs(SENSEI, `&ids=${workerReply1}`)
    const events = await observed()
    expect(events.find((e) => e.id === workerReply1)?.deliveredVia).toBe('fetch')
    expect(events.find((e) => e.id === humanReplyId)?.deliveredVia).toBeUndefined()
    expect(events.find((e) => e.id === workerReply2)?.deliveredVia).toBeUndefined()
  })

  test('unknown ids come back LOUD — an explicit per-id miss, never a silent drop', async () => {
    const res = await fetchAs(SENSEI, `&ids=${workerReply2},999999`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as FetchBody
    expect(body.events.map((e) => e.id)).toEqual([workerReply2])
    expect(body.missing).toEqual([999999])
  })

  test('a FOREIGN id — in pending, outside the reader’s mailbox — is a miss, not a disclosure', async () => {
    // The human's reply concerns the sensei, not the worker: it is in pending
    // and NOT in the worker's mailbox. Fetching it as the worker must neither
    // return it nor stamp it — membership is the mailbox rule, and a selector
    // must not become a side door through it.
    const res = await fetchAs(WORKER, `&ids=${humanReplyId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as FetchBody
    expect(body.events).toEqual([])
    expect(body.missing).toEqual([humanReplyId])
    expect((await observed()).find((e) => e.id === humanReplyId)?.deliveredVia).toBeUndefined()
  })
})

describe('S4 — malformed or ambiguous selection is a 400, not a guess (task 018’s lesson)', () => {
  test('non-numeric ids are a caller bug', async () => {
    expect((await fetchAs(SENSEI, '&ids=abc')).status).toBe(400)
    expect((await fetchAs(SENSEI, `&ids=${workerReply1},xyz`)).status).toBe(400)
  })

  test('an empty ids list selects nothing meaningfully — refused', async () => {
    expect((await fetchAs(SENSEI, '&ids=')).status).toBe(400)
  })

  test('a stray comma is malformed, not normalized — silent repair is the silent-omission twin', async () => {
    expect((await fetchAs(SENSEI, '&ids=1,,2')).status).toBe(400)
    expect((await fetchAs(SENSEI, `&ids=${workerReply1},`)).status).toBe(400)
  })

  test('ids beyond safe-integer range are refused — two distinct strings must not collapse to one number', async () => {
    expect((await fetchAs(SENSEI, '&ids=9007199254740993')).status).toBe(400)
  })

  test('two selectors at once have no defined precedence — refused rather than silently picking one', async () => {
    expect((await fetchAs(SENSEI, `&ids=${workerReply1}&type=worker:reply`)).status).toBe(400)
    expect((await fetchAs(SENSEI, '&from=chat-human&type=worker:reply')).status).toBe(400)
  })

  test('a selector without an addressed read has no mailbox to select from — refused', async () => {
    const res = await fetch(`${base}/events?ids=${workerReply1}`)
    expect(res.status).toBe(400)
  })
})

describe('S4 — the summary’s own keys are directly fetchable (shared keys, no translation gap)', () => {
  test('the LIVE summary’s groups map one-to-one onto selector results', async () => {
    // Reconnect the sensei to read its real inbox — the same object the wake
    // and the piggyback line render. Every key the summary shows must fetch
    // exactly the events it counted: blocking entries by `from` (ids equal,
    // order preserved), queued types by the summary's OWN key.
    sensei = await connectAgent(ws, SENSEI, 'sensei')
    const inboxRes = await fetch(`${base}/inbox`, { headers: { 'x-jean-agent': SENSEI } })
    const { inbox } = (await inboxRes.json()) as {
      inbox: {
        blocking: Array<{ from: string; ids: number[]; count: number }>
        queued: { byType: Record<string, number> }
      } | null
    }
    expect(inbox).not.toBeNull()
    if (!inbox) return

    expect(inbox.blocking.map((b) => b.from)).toEqual([HUMAN])
    for (const entry of inbox.blocking) {
      const body = (await (await fetchAs(SENSEI, `&from=${entry.from}`)).json()) as FetchBody
      expect(body.events.map((e) => e.id)).toEqual(entry.ids)
      expect(body.events).toHaveLength(entry.count)
      for (const e of body.events) expect(e.code).toBeTruthy()
    }

    // The queued groups include the seeded worker replies AND whatever else
    // the mailbox truthfully holds (the sensei's own boot-time disconnect,
    // e.g.) — the bijection must hold for every key the summary shows, so the
    // loop is generic over the live byType rather than a hand-picked subset.
    expect(inbox.queued.byType['worker:reply']).toBe(2)
    for (const [key, count] of Object.entries(inbox.queued.byType)) {
      const body = (await (await fetchAs(SENSEI, `&type=${encodeURIComponent(key)}`)).json()) as FetchBody
      expect(body.events).toHaveLength(count)
      for (const e of body.events) expect(e.code).toBeTruthy()
    }
  })

  test('the group KINDS do not cross: a machine sender is not a blocking key', async () => {
    // The worker's replies file under queued (`worker:reply`), not under a
    // blocking entry — so ?from= of a machine sender is an empty result (a
    // key that matches no group), never that sender's queued slice through
    // the wrong door.
    const body = (await (await fetchAs(SENSEI, `&from=${WORKER}`)).json()) as FetchBody
    expect(body.events).toEqual([])
    expect(body.missing).toBeUndefined()
  })

  test('the full-mailbox fetch is UNCHANGED: no selector, whole mailbox, codes, and no missing field', async () => {
    // The sensei's mailbox is universal, so "the whole mailbox" is exactly the
    // pending queue the observer sees — seeded replies plus the sensei's own
    // boot-time disconnect. Derived, not hand-listed, so the case pins the
    // no-selector path against the live truth.
    const wholeQueue = (await observed()).map((e) => e.id).sort((a, b) => a - b)
    const body = (await (await fetchAs(SENSEI)).json()) as FetchBody
    expect(body.events.map((e) => e.id).sort((a, b) => a - b)).toEqual(wholeQueue)
    for (const id of [humanReplyId, workerReply1, workerReply2]) expect(wholeQueue).toContain(id)
    for (const e of body.events) expect(e.code).toBeTruthy()
    expect(body.missing).toBeUndefined()
  })
})

describe('S4 — the whole gesture, end to end: summary → drill down → handle → ack', () => {
  test('a blocking group fetched by its summary key acks with its own codes — and the rest stays put', async () => {
    const body = (await (await fetchAs(SENSEI, `&from=${HUMAN}`)).json()) as FetchBody
    expect(body.events).toHaveLength(1)
    const [blocking] = body.events
    const ack = (await (
      await fetch(`${base}/events/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairs: [{ id: blocking?.id, code: blocking?.code }] }),
      })
    ).json()) as { acknowledged: number }
    expect(ack.acknowledged).toBe(1)

    const remaining = await observed()
    expect(remaining.map((e) => e.id)).not.toContain(blocking?.id)
    for (const id of [workerReply1, workerReply2]) expect(remaining.map((e) => e.id)).toContain(id)
  })
})
