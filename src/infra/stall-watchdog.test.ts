/**
 * THE LONG-WAIT BACKSTOP, at the integration level.
 *
 * ── WHAT THIS FILE WAS, AND WHY IT KEPT ITS NAME ──
 *
 * The stall watchdog: a second timer that force-pushed past the idle gate. Its
 * own header said why it existed — a missed Stop hook left the sensei at
 * `idle:false`, suppressing every machine nudge, and something had to ignore the
 * flag. Delete the gate and that reason is gone with it: the ladder now pushes
 * unconditionally and never stops, so a second clock has no job (ruled
 * 2026-08-05; `core/notify.ts` carries the full note).
 *
 * But the RULING on task 043's casualty list was explicit that this is not a
 * whole-file casualty — "something watchdog-shaped survives as the long-wait
 * backstop; its cases get adapted rather than deleted". That survivor is S11:
 * an agent that never acks and never acts is a BROKEN AGENT, reported to the
 * human on a louder channel. Same question the watchdog was asking — "what
 * catches a dojo that has quietly stopped?" — answered by a mechanism that
 * reports rather than one that shouts louder at somebody who is not listening.
 *
 * So the file keeps its name and its two cases keep their shapes: one proves the
 * backstop FIRES, one proves it STANDS DOWN. What moved is the trigger (silence
 * past a bound, not a stuck flag) and the audience (the human's channel, not the
 * sensei's own).
 *
 * ── WHY AT THIS LEVEL AT ALL ──
 *
 * `s11-broken-agent.core.test.ts` proves the decision. It cannot prove that a
 * timer drives it, that `supervisionView` populates `agents` from the live
 * registry, or that the report reaches a socket — and every one of those is a
 * way for a backstop to be perfectly correct and completely silent, which is the
 * exact failure class a backstop exists for.
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

const TEST_PORT = 8800
const DATA_DIR = '/tmp/jean-test-stall-watchdog'
/** The bound. Shrunk so "silent past it" is reachable in-test; the supervise
 *  tick is `min(60s, reminderAfter, brokenAfter)`, so this also sets the grid. */
const BROKEN_AFTER_MS = 700
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
      JEAN_BROKEN_AGENT_AFTER_MS: String(BROKEN_AFTER_MS),
      // Park the two clocks that would otherwise deliver into these assertions:
      // the task nag (no tasks here, but its tick shares the grid) and the quiet
      // notifier. OLD: `JEAN_STALL_NUDGE_MS` / `JEAN_BLOCKING_BACKOFF_MS`,
      // neither of which names anything any more — a test setting a dead env var
      // configures nothing and silently measures the defaults.
      JEAN_REMINDER_AFTER_MS: String(600_000),
      JEAN_NUDGE_INTERVAL_MS: String(600_000),
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

/** The backstop's own voice. OLD: `text.startsWith('Watchdog:')`. The report is
 *  addressed to a human, so it reads like one sentence about one agent rather
 *  than a machine prefix — matching on the agent name and the verb is what
 *  survives a wording change without becoming a match-anything. */
const isBrokenReport = (m: OutboundMsg, agent: string): m is DeliverMsg =>
  m.type === 'deliver' && m.from === 'infra' && m.text.startsWith(`${agent} has not responded`)

const reports = (msgs: OutboundMsg[], agent: string) => msgs.filter((m) => isBrokenReport(m, agent))

async function until(pred: () => boolean, budgetMs = 6_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(50)
  }
  return pred()
}

describe('the long-wait backstop (S11)', () => {
  test(
    'FIRES: an agent silent past the bound is reported — once, on the human’s channel',
    async () => {
      // The human is connected FIRST and is the audience: O3 says the report
      // goes to the bridge when there is one and the sensei only when there is
      // not. Reporting a broken worker into the queue of the orchestrator that
      // is already failing to get anything out of it is the shape of an alert
      // nobody reads.
      using human = await connectAgent(WS_URL, 'watch-human', 'user')
      using _sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
      using _worker = await connectAgent(WS_URL, 'w1', 'worker')

      // Nothing is stuck and no flag is involved — the worker simply says
      // nothing. That is the whole precondition now, and it is the one that
      // covers "busy" and "dead" as a single case (canon E3).
      expect(await until(() => reports(human.messages, 'w1').length > 0)).toBe(true)
      const report = reports(human.messages, 'w1')[0]
      expect(report?.text).toContain('no activity')

      // ONCE per silence, not once per tick. Several supervise ticks pass here;
      // a backstop that repeats every window is the pre-fix nudge loop wearing a
      // different hat.
      await Bun.sleep(BROKEN_AFTER_MS * 3)
      expect(reports(human.messages, 'w1')).toHaveLength(1)

      // And it is in the log, addressed, so the answer survives the session.
      const hist = (await (await fetch(`${BASE}/history?last=40`)).json()) as {
        events: Array<{ type: string; data: { agent?: string; to?: string } }>
      }
      const recorded = hist.events.filter((e) => e.type === 'agent-unresponsive' && e.data.agent === 'w1')
      expect(recorded).toHaveLength(1)
      expect(recorded[0]?.data.to).toBe('watch-human')
    },
    SLOW_TEST_MS,
  )

  test(
    'STANDS DOWN: any activity clears the report, and a fresh silence earns a fresh one',
    async () => {
      // OLD: `STANDS DOWN while a human is waiting, even before that episode has
      // fired its first wake` — the watchdog deferring to the blocking path so
      // two timers would not double-push. With one pusher that question cannot
      // arise; what CAN still arise, and is the reason this case is worth its
      // runtime, is a latch that never clears. An alert that stays lit after the
      // condition ends is how every ignored alerting system begins, and the
      // decision is written as a restart of the cycle precisely to avoid it —
      // which is only meaningful if something proves the cycle actually restarts.
      using human = await connectAgent(WS_URL, 'watch-human', 'user')
      using worker = await connectAgent(WS_URL, 'w2', 'worker')

      expect(await until(() => reports(human.messages, 'w2').length > 0)).toBe(true)
      const afterFirst = reports(human.messages, 'w2').length

      // The agent speaks. The report must clear — and stay cleared while it
      // keeps speaking.
      worker.ws.send(JSON.stringify({ type: 'reply', from: 'w2', text: 'still here' }))
      await Bun.sleep(200)
      const keepAlive = setInterval(
        () => worker.ws.send(JSON.stringify({ type: 'reply', from: 'w2', text: 'still here' })),
        BROKEN_AFTER_MS / 3,
      )
      await Bun.sleep(BROKEN_AFTER_MS * 3)
      clearInterval(keepAlive)
      expect(reports(human.messages, 'w2')).toHaveLength(afterFirst)

      // Then it goes quiet again: a NEW silence is a new report, not a repeat
      // suppressed by the old one.
      expect(await until(() => reports(human.messages, 'w2').length > afterFirst)).toBe(true)
    },
    SLOW_TEST_MS,
  )
})
