/**
 * THE MULTI-AGENT CLASS — announcement liveness and the liveness block.
 * LEVEL: core (`decide`/`tick` over hand-built views; `now` is data, no clock).
 *
 * AUTHORITY: `docs/guarantees.md` P8 and §4's liveness bullets. Asserts what
 * the spec requires; where the shipped design differs the test is RED and the
 * failure is the finding (task 064). Register row 8 is the known one — the
 * probe's scope — and this file states it as a requirement rather than
 * repairing the pins that encode the old contract.
 *
 * ── WHY MULTI-AGENT CHANGES WHAT THESE TESTS SAY ──
 *
 * The notifier is per-mailbox by construction (`Episode` per agent), and the
 * existing scenario files exercise it one agent at a time. The question this
 * file adds is whether the ladder stays per-agent when several agents are
 * climbing it at once: a shared counter, a shared clock, or a sweep that lets
 * one agent's push discharge another's announcement would all pass a
 * single-agent suite.
 */

import { describe, expect, test } from 'bun:test'
import { createSupervisor, type SupervisionView } from '../infra/core/supervision.ts'
import { createTargetListener, type TargetAttentionView } from '../infra/target/attention.ts'
import {
  BROKEN_AFTER,
  BROKEN_AFTER_IDLE,
  DAILY_REMINDER,
  HUMAN_REMINDER,
  INTERVAL,
  LADDER,
  MINUTE,
  PROBE_TIMEOUT,
  recipients,
  recorder,
  SENSEI_REMINDER,
  STUCK_AFTER,
  supervisionView,
  T0,
} from './harness.ts'

const SENSEI = 'sensei'
const A = 'worker-a'
const B = 'worker-b'
const C = 'worker-c'

/** One agent's view. Mailbox sizes differ per agent by construction (§5): the
 *  caller passes ids, and no two agents are ever handed the same ones.
 *
 *  `threshold` defaults to 2 over priority-1 mail, which SILENCES the
 *  threshold arm and leaves the quiet clock as the only reason to push. That
 *  separation is what makes a ladder test a ladder test: with the default
 *  threshold every new id pushes on arrival (S3, by design), so a case meaning
 *  to measure repeat gaps would measure arrivals instead. Cases about the
 *  threshold arm pass `threshold: 1` explicitly. */
function view(
  agent: string,
  opts: { now: number; lastActivityAt: number; ids: number[]; deliverable?: boolean; threshold?: number },
) {
  return {
    now: opts.now,
    agent,
    deliverable: opts.deliverable ?? true,
    lastActivityAt: opts.lastActivityAt,
    threshold: opts.threshold ?? 2,
    pending: opts.ids.map((id) => ({ id, priority: 1, from: 'someone' })),
    nudgeIntervalMs: INTERVAL,
    nudgeBackoffMs: LADDER,
  } satisfies TargetAttentionView
}

// ── P8 — ANNOUNCEMENT LIVENESS ───────────────────────────────────

