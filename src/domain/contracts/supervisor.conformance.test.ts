/**
 * Supervisor conformance — the liveness block whole, the reminder cadences,
 * both by-construction row closures. RED BY ABSENCE until D9 lands
 * `src/domain/supervisor/index.ts` exporting `supervisor: SupervisorContract`.
 *
 * Probe ledgers, down episodes and reminder clocks are indirectly-visible
 * state — driven here through behaviour sequences over a deterministic
 * clock, per the two-cluster checklist.
 */

import { describe, expect, test } from 'bun:test'
import { counted } from '../fixture/index.ts'
import type {
  SupervisedAgentFacts,
  SupervisedTaskFacts,
  SupervisorConfig,
  SupervisorContract,
  SupervisorState,
  SupervisorView,
} from './supervisor.ts'

const IMPL_PATH: string = '../supervisor/index.ts'
const supervisor: SupervisorContract = await import(IMPL_PATH)
  .then((m) => (m as { supervisor: SupervisorContract }).supervisor)
  .catch((err: unknown) => {
    if (String(err).includes('Cannot find module')) {
      throw new Error(
        'RED BY ABSENCE — src/domain/supervisor/index.ts does not exist yet. ' +
          'Task D9 implements the SupervisorContract; nothing else may (no plausible stubs — design §9).',
      )
    }
    throw err
  })

const T0 = 1_755_600_000_000
const ORCH = 'orchestrator-o'
const WORKER = 'worker-a'
const HOUR = 3_600_000
const DAY = 86_400_000

const CONFIG: SupervisorConfig = {
  senseiReminderMs: 600_000,
  humanReminderMs: HOUR,
  dailyReminderMs: DAY,
  idlePingAfterMs: DAY,
  probeTimeoutMs: 300_000,
  stuckAfterMs: 1_800_000,
}

function agent(over: Partial<SupervisedAgentFacts> & { name: string }): SupervisedAgentFacts {
  return { role: 'worker', connected: true, holdsWork: false, hasPendingMail: false, ...over }
}

function view(now: number, over?: Partial<SupervisorView>): SupervisorView {
  return { now, orchestrator: ORCH, tasks: [], agents: [], ...over }
}

/** Advance in grid steps, collecting effects, applying each decision. */
function run(state: SupervisorState, from: number, to: number, mk: (now: number) => SupervisorView) {
  const collected: { at: number; effects: SupervisorDecisionEffects }[] = []
  let s = state
  for (let t = from; t <= to; t += 60_000) {
    const d = supervisor.decide(s, mk(t), CONFIG)
    if (d.effects.length > 0) collected.push({ at: t, effects: d.effects })
    s = d.next
  }
  return { state: s, collected }
}
type SupervisorDecisionEffects = ReturnType<SupervisorContract['decide']>['effects']

