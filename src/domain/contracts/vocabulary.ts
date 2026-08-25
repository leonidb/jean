/**
 * The dojo's vocabulary — event kinds, their data shapes, streams, roles,
 * identities. Names, no logic (design §3).
 *
 * ── THE LOG IS THE ONE THING CARRIED (design §9) ──
 *
 * Every dojo's state IS its event log, so this file must fold the event
 * shapes real logs already hold. Each data type below is derived from its
 * WRITER — the `record(...)`/`emit(...)` sites of the system that produced
 * those logs — never from an observed sample (design §6's derive-from-the-
 * writer rule). Kinds and fields the current system no longer writes are
 * kept and marked historical: a reader that chokes on a shape it used to
 * write is a migration nobody asked for.
 *
 * ── IDENTITY (design §3, corrected 2026-08-18) ──
 *
 * `name` is THE identity: set at launch, carried on events, what every
 * lookup keys on. `role` is a shared CATEGORY, not an identity — two workers
 * both have role 'worker', and nothing may assume one agent per role.
 * Protocol-level since 2026-08-18: ruled into `docs/guarantees.md` §1.
 *
 * What this file cannot enforce, and what does: nothing here checks that an
 * event's data matches its kind — the store is untyped. The resolution
 * conformance suite and each module's own suite are the enforcement; this
 * file is the shared language they enforce in.
 */

import type { StoredEvent } from '../../es/index.ts'

// ── Identity and roles ───────────────────────────────────────────

/** THE identity. `builder`, `architect`, `sensei` — one per agent, unique in
 *  the roster. */
export type AgentName = string

/** A shared category — never an identity. Several agents may hold one role.
 *  'librarian' is the headless consolidation role; real logs carry it on
 *  `headless-completed` and `memory` events (data compatibility). */
export type AgentRole = 'sensei' | 'worker' | 'user' | 'peer' | 'librarian'

// ── Streams ──────────────────────────────────────────────────────

export const SYSTEM_STREAM = 'system'
export const TRIGGERS_STREAM = 'triggers'
export const PLAYBOOKS_STREAM = 'playbooks'
export const MEMORY_STREAM = 'memory'

/** ── THE RECORDING RULE for agent speech (RULED at task 116, from the
 *  2026-08-20 stream audit) ── An untagged `reply` records to the AGENT'S
 *  OWN stream, period. The old inference — file it onto whichever task the
 *  agent happens to hold — is REMOVED, not replaced: the audit showed it
 *  was 100% guesswork (workers never tag), and the guesses were wrong at
 *  scale (a parked task accumulated fifteen unrelated status reports; a
 *  spec task's record ran half probe-chatter). An EXPLICIT `taskId` on a
 *  reply stays honored — deliberate task-scoping is the caller's to
 *  claim, never inferred. `comment` is the durable task-writing verb; no
 *  task in the audited log relied on replies for its record. Bridge
 *  inbound (human speech) NEVER task-files — humans never mean a task
 *  implicitly. Delivery is UNTOUCHED either way: `reply` resolves to the
 *  orchestrator by kind, stream-independent (pinned in resolution's
 *  conformance). */
export function taskStream(taskId: string): string {
  return `task-${taskId}`
}
export function agentStream(agent: AgentName): string {
  return `agent-${agent}`
}
export function taskIdFromStream(stream: string): string | undefined {
  return stream.startsWith('task-') ? stream.slice(5) : undefined
}
export function agentFromStream(stream: string): AgentName | undefined {
  return stream.startsWith('agent-') ? stream.slice(6) : undefined
}

// ── Task vocabulary ──────────────────────────────────────────────

export type TaskStatus = 'todo' | 'assigned' | 'in-progress' | 'waiting' | 'done' | 'cancelled'

/** WHO a parked task waits on. Required on entry to `waiting` — a task cannot
 *  be parked on nobody (ruled 2026-08-14). */
export type BlockedOn = 'sensei' | 'human' | 'external'

// ── Delivery evidence vocabulary ─────────────────────────────────

/**
 * How an event reached its agent. Records what infra HANDED OVER, not what
 * the agent demonstrably read. 'heartbeat' is historical only (its writer,
 * the stall watchdog, is deleted) — it stays because logs contain it.
 */
export type DeliveredVia = 'wake' | 'piggyback' | 'heartbeat' | 'fetch'

/** What removed an event from pending. 'auto-clear' is historical only —
 *  logs contain it; nothing writes it. */
export type ClearedBy = 'ack' | 'auto-clear'

// ── Event data shapes, by kind ───────────────────────────────────
// Derived from the writers. Optional fields are optional because real logs
// hold events without them — not as API looseness.

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
  actorRole?: string
  blockedOn?: BlockedOn
  blockedNote?: string
  /** The snooze — demotes the blocker's reminder to a daily cadence until the
   *  date passes. Absent means none was chosen for THIS transition. */
  resumeAt?: string
}

