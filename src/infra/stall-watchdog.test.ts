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
 * backstop; its cases get adapted rather than deleted". That survivor is S11.
 *
 * So the file keeps its name and its two cases keep their shapes: one proves
 * the backstop FIRES, one proves it STANDS DOWN.
 *
 * ── THE AUDIENCE CHANGED, AND THAT IS NOW THE SHARPEST ASSERTION ──
 *
 * These cases used to end at the HUMAN's socket: silence past a bound produced
 * a direct push to the bridge. Deleted 2026-08-14 — infra has no line to the
 * human at all. What happens instead, in order:
 *
 *   silent past its bound  → an `agent-probe` addressed to the agent
 *     answered             → NOTHING. no event, no notification.
 *     unanswered           → an `agent-down` in the SENSEI's mailbox
 *
 * The human is never in that sequence. So the case that used to assert "the
 * report arrived on the human's channel" now asserts the opposite, and it is
 * the most valuable line in the file: a reintroduced direct push would light it
 * up immediately, at the level where a port deletion could still be worked
 * around by a new call site.
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
/** How long a probed agent has to answer. Short enough that the escalation is
 *  observable in-test, long enough to be distinguishable from the bound. */
const PROBE_TIMEOUT_MS = 400
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
      // The agents here hold no tasks, so it is the IDLE bound that governs
      // them. Setting only the working one would have measured the 24h default
      // and timed out — the tiered bound (ruled 2026-08-14) makes this the
      // dial that actually applies.
      JEAN_BROKEN_AGENT_IDLE_AFTER_MS: String(BROKEN_AFTER_MS),
      JEAN_PROBE_TIMEOUT_MS: String(PROBE_TIMEOUT_MS),
      // Park the two clocks that would otherwise deliver into these assertions:
      // the task nag (no tasks here, but its tick shares the grid) and the quiet
      // notifier. OLD: `JEAN_STALL_NUDGE_MS` / `JEAN_BLOCKING_BACKOFF_MS`,
      // neither of which names anything any more — a test setting a dead env var
      // configures nothing and silently measures the defaults.
      JEAN_SENSEI_REMINDER_MS: String(600_000),
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

/** Supervision's own emissions, read from the log — the only place they exist
 *  now that nothing is pushed anywhere. */
async function supervisionEvents(): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const hist = (await (await fetch(`${BASE}/history?last=80`)).json()) as {
    events: Array<{ type: string; data: Record<string, unknown> }>
  }
  return hist.events.filter((e) => e.type === 'agent-probe' || e.type === 'agent-down')
}

const probesFor = (rows: Array<{ type: string; data: Record<string, unknown> }>, agent: string) =>
  rows.filter((e) => e.type === 'agent-probe' && e.data.agent === agent)
const downsFor = (rows: Array<{ type: string; data: Record<string, unknown> }>, agent: string) =>
  rows.filter((e) => e.type === 'agent-down' && e.data.subject === agent)

/** ANY push that reached a socket from infra. The human must never see one. */
const infraPushes = (msgs: OutboundMsg[]): DeliverMsg[] =>
  msgs.filter((m): m is DeliverMsg => m.type === 'deliver' && m.from === 'infra')

async function until(pred: () => boolean | Promise<boolean>, budgetMs = 6_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await pred()) return true
    await Bun.sleep(50)
  }
  return await pred()
}

describe('the long-wait backstop (S11)', () => {
  test(
    'FIRES: an agent silent past the bound is PROBED, then reported to the SENSEI — never to the human',
    async () => {
      // The human is connected throughout and is the audience that must NOT be
      // reached. Reporting a broken worker to a person who cannot restart it,
      // at whatever hour the bound expires, is the behaviour this replaces.
      using human = await connectAgent(WS_URL, 'watch-human', 'user')
      using _sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
      using _worker = await connectAgent(WS_URL, 'w1', 'worker')

      // Nothing is stuck and no flag is involved — the worker simply says
      // nothing. That is the whole precondition, and it covers "busy" and
      // "dead" as a single case (canon E3).
      expect(await until(async () => probesFor(await supervisionEvents(), 'w1').length > 0)).toBe(true)

      // It never answers, so the question becomes a report — addressed to the
      // sensei, naming its subject in `subject` rather than `agent`.
      expect(await until(async () => downsFor(await supervisionEvents(), 'w1').length > 0)).toBe(true)
      const down = downsFor(await supervisionEvents(), 'w1')[0]
      expect(down?.data.to).toBe('sensei')
      expect(down?.data.agent).toBeUndefined()

      // ONCE per episode, not once per tick. Several supervise ticks pass here;
      // a backstop that repeats every window is the metronome this replaced.
      await Bun.sleep(BROKEN_AFTER_MS * 3)
      const rows = await supervisionEvents()
      expect(downsFor(rows, 'w1')).toHaveLength(1)
      expect(probesFor(rows, 'w1')).toHaveLength(1)

      // THE LINE THAT MATTERS MOST: the human heard nothing at any point.
      expect(infraPushes(human.messages)).toHaveLength(0)
    },
    SLOW_TEST_MS,
  )

  test(
    'STANDS DOWN: an ANSWERED probe reports nothing at all, and a fresh silence asks again',
    async () => {
      // Silence is the success case. The old shape could not express this: the
      // report had already fired and reached a phone before the agent had any
      // chance to answer, so "it recovered" was unobservable by construction —
      // 23 alarms in two days, zero all-clears.
      using human = await connectAgent(WS_URL, 'watch-human', 'user')
      using worker = await connectAgent(WS_URL, 'w2', 'worker')

      expect(await until(async () => probesFor(await supervisionEvents(), 'w2').length > 0)).toBe(true)

      // The agent answers, and keeps answering. No report should ever exist for
      // this episode.
      worker.ws.send(JSON.stringify({ type: 'reply', from: 'w2', text: 'still here' }))
      const keepAlive = setInterval(
        () => worker.ws.send(JSON.stringify({ type: 'reply', from: 'w2', text: 'still here' })),
        BROKEN_AFTER_MS / 3,
      )
      await Bun.sleep(BROKEN_AFTER_MS * 3)
      clearInterval(keepAlive)
      expect(downsFor(await supervisionEvents(), 'w2')).toHaveLength(0)
      const probesWhileAlive = probesFor(await supervisionEvents(), 'w2').length

      // Then it goes quiet again: a NEW silence earns a new question, not a
      // repeat suppressed by the old one. The cycle restarts rather than
      // latching — a latch that never clears is how every ignored alerting
      // system begins.
      expect(await until(async () => probesFor(await supervisionEvents(), 'w2').length > probesWhileAlive)).toBe(true)

      // …and still nothing reached the human, through either path.
      expect(infraPushes(human.messages)).toHaveLength(0)
    },
    SLOW_TEST_MS,
  )
})
