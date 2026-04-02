/**
 * Board — task types and state transitions.
 *
 * Board state is derived from events via the boardReducer.
 * This module defines the types and transition rules.
 */

// ── Types ──────────────────────────────────────────────────────────

export type TaskStatus =
  | 'inbox'
  | 'active'
  | 'blocked'
  | 'review'
  | 'done'
  | 'cancelled'

export type Task = {
  id: string
  title: string
  description: string
  status: TaskStatus
  queue: string
  playbook?: string
  agent?: string
  createdAt: string  // ISO 8601
  updatedAt: string
}

export type Board = {
  tasks: Task[]
}

// ── Valid transitions ──────────────────────────────────────────────

const transitions: Record<TaskStatus, TaskStatus[]> = {
  inbox:     ['active', 'cancelled'],
  active:    ['blocked', 'review', 'done', 'cancelled'],
  blocked:   ['active', 'cancelled'],
  review:    ['done', 'active', 'cancelled'],
  done:      [],
  cancelled: [],
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to)
}