/** The explicit blocker-handoff event — LIVE, not historical (census
 *  corrected at task 117's round: the rewrite's handoff surface writes it
 *  via `decideHandoff`, per the contract's own restoration note — the old
 *  system shipped only the fold half, and this kind spent months as a
 *  fold with no writer). `task-status` carrying `blockedOn` is the other,
 *  more common path: a park chooses its blocker; a handoff MOVES it. */
export type TaskBlockedData = {
  blockedOn: BlockedOn
  note?: string
  actor?: string
  resumeAt?: string
}

/** Stack-pop revert; bypasses the forward DAG deliberately. */
export type TaskRevertedData = {
  from: TaskStatus
  to: TaskStatus
  actor?: string
}

export type TaskUpdatedData = {
  agent?: AgentName
  description?: string
  actor?: string
}

export type TaskCommentData = {
  agent: AgentName
  role: AgentRole
  text: string
}

/** ── The subscriber pair (A-SUB, ruled 2026-08-18) ── a subscription is a
 *  ROUTING RULE recorded as data: it maps the task's events into the
 *  subscriber's one usual mailbox. Both kinds are HISTORY (resolve to
 *  nobody). `actor` records who caused it — `infra` at the two automatic
 *  moments (creation, reassignment), an agent name for explicit acts. The
 *  taskId is the stream's. */
export type TaskSubscribedData = {
  /** The subscriber — always a mailbox-holder (roster agent). */
  agent: AgentName
  actor: string
}

export type TaskUnsubscribedData = {
  agent: AgentName
  actor: string
}

export type ReplyData = {
  agent: AgentName
  text: string
  /** When the human actually sent it (epoch ms) — bridge bursts otherwise
   *  collapse onto one record-time. */
  sentAt?: number
  /** Source surface's own monotonic id, so sequence survives delivery. */
  sourceId?: string
}

export type SendData = {
  /** The addressee. */
  agent: AgentName
  from: AgentName | 'infra' | 'api'
  text: string
  /** Synchronous adapter handover happened (peers/bridge/triggers). Absent on
   *  queued sends. */
  delivered?: boolean
  /** THE ADMISSION FLAG: the write site decides, the fold applies. Its absence
   *  keeps every historical send out of pending on replay. */
  queued?: true
  attachments?: string[]
  senderRole?: Extract<AgentRole, 'peer'>
  peerDescription?: string
}

export type AgentIdleData = {
  agent: AgentName
  role: AgentRole | 'unknown'
  /** Stale-session diagnostics, written when a stop hook posts for a session
   *  that is no longer current. */
  stale?: boolean
  hookSessionId?: string
  currentSessionId?: string
  disconnected?: boolean
}

export type RegisterData = {
  agent: AgentName
  role: AgentRole
  idle: boolean
  sessionId?: string
}

export type DisconnectData = {
  agent: AgentName
}

export type AckData = {
  eventIds: number[]
  /** Historical: infra-generated auto-clear-on-reply. */
  auto?: 'reply'
  /** Delivery ledger keyed by acked event id. THE READING RULE: one event can
   *  have several acks; the FIRST in log order carries the delivery mark. */
  ledger?: Record<string, { deliveredVia?: DeliveredVia; clearedBy: ClearedBy }>
  /** ── The attributed form (A2 amendment, additive) ── the rewrite's writer
   *  fills these three alongside `eventIds`, so an old fold reads a new
   *  record correctly during a fallback window while the new fold clears
   *  per-pair (spec §2, P6). THE THREE TRAVEL TOGETHER — `caller` present
   *  implies `pairs` and `cleared` present (optional independently only
   *  because TS cannot say all-or-none additively; the conformance suite
   *  holds it). A record with no `caller` is historical: it clears every
   *  pair of `eventIds` on replay — refusing that would resurrect months of
   *  cleared mail. The fold replays `caller`+`cleared`, never `pairs`
   *  (which is verbatim audit data including misses). */
  caller?: AgentName
  pairs?: { id: number; code: string }[]
  cleared?: { eventId: number; deliveredVia?: DeliveredVia }[]
}

export type NudgeData = {
  pendingCount: number
  /** @deprecated historical — pre-transition watchdog. */
  forced?: boolean
  /** @deprecated historical — pre-transition blocking path. */
  blocking?: boolean
}

export type StartData = {
  port: number
}

export type PermissionRequestData = {
  agent: AgentName
  tool: string
  input: Record<string, unknown>
}

/** The parked-task nag. `agent` is deliberately absent from this shape — the
 *  addressee lives in `to`, because data.agent reads as the SPEAKER. */