describe('reminders — the blocker picks the clock, blockedSince is the zero, the orchestrator is always the recipient', () => {
  const parked = (
    blockedOn: 'sensei' | 'human' | 'external',
    over?: Partial<SupervisedTaskFacts>,
  ): SupervisedTaskFacts => ({
    id: '001',
    status: 'waiting',
    blockedOn,
    blockedSinceMs: T0,
    ...over,
  })

  test('sensei-blocked reminds on the tight clock; human hourly; external daily — each addressed to the orchestrator', () => {
    let checked = 0
    for (const [blocker, cadence] of [
      ['sensei', CONFIG.senseiReminderMs],
      ['human', CONFIG.humanReminderMs],
      ['external', CONFIG.dailyReminderMs],
    ] as const) {
      const { collected } = run(supervisor.initial(), T0, T0 + cadence + 120_000, (now) =>
        view(now, { tasks: [parked(blocker)] }),
      )
      expect(collected.length).toBeGreaterThan(0)
      const first = collected[0]
      if (!first) throw new Error('unreachable')
      expect(first.at - T0).toBeGreaterThanOrEqual(cadence)
      for (const e of first.effects) {
        expect(e.kind).toBe('remind')
        if (e.kind === 'remind') {
          expect(e.to).toBe(ORCH)
          expect(e.blockedOn).toBe(blocker)
        }
      }
      checked++
    }
    counted('cadences', checked, 3)
  })

  test('a live snooze DEMOTES to the daily clock; the moment it passes, the blocker cadence resumes — demoted, never silenced', () => {
    const snoozedUntil = T0 + 2 * DAY
    const task = parked('sensei', { resumeAtMs: snoozedUntil })
    // While snoozed: nothing at the sensei cadence…
    const early = run(supervisor.initial(), T0, T0 + CONFIG.senseiReminderMs + 120_000, (now) =>
      view(now, { tasks: [task] }),
    )
    expect(early.collected).toEqual([])
    // …but the daily floor still reminds (a snooze never silences).
    const daily = run(supervisor.initial(), T0, T0 + DAY + 120_000, (now) => view(now, { tasks: [task] }))
    expect(daily.collected.length).toBeGreaterThan(0)
    // After the date passes, the tight cadence is back, automatically.
    const after = run(supervisor.initial(), snoozedUntil, snoozedUntil + CONFIG.senseiReminderMs + 120_000, (now) =>
      view(now, { tasks: [task] }),
    )
    expect(after.collected.length).toBeGreaterThan(0)
    expect((after.collected[0]?.at ?? 0) - snoozedUntil).toBeLessThanOrEqual(CONFIG.senseiReminderMs + 60_000)
  })

  test('an empty board produces NO events at all — the wake cannot exist unless something is parked (self-gating)', () => {
    const { collected } = run(supervisor.initial(), T0, T0 + 3 * DAY, (now) => view(now))
    expect(collected).toEqual([])
  })

  test('LEGACY TASKS arrive with the composer’s floor already injected (R10) — one reminder at the cadence, no nag storm', () => {
    // blockedSinceMs is REQUIRED: a pre-pin task reaches this view only
    // through the composer, which supplies updatedAt as the honest floor.
    const legacy: SupervisedTaskFacts = { id: '002', status: 'waiting', blockedOn: 'human', blockedSinceMs: T0 }
    const { collected } = run(supervisor.initial(), T0, T0 + HOUR + 120_000, (now) => view(now, { tasks: [legacy] }))
    expect(collected.length).toBe(1) // exactly one reminder at the cadence — not one per tick
  })
})

