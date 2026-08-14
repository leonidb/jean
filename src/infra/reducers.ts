/**
 * Jean domain reducers — pure functions that derive state from events.
 *
 * boardReducer: events → Board (task state)
 * pendingReducer: events → pending actionable events for sensei
 */

import type { Reducer, StoredEvent } from '../es/index.ts'
import type { BlockedOn, Board, Task, TaskStatus } from './board.ts'
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
  /** The role the transition was driven AS. Checked against `canActorTransition`
   *  at the API boundary (013 S7); recorded so a replay can audit who closed
   *  what. */
  actorRole?: string
  /** WHO the task waits on. Required on entry to `waiting`. See Task.blockedOn. */
  blockedOn?: BlockedOn
  blockedNote?: string
  /** The snooze — valid with any blocker, demoting its reminder to a daily
   *  cadence until the date passes. See Task.resumeAt. */
  resumeAt?: string
}

/**
 * The explicit act of moving a task's blocker (013 S8's handoff).
 *
 * ITS OWN EVENT, per the explicit-acts principle (task 041's first amendment,
 * Leonid): escalating to the human is an act, not a side effect riding on
 * something else's back. Infra accepts ANY reassignment — the no-return rule
 * left the infra contract in the S8 amendment, because infra cannot see whether
 * new information arrived (that conversation happens inside the sensei's
 * session). There is deliberately no cycle guard; building one would be the
 * deviation, and it would silently refuse a legitimate re-escalation.
 */
