/**
 * Jean domain reducers — pure functions that derive state from events.
 *
 * boardReducer: events → Board (task state)
 * pendingReducer: events → pending actionable events for sensei
 */

import type { Reducer, StoredEvent } from '../es/index.ts'
import type { Board, Task, TaskStatus } from './board.ts'
import type { AgentRole } from './protocol.ts'

// ── Event data shapes ────────────────────────────────────────────
// Common: most events carry `agent` in data

export type TaskCreatedData = {
  title: string
  description: string
  queue: string
  playbook?: string
}

export type TaskStatusData = {
  from: TaskStatus
  to: TaskStatus
}

export type TaskUpdatedData = {
  agent?: string
  description?: string
}

export type ReplyData = {
  agent: string
  text: string
}

export type AgentIdleData = {
  agent: string
  role: AgentRole
}

export type SendData = {
  agent: string
  from: string
  text: string
  delivered: boolean
}

export type AckData = {
  eventIds: number[]
}

export type RegisterData = {
  agent: string
  role: AgentRole
  idle: boolean
  sessionId?: string
}

export type NudgeData = {
  pendingCount: number
}

export type PermissionRequestData = {
  agent: string
  tool: string
  input: Record<string, unknown>
}

export type StartData = {
  port: number
}

export type TriggerCreatedData = {
  id: string
  cron?: string
  at?: string
  agent: string
  prompt: string
  createdBy: string
  metadata?: Record<string, unknown>
}

export type TriggerUpdatedData = {
  id: string
  cron?: string
  at?: string
  agent?: string
  prompt?: string
  status?: 'active' | 'disabled'
  metadata?: Record<string, unknown>
}

export type TriggerRemovedData = {
  id: string
}

export type TriggerFiredData = {
  triggerId: string
  agent: string
  prompt: string
}

// ── Stream helpers ───────────────────────────────────────────────

export function taskStream(taskId: string): string { return `task-${taskId}` }
export function agentStream(agent: string): string { return `agent-${agent}` }
export const SYSTEM_STREAM = 'system'
export const TRIGGERS_STREAM = 'triggers'

export function taskIdFromStream(stream: string): string | undefined {
  return stream.startsWith('task-') ? stream.slice(5) : undefined
}

export function agentFromStream(stream: string): string | undefined {
  return stream.startsWith('agent-') ? stream.slice(6) : undefined
}

/** Extract agent name from a StoredEvent — checks data.agent, then stream prefix. */
export function agentFromEvent(event: StoredEvent): string | undefined {
  return (event.data as Record<string, unknown>)?.agent as string | undefined
    ?? agentFromStream(event.stream)
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
        tasks: state.tasks.map(t => {
          if (t.id !== taskId) return t
          const updated = { ...t, status: d.to, updatedAt: event.ts }
          // When activating a task, ensure agent is set (default to queue)
          if (d.to === 'active' && !updated.agent) updated.agent = t.queue
          return updated
        }),
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
    case 'trigger-fired':
      return [...state, event]

    case 'agent-idle': {
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

// ── Trigger reducer ──────────────────────────────────────────────

export type Trigger = {
  id: string
  cron?: string
  at?: string
  agent: string
  prompt: string
  status: 'active' | 'fired' | 'disabled'
  createdBy: string
  createdAt: string
  lastFiredAt?: string
  metadata?: Record<string, unknown>
}

export type TriggerState = { triggers: Trigger[] }

export const triggerReducer: Reducer<TriggerState> = (state, event) => {
  switch (event.type) {
    case 'trigger-created': {
      const d = event.data as TriggerCreatedData
      const trigger: Trigger = {
        id: d.id,
        cron: d.cron,
        at: d.at,
        agent: d.agent,
        prompt: d.prompt,
        status: 'active',
        createdBy: d.createdBy,
        createdAt: event.ts,
        metadata: d.metadata,
      }
      return { triggers: [...state.triggers, trigger] }
    }

    case 'trigger-updated': {
      const d = event.data as TriggerUpdatedData
      return {
        triggers: state.triggers.map(t =>
          t.id === d.id
            ? {
                ...t,
                ...(d.cron !== undefined && { cron: d.cron }),
                ...(d.at !== undefined && { at: d.at }),
                ...(d.agent !== undefined && { agent: d.agent }),
                ...(d.prompt !== undefined && { prompt: d.prompt }),
                ...(d.status !== undefined && { status: d.status }),
                ...(d.metadata !== undefined && { metadata: d.metadata }),
              }
            : t,
        ),
      }
    }

    case 'trigger-removed': {
      const d = event.data as TriggerRemovedData
      return { triggers: state.triggers.filter(t => t.id !== d.id) }
    }

    case 'trigger-fired': {
      const d = event.data as TriggerFiredData
      return {
        triggers: state.triggers.map(t => {
          if (t.id !== d.triggerId) return t
          return {
            ...t,
            lastFiredAt: event.ts,
            ...(t.at && !t.cron ? { status: 'fired' as const } : {}),
          }
        }),
      }
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
  const agent = agentFromEvent(event)
  return {
    id: event.id,
    type: event.type,
    ts: event.ts,
    ...(taskId && { taskId }),
    ...(agent && { agent }),
    data: event.data,
  }
}
