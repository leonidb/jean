/**
 * Connector spine — the neutral wire plus the shapes above it.
 * See docs/connectors.md.
 *
 * A `Connector` is a generic, role-agnostic transport (receive + optionally
 * send). "Bridge" (bidirectional chat) and "Source" (read-only feed) are
 * product roles composed by an *adapter* one layer up — the connector itself
 * never knows which role it's serving.
 */

export const CONNECTOR_KINDS = ['telegram', 'gmail', 'slack', 'whatsapp'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

export const CONNECTOR_ROLES = ['bridge', 'source'] as const
export type ConnectorRole = (typeof CONNECTOR_ROLES)[number]

/**
 * A structured, kind-aware inbound item. A chat message fills the basics
 * (`id`/`from`/`text`); an email fills the rest; `raw` keeps the source-specific
 * payload so nothing is lost when a consumer needs more than the envelope.
 */
export type InboundItem = {
  /** Stable per-source id — email Message-ID, telegram update_id, slack ts.
   *  The dedupe key. */
  id: string
  kind: ConnectorKind
  /** Epoch ms. */
  at: number
  from: string
  /** Best-effort plain text: chat body, or the email's text part. */
  text: string
  /** Email thread / slack thread_ts. */
  threadId?: string
  subject?: string
  headers?: Record<string, string>
  /** Attachments already persisted via ConnectorContext.saveAttachment. */
  attachments?: { path: string; name: string; mime?: string }[]
  /** Escape hatch: the source-specific payload. */
  raw?: unknown
}

/** An outbound message a bidirectional connector can send. Mirrors the current
 *  bridge's outbound shape so the Telegram refactor (step 3) is a clean lift. */
export type OutboundMessage = { from: string; text: string; attachments?: string[] }

/** Persisted poll position for a connector (IMAP UID, slack ts, telegram
 *  offset), so a restart never replays or duplicates. */
export type CursorStore = {
  get(): string | undefined
  set(cursor: string): void
}

/** Infra services a connector uses while running. Role-neutral: it can emit
 *  inbound items, persist attachments, and track its cursor — nothing about
 *  bridges, agents, or queues leaks in here. */
export type ConnectorContext = {
  emit(item: InboundItem): void
  saveAttachment(data: Uint8Array, name: string): string
  cursor: CursorStore
}

/** The neutral wire. Knows its transport, nothing about roles. */
export type Connector = {
  kind: ConnectorKind
  /** Begin receiving; call `ctx.emit` per inbound item. Resolves once started. */
  start(ctx: ConnectorContext): Promise<void>
  /** Present ONLY when the transport's outbound side is configured. A read-only
   *  Source connector omits it. */
  send?(msg: OutboundMessage): Promise<boolean>
  connected(): boolean
}

/** A connector's parsed, per-instance config. `settings` is the kind-specific
 *  bag (imap creds, chatId, channels, …) — each connector validates its own. */
export type ConnectorConfig = {
  /** The config key — the instance name, e.g. "personal-mail". */
  instance: string
  kind: ConnectorKind
  role: ConnectorRole
  settings: Record<string, unknown>
}
