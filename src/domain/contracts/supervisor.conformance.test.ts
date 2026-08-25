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
  return {
    role: 'worker',
    connected: true,
    engaged: false,
    engagedTaskIds: [],
    holdsUndone: false,
    hasPendingMail: false,
    ...over,
  }
}

/** Engaged AND saying which claims — the pairing the contract's invariant
 *  requires, so no walk below can accidentally assert one without the other. */
function engagedOn(name: string, ids: readonly string[], over?: Partial<SupervisedAgentFacts>): SupervisedAgentFacts {
  return agent({ name, engaged: true, engagedTaskIds: ids, holdsUndone: true, ...over })
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

  test('a RE-PARKED task reminds on the NEW park’s clock (task 100): no reminder made before this park began counts', () => {
    const phase1 = run(supervisor.initial(), T0, T0 + HOUR + 120_000, (now) =>
      view(now, { tasks: [{ id: '003', status: 'waiting', blockedOn: 'human', blockedSinceMs: T0 }] }),
    )
    expect(phase1.collected.length).toBe(1) // reminded once on the hourly clock
    // The task unparks and moves for a while…
    const between = run(phase1.state, T0 + 2 * HOUR, T0 + 3 * HOUR, (now) =>
      view(now, { tasks: [{ id: '003', status: 'in-progress', blockedSinceMs: T0 }] }),
    )
    expect(between.collected).toEqual([])
    // …and parks AGAIN. The stale `reminded` entry predates this park — the
    // defect measured from it and reminded IMMEDIATELY (D9's third codex
    // bug). blockedSinceMs is the floor: the new park earns its full hour.
    const repark = T0 + 3 * HOUR
    const phase2 = run(between.state, repark, repark + HOUR + 120_000, (now) =>
      view(now, { tasks: [{ id: '003', status: 'waiting', blockedOn: 'human', blockedSinceMs: repark }] }),
    )
    expect(phase2.collected.length).toBe(1)
    expect((phase2.collected[0]?.at ?? 0) - repark).toBeGreaterThanOrEqual(CONFIG.humanReminderMs)
  })

  test('SNOOZE EXPIRY through one continuous state (codex, task 100): the demotion is computed per tick, never stored', () => {
    // The existing demotion test restarts from initial() per phase, so an
    // implementation that STORED the demotion at first sight of the snooze
    // would still pass it. One continuous run pins the law's mechanism: the
    // instant the date passes, the tight cadence is back with no restart.
    const resumeAt = T0 + HOUR
    const task = parked('sensei', { resumeAtMs: resumeAt })
    const { collected } = run(supervisor.initial(), T0, resumeAt + 300_000, (now) => view(now, { tasks: [task] }))
    expect(collected.filter((c) => c.at < resumeAt)).toEqual([]) // demoted: the daily floor owes nothing this early
    expect(collected.length).toBe(1)
    expect(collected[0]?.at).toBe(resumeAt) // the first eligible tick after expiry — blockedSince is long past
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
    const busy = agent({
      name: WORKER,
      hasPendingMail: true,
      engaged: true,
      holdsUndone: true,
      lastActivityAt: T0 - 60_000,
    })
    const { collected } = run(supervisor.initial(), T0, T0 + 2 * HOUR, (now) => view(now, { agents: [busy] }))
    expect(collected.flatMap((c) => c.effects).filter((e) => e.kind === 'report')).toEqual([])
  })

  test('A PROBE CARRIES THE QUESTION IT ASKS (task 132): the stuck arm names the work it is about', () => {
    // THE BAR IS NOT AUDITABILITY — it is that the recipient can select the
    // correct action on receipt. Events 7224 and 7248 in this dojo's own log
    // are byte-identical apart from id and timestamp, and wanted opposite
    // answers: "still working" at one, park-the-task at the other. Nothing in
    // the payload could have told them apart.
    const held = engagedOn(WORKER, ['081'], { lastActivityAt: T0 })
    const { collected } = run(supervisor.initial(), T0, T0 + 4 * HOUR, (now) => view(now, { agents: [held] }))
    const probes = collected.flatMap((c) => c.effects).filter((e) => e.kind === 'probe')
    expect(probes.length).toBeGreaterThan(0)
    const first = probes[0]
    if (first?.kind !== 'probe') throw new Error('unreachable')
    expect(first.probeKind, 'a mid-work probe must say it is the stuck ask').toBe('stuck')
    if (first.probeKind !== 'stuck') throw new Error('unreachable')
    // THE CLAIMS, not a boolean. A recipient asked about work it has to guess
    // at is the incident, and guessing is what produced the wrong answer.
    expect(first.engagedTaskIds).toEqual(['081'])
  })

  test('an ENGAGED agent that owns nothing still gets the stuck ask, naming nothing — and that is the fact', () => {
    // `engaged` is owner-or-queue; the ids are owner-only. So a worker whose
    // only in-progress claim sits in its QUEUE and belongs to someone else is
    // on the stuck clock with nothing to be told about. The list is empty and
    // that emptiness IS the message: "you are being asked about work you do
    // not own." 084's unpropagated ruling, visible in the field for the first
    // time rather than as an over-count nobody can see.
    //
    // The alternative — naming the queue-only task — would have the recipient
    // park work belonging to someone else, mid-flight, under the ruled worker
    // action. That is why this walk exists and why the ids are not `heldBy`'s.
    const queueOnly = agent({ name: WORKER, engaged: true, engagedTaskIds: [], holdsUndone: true, lastActivityAt: T0 })
    const { collected } = run(supervisor.initial(), T0, T0 + 4 * HOUR, (now) => view(now, { agents: [queueOnly] }))
    const probe = collected.flatMap((c) => c.effects).find((e) => e.kind === 'probe')
    if (probe?.kind !== 'probe') throw new Error('unreachable')
    expect(probe.probeKind).toBe('stuck')
    if (probe.probeKind !== 'stuck') throw new Error('unreachable')
    expect(probe.engagedTaskIds).toEqual([])
  })

  test('...and the idle arm says so, and has nothing to name', () => {
    // Reached only past `holdsUndone`, so an idle-armed probe has no claims BY
    // CONSTRUCTION — which is why the effect's shape refuses to carry any.
    const empty = agent({ name: WORKER, lastActivityAt: T0 })
    const { collected } = run(supervisor.initial(), T0, T0 + 2 * DAY, (now) => view(now, { agents: [empty] }))
    const probes = collected.flatMap((c) => c.effects).filter((e) => e.kind === 'probe')
    expect(probes.length).toBe(1)
    const only = probes[0]
    if (only?.kind !== 'probe') throw new Error('unreachable')
    expect(only.probeKind, 'a nothing-held probe must say it is the idle ask').toBe('idle')
  })

  test('the two arms are DISTINGUISHABLE — the same agent, the same silence, different questions', () => {
    // The 7224/7248 pair, reduced to its mechanism: hold the silence and the
    // recipient fixed and vary only what the board says. Two probes come out,
    // and they must not be the same value. This is the walk that fails if the
    // reason is dropped again anywhere between the decision and the effect.
    const mid = run(supervisor.initial(), T0, T0 + 4 * HOUR, (now) =>
      view(now, { agents: [engagedOn(WORKER, ['081'], { lastActivityAt: T0 })] }),
    )
    const idle = run(supervisor.initial(), T0, T0 + 2 * DAY, (now) =>
      view(now, { agents: [agent({ name: WORKER, lastActivityAt: T0 })] }),
    )
    const kindOf = (r: typeof mid) => {
      const p = r.collected.flatMap((c) => c.effects).find((e) => e.kind === 'probe')
      return p?.kind === 'probe' ? p.probeKind : undefined
    }
    expect(kindOf(mid)).toBe('stuck')
    expect(kindOf(idle)).toBe('idle')
    expect(kindOf(mid)).not.toBe(kindOf(idle))
  })

  test('§0: the orchestrator is NEVER probed and never the subject of a report, however silent', () => {
    const silentOrch = agent({
      name: ORCH,
      role: 'sensei',
      lastActivityAt: T0 - 7 * DAY,
      engaged: true,
      holdsUndone: true,
    })
    const { collected } = run(supervisor.initial(), T0, T0 + 3 * DAY, (now) => view(now, { agents: [silentOrch] }))
    const about = collected
      .flatMap((c) => c.effects)
      .filter((e) => (e.kind === 'probe' && e.agent === ORCH) || (e.kind === 'report' && e.subject === ORCH))
    expect(about).toEqual([])
    // …and BY SEAT, NOT BY ROLE (task 100): a sensei-role fixture never
    // reaches the by-name check — the role filter already excludes it, so
    // the case above pinned the WEAKER rule. An orchestrator whose record
    // says `worker` sails through the role filter; only §0's own exclusion
    // stands between it and a probe.
    const workerRoleOrch = agent({
      name: ORCH,
      role: 'worker',
      lastActivityAt: T0 - 7 * DAY,
      engaged: true,
      holdsUndone: true,
    })
    const byName = run(supervisor.initial(), T0, T0 + 3 * DAY, (now) => view(now, { agents: [workerRoleOrch] }))
    expect(byName.collected.flatMap((c) => c.effects)).toEqual([])
  })

  test('REGISTER ROW 7 BY CONSTRUCTION: every down gets a matching return — holding work or not', () => {
    // A disconnected worker holding work goes down; it comes back HOLDING
    // NOTHING (the orchestrator rerouted its tasks) — the recovery must
    // still be reported: the episode that produced a report ends with one.
    const goneDown = agent({
      name: WORKER,
      connected: false,
      engaged: true,
      holdsUndone: true,
      lastActivityAt: T0 - DAY,
    })
    const phase1 = run(supervisor.initial(), T0, T0 + DAY, (now) => view(now, { agents: [goneDown] }))
    const downs = phase1.collected.flatMap((c) => c.effects).filter((e) => e.kind === 'report' && e.status === 'down')
    // EXACTLY one — the edge, not a stream (task 100: `toBeGreaterThan(0)`
    // was the loudest gap in the module; D9 measured 1 correct vs 1441
    // one-per-tick over a simulated day, every one a pair to clear).
    expect(downs.length).toBe(1)
    for (const d of downs) if (d.kind === 'report') expect(d.to).toBe(ORCH)
    // The worker returns — connected, active, holding nothing.
    const returned = agent({
      name: WORKER,
      connected: true,
      engaged: false,
      holdsUndone: false,
      lastActivityAt: T0 + DAY + 60_000,
    })
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
    const stuck = (last: number) => [agent({ name: WORKER, engaged: true, holdsUndone: true, lastActivityAt: last })]
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

  test('RULED (task 115): a waiting or assigned task puts its holder on NO clock — never probed, never pinged, however silent', () => {
    // The live shakedown's probe loop: the builder held ONE waiting task
    // (blocked external, snoozed) and was probed every 31 quiet minutes
    // forever — probe, ack, ack resets the clock, probe again. `engaged`
    // excludes waiting BY RULING (the parked task reminds the orchestrator
    // on its blocker's clock; the holder owes nothing) and excludes
    // assigned (an undispatched assignment is the orchestrator's board
    // follow-up). `holdsUndone` keeps the same holder out of the
    // idle-empty ping too — the identical bug at a daily cadence. The one
    // fact shape below covers both cases.
    const parkedHolder = agent({ name: WORKER, engaged: false, holdsUndone: true, lastActivityAt: T0 - 7 * DAY })
    const { collected } = run(supervisor.initial(), T0, T0 + 3 * DAY, (now) => view(now, { agents: [parkedHolder] }))
    expect(collected.flatMap((c) => c.effects)).toEqual([])
    // The mirror: the ruling removes the FALSE clock, not the real one —
    // an engaged holder rides the stuck clock exactly as before.
    const engagedHolder = agent({ name: 'worker-e', engaged: true, holdsUndone: true, lastActivityAt: T0 })
    const stuck = run(supervisor.initial(), T0, T0 + 2 * HOUR, (now) => view(now, { agents: [engagedHolder] }))
    expect(stuck.collected.flatMap((c) => c.effects).filter((e) => e.kind === 'probe').length).toBe(1)
  })

  test('a STUCK probe lapses with the engagement; an idle ping never answers for it — no verdict without a fresh question (task 115)', () => {
    // Walk A: probed mid-work, then the task PARKS. The question is moot —
    // and the stale mark must not survive to trigger an instant verdict
    // when the agent re-engages minutes-silent later. The re-engagement
    // earns a FRESH probe first, then the ordinary window.
    const engaged = (last: number) => [agent({ name: WORKER, engaged: true, holdsUndone: true, lastActivityAt: last })]
    const parked = (last: number) => [agent({ name: WORKER, engaged: false, holdsUndone: true, lastActivityAt: last })]
    let phase = run(supervisor.initial(), T0, T0 + CONFIG.stuckAfterMs + 60_000, (now) =>
      view(now, { agents: engaged(T0) }),
    )
    expect(phase.collected.flatMap((c) => c.effects).filter((e) => e.kind === 'probe').length).toBe(1)
    // Parks before the answer window closes; silence continues.
    phase = run(phase.state, T0 + CONFIG.stuckAfterMs + 2 * 60_000, T0 + HOUR, (now) =>
      view(now, { agents: parked(T0) }),
    )
    expect(phase.collected).toEqual([]) // no verdict off the moot question
    // Re-engages, still silent since T0 — long past the bound. The stale
    // ask must not produce an INSTANT verdict; the re-engagement earns a
    // fresh probe first, and only ITS answer window may report.
    phase = run(phase.state, T0 + HOUR + 60_000, T0 + HOUR + 10 * 60_000, (now) => view(now, { agents: engaged(T0) }))
    const effects = phase.collected.flatMap((c) => c.effects)
    expect(effects.filter((e) => e.kind === 'probe').length).toBe(1) // the fresh question
    const freshProbeAt = phase.collected.find((c) => c.effects.some((e) => e.kind === 'probe'))?.at ?? 0
    const reportAt = phase.collected.find((c) => c.effects.some((e) => e.kind === 'report'))?.at
    if (reportAt !== undefined) {
      // A report may only follow the FRESH ask's full window — never the
      // stale one's (which expired an hour ago and would fire instantly).
      expect(reportAt - freshProbeAt).toBeGreaterThanOrEqual(CONFIG.probeTimeoutMs)
    }
    // Walk B: an IDLE PING's mark reaching the engaged branch must not
    // stand in for a stuck probe (pre-115 leak: idle→engaged fired the
    // verdict with no stuck question ever asked).
    const idle = (last: number) => [agent({ name: 'worker-i', lastActivityAt: last })]
    let b = run(supervisor.initial(), T0, T0 + 10 * 60_000, (now) => view(now, { agents: idle(T0 - DAY) }))
    expect(b.collected.flatMap((c) => c.effects).filter((e) => e.kind === 'probe').length).toBe(1) // the idle ping
    const engagedI = (last: number) => [
      agent({ name: 'worker-i', engaged: true, holdsUndone: true, lastActivityAt: last }),
    ]
    b = run(b.state, T0 + 20 * 60_000, T0 + 40 * 60_000, (now) => view(now, { agents: engagedI(T0 - DAY) }))
    const bEffects = b.collected.flatMap((c) => c.effects)
    // The first thing that happens is a STUCK probe — never a report.
    const firstReportAt = b.collected.find((c) => c.effects.some((e) => e.kind === 'report'))?.at
    const stuckProbeAt = b.collected.find((c) => c.effects.some((e) => e.kind === 'probe'))?.at
    expect(stuckProbeAt).toBeDefined()
    if (firstReportAt !== undefined && stuckProbeAt !== undefined) {
      expect(firstReportAt - stuckProbeAt).toBeGreaterThanOrEqual(CONFIG.probeTimeoutMs)
    }
    expect(bEffects.filter((e) => e.kind === 'report' && e.status === 'up-but-stuck').length).toBeLessThanOrEqual(1)
  })

  test('ROW 8 GATES PROBES ONLY (task 102): mail never shields a verdict — a probe mints mail, and a blanket exit cancelled every report', () => {
    // (a) A DISCONNECTED agent with queued mail still reads down — its
    // ladder is refused wakes, not liveness. The first composed run showed
    // the blanket exit hiding exactly this: dispatches queue to a dead
    // worker and nobody is ever told it is dead.
    const goneWithMail = agent({
      name: WORKER,
      connected: false,
      engaged: true,
      holdsUndone: true,
      hasPendingMail: true,
      lastActivityAt: T0 - DAY,
    })
    const phase1 = run(supervisor.initial(), T0, T0 + 10 * 60_000, (now) => view(now, { agents: [goneWithMail] }))
    const downs = phase1.collected.flatMap((c) => c.effects).filter((e) => e.kind === 'report' && e.status === 'down')
    expect(downs.length).toBe(1)
    // (b) The stuck VERDICT proceeds although the probe's own mail is now
    // pending: the probe was already asked; the answer window is what runs.
    const stuck = (pendingMail: boolean) => [
      agent({ name: 'worker-s', engaged: true, holdsUndone: true, hasPendingMail: pendingMail, lastActivityAt: T0 }),
    ]
    const probed = run(supervisor.initial(), T0, T0 + CONFIG.stuckAfterMs + 60_000, (now) =>
      view(now, { agents: stuck(false) }),
    )
    expect(probed.collected.flatMap((c) => c.effects).filter((e) => e.kind === 'probe').length).toBe(1)
    const verdict = run(
      probed.state,
      T0 + CONFIG.stuckAfterMs + 2 * 60_000,
      T0 + 2 * HOUR,
      (now) => view(now, { agents: stuck(true) }), // the probe now sits in its mailbox
    )
    const reports = verdict.collected
      .flatMap((c) => c.effects)
      .filter((e) => e.kind === 'report' && e.status === 'up-but-stuck')
    expect(reports.length).toBe(1)
    // (c) The MIRROR stays: a mail-holding quiet worker is still never
    // asked a NEW question — no probe, however silent (row 8's actual rule,
    // already pinned above; re-asserted here against this fixture's shape).
    const quietWithMail = agent({
      name: 'worker-q',
      hasPendingMail: true,
      engaged: true,
      holdsUndone: true,
      lastActivityAt: T0 - DAY,
    })
    const noProbe = run(supervisor.initial(), T0, T0 + 2 * HOUR, (now) => view(now, { agents: [quietWithMail] }))
    expect(noProbe.collected.flatMap((c) => c.effects).filter((e) => e.kind === 'probe')).toEqual([])
  })

  test('the idle ping RE-ARMS after acknowledgement (codex, task 100): activity clears the outstanding probe; new silence earns a new ping', () => {
    // Probed once (idle a day already)…
    const phase1 = run(supervisor.initial(), T0, T0 + 10 * 60_000, (now) =>
      view(now, { agents: [agent({ name: WORKER, lastActivityAt: T0 - DAY })] }),
    )
    expect(phase1.collected.flatMap((c) => c.effects).filter((e) => e.kind === 'probe').length).toBe(1)
    // …the worker acknowledges — its own act — and is cleared silently…
    const ackAt = T0 + 20 * 60_000
    const phase2 = run(phase1.state, ackAt, ackAt + 10 * 60_000, (now) =>
      view(now, { agents: [agent({ name: WORKER, lastActivityAt: ackAt })] }),
    )
    expect(phase2.collected).toEqual([])
    // …and a NEW day of silence earns a SECOND ping, measured from the ack.
    // One-probe-forever is the silent-direction defect: the edge-trigger
    // must re-arm on acknowledgement, not retire.
    const phase3 = run(phase2.state, ackAt + DAY - 10 * 60_000, ackAt + DAY + 10 * 60_000, (now) =>
      view(now, { agents: [agent({ name: WORKER, lastActivityAt: ackAt })] }),
    )
    const probes = phase3.collected.filter((c) => c.effects.some((e) => e.kind === 'probe'))
    expect(probes.length).toBe(1)
    expect((probes[0]?.at ?? 0) - ackAt).toBeGreaterThanOrEqual(CONFIG.idlePingAfterMs)
  })

  test('an UP-BUT-STUCK report gets a matching return too (ruled, task 100): row 7 closes per REPORT, not per down', () => {
    // The contract's row-7 sentence named `down`; a stale stuck alarm is the
    // same unclosed claim in the orchestrator's hands, so the ruling extends
    // the return to every report kind.
    const phase1 = run(supervisor.initial(), T0, T0 + HOUR, (now) =>
      view(now, { agents: [agent({ name: WORKER, engaged: true, holdsUndone: true, lastActivityAt: T0 })] }),
    )
    const stuckReports = phase1.collected
      .flatMap((c) => c.effects)
      .filter((e) => e.kind === 'report' && e.status === 'up-but-stuck')
    expect(stuckReports.length).toBe(1)
    // The agent wakes and acts: exactly one `recovered` closes the alarm.
    const wokeAt = T0 + HOUR + 60_000
    const phase2 = run(phase1.state, wokeAt, wokeAt + 20 * 60_000, (now) =>
      view(now, { agents: [agent({ name: WORKER, engaged: true, holdsUndone: true, lastActivityAt: wokeAt })] }),
    )
    const recoveries = phase2.collected
      .flatMap((c) => c.effects)
      .filter((e) => e.kind === 'report' && e.status === 'recovered')
    expect(recoveries.length).toBe(1)
  })

  test('UNASSUMED INPUT: a user-role name in the agents view is not a worker — never probed, never reported', () => {
    const humanShape = agent({ name: 'human-h', role: 'user', lastActivityAt: T0 - 7 * DAY })
    const { collected } = run(supervisor.initial(), T0, T0 + 3 * DAY, (now) => view(now, { agents: [humanShape] }))
    expect(collected.flatMap((c) => c.effects)).toEqual([])
  })
})

describe('the orchestrator absent — the state records only what was actually emitted (task 100)', () => {
  // Both of D9's liveness bugs lived here, and neither was reachable: every
  // fixture above keeps an orchestrator on record, while a between-boot gap
  // is exactly when supervision matters.
  test('down, then the agent returns during a no-orchestrator gap: the episode stays open; the recovery fires when a recipient exists', () => {
    const gone = agent({ name: WORKER, connected: false, engaged: true, holdsUndone: true, lastActivityAt: T0 - DAY })
    const phase1 = run(supervisor.initial(), T0, T0 + 10 * 60_000, (now) => view(now, { agents: [gone] }))
    const downs = phase1.collected.flatMap((c) => c.effects).filter((e) => e.kind === 'report' && e.status === 'down')
    expect(downs.length).toBe(1)
    // The agent returns while NO orchestrator is on record. Nothing can be
    // told to nobody — and nothing may be lost either: the defect cleared
    // the episode here, and the matching return vanished forever.
    const back = (last: number) =>
      agent({ name: WORKER, connected: true, engaged: false, holdsUndone: false, lastActivityAt: last })
    const gap = run(phase1.state, T0 + 20 * 60_000, T0 + 40 * 60_000, (now) =>
      view(now, { orchestrator: undefined, agents: [back(now - 60_000)] }),
    )
    expect(gap.collected).toEqual([])
    // An orchestrator exists again: the matching return arrives, exactly once.
    const healed = run(gap.state, T0 + 41 * 60_000, T0 + 60 * 60_000, (now) =>
      view(now, { agents: [back(now - 60_000)] }),
    )
    const recoveries = healed.collected
      .flatMap((c) => c.effects)
      .filter((e) => e.kind === 'report' && e.status === 'recovered')
    expect(recoveries.length).toBe(1)
  })

  test('a stuck timeout reached with no orchestrator reports NOTHING — and the episode ends silently on return, no stray recovered', () => {
    const stuck = (last: number) => [agent({ name: WORKER, engaged: true, holdsUndone: true, lastActivityAt: last })]
    // Probed while an orchestrator exists…
    const phase1 = run(supervisor.initial(), T0, T0 + CONFIG.stuckAfterMs + 60_000, (now) =>
      view(now, { agents: stuck(T0) }),
    )
    expect(phase1.collected.flatMap((c) => c.effects).filter((e) => e.kind === 'probe').length).toBe(1)
    // …the answer window runs out during a no-orchestrator gap. No verdict is
    // emitted, so none may be RECORDED: the defect marked `reported` without
    // emitting, and the agent's later return closed a report never made.
    const gap = run(phase1.state, T0 + CONFIG.stuckAfterMs + 2 * 60_000, T0 + 2 * HOUR, (now) =>
      view(now, { orchestrator: undefined, agents: stuck(T0) }),
    )
    expect(gap.collected).toEqual([])
    // The agent acts, with the orchestrator back: an episode that reported
    // nothing ends SILENTLY.
    const woke = run(gap.state, T0 + 2 * HOUR + 60_000, T0 + 3 * HOUR, (now) =>
      view(now, { agents: [agent({ name: WORKER, engaged: true, holdsUndone: true, lastActivityAt: now - 60_000 })] }),
    )
    expect(woke.collected).toEqual([])
  })
})
