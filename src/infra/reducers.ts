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

/** Revert the task to a previous status (stack-pop semantics). Bypasses canTransition; the DAG is only for forward progress. */
export type TaskRevertedData = {
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

/** Substantive comment on a task. Distinct from reply — curated, deliberate, surfaced via ?include=comments. Emitted by workers or by the sensei. */
export type TaskCommentData = {
  agent: string
  role: AgentRole
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
  /** Absolute local file paths delivered alongside the text (media surfaces). */
  attachments?: string[]
  /** Present when the sender is a registered peer (another dojo's sensei).
   *  Recorded so sensei's skill can frame the message appropriately. */
  senderRole?: Extract<AgentRole, 'peer'>
  /** Peer description looked up from the receiver's own peers.json at the
   *  time the event was recorded. Stable — not sent by the peer, can't be
   *  rewritten per-message. */
  peerDescription?: string
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

/**
 * `kind` distinguishes routing:
 *   'agent'    — deliver the prompt to a registered agent (sensei, worker, …).
 *                `agent` is the agent name. Default for backwards compatibility.
 *   'headless' — spawn a one-shot Claude process under the given role's
 *                permissions/skills. `agent` is the role name (e.g. 'librarian').
 *                Used by the consolidate-wiki trigger; see docs/llm-wiki-design.md.
 */
export type TriggerKind = 'agent' | 'headless'

export type TriggerCreatedData = {
  id: string
  cron?: string
  at?: string
  agent: string
  prompt: string
  actor: string
  /** Default 'agent' when omitted — preserves existing event log semantics. */
  kind?: TriggerKind
  /**
   * Model for headless triggers. Accepts 'sonnet'/'opus'/'haiku' or a full
   * model ID. Only valid when kind='headless'; agent triggers ignore this
   * because the agent is already a running session with a fixed model.
   */
  model?: string
  /**
   * Retry budget for headless triggers. Default 0 (single attempt).
   * On probe-fail, timeout, or non-zero exit, retry up to N more times with
   * a fixed 60-sec backoff between attempts. Each attempt records its own
   * `headless-completed` event with `attempt: N` so failed retries stay
   * auditable. Only meaningful for kind='headless'; agent triggers ignore it.
   */
  retries?: number
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
  kind?: TriggerKind
}

/**
 * Recorded after a headless trigger run completes (success, failure, or
 * timeout). Distinct from any domain events the spawned process itself
 * emitted (e.g. wiki-consolidated). Always recorded so the run is auditable
 * even if the spawn never wrote any of its own events.
 */
export type HeadlessCompletedData = {
  triggerId: string
  role: AgentRole
  exitCode: number
  durationMs: number
  timedOut: boolean
  /** Truncated tail of stderr when exitCode !== 0 (for debugging). */
  stderrTail?: string
  /**
   * Claude Code session UUID — locate the conversation JSONL at
   * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
   */
  sessionId?: string
  /** USD cost reported by Claude Code, when available. */
  costUsd?: number
  /** Total tokens (input + output + cached) when available. */
  totalTokens?: number
  /** Model that actually answered (post-fallback if any). */
  model?: string
  /**
   * 1-indexed attempt number for retry-enabled headless triggers. Omitted
   * when the trigger has no retry budget (single-attempt run). When present,
   * each retry emits its own headless-completed event so the timeline of a
   * retried run is fully auditable.
   */
  attempt?: number
  /**
   * Pre-flight probe outcome when retries are enabled. `latencyMs` is the
   * observed round-trip for a tiny haiku call; high latency or absence
   * (probe failed) is the signal that the network stack hasn't recovered
   * from sleep yet, which is the load-bearing failure mode this surface
   * was added to mitigate.
   */
  probeLatencyMs?: number
  /** True when the spawn was skipped because the pre-flight probe failed. */
  probeFailed?: boolean
  /**
   * When the run was launched in stream-json mode with a tee, this is the
   * dojo-relative path to the captured stdout JSONL. Even a kill mid-flight
   * leaves a partial trace at this path — the line-by-line tool calls show
   * which step stalled. Absent for single-shot JSON or text runs.
   */
  streamPath?: string
}

// ── Memory event data ───────────────────────────────────────────
//
// Emitted via POST /context/memorize. The librarian (a headless Claude
// spawned by the consolidate-wiki trigger) reads these in batches via
// the cursor and distills them into the wiki under .jean/context/.
// Memory events live in the dedicated MEMORY_STREAM so the librarian
// can read them with a single stream filter rather than scanning every
// event by type.
//
// `scope`:
//   'dojo' (default) — knowledge that's specific to this dojo
//   'user'           — facts about the user that should span dojos
//                      (consolidator may forward to ~/.jean/identity later)

export type MemoryScope = 'dojo' | 'user'

export type MemoryData = {
  agent: string
  role: AgentRole
  text: string
  scope: MemoryScope
  /** Task this memory was discovered in, if any. Helps the librarian trace
   *  attribution when distilling pages. */
  taskId?: string
}

// ── Wiki-consolidated event data ────────────────────────────────
//
// Emitted via POST /context/consolidated by the librarian at the end
// of a successful consolidation run. Captures what changed (page
// counts, tasks distilled, corrections applied) plus any anomalies
// the librarian wants surfaced to sensei. Sensei sees this in the
// pendingProjection and can surface non-empty anomalies to the human.

export type WikiConsolidatedData = {
  pagesCreated?: number
  pagesUpdated?: number
  corrections?: number
  tasksDistilled?: number
  eventsProcessed?: number
  rawFilesProcessed?: number
  /** Free-form messages the librarian wants sensei to look at: stale
   *  references, unclear contradictions, files it couldn't extract, etc. */
  anomalies?: string[]
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
export const MEMORY_STREAM = 'memory'

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

/** Replace one task in the board state, leaving others untouched. Returns the same Board reference if taskId not found. */
function updateTask(state: Board, taskId: string, update: (t: Task) => Task): Board {
  let changed = false
  const tasks = state.tasks.map((t) => {
    if (t.id !== taskId) return t
    changed = true
    return update(t)
  })
  return changed ? { tasks } : state
}

export const boardReducer: Reducer<Board> = (state, event) => {
  const taskId = taskIdFromStream(event.stream)
  switch (event.type) {
    case 'task-created': {
      const d = event.data as TaskCreatedData
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
      if (!taskId) return state
      const to = migrateStatus(d.to)
      return updateTask(state, taskId, (t) => {
        const updated = { ...t, status: to, updatedAt: event.ts }
        // When starting a task, ensure agent is set (default to queue)
        if (to === 'in-progress' && !updated.agent) updated.agent = t.queue
        return updated
      })
    }

    case 'task-reverted': {
      const d = event.data as TaskRevertedData
      if (!taskId) return state
      return updateTask(state, taskId, (t) => ({ ...t, status: migrateStatus(d.to), updatedAt: event.ts }))
    }

    case 'task-updated': {
      const d = event.data as TaskUpdatedData
      if (!taskId) return state
      return updateTask(state, taskId, (t) => ({
        ...t,
        ...(d.agent !== undefined && { agent: d.agent }),
        ...(d.description !== undefined && { description: d.description }),
        updatedAt: event.ts,
      }))
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
    case 'playbook-created':
    case 'playbook-updated':
    case 'playbook-removed':
      return [...state, event]

    case 'trigger-fired': {
      // Headless triggers (the librarian's consolidate-wiki run) are autonomous —
      // fireTrigger delivers NOTHING to the sensei for them; the run handles itself.
      // Their audit event must therefore NOT enter pending, or every scheduled firing
      // nudges the sensei ("Events pending" → it checks the board → "nothing
      // actionable"), pure noise. A non-headless trigger DOES deliver a prompt to an
      // agent, so the sensei should stay aware of it — keep it in pending.
      const d = event.data as TriggerFiredData
      if (d.kind === 'headless') return state
      return [...state, event]
    }

    case 'wiki-consolidated': {
      // The librarian trigger is addressed to the librarian, so its FIRING never
      // nudges the sensei (headless trigger-fired is dropped above). But a
      // consolidation that actually DID something — changed pages, distilled tasks,
      // applied corrections, or flagged anomalies — is worth the sensei knowing.
      // A no-op run (processed events but changed nothing) stays silent.
      const d = event.data as WikiConsolidatedData
      const didWork =
        (d.pagesCreated ?? 0) > 0 ||
        (d.pagesUpdated ?? 0) > 0 ||
        (d.corrections ?? 0) > 0 ||
        (d.tasksDistilled ?? 0) > 0 ||
        (d.anomalies?.length ?? 0) > 0
      return didWork ? [...state, event] : state
    }

    case 'task-comment': {
      const d = event.data as TaskCommentData
      // Sensei-authored comments don't self-nudge; worker comments do.
      if (d.role === 'sensei') return state
      return [...state, event]
    }

    case 'register': {
      // Sensei's own registration doesn't self-nudge (also redundant with the connect-time welcome message).
      const d = event.data as RegisterData
      if (d.role === 'sensei') return state
      return [...state, event]
    }

    case 'disconnect':
      // Always notify on disconnect — if the disconnecting agent IS the sensei, findSensei() returns undefined
      // and the nudge is a no-op; when the sensei reconnects it sees the disconnect in pending.
      return [...state, event]

    // agent-idle deliberately NOT in pending: idle is diagnostic only. Workers signal meaningful
    // progress via reply/task-comment — those wake the sensei. Stop-hook firings don't.

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
  /** 'agent' = route to registered agent; 'headless' = spawn one-shot Claude under role. */
  kind: TriggerKind
  /** Only meaningful when kind='headless'. Undefined = use Claude Code default. */
  model?: string
  /** Retry budget for kind='headless'. Default 0 = single attempt. See TriggerCreatedData.retries. */
  retries?: number
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
        // Default 'agent' for legacy events that pre-date the kind field.
        kind: d.kind ?? 'agent',
        ...(d.model && { model: d.model }),
        ...(d.retries !== undefined && d.retries > 0 && { retries: d.retries }),
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
