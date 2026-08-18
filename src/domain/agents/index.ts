/**
 * Agents — membership, roles, activity, sessions (contract
 * `contracts/agents.ts`, task D4).
 *
 * ── TWO SOURCES OF FACT, NEVER MIXED ──
 *
 * This module's STATE is the persisted record: who has ever registered, under
 * what roles, and which sensei holds the seat. Who is connected RIGHT NOW is
 * the shell's knowledge and arrives only as plain values — `incumbent`,
 * `orchestratorConnected`, `transportLive`, `liveRole`. Nothing here reads a
 * socket, a clock or an environment variable, which is what lets every rule
 * below be decided by a caller holding facts rather than by this file holding
 * a connection.
 *
 * That separation is also why `disconnect` folds to almost nothing: it does
 * not remove membership and does not vacate the seat. An agent that is away
 * still owns its mailbox, and the orchestrator's clocks and mail must survive
 * its outage — the seat outlives the session deliberately.
 *
 * ── MEMBERSHIP IS DOJO AGENTS ONLY, AND THAT IS A ROUTING DECISION ──
 *
 * `isDojoAgent` answers "may mail be QUEUED for this name" — sensei and
 * worker, the roles that hold a mailbox and a queue. A `user` or `peer`
 * registration does not make one: their mail routes by role through an
 * adapter, so queueing for them would build a mailbox with no reader. This is
 * the queue-vs-warn line, and the warn side is the safe one: a sender told
 * "unknown agent" fixes the name, where a silent queue accumulates forever.
 *
 * The KNOWN CORNER stays visible rather than being papered over: membership
 * has no leaving act, so a name once registered queues mail forever. No
 * retirement kind is invented here ahead of the R4 ruling — this module is
 * where it lands when it comes.
 *
 * ── RESERVED NAMES MATCH EXACTLY, AND THAT IS THE POINT ──
 *
 * `infra` and `api` are refused because resolution's `authorOf` compares
 * `from` against those two strings EXACTLY. The refusal is calibrated to that
 * comparison: an agent named `Infra` collides with nothing, so refusing it
 * would cost a legal name to prevent a collision that cannot happen. A
 * case-insensitive check here would be a guess about a different bug.
 *
 * ── ROLE PRECEDENCE: user OUTRANKS sensei, ON PURPOSE ──
 *
 * A live session's role wins outright — the caller is holding the session, so
 * it knows better than the log. Among persisted records `user` beats `sensei`
 * because the failure modes are not symmetric: reading a waiting human as an
 * orchestrator demotes their message out of the blocking classification and
 * they wait unanswered, while reading a once-orchestrator name as a human
 * only over-classifies some mail as blocking. A missed human is the worse
 * failure, so the tie breaks toward noticing them.
 *
 * ── DUPLICATE SESSIONS: INCUMBENT RESOLUTION RUNS BEFORE THE SEAT RULE ──
 *
 * Both rules can fire on one registration, and the order matters in exactly
 * one case: an orchestrator reconnecting on its own session is both "an
 * incumbent replacing itself" and "a second orchestrator while one is
 * connected". Resolving the incumbent first is what stops its own liveness
 * from locking the seat against it — the connected orchestrator IS the
 * newcomer, and refusing it would leave the dojo with a seat nobody can take
 * until the transport times out.
 *
 * What this file cannot enforce, and what does: the precedence order, the
 * reserved-name refusal, the one-orchestrator rule, the duplicate verdicts
 * and the classification boundary are held by `agents.conformance.test.ts`.
 */

import type {
  AgentsContract,
  AgentsState,
  IdleReport,
  RegistrationCommand,
  RegistrationVerdict,
  SessionClass,
} from '../contracts/agents.ts'
import { RESERVED_NAMES } from '../contracts/agents.ts'
import type { AgentName, AgentRole, RegisterData, StoredEvent } from '../contracts/vocabulary.ts'

// ── State ────────────────────────────────────────────────────────

/** One name's persisted record. `all` is every role it has ever registered
 *  under — reuse is not forbidden, so precedence needs the whole set — and
 *  `last` is the most recent, which decides among the roles precedence does
 *  not rank. */
type Record_ = { readonly all: ReadonlySet<AgentRole>; readonly last: AgentRole }

type Registry = {
  readonly names: ReadonlyMap<AgentName, Record_>
  /** The seat: the sensei name seen most recently in a register. */
  readonly orchestrator: AgentName | undefined
}

function registry(state: AgentsState): Registry {
  return state as unknown as Registry
}
function seal(next: Registry): AgentsState {
  return next as unknown as AgentsState
}

/** The roles that hold a mailbox and a queue — see the header on the
 *  queue-vs-warn line. */
const DOJO_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(['sensei', 'worker'])

// ── The fold ─────────────────────────────────────────────────────

const fold = (state: AgentsState, event: StoredEvent): AgentsState => {
  // `disconnect` is deliberately absent from this switch. It is a real event
  // that folds to NOTHING here: being away costs an agent neither its
  // membership nor, for a sensei, the seat.
  if (event.type !== 'register') return state

  const data = (event.data ?? {}) as Partial<RegisterData>
  const name = data.agent
  const role = data.role
  if (typeof name !== 'string' || name.length === 0 || typeof role !== 'string') return state

  const current = registry(state)
  const existing = current.names.get(name)
  const all = new Set(existing?.all ?? [])
  all.add(role)

  const names = new Map(current.names)
  names.set(name, { all, last: role })

  return seal({
    names,
    // Most recent sensei register takes the seat. A worker registering never
    // vacates it, and neither does anything else.
    orchestrator: role === 'sensei' ? name : current.orchestrator,
  })
}

// ── Rules ────────────────────────────────────────────────────────

