/**
 * SCENARIO 10 — WORKER STATUS (H4's replacement, ruled 2026-08-11).
 * LEVEL: core (supervision inputs in, emitted events out).
 *
 * CANON (S10 as REPLACED — confirmed verbatim): "A stalled task has no
 * reporter of its own — a task surfaces through what it waits on. Worker state
 * is watched per-worker: the sensei receives worker status-change events
 * (down, up-but-stuck, recovered); a worker past its broken bound is reported
 * to the human once. No per-task reminders, no separate priority."
 *
 * Confirmed definitions: down = no live session; up-but-stuck = session alive
 * but nothing jean-visible from the worker past the silence bound while it
 * holds an active task — both derived from existing signals (session liveness
 * + activity clock), no new machinery.
 *
 * ── WHAT THIS FILE REPLACES ──
 *
 * `s10-reminders.core.test.ts` — the two-reminders-then-escalate ladder. That
 * whole mechanism is DELETED, not adapted: task-level stall coverage is now
 * S7's sensei-nag for waiting-on-sensei, the S9 digest for human/external, the
 * resume date for time, and THESE events for in-progress work. The H4 ruling
 * comment on task 046 is the license for the file swap.
 *
 * ── THE EVENTS ARE THE REPORT — NO DIRECT PUSH ──
 *
 * "The sensei receives worker status-change events" — and the mailbox is how
 * every agent receives everything now (the unification ruling, same day). So
 * the supervisor EMITS on status change and delivers nothing itself; the
 * sensei's mailbox and the notifier do the announcing. Asserted here as
 * emissions, with the mailbox membership pinned in
 * `unification.projection.test.ts`.
 *
 * ── THE WATCH-LIST IS THE BOARD, AND THAT IS THE SELF-QUIETING PROPERTY ──
 *
 * A worker is watched while it holds in-progress work — derived in core from
 * the tasks the view already carries, per-WORKER, not per-task. Consequence
 * (named at plan review): a down worker whose tasks the sensei reroutes leaves
 * the watch-list and stops being reported at all. Self-quieting when the sensei
 * does its job, loud when nobody does.
 *
 * WORK INCLUDES `assigned` since 2026-08-14 — a worker that stopped holding a
 * dispatched-but-unstarted task was watched by nothing at all before.
 */

import { describe, expect, test } from 'bun:test'
import type { SupervisedTask } from '../infra/target/supervision.ts'
import { createSupervisor } from '../infra/target/supervision.ts'
import {
  BROKEN_AFTER,
  deliveries,
  MINUTE,
  PROBE_TIMEOUT,
  recorder,
  STUCK_AFTER,
  supervisionView,
  T0,
} from './harness.ts'

const WORKER = 'builder'

function driver() {
  const r = recorder()
  return { r, supervisor: createSupervisor(r.exec) }
}

/** An in-progress task held by the worker. */
function held(id = '044', agent = WORKER): SupervisedTask {
  return { id, title: `task ${id}`, status: 'in-progress', agent, lastEventAt: T0 }
}

/** The worker's agent row. Live and freshly-active unless a case says not. */
const workerRow = (over: Partial<{ sessionLive: boolean; lastActivityAt: number }> = {}) => ({
  name: WORKER,
  role: 'worker',
  lastActivityAt: over.lastActivityAt ?? T0,
  ...(over.sessionLive !== undefined && { sessionLive: over.sessionLive }),
})

const statusEvents = (r: ReturnType<typeof recorder>) =>
  r.emitted
    .filter((e) => e.type === 'worker-status')
    // Picked, not cast: the events also carry display text, and these cases
    // pin the MACHINE (who, which transition), not the wording.
    .map((e) => ({ agent: e.data.agent as string, status: e.data.status as string }))

