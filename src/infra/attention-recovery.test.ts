// Attention phase 2 — the failure scenarios the review proved live (2026-07-24):
// the episode state machine must be SELF-HEALING across the routine
// discontinuities. A high-priority event pending with no push fired (infra
// restart, sensei absent at arrival, masked arrival) converges within ~one tick
// of a sensei being available — it never fails closed.
//
// ── CARRIED THROUGH THE TRANSITION (task 045), AND WHAT MOVED ──
//
// The QUESTION is unchanged and is why these two cases survive: infra's
// bookkeeping about who-has-been-told is in-memory, so every discontinuity that
// empties it (a restart, an absent sensei, a rename) is a chance to fail
// silently — and silence is the one failure this system cannot see.
//
// What moved is the MECHANISM under it, so the oracle moved with it:
//
//   - The blocking wake is gone. There is no separate human-waiting path any
//     more: a human is simply the highest-priority sender (core/priority.ts) and
//     priority decides whether an arrival pushes. So the push a human's message
//     produces is THE push — `Events pending — inbox summary` — and the old
//     `A human is waiting` prefix that these tests matched on no longer exists.
//   - `nudge` events no longer carry `blocking: true`. Priority is opaque to
//     every agent-facing surface (013 VOCABULARY), and a boolean in the log
//     saying "this one was the urgent kind" is that leak in its most durable
//     form. What the event still carries — and what the assertion below moved
//     to — is that infra recorded telling somebody.
//   - The env dials were renamed with the machinery. `JEAN_BLOCKING_BACKOFF_MS`
//     and `JEAN_STALL_NUDGE_MS` no longer exist; a test still setting them
//     configures NOTHING and silently measures the 120s defaults, which is the
//     shape of a test that observes the wrong thing while looking green.
//
// THE THIRD CASE, `WATCHDOG STANDDOWN`, IS RETIRED — see the note at the foot of
// this file, which is the honest place for it.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Subprocess } from 'bun'
import type { DeliverMsg, OutboundMsg } from './protocol.ts'
import { connectAgent } from './test-helpers.ts'

// Timing-dominated tests: their runtime floor is a deliberate OBSERVATION
// WINDOW (the assertion is "nothing happened for N seconds"), so bun's 5000ms
// default is a ceiling they sit under rather than a budget they aim at, and
// ambient machine load pushes them through it. An explicit timeout costs
// nothing when the test passes — it is a ceiling, not a sleep — so these are
// given real headroom. The windows themselves must NOT be shrunk: they are
// what is being asserted. (task 001, 2026-07-25: connectAgent's greeting-wait
// added ~500ms to every sensei connect and tipped the slowest one over.)
const SLOW_TEST_MS = 15_000

const TEST_PORT = 8806
const DATA_DIR = '/tmp/jean-test-attention-recovery'
const BACKOFF_MS = 500
const BASE = `http://127.0.0.1:${TEST_PORT}`
const WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`

let server: Subprocess | null = null

async function startServer(extraEnv: Record<string, string> = {}) {
  server = Bun.spawn(['bun', 'run', 'src/infra/server.ts'], {
    env: {
      ...process.env,
      JEAN_PORT: String(TEST_PORT),
      JEAN_DATA_DIR: DATA_DIR,
      // THE LIVE DIAL NAMES. Shrunk so a repeat is observable in-test; the
      // interval is parked far away so these cases measure the ARRIVAL path
      // (what a discontinuity breaks) rather than the quiet clock.
      JEAN_NUDGE_BACKOFF_MS: String(BACKOFF_MS),
      JEAN_NUDGE_INTERVAL_MS: String(60_000),
      ...extraEnv,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`${BASE}/`)
      return
    } catch {
      await Bun.sleep(100)
    }
  }
  throw new Error('server did not start')
}

function stopServer() {
  server?.kill()
  server = null
}

beforeEach(() => {
  try {
    rmSync(DATA_DIR, { recursive: true })
  } catch {}
  mkdirSync(DATA_DIR, { recursive: true })
})
afterEach(() => {
  stopServer()
})

/** A push from infra. OLD: `text.startsWith('A human is waiting')` — the
 *  blocking wake's own prefix. NEW: there is one push path, so the oracle is the
 *  push itself; WHICH events earned it is decided by priority, and asserted by
 *  the payload check in each case rather than by a second message shape. */
const isWake = (m: OutboundMsg): m is DeliverMsg =>
  m.type === 'deliver' && m.from === 'infra' && m.text.startsWith('Events pending')

async function waitForWake(sensei: { messages: OutboundMsg[] }, tries = 40): Promise<DeliverMsg | undefined> {
  for (let i = 0; i < tries; i++) {
    const wake = sensei.messages.find(isWake)
    if (wake) return wake
    await Bun.sleep(100)
  }
  return undefined
}

/** Drain everything pending, in the ONE ack form S5 leaves (`{id, code}` pairs).
 *  The unaddressed fetch is deliberate: this is a test draining the whole queue,
 *  not an agent reading its mailbox, and only the addressed read stamps the
 *  ledger. OLD: `{upToId: max(ids)}` — drain-all sugar, deleted with S5. */
async function drainAll(): Promise<void> {
  const { events } = (await (await fetch(`${BASE}/events`)).json()) as {
    events: Array<{ id: number; code: string }>
  }
  if (events.length === 0) return
  await fetch(`${BASE}/events/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairs: events.map((e) => ({ id: e.id, code: e.code })) }),
  })
}

