/**
 * The resolution contract — who each event addresses (spec §1, §4).
 *
 * Every kind declares a resolution: recipients decided at creation, possibly
 * several, possibly none. An event with recipients is MAIL — each recipient
 * must read and clear it. An event resolving to nobody is HISTORY — a fact in
 * the log nobody must act on. History is not a second category; it is the
 * empty case of the one rule. **Mail is never addressed to its author** —
 * author exclusion is part of every kind's resolution, not a filter applied
 * afterwards (spec §1).
 *
 * The normative table is spec §4. In this contract's terms:
 *
 *   send (named agent)                        → data.agent
 *   reply from a worker                       → orchestrator
 *   reply from a human (user role)            → orchestrator
 *   task created / status / comment / etc.    → everyone involved with the
 *                                               task, minus the author —
 *                                               and "involved" is DEFINED as
 *                                               the task's SUBSCRIBERS
 *                                               (A-SUB, ruled 2026-08-18;
 *                                               authorial intent: §4's row
 *                                               was written meaning a
 *                                               participant set — this is
 *                                               the row's meaning getting
 *                                               its mechanism, not a new
 *                                               idea layered on)
 *   task-subscribed / task-unsubscribed       → nobody — history (routing-
 *                                               rule changes; the effect
 *                                               shows in future routing)
 *   task-reminder                             → orchestrator
 *   trigger-fired targeting X                 → X (agent triggers; headless
 *                                               runs spawn, nothing to mail)
 *   agent-probe (idle-liveness ping)          → the pinged worker
 *   greet (a self-directed seat connected     → data.agent — THE GREET IS
 *     to a quiet dojo; task 133)                ORDINARY MAIL. It is not a
 *                                               second push path: it enters
 *                                               its recipient's mailbox and
 *                                               is announced, repeated and
 *                                               cleared by the machinery
 *                                               that carries everything
 *                                               else. The old
 *                                               implementation was a raw
 *                                               `deliver` with no mailbox
 *                                               entry — the defect shape
 *                                               task 053 exists to catch.
 *   agent-down / worker-status                → orchestrator
 *   register (queued only) / disconnect       → orchestrator, MINUS THE
 *     (task 139; ruled: the two halves of       SUBJECT — an agent is never
 *     a pair resolve alike)                     told of its own arrival or
 *                                               its own departure. Both
 *                                               halves of the pair resolve
 *                                               alike. The exclusion is the
 *                                               row's, not `authorOf`'s:
 *                                               arriving is not acting
 *                                               (R15), nor is a socket
 *                                               closing, so neither record
 *                                               has an author and the
 *                                               author pass excludes no
 *                                               one; without the row's own
 *                                               minus, the orchestrator's
 *                                               register would be in its
 *                                               mailbox when the greet is
 *                                               minted, and no seat would
 *                                               ever be greeted again — and
 *                                               its own disconnect would be
 *                                               its next session's first
 *                                               ack (the noise task 050
 *                                               flagged; the greet now
 *                                               carries the "you restarted"
 *                                               fact). The subject test is
 *                                               by SEAT (subject ≠ the
 *                                               recorded orchestrator), not
 *                                               by role. The register half
 *                                               restores the old reducer,
 *                                               which the D1 transcription
 *                                               lost (spec §4 had no row
 *                                               for the kind). The two
 *                                               lines differ only in the
 *                                               admission flag, and that is
 *                                               replay mechanics, not
 *                                               semantics: register needs
 *                                               it because dozens of
 *                                               historical unflagged
 *                                               registers must not
 *                                               resurrect; disconnect was
 *                                               always mail — its historical
 *                                               pairs are cleared by the
 *                                               log's own acks, and a seat's
 *                                               unacked own-disconnects drop
 *                                               out on replay (pending only
 *                                               shrinks) — so it never grew
 *                                               one.
 *   wiki-consolidated                         → orchestrator (queued only —
 *                                               the skill surfaces its
 *                                               anomalies to the human;
 *                                               repinned at task 119)
 *   ack / nudge / agent-idle / memory /
 *     start / permission-request /
 *     trigger CRUD /
 *     playbook CRUD / headless-completed      → nobody — history
 *                                               (headless-completed
 *                                               deliberately: per-attempt
 *                                               forensics; the run's
 *                                               summary is
 *                                               wiki-consolidated)
 *
 * "Everyone involved" is a resolution, not an address: a task created
 * unassigned by the orchestrator resolves to nobody and is history (spec §4).
 * With no orchestrator in the context, kinds addressed to the orchestrator
 * resolve empty — never to a fallback (a mailbox nobody owns is the orphan
 * class P4 abolishes).
 *
 * THE ADMISSION FLAG (surfaced at A6's composition round, task 102): seven
 * kinds — `send`, `task-reminder`, `agent-probe`, `agent-down`,
 * `worker-status`, (since task 119) `wiki-consolidated`, and (since task
 * 139) `register` — became MAIL mid-history; their shapes carry
 * `queued?: true`, the vocabulary's admission flag ("the write site
 * decides, the fold applies"). WITHOUT the flag they resolve to NOBODY:
 * a bookkeeping-era record, a send handed over synchronously
 * (`delivered`), or a register written before 139 (every real log holds
 * dozens, all unacked), must not mint pairs on replay — the composed system's
 * first real-log replay would otherwise resurrect months of handled mail
 * as pending. Admission is part of the DECLARED RESOLUTION — the one
 * membership source — never a second check beside it (P2). Kinds that
 * were always mail (`reply`, the task family) carry no flag: their
 * historical pairs are cleared by the log's own ack records.
 *
 * What the type system cannot enforce here, and what does: that an
 * implementation's answers actually match the table, that author exclusion
 * holds for every kind, and that unknown kinds resolve empty rather than
 * throwing — all of that is held by `resolution.conformance.test.ts`, which
 * is the executable form of the table above.
 */

