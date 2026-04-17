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
