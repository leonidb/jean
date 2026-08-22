/**
 * Wire protocol between channel plugins and infrastructure service.
 *
 * All messages are JSON over WebSocket.
 */

// ── Channel plugin → Infrastructure ───────────────────────────────

/** Plugin identifies itself on connect. `peer` = another dojo's sensei,
 *  registered locally via `jean peer add`; it never holds a local WS. */
/** Single source of truth for valid agent roles. Iterating this is the only
 *  way to enumerate roles — don't hand-write the list elsewhere. */
export const AGENT_ROLES = ['worker', 'sensei', 'user', 'peer', 'librarian'] as const

export type AgentRole = (typeof AGENT_ROLES)[number]

export function isAgentRole(s: string): s is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(s)
}

export type RegisterMsg = {
  type: 'register'
  agent: string // agent name, e.g. "scratch", "sensei"
  role: AgentRole
  sessionId?: string
  tags?: string[]
}

/** Agent sends a reply (via the `reply` tool in the channel plugin). `taskId` flows through from the deliver being replied to. */
export type ReplyMsg = {
  type: 'reply'
  from: string
  text: string
  taskId?: string
}

/**
 * Agent comments substantively on a task (via the `comment` tool).
 * Distinct from `reply` — deliberate, curated, surfaced via ?include=comments.
 * `taskId` is required (unlike ReplyMsg, which falls back to the most recent deliver's taskId) —
 * comments are named acts, not conversational responses, so attribution must be explicit.
 */
export type TaskCommentMsg = {
  type: 'task-comment'
  from: string
  taskId: string
  text: string
}

/** Agent sends a message to another agent/channel (via the `send` tool). `from` is overridden to the connected agent. */
export type SendMsg = {
  type: 'send'
  from: string
  to: string
  text: string
  taskId?: string
  /** Absolute local file paths to deliver alongside the text. Surfaces that
   *  support media (Telegram) upload them; text-only surfaces ignore them. */
  attachments?: string[]
}

// ── Infrastructure → Channel plugin ───────────────────────────────

/** Push a message into the agent's Claude session */
export type DeliverMsg = {
  type: 'deliver'
  from: string
  text: string
  taskId?: string
  /** Absolute local file paths to deliver alongside the text (media surfaces
   *  upload them; the Claude-session transport ignores them). */
  attachments?: string[]
}

/** Ack registration */
export type RegisteredMsg = {
  type: 'registered'
  agent: string
  role: AgentRole
}

/** Fatal error — infra is closing this connection. Plugin should NOT reconnect.
 *  The `code` is machine-readable; `message` is human-readable. */
export type ErrorMsg = {
  type: 'error'
  code: 'duplicate-session'
  agent: string
  message: string
}

// ── Infrastructure HTTP endpoints ─────────────────────────────────

/** POST /send — external process pushes a message to an agent */
export type SendRequest = {
  to: string
  from: string
  text: string
  taskId?: string
  attachments?: string[]
}

// ── Task API types ───────────────────────────────────────────────

export type CreateTaskRequest = {
  title: string
  description: string
  queue: string
  playbook?: string
  actor?: string
}

export type UpdateTaskRequest = {
  agent?: string
  description?: string
  actor?: string
}

export type UpdateStatusRequest = {
  status: string
  actor?: string
  /** What the caller claims to be. Only ever used to APPLY a restriction, never
   *  to lift one: an unregistered caller cannot escape the worker rules by
   *  omitting this, and cannot acquire the sensei's powers by asserting them
   *  (see the actor gate in server.ts). */
  actorRole?: string
  /** WHO the task waits on. REQUIRED when parking (`→ waiting`) — 013 S7. */
  blockedOn?: 'sensei' | 'human' | 'external'
  blockedNote?: string
  /** ISO instant — the snooze. Valid alongside any blocker; it demotes the
   *  reminder to a daily cadence until it passes. See Task.resumeAt. */
  resumeAt?: string
}

// ── Union types ───────────────────────────────────────────────────

export type InboundMsg = RegisterMsg | ReplyMsg | TaskCommentMsg | SendMsg
export type OutboundMsg = DeliverMsg | RegisteredMsg | ErrorMsg
