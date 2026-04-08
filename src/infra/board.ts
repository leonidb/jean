/**
 * Board — task types and state transitions.
 *
 * Board state is derived from events via the boardReducer.
 * This module defines the types and transition rules.
 */

// ── Types ──────────────────────────────────────────────────────────

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