describe('S10 (H4) — down: a task-holding worker with no live session', () => {
  test('the session dies → ONE worker-status "down" event, and only one however long it stays down', () => {
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + 3 * STUCK_AFTER; t += MINUTE) {
      supervisor.tick(
        supervisionView({ now: t, tasks: [held()], agents: [workerRow({ sessionLive: false, lastActivityAt: T0 })] }),
      )
    }
    expect(statusEvents(r)).toEqual([{ agent: WORKER, status: 'down' }])
  })

  test('per WORKER, not per task — two held tasks, one down worker, ONE event', () => {
    // The inversion of the old per-task ladder, and the point of the
    // restructure: the reporter is the worker's status, so multiplying tasks
    // must not multiply reports.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + STUCK_AFTER; t += MINUTE) {
      supervisor.tick(
        supervisionView({
          now: t,
          tasks: [held('001'), held('002')],
          agents: [workerRow({ sessionLive: false, lastActivityAt: T0 })],
        }),
      )
    }
    expect(statusEvents(r)).toHaveLength(1)
  })

  test('a worker holding NO active task is not watched — its disconnect already told the sensei', () => {
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + 3 * STUCK_AFTER; t += MINUTE) {
      supervisor.tick(
        supervisionView({ now: t, tasks: [], agents: [workerRow({ sessionLive: false, lastActivityAt: T0 })] }),
      )
    }
    expect(statusEvents(r)).toHaveLength(0)
  })

  test('tasks rerouted while down → the worker leaves the watch-list silently, no "recovered"', () => {
    // The sensei handled it; a recovered event for a worker that never
    // recovered would be a lie, and further downs for a worker holding
    // nothing would be noise.
    const { r, supervisor } = driver()
    const down = supervisionView({ now: T0, tasks: [held()], agents: [workerRow({ sessionLive: false })] })
    supervisor.tick(down)
    expect(statusEvents(r)).toEqual([{ agent: WORKER, status: 'down' }])
    for (let t = T0 + MINUTE; t <= T0 + 3 * STUCK_AFTER; t += MINUTE) {
      supervisor.tick(
        supervisionView({ now: t, tasks: [], agents: [workerRow({ sessionLive: false, lastActivityAt: T0 })] }),
      )
    }
    expect(statusEvents(r)).toHaveLength(1)
  })
})

describe('S10 (H4) — up-but-stuck: a probe went UNANSWERED while the worker holds work', () => {
  // THE VERDICT NOW SITS BEHIND A QUESTION (ruled 2026-08-14). It used to be
  // rendered straight from `now - lastActivityAt >= stuckAfterMs`, which
  // declared a worker stuck for the crime of concentrating — observed live at
  // 31 minutes, on a worker that was mid-implementation and had been told to
  // take the time it needed. The bound now decides only WHEN TO ASK.
  test('silence past the bound ASKS; only the unanswered question reports', () => {
    const { r, supervisor } = driver()
    // Through the bound: a probe, and no verdict.
    for (let t = T0; t <= T0 + STUCK_AFTER; t += MINUTE) {
      supervisor.tick(supervisionView({ now: t, tasks: [held()], agents: [workerRow({ lastActivityAt: T0 })] }))
    }
    expect(statusEvents(r)).toHaveLength(0)
    expect(r.emitted.filter((e) => e.type === 'agent-probe')).toHaveLength(1)

    // Through the answer window with nothing back: NOW it is stuck.
    for (let t = T0 + STUCK_AFTER; t <= T0 + STUCK_AFTER + PROBE_TIMEOUT + MINUTE; t += MINUTE) {
      supervisor.tick(supervisionView({ now: t, tasks: [held()], agents: [workerRow({ lastActivityAt: T0 })] }))
    }
    expect(statusEvents(r)).toEqual([{ agent: WORKER, status: 'up-but-stuck' }])
  })

  test('a worker that ANSWERS its probe is never called stuck', () => {
    // The 08:06 false alarm, as a regression test: a working worker crosses the
    // bound, is asked, answers, and nothing is ever reported about it.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + STUCK_AFTER; t += MINUTE) {
      supervisor.tick(supervisionView({ now: t, tasks: [held()], agents: [workerRow({ lastActivityAt: T0 })] }))
    }
    const answered = T0 + STUCK_AFTER + MINUTE
    for (let t = answered; t <= answered + PROBE_TIMEOUT + MINUTE; t += MINUTE) {
      supervisor.tick(supervisionView({ now: t, tasks: [held()], agents: [workerRow({ lastActivityAt: answered })] }))
    }
    expect(statusEvents(r)).toHaveLength(0)
  })

  test('silence WITHIN the bound → nothing, not even a question', () => {
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + STUCK_AFTER - MINUTE; t += MINUTE) {
      supervisor.tick(supervisionView({ now: t, tasks: [held()], agents: [workerRow({ lastActivityAt: T0 })] }))
    }
    expect(r.emitted).toHaveLength(0)
  })

  test('THE CLOCK IS SEEDED FROM THE WORK — a fresh dispatch is not judged on an old silence', () => {
    // The 07:47 false alarm: an idle worker's `lastActivityAt` was 111 minutes
    // old, and the instant a task became in-progress it was judged against that
    // clock — a verdict 19 seconds after the dispatch. `holding` comes from the
    // board and `lastActivityAt` from the registry; nothing reconciled them.
    const dispatchedAt = T0 + 111 * MINUTE
    const { r, supervisor } = driver()
    for (let t = dispatchedAt; t <= dispatchedAt + STUCK_AFTER - MINUTE; t += MINUTE) {
      supervisor.tick(
        supervisionView({
          now: t,
          tasks: [{ ...held(), lastEventAt: dispatchedAt }],
          agents: [workerRow({ lastActivityAt: T0 })],
        }),
      )
    }
    expect(r.emitted).toHaveLength(0)
  })

  test('a stuck worker whose session then dies → "down" announces the change', () => {
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + STUCK_AFTER + PROBE_TIMEOUT + MINUTE; t += MINUTE) {
      supervisor.tick(supervisionView({ now: t, tasks: [held()], agents: [workerRow({ lastActivityAt: T0 })] }))
    }
    supervisor.tick(
      supervisionView({
        now: T0 + STUCK_AFTER + PROBE_TIMEOUT + 2 * MINUTE,
        tasks: [held()],
        agents: [workerRow({ sessionLive: false, lastActivityAt: T0 })],
      }),
    )
    expect(statusEvents(r).map((e) => e.status)).toEqual(['up-but-stuck', 'down'])
  })
})

