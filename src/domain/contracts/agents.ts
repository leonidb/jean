/**
 * The agents contract — membership, roles, activity, sessions
 * (design §3; spec §1's name/role vocabulary embodied; old code read under
 * §8's extraction discipline; the calls recorded in task 082's report).
 *
 * ── IDENTITY (spec §1, ruled 2026-08-18) ──
 *
 * `name` is THE identity — unique in the roster, carried on events, what
 * every lookup keys on. `role` is a shared category; several agents may hold
 * one role and no rule here assumes one agent per role. The single exception
 * is the orchestrator: ONE per dojo, enforced at registration — that is a
 * rule about the dojo, not about the role's nature.
 *
 * ── RESERVED NAMES (R6, ruled at D1's report) ──
 *
 * `infra` and `api` are the system's own author names on machine-written
 * events. An agent registered under either would collide with machine
 * authorship — receiving machine mail unexcluded or silently receiving
 * none, depending on the author reading. Registration refuses them.
 *
 * ── MEMBERSHIP ──
 *
 * An agent JOINS the dojo's record on its first register event — durable,
 * from the log, surviving restarts. Membership currently has no leaving act:
 * a name once registered queues mail forever (the KNOWN CORNER, accepted and
 * visible). The pending P3 revision (tracker R4) lands here when ruled —
 * this module is the extension point; no retirement kind is invented ahead
 * of the ruling.
 *
 * Two sources of fact about one identity, kept distinct (design §3): this
 * contract's state is the PERSISTED record (who exists, with what role);
 * "who has a live session now" is the shell's connection knowledge and
 * enters decisions only as plain values (`connected`, `incumbentLive`).
 *
 * ── ROLE PRECEDENCE (extracted with its reasoning) ──
 *
 * For a name in both persisted sets (registered user once, sensei later —
 * nothing forbids reuse), `user` wins while disconnected: the opposite
 * order would let a once-orchestrator name demote a waiting HUMAN's messages
 * out of the blocking classification, and a missed human is the failure this
 * system treats as worse than a shrunken mailbox. The live session's role,
 * when the caller passes one, wins over both.
 *
 * ── THE ORCHESTRATOR SEAT ──
 *
 * The orchestrator of record is the sensei name seen MOST RECENTLY in a
 * register — history order, then live registers. It owns the orchestrator's
 * mailbox while no session is connected, so clocks and mail survive an
 * outage; the seat outlives the connection deliberately.
 *
 * ── ACTIVITY (H7, ruled 2026-08-11; the boundary test's UNTESTED-4) ──
 *
 * Activity is the agent's OWN act observed by the messaging system: an
 * inbound frame, an identity-carrying call. NOT activity: the register
 * handshake (automatic at session start, not a choice), a stop-hook post
 * (the harness's act), anything infra records ABOUT the agent, and never
 * anything outside the messaging system (no commits — the dojo is not
 * code-only). Absence of evidence reads as maximally quiet, so a fresh
 * session with waiting mail is announced at once.
 *
 * ── SESSIONS ──
 *
 * Classification is a HINT consumed by judgement; nothing in any delivery
 * path may branch on it. `offline` (transport known dead) beats everything;
 * no observed traffic reads `quiet`, never `active` — absence of evidence is
 * not evidence of presence. Quiet thresholds are per-role INJECTED VALUES
 * (extraction decision D-3: the old module read the environment from inside
 * otherwise-pure code; the environment is the adapter's).
 *
 * ── DUPLICATE SESSIONS ──
 *
 * Two processes fighting for one name: if the incumbent's transport is live
 * and the newcomer carries a different sessionId, the INCUMBENT is kept —
 * the newcomer is refused and told to stop reconnecting, and the
 * orchestrator is notified once (the human's only visible surface for the
 * rejection). A dead incumbent, or the same sessionId reconnecting, is
 * replaced cleanly. Expressed entirely over plain values — the 073 ruling
 * that connection events are domain facts, honoured.
 *
 * What the types cannot enforce, and what does: the precedence order, the
 * reserved-name refusal, the one-orchestrator rule, the duplicate verdicts,
 * and the classification thresholds are held by
 * `agents.conformance.test.ts`.
 */

import type { AgentName, AgentRole, StoredEvent } from './vocabulary.ts'

/** Names the system itself writes as authors; never agents. */
export const RESERVED_NAMES = ['infra', 'api'] as const

export type SessionClass = 'active' | 'quiet' | 'offline'

/** Opaque — the persisted record folded from register/disconnect history. */
export type AgentsState = { readonly __agentsState: true }

export type RegistrationCommand = {
  name: AgentName
  role: AgentRole
  sessionId?: string
  /** The shell's connection facts about an existing holder of this name. */
  incumbent?: { sessionId?: string; live: boolean }
  /** Is an orchestrator session currently connected (for the one-seat rule)? */
  orchestratorConnected: boolean
}

/**
 * VERDICT PRECEDENCE, stated because two rules can apply at once:
 * reserved-name first; then INCUMBENT resolution (a same-session or
 * dead-incumbent `replace` beats the second-orchestrator rule — the
 * reconnecting orchestrator IS the connected one, and refusing its own
 * reconnect would lock the seat); then second-orchestrator; then admit.
 */
export type RegistrationVerdict =
  | { kind: 'admit' }
  /** Same session or dead incumbent: close the old entry, admit this one. */
  | { kind: 'replace' }
  | { kind: 'refuse-reserved' }
  /** Keep the incumbent; tell the newcomer to stop; notify the orchestrator
   *  once — the effect is data, the shell delivers it. */
  | { kind: 'refuse-duplicate'; notifyOrchestrator: true }
  | { kind: 'refuse-second-orchestrator' }

export type IdleReport = { kind: 'ok' } | { kind: 'stale-session'; current: string } | { kind: 'not-connected' }

/** `export const agents: AgentsContract` — src/domain/agents/ (task D4). */
export type AgentsContract = {
  initial: () => AgentsState
  /** Fold register (join/role/seat) and disconnect; everything else ignored. */
  fold: (state: AgentsState, event: StoredEvent) => AgentsState

  isReservedName: (name: string) => boolean
  /** Has this name EVER registered as a dojo agent (sensei or worker)?
   *  The queue-vs-warn input: an unknown name must warn the sender, not
   *  feed a mailbox nobody reads. */
  isDojoAgent: (state: AgentsState, name: AgentName) => boolean
  /** The orchestrator of record — the seat, not the session. */
  orchestratorOf: (state: AgentsState) => AgentName | undefined
  /** Precedence: live session's role → persisted user → persisted sensei →
   *  persisted worker/librarian/peer record → undefined. */
  roleOf: (state: AgentsState, name: AgentName, liveRole?: AgentRole) => AgentRole | undefined

  /** Pure classification over observed values; thresholds injected per role. */
  classifySession: (
    obs: { role: AgentRole; lastActivityAt?: number; transportLive?: boolean },
    now: number,
    quietThresholdMs: (role: AgentRole) => number,
  ) => SessionClass

  decideRegistration: (state: AgentsState, cmd: RegistrationCommand) => RegistrationVerdict

  /** The stop-hook verdict: current session's report, a stale session's, or
   *  a disconnected agent's — a diagnostic classification, never activity. */
  idleReport: (session: { connected: boolean; currentSessionId?: string }, reportedSessionId?: string) => IdleReport
}
