/**
 * Jean domain reducers — pure functions that derive state from events.
 *
 * boardReducer: events → Board (task state)
 * pendingReducer: events → pending actionable events for sensei
 */

import type { Reducer, StoredEvent } from '../es/index.ts'
import { canTransition, type Board, type Task, type TaskStatus } from './board.ts'

// ── Event data shapes ────────────────────────────────────────────

export type TaskCreatedData = {
  title: string
  description: string
  queue: string
  playbook?: string
}

export type TaskStatusData = {
  from: string
  to: string
}

export type TaskUpdatedData = {
  agent?: string
  description?: string
}

export type ReplyData = {
  text: string
}

export type AgentIdleData = {
  role: string
}

export type SendData = {
  from: string
  text: string
  delivered: boolean
}

export type AckData = {
  eventIds: number[]
}

export type RegisterData = {
  role: string
  idle: boolean
}

export type NudgeData = {
  pendingCount: number
}

export type StartData = {
  port: number
}

// ── Stream helpers ───────────────────────────────────────────────

export function taskStream(taskId: string): string { return `task-${taskId}` }
export function agentStream(agent: string): string { return `agent-${agent}` }
export const SYSTEM_STREAM = 'system'

export function taskIdFromStream(stream: string): string | undefined {
  return stream.startsWith('task-') ? stream.slice(5) : undefined
}

export function agentFromStream(stream: string): string | undefined {
  return stream.startsWith('agent-') ? stream.slice(6) : undefined
}

// ── Board reducer ────────────────────────────────────────────────

export const boardReducer: Reducer<Board> = (state, event) => {
  switch (event.type) {
    case 'task-created': {
      const d = event.data as TaskCreatedData
      const taskId = taskIdFromStream(event.stream)
      if (!taskId) return state
      const task: Task = {
        id: taskId,
        title: d.title,
        description: d.description,
        status: 'inbox',
        queue: d.queue,
        playbook: d.playbook,
        createdAt: event.ts,
        updatedAt: event.ts,
      }
      return { tasks: [...state.tasks, task] }
    }

    case 'task-status': {
      const d = event.data as TaskStatusData
      const taskId = taskIdFromStream(event.stream)
      if (!taskId) return state
      return {
        tasks: state.tasks.map(t =>
          t.id === taskId
            ? { ...t, status: d.to as TaskStatus, updatedAt: event.ts }
            : t,
        ),
      }
    }

    case 'task-updated': {
      const d = event.data as TaskUpdatedData
      const taskId = taskIdFromStream(event.stream)
      if (!taskId) return state
      return {
        tasks: state.tasks.map(t =>
          t.id === taskId
            ? {
                ...t,
                ...(d.agent !== undefined && { agent: d.agent }),
                ...(d.description !== undefined && { description: d.description }),
                updatedAt: event.ts,
              }
            : t,
        ),
      }
    }

    default:
      return state
  }
}

// ── Pending reducer ──────────────────────────────────────────────

export type PendingState = StoredEvent[]

export const pendingReducer: Reducer<PendingState> = (state, event) => {
  switch (event.type) {
    case 'reply':
    case 'task-created':
      return [...state, event]

    case 'agent-idle': {
      // Only worker idle is actionable — sensei idle is informational
      const d = event.data as AgentIdleData
      if (d.role === 'sensei') return state
      return [...state, event]
    }

    case 'ack': {
      const d = event.data as AckData
      const acked = new Set(d.eventIds)
      return state.filter(e => !acked.has(e.id))
    }

    default:
      return state
  }
}

// ── API event format ─────────────────────────────────────────────

export type ApiEvent = {
  id: number
  type: string
  ts: string
  taskId?: string
  agent?: string
  data: unknown
}

export function toApiEvent(event: StoredEvent): ApiEvent {
  const taskId = taskIdFromStream(event.stream)
  const agent = agentFromStream(event.stream)
    ?? (event.data as Record<string, unknown>)?.agent as string | undefined
  return {
    id: event.id,
    type: event.type,
    ts: event.ts,
    ...(taskId && { taskId }),
    ...(agent && { agent }),
    data: event.data,
  }
}