const isReservedName = (name: string): boolean => (RESERVED_NAMES as readonly string[]).includes(name)

const roleOf = (state: AgentsState, name: AgentName, liveRole?: AgentRole): AgentRole | undefined => {
  // The live session wins: the caller is holding the connection, so its answer
  // is newer than anything the log can say.
  if (liveRole !== undefined) return liveRole
  const record = registry(state).names.get(name)
  if (record === undefined) return undefined
  // Then the persisted sets, in the contract's order. See the header for why
  // `user` outranks `sensei` rather than the other way round.
  if (record.all.has('user')) return 'user'
  if (record.all.has('sensei')) return 'sensei'
  // worker / librarian / peer — unranked among themselves, so the most recent
  // registration is the honest answer.
  return record.last
}

const classifySession = (
  obs: { role: AgentRole; lastActivityAt?: number; transportLive?: boolean },
  now: number,
  quietThresholdMs: (role: AgentRole) => number,
): SessionClass => {
  // A dead transport is dead whatever it said a second ago. Only KNOWN dead
  // counts — `undefined` means the transport has no liveness check, not that
  // it failed one.
  if (obs.transportLive === false) return 'offline'
  // Absence of evidence is not evidence of presence. Reading silence as
  // `active` is what would let a fresh session with waiting mail go
  // unannounced.
  if (obs.lastActivityAt === undefined) return 'quiet'
  // `<=`: exactly at the bound is still active. Thresholds arrive per role
  // from the caller (D-3) — the old module read them from the environment
  // inside otherwise-pure code, and the environment is the adapter's.
  return now - obs.lastActivityAt <= quietThresholdMs(obs.role) ? 'active' : 'quiet'
}

/**
 * `_state` is unread, and that is a finding rather than an oversight. Every
 * fact this decision needs is a SHELL fact — the incumbent's liveness, the
 * newcomer's session, whether an orchestrator is connected — and none of them
 * can come from the persisted record. The seat rule in particular keys on
 * `orchestratorConnected` rather than on `orchestratorOf(state)` because the
 * contract's own precedence note says the incumbent path is what protects a
 * reconnecting orchestrator, so no name comparison is needed here. Reported
 * on task 085 rather than resolved by editing the contract.
 */
// The state parameter was removed from the contract (ruled, task 086 —
// stateless by shape-earns-its-keep); mechanical deletion of the unused
// parameter so the impl stays assignable, noted on 086.
const decideRegistration = (cmd: RegistrationCommand): RegistrationVerdict => {
  // 1. RESERVED, before anything else: the name is wrong whatever the
  //    session facts are, and admitting it would corrupt authorship rather
  //    than merely crowd a seat.
  if (isReservedName(cmd.name)) return { kind: 'refuse-reserved' }

  // 2. INCUMBENT RESOLUTION, before the seat rule — see the header.
  if (cmd.incumbent !== undefined) {
    // "Same session" REQUIRES BOTH IDS, extracted from the old handshake
    // (`!!msg.sessionId && !!existing.sessionId && equal`) and right on the
    // merits: a live incumbent is kept unless the newcomer can PROVE it is
    // that incumbent. Two processes that both arrive without an id are
    // indistinguishable from here, and `undefined === undefined` would read
    // that as proof and evict a session that may be mid-task. The empty
    // string is absent for the same reason the old truthiness test made it so
    // (codex pass, task 085).
    const sameSession =
      Boolean(cmd.sessionId) && Boolean(cmd.incumbent.sessionId) && cmd.sessionId === cmd.incumbent.sessionId
    // A dead incumbent holds nothing; a proven reconnect IS the incumbent.
    // Both are clean replacements rather than conflicts.
    if (!cmd.incumbent.live || sameSession) return { kind: 'replace' }
    // A live incumbent under a different session is the real duplicate. Keep
    // the incumbent — it may be mid-task — and notify the orchestrator, which
    // is the human's only visible surface for the rejection.
    return { kind: 'refuse-duplicate', notifyOrchestrator: true }
  }

  // 3. ONE ORCHESTRATOR PER DOJO. Reached only when there is no incumbent to
  //    resolve, so this can no longer refuse an orchestrator its own seat.
  if (cmd.role === 'sensei' && cmd.orchestratorConnected) return { kind: 'refuse-second-orchestrator' }

  return { kind: 'admit' }
}

const idleReport = (
  session: { connected: boolean; currentSessionId?: string },
  reportedSessionId?: string,
): IdleReport => {
  // Not connected outranks the session comparison: there is no current
  // session to be stale against.
  if (!session.connected) return { kind: 'not-connected' }
  // A report carrying no id is the current session's — the hook posted
  // without one, not from somewhere else. And with no current id there is
  // nothing to be stale against; `stale-session` cannot even be built without
  // naming the current one. Truthiness rather than `!== undefined`, so an
  // empty id reads as absent exactly as the old stop-hook path had it.
  if (!reportedSessionId || !session.currentSessionId) return { kind: 'ok' }
  if (reportedSessionId === session.currentSessionId) return { kind: 'ok' }
  return { kind: 'stale-session', current: session.currentSessionId }
}

export const agents: AgentsContract = {
  initial: () => seal({ names: new Map(), orchestrator: undefined }),
  fold,

  isReservedName,

  isDojoAgent: (state, name) => {
    const record = registry(state).names.get(name)
    if (record === undefined) return false
    // EVER registered as sensei or worker — not "currently", and not "last".
    // A name that was once a worker keeps its queue, because its mail is
    // still waiting for it.
    for (const role of record.all) if (DOJO_ROLES.has(role)) return true
    return false
  },

  orchestratorOf: (state) => registry(state).orchestrator,

  roleOf,
  classifySession,
  decideRegistration,
  idleReport,
}