export type TaskBlockedData = {
  blockedOn: BlockedOn
  note?: string
  actor?: string
  /** The snooze this handoff chooses. Like every park field, absent means none
   *  was chosen for THIS park — never "keep the old one". */
  resumeAt?: string
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
  /** When the HUMAN actually sent it (epoch ms) — distinct from the event's own
   *  record-time. A burst arriving in one poll batch would otherwise collapse
   *  onto a single record-time and lose its order. */
  sentAt?: number
  /** The source surface's own monotonic id (e.g. Telegram message_id), so
   *  sequence survives delivery. */
  sourceId?: string
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

/**
 * The S7/S8 waiting-task nag (task 050, ruled 2026-08-11: supervision rides
 * the mailbox). Emitted by the supervisor onto the SYSTEM stream — never the
 * task's own stream, which would make `resolveAgent` inherit the task's WORKER
 * and deliver the nag to the one party S7's inversion exists to spare.
 *
 * `agent` is deliberately ABSENT from this shape (the five-meanings trap,
 * mailbox-rules.ts): the addressee lives in `to`, because `senderOf` reads
 * `data.agent` as the SPEAKER — a nag about a human-parked task carrying its
 * bridge addressee there would price as "a human is waiting" (priority
 * EXTERNAL) when the human is the one being waited ON.
 */
export type TaskReminderData = {
  taskId: string
  /** The holder being nagged — a dojo agent (mailbox delivery) or the bridge
   *  surface (direct push; the event stays the report of record). */
  to: string
  text: string
  /** THE ADMISSION FLAG (the queued-send precedent): the write site decides,
   *  the fold applies. Absent on the pre-050 bookkeeping events every dojo's
   *  log already holds — admitting those on replay would resurrect months of
   *  long-stale nags into the sensei's mailbox at the first restart. */
  queued?: true
}

export type SendData = {
  agent: string
  from: string
  text: string
  /** Whether an adapter handed the message over synchronously (peers, the
   *  bridge, triggers). ABSENT on queued sends — delivery is not knowable at
   *  record time there; the delivery ledger is the truth. */
  delivered?: boolean
  /** THE ADMISSION FLAG (delivery unification, ruled 2026-08-11). Written by
   *  `routeSend` when the target is a dojo agent; the pending reducer admits a
   *  send IFF this is true — the write site decides, the fold applies (the
   *  applyAck pattern). Its absence is what keeps every historical send out of
   *  pending on replay. */
  queued?: true
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

/**
 * How an event reached its agent (attention phase 4 delivery ledger).
 *
 * PRECISION, deliberately stated (dual review, 2026-07-25): these record what
 * infra HANDED OVER, not what the agent demonstrably read.
 *   'wake'      — a push the transport accepted (a dead socket stamps nothing).
 *   'heartbeat' — the same, from the stall watchdog. HISTORICAL ONLY: the
 *                 watchdog was deleted at the transition, so nothing writes
 *                 this any more. It stays in the union because every dojo's log
 *                 already contains it and a reader must still understand it.
 *   'piggyback' — the inbox line was ATTACHED to a response infra returned to
 *                 the agent. Attach-level only: infra cannot see the client
 *                 read it, and an aborted/dropped response still counts here.
 *   'fetch'     — the agent ASKED for the payload and infra returned it. Added
 *                 at the transition, and it is the strongest of the four: under
 *                 S5 the fetch is the only way to obtain an ack code, so this
 *                 is the one path where infra knows the agent went looking.
 *                 Still attach-level — the response could be dropped in flight.
 *                 STAMPED ONLY ON AN ADDRESSED READ (`GET /events?for=` or the
 *                 caller header). An unaddressed read is an OBSERVER — `jean
 *                 status`, a dashboard, a test — and recording it as a delivery
 *                 would put a confident "delivered" against an event no agent
 *                 ever saw, which is the failure this whole field exists to
 *                 prevent. First-delivery-wins makes that worse, not better:
 *                 whichever observer looked first would become the recorded
 *                 carrier and overwrite the real answer.
 * Confirmed-read is not observable before the phase-5 mailbox model; treat
 * these as "best evidence of delivery", not proof of receipt.
 */
export type DeliveredVia = 'wake' | 'piggyback' | 'heartbeat' | 'fetch'

/**
 * What removed an event from pending.
 *
 * 'ack' is the only one anything writes now: S5 makes explicit `{id, code}`
 * pairs THE clearing path, because auto-clear-on-reply decided on the sensei's
 * behalf that answering a human meant their question was handled — the exact
 * judgement read-before-ack exists to keep with the agent.
 *
 * 'auto-clear' stays in the union as HISTORICAL ONLY, for the same reason
 * `heartbeat` does: every dojo's log already contains it.
 */
export type ClearedBy = 'ack' | 'auto-clear'

export type AckData = {
  eventIds: number[]
  /** Set when infra generated this ack itself — e.g. 'reply': the sensei
   *  answered a bridge user whose single pending blocking event is thereby
   *  handled (attention phase 3, docs/attention.md §5 auto-clear-on-reply).
   *  Absent on agent-initiated acks. */
  auto?: 'reply'
  /**
   * Delivery ledger (attention phase 4), keyed by acked event id: how the event
   * reached the agent and what cleared it. Two fields, deliberately — enough to
   * answer "did this event ever actually get delivered, and by which path" from
   * the event log alone, which previously took watchdog archaeology.
   * `deliveredVia` is absent when the delivery mark was lost (infra restarted
   * while the event sat pending) — unknown, not wrong.
   *
   * ── THE READING RULE: FIRST IN LOG ORDER WINS (task 041, ruled) ──
   *
   * ONE EVENT CAN HAVE SEVERAL ACKS. Fold-decides has every ack append
   * unconditionally — the pending reducer's filter is idempotent, so a duplicate
   * is a structural no-op rather than an error — and two agents racing to clear
   * the same id therefore write two `ack` events, on purpose.
   *
   * Only the FIRST carries the delivery mark. `takeFor` removes the entry as it
   * materializes it, so the second ack's ledger has `clearedBy` and no
   * `deliveredVia`.
   *
   * SO: TO ANSWER "how did event X reach anyone?", TAKE THE FIRST ACK IN LOG
   * ORDER THAT MENTIONS X — never the latest. A reader taking the latest reports
   * "delivery unknown" for an event that was demonstrably delivered, which is
   * the exact failure the ledger exists to prevent, arriving through the reading
   * direction instead of the writing one. `deliveredViaFor` (core/codes.ts)
   * implements this; `src/scenarios/ledger-rule.projection.test.ts` demonstrates
   * both directions, including the wrong answer the naive reader gets.
   */
  ledger?: Record<string, { deliveredVia?: DeliveredVia; clearedBy: ClearedBy }>
}

export type RegisterData = {
  agent: string
  role: AgentRole
  idle: boolean
  sessionId?: string
}

/**
 * What a `nudge` event carries: the queue AS OF EMISSION, and nothing else.
 *
 * `forced` (the stall watchdog fired this, bypassing the idle gate) and
 * `blocking` (a human is waiting) are GONE. There is no watchdog and no idle
 * gate to bypass, and there is no second push path to distinguish: a human is
 * simply the highest-priority sender. `blocking` in particular had to go on its
 * own merits — priority is opaque to every agent-facing surface (013
 * VOCABULARY), and a boolean in the log saying "this one was the urgent kind" is
 * that leak in its most durable form.
 *
 * OPTIONAL ON BOTH, STILL, for the reading direction: every dojo's history
 * contains `nudge` events carrying them, and a reader that chokes on a shape it
 * used to write is a migration nobody asked for.
 */
export type NudgeData = {
  pendingCount: number
  /** @deprecated historical only — written by the pre-transition watchdog. */
  forced?: boolean
  /** @deprecated historical only — written by the pre-transition blocking path. */
  blocking?: boolean
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
        const updated: Task = { ...t, status: to, updatedAt: event.ts }
        // When starting a task, ensure agent is set (default to queue)
        if (to === 'in-progress' && !updated.agent) updated.agent = t.queue
        if (to === 'waiting') {
          // Parking. Absent fields stay absent rather than becoming undefined
          // keys — see Task.blockedOn.
          if (d.blockedOn) updated.blockedOn = d.blockedOn
          if (d.blockedNote) updated.blockedNote = d.blockedNote
          if (d.blockedOn) updated.blockedSince = event.ts
          // CLEAR-OR-REPLACE, unconditional (architect's F2): an absent date
          // on this park must not inherit one from any earlier park, whatever
          // path the task took here. The unpark branch below already clears —
          // this makes the invariant local instead of resting on it.
          updated.resumeAt = d.resumeAt
        } else {
          // LEAVING `waiting` CLEARS THE PARK. Sticky `blockedOn` would keep a
          // task that is actively moving on a reminder clock, generating
          // reminders for a blocker that no longer exists — and a sticky
          // `resumeAt` would demote its NEXT park to a daily cadence on a date
          // nobody chose for it.
          updated.blockedOn = undefined
          updated.blockedNote = undefined
          updated.blockedSince = undefined
          updated.resumeAt = undefined
        }
        return updated
      })
    }

    case 'task-blocked': {
      // S8's handoff. Replaces EVERY park field, not only the blocker: a note
      // left over from the previous blocker describes a question that has
      // already been answered — and a snooze left over from a previous park
      // would DEMOTE this one to a daily cadence until a date nobody chose for
      // it (architect's F2). Clear-or-replace, no third option.
      const d = event.data as TaskBlockedData
      if (!taskId) return state
      return updateTask(state, taskId, (t) => ({
        ...t,
        blockedOn: d.blockedOn,
        blockedNote: d.note,
        blockedSince: event.ts,
        resumeAt: d.resumeAt,
        updatedAt: event.ts,
      }))
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

    case 'send': {
      // QUEUED SENDS ONLY (delivery unification, ruled 2026-08-11). The write
      // site decides — `routeSend` marks a send `queued: true` when its target
      // is a dojo agent and no adapter delivered it — and this fold applies
      // that decision, exactly as the ack fold applies `applyAck`'s. The flag's
      // absence is what keeps every historical send (all of which were
      // adapter-delivered or dropped) out of pending on replay: admitting them
      // would resurrect months of long-answered traffic at the first restart.
      const d = event.data as SendData
      return d.queued === true ? [...state, event] : state
    }

    // H4's worker status-change events: the sensei's mailbox is how it receives
    // them. A subject-self event for mailbox purposes (mailbox-rules.ts
    // authorOf) — the subject has no use for its own status notice.
    case 'worker-status':
      return [...state, event]

    // S11's two halves, and they are addressed to DIFFERENT agents on purpose.
    //
    // `agent-probe` is a question FOR the silent agent: it carries `agent`, so
    // membership resolves to that agent and the notifier announces it — which
    // is the whole delivery mechanism, no special push.
    //
    // `agent-down` is a report ABOUT it, FOR the sensei. It deliberately does
    // NOT carry `agent` (the subject is in `subject`), because that field is
    // what membership resolves on: naming the subject there is exactly what
    // used to deliver the alarm to the accused, waking it and thereby clearing
    // the alarm it had just been accused by. With no `agent` it resolves to
    // nobody and only the sensei's universal mailbox claims it — including when
    // the subject IS the sensei, which is the case that must never orphan.
    //
    // Both are admitted IFF queued, the `send`/`task-reminder` precedent: the
    // write site decides and this fold applies the decision.
    case 'agent-probe':
    case 'agent-down': {
      const d = event.data as { queued?: unknown }
      return d.queued === true ? [...state, event] : state
    }

    // `agent-unresponsive` — S11's PREVIOUS shape, kept in the fold for replay
    // only. Every dojo's log holds these; a fold that stopped admitting them
    // would change what an old log means, and one that admitted them
    // unconditionally would resurrect months of answered alarms at the next
    // restart. Nothing emits this type any more.
    case 'agent-unresponsive':
      return [...state, event]

    case 'task-reminder': {
      // The third supervision arm joins the mailbox (task 050): the S7/S8 nag
      // is an addressed event, admitted IFF the write site queued it. The
      // unflagged shape is the pre-050 bookkeeping record of a push already
      // made — history, not a message (see TaskReminderData.queued).
      const d = event.data as TaskReminderData
      return d.queued === true ? [...state, event] : state
    }

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
