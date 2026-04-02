/**
 * Wire protocol between channel plugins and infrastructure service.
 *
 * All messages are JSON over WebSocket.
 */

// ── Channel plugin → Infrastructure ───────────────────────────────

/** Plugin identifies itself on connect */
export type RegisterMsg = {
  type: 'register'
  agent: string  // agent name, e.g. "scratch", "orchestrator"
}

/** Agent sends a reply (via the `reply` tool in the channel plugin) */
export type ReplyMsg = {
  type: 'reply'
  from: string
  text: string
}

// ── Infrastructure → Channel plugin ───────────────────────────────

/** Push a message into the agent's Claude session */
export type DeliverMsg = {
  type: 'deliver'
  from: string
  text: string
  taskId?: string
}

/** Ack registration */
export type RegisteredMsg = {
  type: 'registered'
  agent: string
}

// ── Infrastructure HTTP endpoints ─────────────────────────────────

/** POST /send — external process pushes a message to an agent */
export type SendRequest = {
  to: string
  from: string
  text: string
  taskId?: string
}

/** POST /agent-idle — stop hook notification */
export type AgentIdleRequest = {
  agent: string
}

// ── Union types ───────────────────────────────────────────────────

export type InboundMsg = RegisterMsg | ReplyMsg
export type OutboundMsg = DeliverMsg | RegisteredMsg
