/**
 * The ARRIVAL push, end to end (013 S3; the transition, task 045).
 *
 * ── WHAT THIS FILE WAS ──
 *
 * Attention phase 2: "blocking (human) events wake the sensei REGARDLESS of the
 * idle flag, with burst coalescing and escalating backoff re-wakes; machine
 * events keep the idle-gated nudge." Two cases — a stall-class kill and a burst.
 *
 * The first is RETIRED WITH ITS PREMISE. `STALL-KILL: a human message wakes a
 * sensei stuck non-idle; a machine event does not` was built on the measured
 * 3-hour stall: a missed Stop hook wedged `idle:false` and starved a waiting
 * human. There is no idle flag to be stuck at any more (canon E3 — "busy and
 * dead are one case"), so the state it wedges cannot be reached, and a test that
 * sets up an impossible state and then asserts a good outcome is green for no
 * reason. The half of it that still has a subject — a human pushes, a machine
 * event does not — is asserted against the live threshold in `queue.test.ts`
 * ("PRIORITY, not idleness, decides an interrupt"), which is where the queue's
 * own file already exercises both senders.
 *
 * The second is KEPT and RE-AIMED, because a burst is where the arrival rule's
 * behaviour is least obvious — and, as the note on the first assertion records,
 * where the transition CHANGED it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
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

const TEST_PORT = 8807
const DATA_DIR = '/tmp/jean-test-attention-wake'
/** The repeat ladder, env-shrunk so a re-push is observable in-test. */
const BACKOFF_MS = 700
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
      // The LIVE dial names. OLD: `JEAN_BLOCKING_BACKOFF_MS` and
      // `JEAN_STALL_NUDGE_MS`, which named the blocking episode and the watchdog
      // — neither exists, and a test that sets them configures nothing while
      // quietly measuring the 120s defaults.
      JEAN_NUDGE_BACKOFF_MS: String(BACKOFF_MS),
      JEAN_NUDGE_INTERVAL_MS: String(BACKOFF_MS),
      JEAN_REMINDER_AFTER_MS: String(600_000), // the supervisor is not the subject
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

/** OLD: `text.startsWith('A human is waiting')`. There is one push path now —
 *  a human is simply the highest-priority sender — so the oracle is the push. */
const isWake = (m: OutboundMsg): m is DeliverMsg =>
  m.type === 'deliver' && m.from === 'infra' && m.text.startsWith('Events pending')

/** Drain, in the one ack form S5 leaves. The unaddressed fetch is deliberate:
 *  a test clearing the whole queue is an observer, and only an ADDRESSED read
 *  stamps the ledger. OLD: `{upToId: max(ids)}`. */
async function ackAll() {
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

describe('the arrival push (S3)', () => {
  test(
    'a burst: each qualifying arrival pushes once, repeats follow the ladder, and a drain resets it',
    async () => {
      using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
      using human = await connectAgent(WS_URL, 'human', 'user')
      await Bun.sleep(200)
      await ackAll()
      const base = sensei.messages.filter(isWake).length

      // ── A BURST OF THREE ──
      //
      // BEHAVIOUR CHANGE, AND IT IS FLAGGED RATHER THAN QUIETLY BLESSED. The old
      // assertion here was `=== 1`: the blocking episode coalesced a burst
      // behind a 30s duplicate check (race guard 3), because the old wake was a
      // fixed-text ALARM — "A human is waiting" — and a second identical alarm
      // 80ms later says nothing the first did not.
      //
      // The transition deletes the episode, and S3's rule is per-event: "an
      // event at or above the threshold is pushed ONCE, on arrival". Three
      // messages are three arrivals, so three pushes — and unlike the old alarm
      // each one carries the mailbox AS OF ITS OWN EMISSION, so the second and
      // third genuinely say something the first did not (there are now two, now
      // three). That is the defensible reading, and it is what the code does.
      //
      // What the sources do NOT settle is VOLUME: nothing in 013 says what a
      // 10-message Slack burst should cost in interrupts, and the old design's
      // dedupe is evidence somebody once thought it mattered. RAISED for ruling
      // (task 045); the assertion below therefore pins the count as
      // CHARACTERIZATION of today's rule, not as a requirement — if the ruling
      // adds coalescing, this line moves and nothing else here should.
      human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'q1' }))
      await Bun.sleep(80)
      human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'q2' }))
      await Bun.sleep(80)
      human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'q3' }))
      await Bun.sleep(300)
      expect(sensei.messages.filter(isWake).length).toBe(base + 3)

      // Whatever the count, the CONTENT rule is the one that must hold: the
      // latest push describes the whole mailbox, not just its own event. This is
      // the assertion that survives a coalescing ruling either way.
      const last = sensei.messages.filter(isWake).at(-1)
      expect(last?.text).toContain('"count": 3')
      expect(last?.text).toContain('q3')

      // ── UNHANDLED → THE LADDER REPEATS ──
      // Nothing new arrives from here on, so every further push is the quiet
      // clock's, which is the backstop for everything the threshold declined.
      const afterBurst = sensei.messages.filter(isWake).length
      let repeats = afterBurst
      for (let i = 0; i < 40 && repeats === afterBurst; i++) {
        repeats = sensei.messages.filter(isWake).length
        if (repeats === afterBurst) await Bun.sleep(100)
      }
      expect(repeats).toBeGreaterThan(afterBurst)

      // ── DRAIN ENDS THE SPELL ──
      // An empty mailbox resets the episode, so the next arrival is genuinely
      // new news rather than an inherited ladder rung. Both halves are asserted:
      // the repeats stop…
      await ackAll()
      await Bun.sleep(BACKOFF_MS + 400)
      const afterAck = sensei.messages.filter(isWake).length
      await Bun.sleep(BACKOFF_MS + 400)
      expect(sensei.messages.filter(isWake).length).toBe(afterAck)

      // …and a new message is pushed immediately rather than waiting a rung.
      human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'new question' }))
      let fresh = afterAck
      for (let i = 0; i < 20 && fresh === afterAck; i++) {
        fresh = sensei.messages.filter(isWake).length
        if (fresh === afterAck) await Bun.sleep(50)
      }
      expect(fresh).toBe(afterAck + 1)
      await ackAll()
    },
    SLOW_TEST_MS,
  )
})