describe('S10 (H4) — recovered', () => {
  test('activity after stuck → ONE "recovered" event, and the cycle can repeat', () => {
    const STUCK_AT = STUCK_AFTER + PROBE_TIMEOUT + MINUTE
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + STUCK_AT; t += MINUTE) {
      supervisor.tick(supervisionView({ now: t, tasks: [held()], agents: [workerRow({ lastActivityAt: T0 })] }))
    }
    expect(statusEvents(r).map((e) => e.status)).toEqual(['up-but-stuck'])

    const spoke = T0 + STUCK_AT + MINUTE
    supervisor.tick(supervisionView({ now: spoke, tasks: [held()], agents: [workerRow({ lastActivityAt: spoke })] }))
    expect(statusEvents(r).map((e) => e.status)).toEqual(['up-but-stuck', 'recovered'])

    // A second silence is a NEW question and a NEW stuck, not a suppressed
    // repeat — cleared, not latched, same rule as S11's report.
    for (let t = spoke; t <= spoke + STUCK_AT; t += MINUTE) {
      supervisor.tick(
        supervisionView({
          now: t,
          tasks: [{ ...held(), lastEventAt: spoke }],
          agents: [workerRow({ lastActivityAt: spoke })],
        }),
      )
    }
    expect(statusEvents(r).map((e) => e.status)).toEqual(['up-but-stuck', 'recovered', 'up-but-stuck'])
  })

  test('a session returning with fresh activity after down → "recovered"', () => {
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [held()], agents: [workerRow({ sessionLive: false })] }))
    const back = T0 + 10 * MINUTE
    supervisor.tick(supervisionView({ now: back, tasks: [held()], agents: [workerRow({ lastActivityAt: back })] }))
    expect(statusEvents(r).map((e) => e.status)).toEqual(['down', 'recovered'])
  })
})

describe('S10 (H4) — no per-task reminders, and the worker is never pushed', () => {
  test('THE DELETION — a silent in-progress task produces no reminder, no escalation, no push to anyone', () => {
    // The old ladder's whole surface: task-reminder to the worker (twice),
    // task-escalated to the sensei. All of it gone — the status events above
    // are the only trace a silent worker leaves, and they are emissions, not
    // pushes.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + 6 * STUCK_AFTER; t += MINUTE) {
      supervisor.tick(supervisionView({ now: t, tasks: [held()], agents: [workerRow({ lastActivityAt: T0 })] }))
    }
    expect(deliveries(r)).toBe(0)
    expect(r.emitted.filter((e) => e.type === 'task-reminder' || e.type === 'task-escalated')).toHaveLength(0)
  })
})

describe('S10 (H4) × S11 — a DOWN worker is reported once, by the status arm alone', () => {
  test('no probe is sent to a gone session — `worker-status: down` is the whole report', () => {
    // What this case used to assert: a down worker past the broken bound was
    // ALSO reported to the human by S11, so one dead session produced two
    // reports on two paths. Ruled 2026-08-14: the probe path is for SESSION
    // ALIVE BUT SILENT only. If the session is gone infra already knows the
    // answer at the instant it drops, and asking a corpse produces a
    // guaranteed timeout and a second report of one fact.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + BROKEN_AFTER + PROBE_TIMEOUT + 10 * MINUTE; t += 10 * MINUTE) {
      supervisor.tick(
        supervisionView({ now: t, tasks: [held()], agents: [workerRow({ sessionLive: false, lastActivityAt: T0 })] }),
      )
    }
    // Exactly one report, from the edge-triggered status arm.
    expect(r.emitted.filter((e) => e.type === 'worker-status')).toHaveLength(1)
    expect(r.emitted.filter((e) => e.type === 'worker-status')[0]?.data.status).toBe('down')
    // …and nothing from the probe path, which would have been the duplicate.
    expect(r.emitted.filter((e) => e.type === 'agent-probe')).toHaveLength(0)
    expect(r.emitted.filter((e) => e.type === 'agent-down')).toHaveLength(0)
    // …and nothing to the human, on any path.
    expect(deliveries(r)).toBe(0)
  })
})