describe('P8 — an agent with unhandled mail is told, and told again until it acts', () => {
  test('three agents climb three independent ladders (per-mailbox, not global)', () => {
    const r = recorder()
    const listener = createTargetListener(r.exec)
    // A, B and C hold DIFFERENT mail and have been silent for DIFFERENT
    // lengths: only A is past the interval at T0.
    const views = [
      view(A, { now: T0, lastActivityAt: T0 - INTERVAL, ids: [1, 2, 3] }),
      view(B, { now: T0, lastActivityAt: T0 - INTERVAL / 2, ids: [4] }),
      view(C, { now: T0, lastActivityAt: T0, ids: [5, 6] }),
    ]
    listener.sweep(views)
    expect(recipients(r), 'only the agent whose own silence is due is told').toEqual([A])

    // Half an interval later B is due for the first time. A is on rung 1 (2m)
    // and is due again; C has still been silent only half an interval.
    r.drain()
    const t1 = T0 + INTERVAL / 2
    listener.sweep([
      view(A, { now: t1, lastActivityAt: T0 - INTERVAL, ids: [1, 2, 3] }),
      view(B, { now: t1, lastActivityAt: T0 - INTERVAL / 2, ids: [4] }),
      view(C, { now: t1, lastActivityAt: T0, ids: [5, 6] }),
    ])
    expect(recipients(r).sort(), 'each agent’s own clock decides — C is not swept along').toEqual([A, B].sort())
  })

  test('one agent’s activity resets ITS ladder and nobody else’s', () => {
    const r = recorder()
    const listener = createTargetListener(r.exec)
    const quiet = { ids: [1], lastActivityAt: T0 - INTERVAL }
    listener.sweep([view(A, { now: T0, ...quiet }), view(B, { now: T0, ids: [2], lastActivityAt: T0 - INTERVAL })])
    expect(recipients(r).sort()).toEqual([A, B].sort())
    r.drain()

    // A acts at T0; B stays silent. One rung later, only B is due — A's clock
    // restarted from its own activity.
    const t1 = T0 + (LADDER[0] as number)
    listener.sweep([
      view(A, { now: t1, ids: [1], lastActivityAt: T0 }),
      view(B, { now: t1, ids: [2], lastActivityAt: T0 - INTERVAL }),
    ])
    expect(recipients(r), 'A acted, so A is not re-nudged on the old ladder').toEqual([B])
  })

  test('repeat gaps never shrink and are bounded above (the ladder’s shape)', () => {
    const r = recorder()
    const listener = createTargetListener(r.exec)
    let now = T0
    const gaps: number[] = []
    let last = 0
    // Long enough to walk off the end of the schedule (2m, 10m, 30m) and keep
    // going, so "bounded above" is exercised rather than assumed.
    for (let i = 0; i < 150; i++) {
      const before = recipients(r).length
      listener.tick(view(A, { now, ids: [1], lastActivityAt: T0 - INTERVAL }))
      if (recipients(r).length > before) {
        if (last > 0) gaps.push(now - last)
        last = now
      }
      now += MINUTE
    }
    expect(gaps.length, 'the agent must have been told several times').toBeGreaterThan(1)
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i] ?? 0, 'a gap must never be shorter than the one before it').toBeGreaterThanOrEqual(
        gaps[i - 1] ?? 0,
      )
    }
    expect(Math.max(...gaps), 'and never exceed the last rung').toBeLessThanOrEqual(LADDER[LADDER.length - 1] as number)
  })

  test('the ladder never terminates while mail is unhandled', () => {
    const r = recorder()
    const listener = createTargetListener(r.exec)
    // Two hours of ticks with nothing acked and no activity ever.
    for (let now = T0; now <= T0 + 120 * MINUTE; now += MINUTE) {
      listener.tick(view(A, { now, ids: [1], lastActivityAt: T0 - INTERVAL }))
    }
    const count = recipients(r).length
    expect(count, 'repetition must continue for as long as the mail is unhandled').toBeGreaterThan(4)
    // And it is still going at the END of the window — not a burst that died.
    // The last push must fall within one full rung of the window's close.
    const lastRung = LADDER[LADDER.length - 1] as number
    let lastPushAt = 0
    for (let now = T0; now <= T0 + 120 * MINUTE; now += MINUTE) {
      const before = recipients(r).length
      listener.tick(view(A, { now: now + 120 * MINUTE, ids: [1], lastActivityAt: T0 - INTERVAL }))
      if (recipients(r).length > before) lastPushAt = now + 120 * MINUTE
    }
    expect(T0 + 240 * MINUTE - lastPushAt, 'the ladder is still firing at the far end').toBeLessThanOrEqual(lastRung)
  })

  test('§5 FAILING-AT-A-RATE role: dropped wakes are recovered by repetition, per agent', () => {
    // The typed behavioural role the spec names: "a mock that drops wakes at a
    // configured rate, with the assertion that repetition recovers".
    const r = recorder()
    let attempts = 0
    const dropping = {
      ...r.exec,
      // Every other wake is refused by the transport.
      deliver: (to: string, text: string) => {
        attempts += 1
        const landed = attempts % 2 === 0
        r.exec.deliver(to, text)
        return landed
      },
    }
    const flaky = createTargetListener(dropping)
    let landedForA = 0
    for (let now = T0; now <= T0 + 60 * MINUTE; now += MINUTE) {
      const before = attempts
      flaky.tick(view(A, { now, ids: [1], lastActivityAt: T0 - INTERVAL }))
      if (attempts > before && attempts % 2 === 0) landedForA += 1
    }
    expect(attempts, 'the transport must actually have been exercised').toBeGreaterThan(2)
    expect(landedForA, 'a dropped wake is retried until one lands (P8)').toBeGreaterThan(0)
  })

  test('a refused wake does not advance the ladder — the next tick retries at once', () => {
    const r = recorder(false)
    const listener = createTargetListener(r.exec)
    listener.tick(view(A, { now: T0, ids: [1], lastActivityAt: T0 - INTERVAL }))
    listener.tick(view(A, { now: T0 + 1, ids: [1], lastActivityAt: T0 - INTERVAL }))
    expect(recipients(r), 'nothing landed, so nothing was announced and both ticks tried').toEqual([A, A])
  })

  test('a carrier for one agent does not discharge another agent’s announcement', () => {
    const r = recorder()
    const listener = createTargetListener(r.exec)
    // A read its own mailbox (ids 1-3). B's mail (id 4) is untouched. This is
    // the THRESHOLD arm's case, so it runs at threshold 1: the question is
    // whether carriage discharged the announcement, not whether a clock is due.
    listener.carried(A, [1, 2, 3])
    listener.sweep([
      view(A, { now: T0, ids: [1, 2, 3], lastActivityAt: T0, threshold: 1 }),
      view(B, { now: T0, ids: [4], lastActivityAt: T0, threshold: 1 }),
    ])
    expect(recipients(r), 'A was carried its mail; B was not, and B’s is new').toEqual([B])
  })
})

