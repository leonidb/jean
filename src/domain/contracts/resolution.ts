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
 *                                               today: the task's agent and
 *                                               the orchestrator
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
 * What the type system cannot enforce here, and what does: that an
 * implementation's answers actually match the table, that author exclusion
 * holds for every kind, and that unknown kinds resolve empty rather than
 * throwing — all of that is held by `resolution.conformance.test.ts`, which
 * is the executable form of the table above.
 */

import type { AgentName, AgentRole, StoredEvent } from './vocabulary.ts'

/**
 * The facts resolution may consult — plain values, two sources kept distinct
 * (design §3): the persisted record answers "who is this" (`roleOf`,
 * `orchestrator`, `taskOwner`); nothing here answers "who is connected",
 * because resolution is decided at creation and must not depend on the live
 * instant (an offline recipient still receives mail — spec P3).
 */
export type ResolutionContext = {
  /** The orchestrator's name, if the dojo has one registered in its record. */
  orchestrator: AgentName | undefined
  /** Persisted role of a name, from the register history. */
  roleOf: (name: AgentName) => AgentRole | undefined
  /** The task's current agent, from the board fold. */
  taskOwner: (taskId: string) => AgentName | undefined
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
