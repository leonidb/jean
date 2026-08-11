/**
 * Board — task types and state transitions.
 *
 * Board state is derived from events via the boardReducer.
 * This module defines the types and transition rules.
 */

// ── Types ──────────────────────────────────────────────────────────

/**
 * Task lifecycle states.
 * - `todo`: created, not yet dispatched.
 * - `assigned`: claimed by a worker but not started.
 * - `in-progress`: worker is actively holding the task. The only status that implies the worker's session is busy.
 * - `waiting`: paused for external input (human answer, API response, time). The worker is NOT busy on this task;
 *   it can be idle or working on something else. Server-side busy/idle derivation must not count `waiting` as busy.
 * - `done`, `cancelled`: terminal.
 */
export type TaskStatus = 'todo' | 'assigned' | 'in-progress' | 'waiting' | 'done' | 'cancelled'

/**
 * Who a parked task is waiting on (013 S7). Closed set.
 *
 * `sensei` is inside the dojo and is chased by the S7/S8 nag ladder; the other
 * three are outside it and are what the S9 digest lists.
 */
export type BlockedOn = 'sensei' | 'human' | 'external' | 'time'

export type Task = {
  id: string
  title: string
  description: string
  status: TaskStatus
  queue: string
  playbook?: string
  agent?: string
  createdAt: string // ISO 8601
  updatedAt: string
  /** Set while `waiting`. Absent — never defaulted — when the task is not
   *  parked: a default would put every active task on the sensei's nag list. */
  blockedOn?: BlockedOn
  blockedNote?: string
  /** When the CURRENT holder took it. S9's per-item age measures from here, not
   *  from creation: measured from creation a just-escalated task reads as
   *  ancient, and never reset a ping-ponged one reads as fresh forever. */
  blockedSince?: string
  /** H3 (ruled 2026-08-11): a time-parked task carries its resume date, set at
   *  park time — "the date is the wake, a trigger is optional precision." The
   *  digest excludes the task until this instant and includes it from then on.
   *  A time-park WITHOUT a date has no wake and is therefore visible
   *  immediately: never-silently-vanishes outranks the spam concern. Cleared
   *  on unpark with the rest of the park fields. */
  resumeAt?: string
}

export type Board = {
  tasks: Task[]
}

// ── Valid transitions ──────────────────────────────────────────────

const transitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ['assigned', 'in-progress', 'cancelled'],
  assigned: ['in-progress', 'cancelled'],
  'in-progress': ['waiting', 'done', 'cancelled'],
  waiting: ['in-progress', 'done', 'cancelled'],
  done: [],
  cancelled: [],
}

/** Map legacy state names from old snapshots/events to current names. */
export function migrateStatus(status: string): TaskStatus {
  const legacy: Record<string, TaskStatus> = {
    inbox: 'todo',
    active: 'in-progress',
    blocked: 'waiting',
    review: 'waiting',
  }
  return legacy[status] ?? (status as TaskStatus)
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to)
}

/**
 * May THIS ACTOR drive this transition? (013 S7; 042 DEVIATION-4.)
 *
 * Distinct from `canTransition`, which answers whether the DAG allows the move
 * at all. BOTH must pass, and the distinction is the point: `in-progress →
 * done` is legal in the DAG for everyone, and it is the ACTOR that makes it
 * refusable.
 *
 * Canon, verbatim: "Worker's only permitted transition: `in-progress → waiting`
 * with `blockedOn` … workers still cannot close tasks." Literally only — task
 * state is the sensei's job, which is also what the worker skill already tells
 * workers.
 *
 * 042 found this half unowned: `PATCH /tasks/:id/status` checked the DAG and
 * RECORDED `actor` WITHOUT EVER CHECKING IT, so any caller could close any
 * task. A requirement that ships as a field nobody enforces is how "workers
 * still cannot close tasks" becomes a comment.
 */
export function canActorTransition(actorRole: string, from: TaskStatus, to: TaskStatus): boolean {
  if (actorRole !== 'worker') return true
  return from === 'in-progress' && to === 'waiting'
}