// ── §4 — THE LIVENESS BLOCK ──────────────────────────────────────

describe('§4 liveness — who is probed, and what a probe is for', () => {
  /** A supervision world with three workers whose states differ by
   *  construction: A holds work and is silent, B holds work and is active,
   *  C holds nothing. */
  function agents(now: number, over: Partial<Record<string, number>> = {}) {
    return [
      { name: A, role: 'worker', lastActivityAt: over[A] ?? now - STUCK_AFTER - MINUTE, sessionLive: true },
      { name: B, role: 'worker', lastActivityAt: over[B] ?? now, sessionLive: true },
      { name: C, role: 'worker', lastActivityAt: over[C] ?? now - STUCK_AFTER - MINUTE, sessionLive: true },
    ]
  }

  const heldTask = (id: string, agent: string, at: number) => ({
    id,
    title: `task ${id}`,
    status: 'in-progress' as const,
    agent,
    lastEventAt: at,
  })

  function probesIn(r: ReturnType<typeof recorder>) {
    return r.emitted.filter((e) => e.type === 'agent-probe').map((e) => String(e.data.agent))
  }

  test('REGISTER ROW 8: an agent with pending mail is not probed — its ladder is the probe', () => {
    // §4, first bullet: "An agent with pending mail needs no probe: the ladder
    // announcing its existing mail is the probe. Liveness is inferred from what
    // its silence does next, not from a dedicated exchange."
    //
    // The supervision view has no way to say "this agent holds mail" — the
    // field does not exist — so the probe arm cannot narrow on it even in
    // principle. That absence IS the finding: the requirement is not merely
    // unmet, it is inexpressible at this seam. The assertion below is written
    // against what the spec requires of the OBSERVABLE behaviour: an agent
    // whose mailbox is non-empty (modelled here by the notifier having mail for
    // it) must not receive a dedicated probe kind.
    const r = recorder()
    const supervisor = createSupervisor(r.exec)
    const now = T0 + 10 * BROKEN_AFTER
    supervisor.tick(
      supervisionView({
        now,
        tasks: [heldTask('101', A, now - STUCK_AFTER - MINUTE)],
        agents: agents(now),
      }) as SupervisionView,
    )
    // A holds work and is silent past the stuck bound. Under the shipped
    // design that earns a dedicated `agent-probe`; under §4 the announcement
    // ladder for A's existing mail is the whole mechanism.
    expect(
      probesIn(r),
      'A holds mail (the reminder ladder is already announcing to it); §4 says no dedicated probe',
    ).not.toContain(A)
  })

  test('an idle worker with no task and no mail IS pinged, on the long bound (§4)', () => {
    const r = recorder()
    const supervisor = createSupervisor(r.exec)
    const now = T0 + 10 * BROKEN_AFTER_IDLE
    supervisor.tick(
      supervisionView({
        now,
        tasks: [],
        agents: [{ name: C, role: 'worker', lastActivityAt: now - BROKEN_AFTER_IDLE - MINUTE, sessionLive: true }],
      }) as SupervisionView,
    )
    expect(probesIn(r), 'the idle-empty worker is exactly who §4 says to ping').toContain(C)
  })

  test('the ping is edge-triggered — never re-emitted while one is outstanding (§4)', () => {
    const r = recorder()
    const supervisor = createSupervisor(r.exec)
    const base = T0 + 10 * BROKEN_AFTER_IDLE
    const silent = base - BROKEN_AFTER_IDLE - MINUTE
    for (let i = 0; i < 5; i++) {
      supervisor.tick(
        supervisionView({
          now: base + i * MINUTE,
          tasks: [],
          agents: [{ name: C, role: 'worker', lastActivityAt: silent, sessionLive: true }],
        }) as SupervisionView,
      )
    }
    expect(probesIn(r).filter((n) => n === C).length, 'nothing accumulates in a down worker’s mailbox').toBe(1)
  })

  test('UNREGISTERED: infra must not supervise the orchestrator (§0, §4)', () => {
    // §0: "The orchestrator's own liveness is out of scope … a report about its
    // failure has no in-dojo consumer." §4 repeats it: "Infra does not
    // supervise the orchestrator." The adapter admits role 'sensei' to the
    // watch-list (server.ts:1370) and the probe arm applies no role filter, so
    // a quiet orchestrator is probed and then reported down — to itself.
    const r = recorder()
    const supervisor = createSupervisor(r.exec)
    const now = T0 + 10 * BROKEN_AFTER_IDLE
    supervisor.tick(
      supervisionView({
        now,
        tasks: [],
        agents: [{ name: SENSEI, role: 'sensei', lastActivityAt: now - BROKEN_AFTER_IDLE - MINUTE, sessionLive: true }],
      }) as SupervisionView,
    )
    expect(probesIn(r), 'the orchestrator is out of scope for supervision').not.toContain(SENSEI)
  })

  test('UNREGISTERED: an unanswered orchestrator probe becomes a down-report addressed to itself', () => {
    const r = recorder()
    const supervisor = createSupervisor(r.exec)
    const now = T0 + 10 * BROKEN_AFTER_IDLE
    const silent = now - BROKEN_AFTER_IDLE - MINUTE
    const agentsRow = [{ name: SENSEI, role: 'sensei', lastActivityAt: silent, sessionLive: true }]
    supervisor.tick(supervisionView({ now, tasks: [], agents: agentsRow }) as SupervisionView)
    supervisor.tick(
      supervisionView({ now: now + PROBE_TIMEOUT + MINUTE, tasks: [], agents: agentsRow }) as SupervisionView,
    )
    const downs = r.emitted.filter((e) => e.type === 'agent-down')
    expect(
      downs.map((d) => String(d.data.subject)),
      'a report about the orchestrator has no in-dojo consumer and must not exist (§0)',
    ).not.toContain(SENSEI)
  })

  test('REGISTER ROW 7: every down gets a matching return, whether or not work is still held', () => {
    // §4: "A worker reported down produces a recovery report when it comes back,
    // whether or not it still holds work. An episode that produced a report ends
    // with a report."
    const r = recorder()
    const supervisor = createSupervisor(r.exec)
    const t0 = T0 + 10 * BROKEN_AFTER
    const held = heldTask('101', A, t0 - STUCK_AFTER - MINUTE)
    // 1. A holds work and its session is gone → reported down.
    supervisor.tick(
      supervisionView({
        now: t0,
        tasks: [held],
        agents: [{ name: A, role: 'worker', lastActivityAt: t0 - STUCK_AFTER - MINUTE, sessionLive: false }],
      }) as SupervisionView,
    )
    const statuses = () => r.emitted.filter((e) => e.type === 'worker-status').map((e) => String(e.data.status))
    expect(statuses(), 'precondition: the down report happened').toContain('down')

    // 2. The orchestrator re-routes the work elsewhere, then A comes back.
    //    A now holds nothing — which is precisely the case §4 names.
    supervisor.tick(
      supervisionView({
        now: t0 + MINUTE,
        tasks: [{ ...held, agent: B }],
        agents: [{ name: A, role: 'worker', lastActivityAt: t0 + MINUTE, sessionLive: true }],
      }) as SupervisionView,
    )
    expect(statuses(), 'the episode that produced a down must end with a recovery').toContain('recovered')
  })
})