describe('attention phase 2 — self-healing recovery', () => {
  test('RESTART: blocking pending in seeded history (unregistered chat-* sender) wakes the sensei after boot', async () => {
    // Seed history with a pending human reply and NO register event — covers
    // both the restart scenario (in-memory episode state lost) and the chat-
    // prefix classification fallback (no persisted register to learn from).
    writeFileSync(
      resolve(DATA_DIR, 'history.jsonl'),
      `${JSON.stringify({
        id: 1,
        stream: 'agent:chat-999',
        type: 'reply',
        ts: new Date().toISOString(),
        data: { agent: 'chat-999', text: 'anyone there after the restart?' },
      })}\n`,
    )
    await startServer()

    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    const wake = await waitForWake(sensei)
    // The episode map is empty at boot BY DESIGN (`hydrate` starts every counter
    // at zero rather than inventing history), and an empty episode has
    // `announcedThroughId: 0` — so the first decision after a sensei appears
    // finds the seeded reply unannounced and pushes. Nothing has to notice that
    // a restart happened; the eager direction is the safe one.
    expect(wake).toBeDefined()
    expect(wake?.text).toContain('anyone there after the restart?')
    // Still classified as a human waiting in the PAYLOAD. The classification did
    // not die with the wake path — it moved from deciding whether to push (now
    // priority's job) to describing what is waiting, which is where the sensei
    // actually needs it.
    expect(wake?.text).toContain('"blocking"')
  })

  test('SENSEI-ABSENT: a human message with no sensei connected wakes it soon after it connects; later messages still work', async () => {
    await startServer()
    using human = await connectAgent(WS_URL, 'human', 'user')
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'hello? nobody home?' }))
    await Bun.sleep(300) // arrival wake is a no-op (no sensei); episode must not poison

    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    const wake = await waitForWake(sensei)
    expect(wake).toBeDefined()
    expect(wake?.text).toContain('hello? nobody home?')

    // Infra RECORDED that it told somebody, and the record carries the queue as
    // of that push (S6). OLD: `data.blocking === true`. That field is gone —
    // priority is opaque to every agent-facing surface, and the log is the most
    // durable such surface there is. The event's job here is unchanged: it is
    // the evidence that a delivery happened, which is what the next assertion
    // needs to be able to distinguish "re-woken" from "never stopped".
    const history = (await (await fetch(`${BASE}/history?last=20`)).json()) as {
      events: Array<{ type: string; data: { pendingCount?: number } }>
    }
    const nudges = history.events.filter((e) => e.type === 'nudge')
    expect(nudges.length).toBeGreaterThan(0)
    expect(nudges.at(-1)?.data.pendingCount).toBeGreaterThan(0)

    // Drain, then a NEW human message still gets a fresh immediate wake (no poisoned state).
    await drainAll()
    const before = sensei.messages.filter(isWake).length
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'second question' }))
    let after = before
    for (let i = 0; i < 20 && after === before; i++) {
      after = sensei.messages.filter(isWake).length
      if (after === before) await Bun.sleep(50)
    }
    expect(after).toBe(before + 1)
  })

  test(
    'ONE PUSHER: an unhandled mailbox is re-pushed on the LADDER, not on the tick grid',
    async () => {
      // ── WHAT THIS CASE USED TO BE, AND WHY IT COULD NOT SURVIVE ──
      //
      // `WATCHDOG STANDDOWN: no Watchdog fire while a blocking episode is
      // active`. It shrank the watchdog window BELOW the blocking backoff and
      // asserted zero `Watchdog:` deliveries — the two timers must not both
      // shout at a sensei that one of them was already handling.
      //
      // That question is retired because its premise is: THERE IS ONLY ONE
      // PUSHER NOW. The watchdog existed to force a push past the idle gate (its
      // own header said so); with the gate deleted the ladder already pushes
      // unconditionally and never stops, and the long-wait survivor is S11's
      // broken-agent report on a louder channel, not a second timer on this one.
      // Re-asserting `Watchdog:` count === 0 against a string no code can emit
      // is the vacuous-green shape this suite exists to avoid.
      //
      // What survives is the half that still has teeth, and it is the half the
      // core tests CANNOT reach: `decide` is pure, so it can prove the ladder's
      // arithmetic but not that the adapter drives it with one timer. Rate is
      // where a second pusher — or a tick that pushes every time it fires —
      // shows up.
      stopServer()
      // Backoff FOUR TICKS wide (tick = min(15s, interval, ...backoff) = 500ms),
      // so "re-pushes on the ladder" and "re-pushes on every tick" produce
      // visibly different counts. Equal dials would make them indistinguishable
      // and the assertion decorative.
      await startServer({ JEAN_NUDGE_INTERVAL_MS: '500', JEAN_NUDGE_BACKOFF_MS: '2000' })
      using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
      using human = await connectAgent(WS_URL, 'human', 'user')
      human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'urgent!' }))
      expect(await waitForWake(sensei)).toBeDefined()

      await Bun.sleep(5_000) // ≥ two full ladder rungs, ≥ ten ticks
      const pushes = sensei.messages.filter(isWake).length
      // It DID keep going — an unhandled mailbox is never abandoned (E1).
      expect(pushes).toBeGreaterThanOrEqual(2)
      // …and it went at the ladder's rate. Ten ticks elapsed; a per-tick pusher
      // (or two pushers on one ladder) lands well outside this bound, while the
      // arrival push plus two rungs sits inside it.
      expect(pushes).toBeLessThanOrEqual(5)
    },
    SLOW_TEST_MS,
  )
})
