/**
 * SCENARIO 7 + 8 (the DATA half) — `blockedOn`, its movement, and who is allowed
 * to move a task at all.
 * LEVEL: projection (a task stream in → board state out; pure).
 *
 * CANON (S7, verbatim): "A worker that completes its task or hits a question
 * puts the task into waiting-on-sensei — same state, different message — and the
 * **sensei** is nagged, not the worker. Worker's only permitted transition:
 * `in-progress → waiting` with `blockedOn: sensei | human | external | time` and
 * a note; workers still cannot close tasks."
 *
 * CANON (S8 + the same-day amendment): "`blockedOn` moves and the nagging
 * follows it. No mute mechanism exists or is needed." The no-return rule left the
 * infra contract entirely — infra cannot see whether new information arrived, so
 * **it accepts any reassignment and builds no cycle guard.**
 *
 * The NAG half of S7/S8 — who gets pushed, and that the push follows the holder
 * — is `s07-nag.core.test.ts` and `s08-handoff.core.test.ts`. This file is only
 * about what the board says.
 *
 * STATUS: RED — `targetBoardReducer` and `canActorTransition` throw.
 *
 * ── DEVIATION-4 IS HALF THIS FILE, AND IT IS THE HALF WITH NO OWNER ──
 *
 * 042 found `PATCH /tasks/:id/status` checks `canTransition` only: `actor` is
 * RECORDED AND NEVER CHECKED, so any caller can drive any legal transition
 * including `→ done`. The readiness order named "blockedOn on Task + reminder
 * event types" — data, not authorization. A requirement that ships as a field
 * nobody enforces is how "workers still cannot close tasks" becomes a comment.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../es/index.ts'
import { canTransition, type Task } from '../infra/board.ts'
import { canActorTransition, type TargetBoard, targetBoardReducer } from '../infra/target/blocked.ts'
import { isParked } from '../infra/target/digest.ts'
import { ev } from './harness.ts'

const TASK = 'task-044'
const ID = '044'

const board = (log: readonly StoredEvent[]): TargetBoard => log.reduce(targetBoardReducer, { tasks: [] })
const taskOf = (log: readonly StoredEvent[]) => board(log).tasks.find((t) => t.id === ID)

const created = () => ev('task-created', TASK, { title: 'red suite', description: '', queue: 'builder' })
const started = () => ev('task-status', TASK, { from: 'todo', to: 'in-progress', actor: 'sensei' })
const parked = (blockedOn: string, note: string, actor = 'builder') =>
  ev('task-status', TASK, { from: 'in-progress', to: 'waiting', actor, blockedOn, blockedNote: note })
const moved = (blockedOn: string, note?: string, actor = 'sensei') =>
  ev('task-blocked', TASK, { blockedOn, ...(note && { note }), actor })

describe('S7 — parking a task records WHO it waits on and WHY', () => {
  test('a worker parks in-progress → waiting with blockedOn and a note', () => {
    const t = taskOf([created(), started(), parked('sensei', 'need the ruling on the digest predicate')])
    expect(t?.status).toBe('waiting')
    expect(t?.blockedOn).toBe('sensei')
    expect(t?.blockedNote).toBe('need the ruling on the digest predicate')
  })

  test('UNTESTED-3 — "same state, different message": finished and blocked are ONE state', () => {
    // Canon S7, verbatim: "A worker that completes its task or hits a question
    // puts the task into waiting-on-sensei — SAME STATE, DIFFERENT MESSAGE".
    //
    // The audit (task 046) found this untested, and named where it fell through:
    // the two-file split. `s07-blocked` tests the field, `s07-nag` tests who
    // gets chased, and the sentence that binds them — that two DIFFERENT worker
    // situations produce the SAME status — belonged to neither.
    //
    // It is worth an assertion because the tempting design is the opposite one:
    // a `done-pending-review` status beside `waiting`, which reads tidier and
    // silently doubles every downstream branch (the nag ladder, the digest
    // predicate, the transition gate). The canon's economy is the requirement.
    const finished = taskOf([created(), started(), parked('sensei', 'done — branch pushed, ready for review')])
    const stuck = taskOf([created(), started(), parked('sensei', 'blocked — which predicate wins for `human`?')])

    // SAME STATE, and the same holder: both are the sensei's problem now.
    expect(finished?.status).toBe('waiting')
    expect(stuck?.status).toBe(finished?.status)
    expect(stuck?.blockedOn).toBe(finished?.blockedOn)

    // DIFFERENT MESSAGE, and it is the only thing that differs. The note is
    // where the distinction lives, which is exactly why it must survive the fold
    // verbatim rather than being normalised into a category.
    expect(finished?.blockedNote).toBe('done — branch pushed, ready for review')
    expect(stuck?.blockedNote).toBe('blocked — which predicate wins for `human`?')
    expect(stuck?.blockedNote).not.toBe(finished?.blockedNote)
  })

  test('a task that was never parked carries no blockedOn at all', () => {
    // Absent, not a default. A task in-progress with `blockedOn: 'sensei'`
    // sitting there from a schema default would put every active task on the
    // sensei's nag list.
    const t = taskOf([created(), started()])
    expect(t?.status).toBe('in-progress')
    expect(t?.blockedOn).toBeUndefined()
    expect(t?.blockedNote).toBeUndefined()
  })

  test('resuming clears the park — blockedOn is not sticky', () => {
    // If it were, a task that came back to life would keep generating nags for
    // a blocker that no longer exists, and S9's digest would list work that is
    // actively moving.
    const t = taskOf([
      created(),
      started(),
      parked('human', 'waiting on the customer'),
      ev('task-status', TASK, { from: 'waiting', to: 'in-progress', actor: 'sensei' }),
    ])
    expect(t?.status).toBe('in-progress')
    expect(t?.blockedOn).toBeUndefined()
  })

  test('the four blockedOn values all fold', () => {
    for (const on of ['sensei', 'human', 'external', 'time'] as const) {
      expect(taskOf([created(), started(), parked(on, `waiting on ${on}`)])?.blockedOn).toBe(on)
    }
  })
})

describe('S8 — the blocker moves, and infra does not argue', () => {
  test('an explicit act moves blockedOn and replaces the note', () => {
    // Its own event, per the explicit-acts principle (041's first amendment):
    // escalating to the human is an ACT, not a side effect of something else.
    const t = taskOf([
      created(),
      started(),
      parked('sensei', 'need a decision'),
      moved('human', 'escalated: needs Leonid'),
    ])
    expect(t?.status).toBe('waiting')
    expect(t?.blockedOn).toBe('human')
    expect(t?.blockedNote).toBe('escalated: needs Leonid')
  })

  test('NO CYCLE GUARD — a blocker may return to a party that already held it', () => {
    // THE AMENDMENT, ASSERTED AS A PERMISSION rather than left as prose. Infra
    // cannot see whether new information arrived — that conversation happens
    // inside the sensei's session, invisible here by construction. Building the
    // guard anyway would be the deviation, and it would silently reject a
    // legitimate re-escalation.
    const t = taskOf([
      created(),
      started(),
      parked('sensei', 'first'),
      moved('human', 'escalated'),
      moved('sensei', 'human answered, back to you'),
      moved('human', 'and again'),
    ])
    expect(t?.blockedOn).toBe('human')
    expect(t?.status).toBe('waiting')
  })

  test('the park age follows the CURRENT holder', () => {
    // S9 measures per-item age off this. Measured from task creation, a
    // just-escalated task reads as ancient; never reset, a ping-ponged task
    // reads as fresh forever. Neither tells the human what they need.
    const t0 = '2026-08-01T00:00:00.000Z'
    const t1 = '2026-08-04T00:00:00.000Z'
    const log = [
      created(),
      started(),
      ev('task-status', TASK, { from: 'in-progress', to: 'waiting', blockedOn: 'sensei' }, t0),
      ev('task-blocked', TASK, { blockedOn: 'human' }, t1),
    ]
    expect(taskOf(log)?.blockedSince).toBe(t1)
  })

  test('there is no mute — nothing in the shape can silence a parked task', () => {
    // "No mute mechanism exists or is needed" (S8). Asserted as an absence over
    // the whole folded task, because a mute would arrive as an innocuous extra
    // field long before anyone called it a mute.
    const t = taskOf([created(), started(), parked('human', 'waiting')])
    expect(Object.keys(t ?? {})).not.toContain('muted')
    expect(Object.keys(t ?? {})).not.toContain('snoozedUntil')
    expect(Object.keys(t ?? {})).not.toContain('silenced')
  })

  test('S8 × H3 — the handoff clears a stale resume date: time+date → human → time is VISIBLE', () => {
    // The architect's F2 (this fix round's adversarial pass): every park field
    // is replaced when the blocker moves — the reducer's own comment says a
    // leftover note "describes a question that has already been answered" —
    // and `resumeAt` is a park field. Left sticky, this exact sequence hides
    // the task until a date NOBODY CHOSE for the final park: the September
    // date belonged to the first time-park, the handoff to the human ended
    // that decision, and the return to `time` recorded no new wake. A
    // time-park with no date has no wake and must be visible (H3's safe
    // direction) — a stale inherited one is worse than none, because it looks
    // chosen.
    const september = '2026-09-01T09:00:00.000Z'
    const t = taskOf([
      created(),
      started(),
      ev('task-status', TASK, { from: 'in-progress', to: 'waiting', blockedOn: 'time', resumeAt: september }),
      moved('human', 'needs Leonid first'),
      moved('time', 'still scheduled-ish, date TBD'),
    ])
    expect(t?.blockedOn).toBe('time')
    expect(t?.resumeAt).toBeUndefined()
    expect(isParked(t as Task, Date.parse('2026-08-11T12:00:00.000Z'))).toBe(true)
  })

  test('S8 × H3 — a handoff CARRYING a resume date records it', () => {
    // Clear-or-replace, both halves: a handoff back to `time` that does choose
    // a wake keeps it, exactly like the parking PATCH does.
    const october = '2026-10-01T09:00:00.000Z'
    const t = taskOf([
      created(),
      started(),
      parked('human', 'needs Leonid'),
      ev('task-blocked', TASK, { blockedOn: 'time', note: 'resume in October', resumeAt: october }),
    ])
    expect(t?.resumeAt).toBe(october)
  })
})

describe('DEVIATION-4 — workers still cannot close tasks', () => {
  test('a worker may park: in-progress → waiting', () => {
    expect(canActorTransition('worker', 'in-progress', 'waiting')).toBe(true)
  })

  test('a worker may NOT close — not from in-progress, not from waiting', () => {
    // The requirement in one line, and the one 042 found unowned.
    expect(canActorTransition('worker', 'in-progress', 'done')).toBe(false)
    expect(canActorTransition('worker', 'waiting', 'done')).toBe(false)
    expect(canActorTransition('worker', 'in-progress', 'cancelled')).toBe(false)
  })

  test('in-progress → waiting is the worker’s ONLY transition', () => {
    // Canon says "only", and the surrounding practice agrees — the worker skill
    // already tells workers that task state is the sensei's job. So starting a
    // task is not a worker's act either.
    expect(canActorTransition('worker', 'todo', 'in-progress')).toBe(false)
    expect(canActorTransition('worker', 'assigned', 'in-progress')).toBe(false)
    expect(canActorTransition('worker', 'waiting', 'in-progress')).toBe(false)
  })

  test('the sensei may drive the transitions the DAG allows', () => {
    expect(canActorTransition('sensei', 'in-progress', 'done')).toBe(true)
    expect(canActorTransition('sensei', 'todo', 'in-progress')).toBe(true)
    expect(canActorTransition('sensei', 'waiting', 'done')).toBe(true)
  })

  test('BOTH gates are required — DAG-legal is not the same as actor-legal', () => {
    // The distinction that makes this a real check rather than a second copy of
    // `canTransition`. `in-progress → done` is legal in the DAG for everyone;
    // it is the ACTOR that makes it refusable.
    expect(canTransition('in-progress', 'done')).toBe(true)
    expect(canActorTransition('worker', 'in-progress', 'done')).toBe(false)
    // And an actor-legal transition the DAG forbids is still forbidden.
    expect(canTransition('done', 'in-progress')).toBe(false)
  })
})
