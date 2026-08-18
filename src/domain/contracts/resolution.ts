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
 *   agent-down / worker-status / disconnect   → orchestrator
 *   ack / nudge / agent-idle / memory /
 *     register / start / permission-request /
 *     wiki-consolidated / trigger CRUD /
 *     playbook CRUD / headless-completed      → nobody — history
 *
 * "Everyone involved" is a resolution, not an address: a task created
 * unassigned by the orchestrator resolves to nobody and is history (spec §4).
 * With no orchestrator in the context, kinds addressed to the orchestrator
 * resolve empty — never to a fallback (a mailbox nobody owns is the orphan
 * class P4 abolishes).
 *
 * THE ADMISSION FLAG (surfaced at A6's composition round, task 102): five
 * kinds — `send`, `task-reminder`, `agent-probe`, `agent-down`,
 * `worker-status` — became MAIL mid-history; their shapes carry
 * `queued?: true`, the vocabulary's admission flag ("the write site
 * decides, the fold applies"). WITHOUT the flag they resolve to NOBODY:
 * a bookkeeping-era record, or a send handed over synchronously
 * (`delivered`), must not mint pairs on replay — the composed system's
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