import type { AgentName, StoredEvent } from './vocabulary.ts'

/**
 * The facts resolution may consult — plain values from the persisted record
 * ("who is this"); nothing here answers "who is connected", because
 * resolution is decided at creation and must not depend on the live instant
 * (an offline recipient still receives mail — spec P3).
 *
 * `roleOf` was here and is REMOVED (ruled at D1's report, 2026-08-18): no §4
 * resolution consults a sender's role — worker and human replies alike go to
 * the orchestrator. A shape earns its keep only if a caller uses it as
 * designed (design §6); a module that someday needs role facts asks for them
 * then, in its own contract.
 */
export type ResolutionContext = {
  /** The orchestrator's name, if the dojo has one registered in its record.
   *  Consumed by the orchestrator-addressed kinds (reply, reminders,
   *  supervision) — NOT by the task row, which reads subscriptions only
   *  (ruled: no hardcoded orchestrator rule survives in the table). */
  orchestrator: AgentName | undefined
  /** The task's subscribers, from the tasks fold — the DEFINITION of
   *  "involved" for the task row (A-SUB). Includes the automatic
   *  subscriptions (creation → roster owner + orchestrator; reassignment →
   *  new owner) whether written explicitly or derived from an old log by
   *  the migration reading. */
  subscribersOf: (taskId: string) => readonly AgentName[]
}

/** Recipients of one event — possibly several, possibly none. Author never
 *  included. Unknown kinds resolve empty (history), never throw: logs are
 *  permanent and older/newer writers must not break the fold. */
export type ResolveRecipients = (event: StoredEvent, ctx: ResolutionContext) => readonly AgentName[]

/** The author of an event — the agent that produced it, when one did.
 *  Machine-produced events (infra's own emissions) have no author. */
export type AuthorOf = (event: StoredEvent) => AgentName | undefined

/** The module's public surface. One implementation object, typed by this
 *  contract (design §3) — `export const resolution: ResolutionContract`. */
export type ResolutionContract = {
  resolve: ResolveRecipients
  authorOf: AuthorOf
}