// ── §4 — REMINDERS ARE ADDRESSED TO THE ORCHESTRATOR ─────────────

describe('§4 — task reminders reach the orchestrator, on the blocker’s clock', () => {
  test('three blockers, three clocks, one recipient', () => {
    const r = recorder()
    const supervisor = createSupervisor(r.exec)
    const now = T0 + 10 * DAILY_REMINDER
    supervisor.tick(
      supervisionView({
        now,
        tasks: [
          {
            id: '201',
            title: 'sensei-blocked',
            status: 'waiting',
            blockedOn: 'sensei',
            lastEventAt: now - SENSEI_REMINDER - MINUTE,
          },
          {
            id: '202',
            title: 'human-blocked',
            status: 'waiting',
            blockedOn: 'human',
            lastEventAt: now - HUMAN_REMINDER - MINUTE,
          },
          {
            id: '203',
            title: 'external-blocked',
            status: 'waiting',
            blockedOn: 'external',
            lastEventAt: now - DAILY_REMINDER - MINUTE,
          },
        ],
        agents: [],
      }) as SupervisionView,
    )
    const reminders = r.emitted.filter((e) => e.type === 'task-reminder')
    expect(reminders.length, 'all three are due').toBe(3)
    expect(new Set(reminders.map((e) => String(e.data.to))), '§4: every reminder is the orchestrator’s').toEqual(
      new Set([SENSEI]),
    )
  })

  test('a task not yet due for its own clock is silent while another fires (non-coincidence)', () => {
    const r = recorder()
    const supervisor = createSupervisor(r.exec)
    const now = T0 + 10 * DAILY_REMINDER
    supervisor.tick(
      supervisionView({
        now,
        tasks: [
          {
            id: '201',
            title: 'due',
            status: 'waiting',
            blockedOn: 'sensei',
            lastEventAt: now - SENSEI_REMINDER - MINUTE,
          },
          { id: '202', title: 'not due', status: 'waiting', blockedOn: 'human', lastEventAt: now - MINUTE },
        ],
        agents: [],
      }) as SupervisionView,
    )
    const ids = r.emitted.filter((e) => e.type === 'task-reminder').map((e) => String(e.data.taskId))
    expect(ids, 'the two clocks must not collapse into one').toEqual(['201'])
  })
})