export type TaskReminderData = {
  taskId: string
  to: AgentName | string
  text: string
  /** Admission flag; absent on pre-050 bookkeeping events. */
  queued?: true
}

export type GreetData = {
  /** THE RECIPIENT, named in the record. A greet is ordinary mail (task
   *  133), so the event must say who it is for — the same reason
   *  `agent-probe` names its subject: a record that cannot say what it was
   *  about leaves the class diagnosable only at a watched terminal. */
  agent: AgentName
  /** Queued like any other mail; never a direct push. */
  queued?: boolean
}

export type AgentProbeData = {
  agent: AgentName
  quietMinutes: number
  text: string
  /** WHICH QUESTION (task 132). The two probes are different asks — mid-work
   *  silence, and nothing-held silence — and a recipient that cannot tell
   *  them apart cannot answer either. Optional in the type because the log is
   *  permanent: every probe written before 2026-08-25 lacks it, and a reader
   *  must not have to pretend otherwise. New records always carry it. */
  probeKind?: 'stuck' | 'idle'
  /** The in-progress claims a STUCK probe is about; absent on an idle one,
   *  which has none by construction. Same reason as `nudge`'s recipient
   *  (task 127, law d): a record that cannot say what it was about leaves
   *  the class diagnosable only at a watched terminal. */
  taskIds?: readonly string[]
  queued?: true
}

export type AgentDownData = {
  subject: AgentName
  to?: AgentName
  quietMinutes: number
  text: string
  queued?: true
}

export type WorkerStatusData = {
  agent: AgentName
  status: 'down' | 'up-but-stuck' | 'recovered'
  text: string
  queued?: true
}

export type TriggerKind = 'agent' | 'headless'

export type TriggerCreatedData = {
  id: string
  cron?: string
  at?: string
  agent: string
  prompt: string
  actor: string
  kind?: TriggerKind
  model?: string
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

export type HeadlessCompletedData = {
  triggerId: string
  role: AgentRole
  exitCode: number
  durationMs: number
  timedOut: boolean
  stderrTail?: string
  sessionId?: string
  costUsd?: number
  totalTokens?: number
  model?: string
  attempt?: number
  probeLatencyMs?: number
  probeFailed?: boolean
  streamPath?: string
}

export type MemoryScope = 'dojo' | 'user'

export type MemoryData = {
  agent: AgentName
  role: AgentRole
  text: string
  scope: MemoryScope
  taskId?: string
}

export type WikiConsolidatedData = {
  pagesCreated?: number
  pagesUpdated?: number
  corrections?: number
  tasksDistilled?: number
  eventsProcessed?: number
  rawFilesProcessed?: number
  anomalies?: string[]
  /** THE ADMISSION FLAG (task 119 — the kind became MAIL mid-history):
   *  the consolidation summary routes to the orchestrator, whose skill
   *  surfaces `anomalies` to the human. Absent on every historical record
   *  (bookkeeping era) so replay resurrects nothing. */
  queued?: true
}

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

// ── The kind census ──────────────────────────────────────────────

/**
 * Every kind a real dojo log holds, mapped to its data shape. This is the
 * closed census as of the rewrite (main, at the rewrite decision of 2026-08-18); a NEW kind enters here
 * only together with its resolution declaration (spec §4: "a new kind must
 * declare its resolution before it can be emitted").
 */
export type KindDataMap = {
  'task-created': TaskCreatedData
  'task-status': TaskStatusData
  'task-blocked': TaskBlockedData
  'task-reverted': TaskRevertedData
  'task-updated': TaskUpdatedData
  'task-comment': TaskCommentData
  'task-subscribed': TaskSubscribedData
  'task-unsubscribed': TaskUnsubscribedData
  'task-reminder': TaskReminderData
  reply: ReplyData
  send: SendData
  register: RegisterData
  disconnect: DisconnectData
  'agent-idle': AgentIdleData
  'agent-probe': AgentProbeData
  greet: GreetData
  'agent-down': AgentDownData
  'worker-status': WorkerStatusData
  ack: AckData
  nudge: NudgeData
  start: StartData
  'permission-request': PermissionRequestData
  'trigger-created': TriggerCreatedData
  'trigger-updated': TriggerUpdatedData
  'trigger-removed': TriggerRemovedData
  'trigger-fired': TriggerFiredData
  'headless-completed': HeadlessCompletedData
  memory: MemoryData
  'wiki-consolidated': WikiConsolidatedData
  'playbook-created': PlaybookCreatedData
  'playbook-updated': PlaybookUpdatedData
  'playbook-removed': PlaybookRemovedData
}

export type KnownKind = keyof KindDataMap

/** The envelope is the store's (`es/`): { id, ts, type, stream, data }. The
 *  domain speaks StoredEvent; the store engine behind it is infrastructure. */
export type { StoredEvent }