describe('the liveness block — who is probed, and what a probe is for', () => {
  test('REGISTER ROW 8 BY CONSTRUCTION: an agent with pending mail is never probed — its ladder is the probe', () => {
    const busyMailbox = agent({ name: WORKER, hasPendingMail: true, lastActivityAt: T0 - 3 * DAY })
    const { collected } = run(supervisor.initial(), T0, T0 + 2 * DAY, (now) => view(now, { agents: [busyMailbox] }))
    expect(collected.flatMap((c) => c.effects).filter((e) => e.kind === 'probe')).toEqual([])
  })

  test('an IDLE-EMPTY worker is pinged after the configured silence — edge-triggered, never re-emitted while outstanding', () => {
    const idle = (last: number) => [agent({ name: WORKER, lastActivityAt: last })]
    const { collected } = run(supervisor.initial(), T0, T0 + 2 * DAY, (now) => view(now, { agents: idle(T0 - DAY) }))
    const probes = collected.flatMap((c) => c.effects).filter((e) => e.kind === 'probe')
    expect(probes.length).toBe(1) // ONE outstanding ping — nothing accumulates in a down worker's mailbox
  })

  test('DOWN KEYS ON ACTIVITY, NEVER ACK: a busy agent with unread mail and recent activity is never reported', () => {
    const busy = agent({ name: WORKER, hasPendingMail: true, holdsWork: true, lastActivityAt: T0 - 60_000 })
    const { collected } = run(supervisor.initial(), T0, T0 + 2 * HOUR, (now) => view(now, { agents: [busy] }))
    expect(collected.flatMap((c) => c.effects).filter((e) => e.kind === 'report')).toEqual([])
  })

  test('§0: the orchestrator is NEVER probed and never the subject of a report, however silent', () => {
    const silentOrch = agent({ name: ORCH, role: 'sensei', lastActivityAt: T0 - 7 * DAY, holdsWork: true })
    const { collected } = run(supervisor.initial(), T0, T0 + 3 * DAY, (now) => view(now, { agents: [silentOrch] }))
    const about = collected
      .flatMap((c) => c.effects)
      .filter((e) => (e.kind === 'probe' && e.agent === ORCH) || (e.kind === 'report' && e.subject === ORCH))
    expect(about).toEqual([])
  })

  test('REGISTER ROW 7 BY CONSTRUCTION: every down gets a matching return — holding work or not', () => {
    // A disconnected worker holding work goes down; it comes back HOLDING
    // NOTHING (the orchestrator rerouted its tasks) — the recovery must
    // still be reported: the episode that produced a report ends with one.
    const goneDown = agent({ name: WORKER, connected: false, holdsWork: true, lastActivityAt: T0 - DAY })
    const phase1 = run(supervisor.initial(), T0, T0 + DAY, (now) => view(now, { agents: [goneDown] }))
    const downs = phase1.collected.flatMap((c) => c.effects).filter((e) => e.kind === 'report' && e.status === 'down')
    expect(downs.length).toBeGreaterThan(0)
    for (const d of downs) if (d.kind === 'report') expect(d.to).toBe(ORCH)
    // The worker returns — connected, active, holding nothing.
    const returned = agent({ name: WORKER, connected: true, holdsWork: false, lastActivityAt: T0 + DAY + 60_000 })
    const phase2 = run(phase1.state, T0 + DAY + 60_000, T0 + DAY + 30 * 60_000, (now) =>
      view(now, { agents: [returned] }),
    )
    const recoveries = phase2.collected
      .flatMap((c) => c.effects)
      .filter((e) => e.kind === 'report' && e.status === 'recovered')
    expect(recoveries.length).toBe(1) // exactly one — the edge, not a stream
    // And an episode that produced NO report ends silently: a fresh healthy
    // agent coming and going emits nothing.
    const healthy = agent({ name: 'worker-quiet', lastActivityAt: T0 })
    const calm = run(supervisor.initial(), T0, T0 + HOUR, (now) => view(now, { agents: [healthy] }))
    expect(calm.collected.flatMap((c) => c.effects).filter((e) => e.kind === 'report')).toEqual([])
  })

  test('UP-BUT-STUCK: session alive, holding work, jean-silent past the bound, probed and unanswered → reported once to the orchestrator', () => {
    const stuck = (last: number) => [agent({ name: WORKER, holdsWork: true, lastActivityAt: last })]
    const { collected } = run(supervisor.initial(), T0, T0 + 6 * HOUR, (now) => view(now, { agents: stuck(T0) }))
    const all = collected.flatMap((c) => c.effects)
    const probes = all.filter((e) => e.kind === 'probe')
    const stuckReports = all.filter((e) => e.kind === 'report' && e.status === 'up-but-stuck')
    expect(probes.length).toBeGreaterThan(0) // asked first — never reported before the question (probe-before-verdict)
    expect(stuckReports.length).toBe(1) // then reported ONCE, on the edge
    const probeAt = collected.find((c) => c.effects.some((e) => e.kind === 'probe'))?.at ?? 0
    expect(probeAt - T0).toBeGreaterThanOrEqual(CONFIG.stuckAfterMs) // asked only after the silence bound
    const reportAt =
      collected.find((c) => c.effects.some((e) => e.kind === 'report' && e.status === 'up-but-stuck'))?.at ?? 0
    expect(reportAt - probeAt).toBeGreaterThanOrEqual(CONFIG.probeTimeoutMs) // the answer window elapsed
  })

  test('UNASSUMED INPUT: a user-role name in the agents view is not a worker — never probed, never reported', () => {
    const humanShape = agent({ name: 'human-h', role: 'user', lastActivityAt: T0 - 7 * DAY })
    const { collected } = run(supervisor.initial(), T0, T0 + 3 * DAY, (now) => view(now, { agents: [humanShape] }))
    expect(collected.flatMap((c) => c.effects)).toEqual([])
  })
})
