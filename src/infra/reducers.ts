/**
 * Jean domain reducers — pure functions that derive state from events.
 *
 * boardReducer: events → Board (task state)
 * pendingReducer: events → pending actionable events for sensei
 */

import type { Reducer, StoredEvent } from '../es/index.ts'
import type { Board, Task, TaskStatus } from './board.ts'
import { migrateStatus } from './board.ts'
import type { AgentRole } from './protocol.ts'

// ── Event data shapes ────────────────────────────────────────────
// Common: most events carry `agent` in data

export type TaskCreatedData = {
  title: string
  description: string
  queue: string
  playbook?: string
  actor?: string
}

export type TaskStatusData = {
  from: TaskStatus
  to: TaskStatus
  actor?: string
}

export type TaskUpdatedData = {
  agent?: string
  description?: string
  actor?: string
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
  actor: string
  metadata?: Record<string, unknown>
}

export type TriggerUpdatedData = {
  id: string
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

// ── Playbook event data ─────────────────────────────────────────

export type PlaybookCreatedData = {
  id: string
  content: string
  hash: string
}

export type PlaybookUpdatedData = {
  id: string
  content: string
  hash: string
  prevHash: string
}

export type PlaybookRemovedData = {
  id: string
  lastHash: string
}

// ── Stream helpers ───────────────────────────────────────────────

export function taskStream(taskId: string): string {
  return `task-${taskId}`
}
export function agentStream(agent: string): string {
  return `agent-${agent}`
}
export const SYSTEM_STREAM = 'system'
export const TRIGGERS_STREAM = 'triggers'
export const PLAYBOOKS_STREAM = 'playbooks'

export function taskIdFromStream(stream: string): string | undefined {
  return stream.startsWith('task-') ? stream.slice(5) : undefined
}

export function agentFromStream(stream: string): string | undefined {
  return stream.startsWith('agent-') ? stream.slice(6) : undefined
}

/** Extract agent name from a StoredEvent — checks data.agent, then stream prefix. */
export function agentFromEvent(event: StoredEvent): string | undefined {
  return ((event.data as Record<string, unknown>)?.agent as string | undefined) ?? agentFromStream(event.stream)
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
        status: 'todo',
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
      const to = migrateStatus(d.to)
      return {
        tasks: state.tasks.map((t) => {
          if (t.id !== taskId) return t
          const updated = { ...t, status: to, updatedAt: event.ts }
          // When starting a task, ensure agent is set (default to queue)
          if (to === 'in-progress' && !updated.agent) updated.agent = t.queue
          return updated
        }),
      }
    }

    case 'task-updated': {
      const d = event.data as TaskUpdatedData
      const taskId = taskIdFromStream(event.stream)
      if (!taskId) return state
      return {
        tasks: state.tasks.map((t) =>
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

/** Migrate board snapshot with legacy status names to current names. */
export function migrateBoard(board: Board): Board {
  let changed = false
  const tasks = board.tasks.map((t) => {
    const migrated = migrateStatus(t.status)
    if (migrated !== t.status) {
      changed = true
      return { ...t, status: migrated }
    }
    return t
  })
  return changed ? { tasks } : board
}

// ── Pending reducer ──────────────────────────────────────────────

export type PendingState = StoredEvent[]

export const pendingReducer: Reducer<PendingState> = (state, event) => {
  switch (event.type) {
    case 'reply':
    case 'task-created':
    case 'trigger-fired':
    case 'playbook-created':
    case 'playbook-updated':
    case 'playbook-removed':
      return [...state, event]

    case 'agent-idle': {
      const d = event.data as AgentIdleData
      if (d.role === 'sensei') return state
      return [...state, event]
    }

    case 'ack': {
      const d = event.data as AckData
      const acked = new Set(d.eventIds)
      return state.filter((e) => !acked.has(e.id))
    }

    default:
      return state
  }
}

// ── Trigger reducer ──────────────────────────────────────────────

type TriggerBase = {
  id: string
  agent: string
  prompt: string
  status: 'active' | 'fired' | 'disabled'
  actor: string
  createdAt: string
  lastFiredAt?: string
  metadata?: Record<string, unknown>
}

/** Exactly one of cron (recurring) or at (one-off). */
type TriggerSchedule = { cron: string; at?: undefined } | { cron?: undefined; at: string }

/** Discriminated union: a trigger has exactly one schedule kind. */
export type Trigger = TriggerBase & TriggerSchedule

export type TriggerState = { triggers: Trigger[] }

/** Extract the schedule half of a Trigger from raw event data, or null if neither is set. */
function scheduleFrom(d: { cron?: string; at?: string }): TriggerSchedule | null {
  if (d.cron) return { cron: d.cron }
  if (d.at) return { at: d.at }
  return null
}

export const triggerReducer: Reducer<TriggerState> = (state, event) => {
  switch (event.type) {
    case 'trigger-created': {
      const d = event.data as TriggerCreatedData
      // Invariant enforced at API boundary: exactly one of cron or at is set. Events that violate are dropped.
      const schedule = scheduleFrom(d)
      if (!schedule) return state
      const trigger: Trigger = {
        id: d.id,
        ...schedule,
        agent: d.agent,
        prompt: d.prompt,
        status: 'active',
        // TODO: remove createdBy fallback once legacy events are cleaned from all dojos
        actor: d.actor ?? ((d as Record<string, unknown>).createdBy as string | undefined) ?? 'unknown',
        createdAt: event.ts,
        metadata: d.metadata,
      }
      return { triggers: [...state.triggers, trigger] }
    }

    case 'trigger-updated': {
      const d = event.data as TriggerUpdatedData
      return {
        triggers: state.triggers.map((t) =>
          t.id === d.id
            ? {
                ...t,
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
      return { triggers: state.triggers.filter((t) => t.id !== d.id) }
    }

    case 'trigger-fired': {
      const d = event.data as TriggerFiredData
      return {
        triggers: state.triggers.map((t) => {
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

// ── Playbook reducer ────────────────────────────────────────────

export type Playbook = {
  id: string
  name: string
  description: string
  content: string
  hash: string
  createdAt: string
  updatedAt: string
}

export type PlaybookState = { playbooks: Playbook[] }

/** Parse YAML-ish frontmatter from markdown. Only extracts name and description. */
function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/)
  const fm = match?.[1]
  if (!fm) return { name: '', description: '' }
  const fmLines = fm.split('\n')
  const name = fm.match(/^name:\s*(.+)/m)?.[1]?.trim() ?? ''
  let description = ''
  const descLineIdx = fmLines.findIndex((l) => /^description:/.test(l))
  if (descLineIdx >= 0) {
    const afterColon = fmLines[descLineIdx]?.replace(/^description:\s*/, '')
    if (afterColon === '>' || afterColon === '') {
      const indented: string[] = []
      for (const l of fmLines.slice(descLineIdx + 1)) {
        if (/^\s+/.test(l)) indented.push(l.trim())
        else break
      }
      description = indented.filter(Boolean).join(' ')
    } else {
      description = afterColon ?? ''
    }
  }
  return { name, description }
}

export const playbookReducer: Reducer<PlaybookState> = (state, event) => {
  switch (event.type) {
    case 'playbook-created': {
      const d = event.data as PlaybookCreatedData
      const { name, description } = parseFrontmatter(d.content)
      const playbook: Playbook = {
        id: d.id,
        name: name || d.id,
        description,
        content: d.content,
        hash: d.hash,
        createdAt: event.ts,
        updatedAt: event.ts,
      }
      return { playbooks: [...state.playbooks, playbook] }
    }

    case 'playbook-updated': {
      const d = event.data as PlaybookUpdatedData
      const { name, description } = parseFrontmatter(d.content)
      return {
        playbooks: state.playbooks.map((p) =>
          p.id === d.id
            ? { ...p, name: name || d.id, description, content: d.content, hash: d.hash, updatedAt: event.ts }
            : p,
        ),
      }
    }

    case 'playbook-removed': {
      const d = event.data as PlaybookRemovedData
      return { playbooks: state.playbooks.filter((p) => p.id !== d.id) }
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
