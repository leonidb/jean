/**
 * The new adapter — server skeleton, WS lifecycle, and the module surfaces
 * (design §5; tasks E1 and E2). The old `src/infra/server.ts` keeps serving;
 * nothing here touches it.
 *
 * ── EVERY HANDLER IS THE SAME FIVE STEPS ──
 *
 * parse → resolve context → call domain → execute effects → serialize. The
 * handler makes no decision, and the file contains no conditional that is not
 * dispatching on route or method. A 400 here is a typed domain refusal
 * RENAMED, never the adapter's own judgement — which is why the refusal
 * unions exist at all, and why E2's renames live in one table
 * (`refusals.ts`) rather than inline at each `return`.
 *
 * ── FACTS ARE COMPOSED FROM THEIR OWNING CONTRACT (R10) ──
 *
 * Nothing below derives a fact it could ask a module for. `roleOf` and
 * `isDojoAgent` come from agents; membership and classification come from
 * mailbox; recipients come from resolution; staleness arithmetic comes from
 * tasks. Composing them here rather than re-deriving them is what keeps one
 * question having one answer — the P2 seam has nowhere to open if the shell
 * never opens it. The surfaces receive those closures through
 * `SurfaceContext`, so two surfaces cannot form different opinions.
 *
 * ── THREE REGISTER ROWS, EACH WRITTEN DOWN WHERE IT LANDS ──
 *
 * R8 — the connectedAt→lastActivityAt fallback is DROPPED. The old `/agents`
 * display passed connect time as activity, so a freshly connected session read
 * `active` before it had done anything. The agents contract is explicit that
 * the register handshake is not activity ("automatic at session start, not a
 * choice"), so feeding it in was reading the handshake as an act. Fresh
 * sessions now read `quiet` until they do something. Deliberate, and visible.
 *
 * R13 — NEVER PRODUCE NaN IN A FACT. `NaN` fails every comparison, so a NaN
 * `lastActivityAt` makes `now - it` NaN, and a notifier that finds no bound
 * satisfied announces on every tick. NaN reads LOUD. Every parsed instant
 * below is guarded to `undefined` rather than passed through — absent is a
 * meaning the domain handles; NaN is not.
 *
 * R9 belongs to E3 (the trigger timers), and is recorded there: whoever calls
 * `shouldCatchUp` carries the active-status filter, because the domain
 * function deliberately does not. E2 added the triggers SURFACE and no timer,
 * so R9 is still open and still E3's — a startup catch-up loop that forgets it
 * makes disabled triggers fire on every boot, and nothing fails.
 */

import { type FSWatcher, mkdirSync, watch } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { agents as agentsModule } from '../domain/agents/index.ts'
import type { AckPair, MailboxState, ViewFacts } from '../domain/contracts/mailbox.ts'
import type { NotifierExecutor, NotifierView } from '../domain/contracts/notifier.ts'
import type { SupervisedAgentFacts, SupervisorView } from '../domain/contracts/supervisor.ts'
import type { Trigger } from '../domain/contracts/triggers.ts'
import type { AckData, AgentName, AgentRole, DeliveredVia } from '../domain/contracts/vocabulary.ts'
import {
  agentStream,
  PLAYBOOKS_STREAM,
  SYSTEM_STREAM,
  TRIGGERS_STREAM,
  taskIdFromStream,
  taskStream,
} from '../domain/contracts/vocabulary.ts'
import { mailbox } from '../domain/mailbox/index.ts'
import { playbooks } from '../domain/playbooks/index.ts'
import { resolution } from '../domain/resolution/index.ts'
import { routing } from '../domain/routing/index.ts'
import { tasks } from '../domain/tasks/index.ts'
import { triggers } from '../domain/triggers/index.ts'
import { createStore, jsonlBackend, memoryBackend, type StoredEvent } from '../es/index.ts'
import { type Attention, type AttentionConfig, createAttention } from './attention.ts'
import type { Caller, SurfaceContext } from './context.ts'
import type { SupervisionExecutor } from './executors.ts'
import { scanPlaybooks } from './playbook-files.ts'
import { createScheduler, type Scheduler } from './schedule.ts'
import { knowledgeRoutes } from './surfaces/knowledge.ts'
import { playbookRoutes } from './surfaces/playbooks.ts'
import { taskRoutes } from './surfaces/tasks.ts'
import { triggerRoutes } from './surfaces/triggers.ts'

// ── Ports ────────────────────────────────────────────────────────

export type AdapterPorts = {
  now: () => number
  log: (line: string) => void
  /** The receiver's OWN frozen description of a registered peer sender —
   *  a routing fact whose source is the peer registry, which is a file, which
   *  makes it a port. Default: nothing is a peer. */
  peerDescriptionOf: (name: string) => string | undefined
  /** Search telemetry. Best-effort by contract: it carries private query text
   *  and is for offline scoring, so a failure here never fails a search. */
  logRetrieval: (record: Record<string, unknown>) => void
}

export type ServerOptions = {
  port?: number
  /** Absent = in-memory (tests). */
  dataDir?: string
  /** How long an in-progress task may go quiet before `/board` flags it.
   *  Injected, never ambient: the domain does the arithmetic, the shell
   *  supplies the bound. */
  staleAfterMs?: number
  /** The attention cadences. Injected whole so a test drives the ladder
   *  without waiting out a two-minute quiet clock. */
  attention?: Partial<AttentionConfig>
  /** Start the tick timers. Off in tests by default — a suite that wants a
   *  tick calls it, and one that does not must not inherit a clock. */
  startTimers?: boolean
  ports?: Partial<AdapterPorts>
}

/** A non-socket surface joining the dojo: the bridge registers this way, as
 *  a `user`-role agent whose deliver() is its own send. Everything past the
 *  handshake is the ordinary path — routing, mailbox, announcement — so a
 *  bridge is a session that happens not to have a socket. */
export type Surface = {
  name: AgentName
  role: AgentRole
  deliver: (payload: unknown) => boolean
  /** The attaching process's own id, exactly as a register frame carries
   *  one. It is what separates the SAME bridge reconnecting (a replace) from
   *  a SECOND bridge claiming the name (a duplicate) — one rule for both
   *  doors, rather than a socket rule and a surface rule. */
  sessionId?: string
}

export type AdapterHandle = {
  port: number
  /** Release the clocks, finish the appends already accepted, close the
   *  socket — in that order. Awaitable; callers that do not care may not. */
  stop: () => Promise<void>
  /** Attach a surface; the returned function detaches it. */
  attachSurface: (surface: Surface) => () => void
  /** A message arriving FROM a surface, in the surface's own voice. Same
   *  path a WS `reply` frame takes — the bridge does not get a private one. */
  postInbound: (name: AgentName, text: string, meta?: { sentAt?: number; sourceId?: string }) => Promise<void>
  /** Run one attention pass by hand. The timers do this on a grid; a caller
   *  that has just changed the world and wants the consequence now (a test,
   *  a shakedown) asks directly. */
  tick: () => void
}

/**
 * The roles a register frame may claim — a TABLE, not a hand-written set.
 *
 * E1 shipped this as `new Set([...])` and flagged the drift: a role added to
 * the vocabulary and not here is refused at the socket with `invalid-role`,
 * and nothing catches it. `Record<AgentRole, true>` catches it in both
 * directions at compile time — a missing key is an error, an extra key is an
 * error — so the pin is the type rather than a test that has to be run.
 */
const ROLE_TABLE: Record<AgentRole, true> = { sensei: true, worker: true, user: true, peer: true, librarian: true }
export const ROLES: ReadonlySet<string> = new Set(Object.keys(ROLE_TABLE))

/** A day. Generous on purpose: workers go legitimately quiet for hours on
 *  file, git and test work, and the target is the FORGOTTEN task. */
const DEFAULT_STALE_MS = 24 * 60 * 60_000

/** What counts as activity ON A TASK — the fact `staleTasks` measures from.
 *  Infra's own bookkeeping (an automatic subscription, a reminder) is
 *  deliberately absent: a task nobody has touched must not look touched
 *  because the system wrote a routing rule about it. */
const TASK_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  'task-created',
  'task-status',
  'task-blocked',
  'task-updated',
  'task-reverted',
  'task-comment',
  'reply',
  'send',
])

/** An env number, or the default. Non-finite input takes the default rather
 *  than becoming a bound nothing satisfies (R13's shape, at configuration). */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * The cadences, with the ruled defaults. Every one of them is CONFIGURATION
 * (P8: bounds are configuration, never numbers in a contract) — the domain
 * takes them injected and this is where they come from.
 *
 * The tick grids are finer than the smallest window they serve, so the
 * promise is "by the first tick at or after the deadline" rather than a
 * whole window late.
 */
function defaultAttention(): AttentionConfig {
  const nudgeIntervalMs = envMs('JEAN_NUDGE_INTERVAL_MS', 120_000)
  const backoffMs = (() => {
    const raw = process.env.JEAN_NUDGE_BACKOFF_MS
    const parsed = (raw ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0)
    return parsed.length > 0 ? parsed : [120_000, 300_000, 600_000]
  })()
  const senseiReminderMs = envMs('JEAN_SENSEI_REMINDER_MS', 600_000)
  const probeTimeoutMs = envMs('JEAN_PROBE_TIMEOUT_MS', 300_000)
  const stuckAfterMs = envMs('JEAN_STUCK_AFTER_MS', 1_800_000)
  return {
    notifier: { nudgeIntervalMs, backoffMs },
    supervisor: {
      senseiReminderMs,
      humanReminderMs: envMs('JEAN_HUMAN_REMINDER_MS', 3_600_000),
      dailyReminderMs: envMs('JEAN_DAILY_REMINDER_MS', 86_400_000),
      idlePingAfterMs: envMs('JEAN_IDLE_PING_AFTER_MS', 86_400_000),
      probeTimeoutMs,
      stuckAfterMs,
    },
    notifyTickMs: Math.min(15_000, nudgeIntervalMs, ...backoffMs),
    superviseTickMs: Math.min(60_000, senseiReminderMs, probeTimeoutMs, stuckAfterMs),
  }
}

/** Compact ages: `45s`, `4m`, `2h`, `3d`. */
function fmtAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

// ── Live sessions ────────────────────────────────────────────────

type Session = {
  name: AgentName
  role: AgentRole
  /** The registering process's own id, when it sent one — what makes a
   *  same-session reconnect a `replace` rather than a duplicate. */
  sessionId?: string
  /** When this session arrived. NOT activity — see `supervisionView`, which
   *  is the only reader, and the note there about why the two consumers of
   *  "how long since we heard anything" need different floors. */
  connectedAt: number
  send: (payload: unknown) => boolean
  /** Hang up on this session. A `replace` verdict says to close the old
   *  entry, not merely to forget it — see the register handler. */
  close: () => void
}

// ── The server ───────────────────────────────────────────────────

export async function createAdapterServer(options: ServerOptions = {}): Promise<AdapterHandle> {
  const ports: AdapterPorts = {
    now: () => Date.now(),
    log: () => {},
    peerDescriptionOf: () => undefined,
    logRetrieval: () => {},
    ...options.ports,
  }
  const store = createStore(options.dataDir ? jsonlBackend(`${options.dataDir}/events.jsonl`) : memoryBackend())

  // Folded state, one projection per module — rebuilt by replay, evolved by
  // append. Kept as plain values: every fold is a pure domain function.
  let agentState = agentsModule.initial()
  let taskState = tasks.initial()
  let mailState = mailbox.initial()
  let triggerState = triggers.initial()
  let playbookState = playbooks.initial()
  /** Epoch ms of the last real event on each task's stream — shell
   *  bookkeeping, and the contract asks for it as the caller's fact. */
  const taskActivity = new Map<string, number>()
  const sessions = new Map<AgentName, Session>()
  /**
   * Epoch ms of each agent's last OWN act.
   *
   * Keyed by NAME and outliving the session on purpose: the agents contract
   * is explicit that the mailbox and its clocks survive an outage, so an
   * agent that acted, disconnected and came back has a last act — five
   * minutes ago — not a blank. R8 is untouched by this: an agent that has
   * never acted still has no entry, which is what `/agents` reports.
   */
  const lastActivity = new Map<AgentName, number>()
  /**
   * THE DELIVERY LEDGER — how each pending event first reached its agent.
   *
   * FIRST WRITE WINS: the question the mark answers is "how did this reach
   * them", and an event pushed and then fetched reached them by the push.
   * Absent is "unknown", never "not delivered" — which is why nothing here
   * ever writes a mark for something that was refused.
   *
   * In memory only, and that is honest: evidence of a handover this process
   * performed is evidence this process has. A restart forgets it, and the
   * ack record then carries no mark rather than a guessed one.
   */
  const deliveryLedger = new Map<number, DeliveredVia>()

  /** Record how an event reached its agent. First write wins; nothing that
   *  did not happen is ever passed in. */
  function stampDelivery(via: DeliveredVia, ids: readonly number[]): void {
    for (const id of ids) if (!deliveryLedger.has(id)) deliveryLedger.set(id, via)
  }

  const orchestratorOf = () => agentsModule.orchestratorOf(agentState)
  const isRosterMember = (name: AgentName) => agentsModule.isDojoAgent(agentState, name)
  const roleOf = (name: AgentName) => agentsModule.roleOf(agentState, name, sessions.get(name)?.role)

  /** The resolution context, composed — never re-derived (R10). */
  const resolutionContext = () => ({
    orchestrator: orchestratorOf(),
    subscribersOf: (taskId: string) => tasks.subscribersOf?.(taskState, taskId) ?? [],
  })

  /** The mailbox's view facts, composed the same way: role from agents,
   *  sender from resolution. Two contracts, no third opinion. */
  const viewFacts = (): ViewFacts => ({
    roleOf: (name) => roleOf(name),
    senderOf: (event) => resolution.authorOf(event),
  })

  /**
   * Fold one appended event into every projection, in one place, so no caller
   * can update one and forget another.
   *
   * THE ORDER IS LOAD-BEARING for the first three: tasks needs the roster and
   * the orchestrator's seat from agents, and mailbox needs resolution, which
   * needs `subscribersOf` from tasks. Triggers is appended AFTER them because
   * it consumes nothing any other fold produces — put it earlier and it would
   * look like it belonged to the chain.
   */
  function absorb(event: StoredEvent): void {
    agentState = agentsModule.fold(agentState, event)
    taskState = tasks.fold(taskState, event, isRosterMember, orchestratorOf())
    mailState = mailbox.fold(mailState, event, (e) => resolution.resolve(e, resolutionContext()))
    triggerState = triggers.fold(triggerState, event)
    playbookState = playbooks.fold(playbookState, event)

    const onTask = taskIdFromStream(event.stream)
    if (onTask !== undefined && TASK_ACTIVITY_KINDS.has(event.type)) {
      const at = Date.parse(event.ts)
      // R13 at the second fact-writing site: an unparseable ts must not become
      // a NaN activity instant, because `now - NaN` satisfies no bound and a
      // task that can never be stale is a task nobody is ever told about.
      if (Number.isFinite(at)) taskActivity.set(onTask, at)
    }
  }

  /**
   * The ONE write path: append, fold, and then append whatever the domain says
   * must follow.
   *
   * THE A-SUB FORWARD HALF LIVES HERE, not in the tasks surface. The
   * subscription rule is stated once in `autoSubscriptionsFor` and used twice
   * — the fold applies it on replay (which IS the migration), and the shell
   * appends it going forward so the log carries subscriptions as DATA rather
   * than as an implicit rule a later reader has to know. Putting it in the
   * surface would mean every future writer of a task event has to remember;
   * putting it here means none of them can forget.
   *
   * The recursion terminates at depth one: `task-subscribed` implies no
   * further subscriptions.
   */
  /**
   * In-flight appends, so `stop` can wait for them.
   *
   * Not bookkeeping for its own sake: several write paths are deliberately
   * fire-and-forget (`void record(...)` from the WS frames, from a nudge,
   * from a disconnect), because the caller has nothing to do with the
   * result. A `stop` that returned while one was in flight would cut a write
   * the process had already accepted — invisible in production and, in a
   * test, an append landing after its temp directory is gone.
   */
  let inFlight = 0
  const idleWaiters: (() => void)[] = []
  const drain = (): Promise<void> =>
    inFlight === 0 ? Promise.resolve() : new Promise<void>((done) => idleWaiters.push(done))

  async function record(type: string, stream: string, data: unknown): Promise<StoredEvent> {
    inFlight++
    try {
      return await appendAndFold(type, stream, data)
    } finally {
      inFlight--
      if (inFlight === 0) for (const waiter of idleWaiters.splice(0)) waiter()
    }
  }

  async function appendAndFold(type: string, stream: string, data: unknown): Promise<StoredEvent> {
    const event = await store.append({ type, stream, data })
    absorb(event)
    for (const sub of tasks.autoSubscriptionsFor?.(event, isRosterMember, orchestratorOf()) ?? []) {
      await record('task-subscribed', taskStream(sub.taskId), sub.data)
    }
    // THE ARRIVAL HOOK, last: after the event and everything it implies are
    // folded, so a decision made here sees the whole consequence of the
    // append rather than half of it. Attention is created below and this
    // runs on every live append, never on replay — a boot must not announce
    // a year of history.
    attention?.observe(event, actorOf(event))
    if (event.stream === TRIGGERS_STREAM) scheduler?.sync()
    return event
  }

  /**
   * WHOSE OWN ACT this event was — R14's composition law 4, and the one
   * clause of it this adapter deliberately does not follow.
   *
   * Speech and transitions carry their author, and `resolution.authorOf` is
   * the one function that knows which field that is per kind (`agent` means
   * addressee, speaker, subject and target across the census). A clearing is
   * attributed by the ack record's own `caller`.
   *
   * NOT `register`. RULED at task 103 (R15): the agents contract won its
   * contradiction with the harness's original law 4 — the handshake is the
   * transport arriving, not the agent acting, and counting it silenced the
   * reconnect announcement while granting unearned quiet-clocks. The
   * harness now says the same thing this function always did.
   */
  function actorOf(event: StoredEvent): AgentName | undefined {
    if (event.type === 'ack') {
      const caller = (event.data as AckData | undefined)?.caller
      return typeof caller === 'string' ? caller : undefined
    }
    return resolution.authorOf(event)
  }

  // THE BOOT REPLAY. Without this the projections start empty while the store
  // keeps counting ids from disk, so a restarted dojo would answer every
  // membership, routing and mailbox question from nothing while its log said
  // otherwise — the log IS the state, and a shell that does not read it has
  // silently invented a second one (codex pass, task 101).
  //
  // It goes through `absorb`, NOT `record`: replay must not re-append the
  // automatic subscriptions the fold already derives, or every boot would
  // grow the log by one event per task.
  for (const event of await store.read()) absorb(event)

  /** An agent's own act. The ONLY writer of `lastActivity` — see R8, and
   *  guarded for R13: a clock port that ever returned NaN would write a fact
   *  that fails every comparison, and a notifier finding no bound satisfied
   *  announces on every tick. NaN reads LOUD, so it never becomes a fact. */
  function observeActivity(name: AgentName): void {
    const at = ports.now()
    if (Number.isFinite(at)) lastActivity.set(name, at)
  }

  // ── The attention view composers (R10: every fact from its owner) ──

  /**
   * The notifier's world. Built FRESH at every decision — the delivered
   * announcement and the `pendingCount` on its `nudge` come out of ONE
   * snapshot, so they cannot disagree.
   *
   * WHO IS IN IT: everyone holding mail, plus everyone connected. An agent
   * holding nothing produces no announcement, so the connected half costs a
   * pass over an empty mailbox and buys a view that does not depend on the
   * order of two maps.
   *
   * `lastActivityAt` is ABSENT for an agent that has never acted, and that
   * is the contract's own reading: absence is maximally quiet, so a fresh
   * session with waiting mail is announced at once. Compare
   * `supervisionView`, where absence means something the shell must not say.
   */
  function notifyView(now: number): NotifierView {
    const names = new Set<AgentName>(sessions.keys())
    for (const pair of mailbox.pendingPairs(mailState)) names.add(pair.recipient)
    const facts = viewFacts()
    return {
      now,
      agents: [...names].map((name) => {
        const at = lastActivity.get(name)
        return {
          name,
          pendingIds: mailbox.mailboxOf(mailState, name).map((e) => e.id),
          hasBlocking: mailbox.countsFor(mailState, name, facts).blocking > 0,
          ...(at !== undefined && { lastActivityAt: at }),
        }
      }),
    }
  }

  /** Epoch ms, or the honest floor — never NaN (R13). A timestamp the log
   *  cannot parse must not become a bound nothing satisfies. */
  const instant = (iso: string | undefined, floor: number): number => {
    const parsed = iso === undefined ? Number.NaN : Date.parse(iso)
    return Number.isFinite(parsed) ? parsed : floor
  }

  /**
   * The supervisor's world.
   *
   * ── THE SAME FIELD, THE OPPOSITE FAILURE ──
   *
   * `lastActivityAt` is optional in both views and "absent" means the same
   * thing in both — never observed — but the two consumers do OPPOSITE
   * things with it. The notifier answers "announce now", which costs a wake
   * the agent may ignore. The supervisor answers "report this agent down to
   * the orchestrator", which is an alarm a human reads. So the notifier can
   * be handed a blank and the supervisor cannot: pass every roster member
   * with no recorded act and the first tick after a boot reports the entire
   * dojo dead.
   *
   * Two floors, and the contract blesses the shape — it already requires the
   * composer to supply `blockedSinceMs` from `updatedAt` when a task predates
   * the `blockedSince` pin, "never a crash, never a nag storm":
   *
   *  - a LIVE session with no act yet measures from when it CONNECTED. That
   *    is not the handshake counted as activity (R8 forbids that, and
   *    `/agents` still shows nothing); it is the honest start of the window
   *    in which we have heard nothing.
   *  - a DISCONNECTED agent is in this view ONLY if the board says it holds
   *    work, and measures from its newest held task's own timestamp. The
   *    registry forgets a session's clock; the board does not, and measuring
   *    from the epoch instead would report every worker down within a tick
   *    of every restart.
   *
   * An agent that is neither connected nor holding work is not in the view
   * at all. There is nothing to supervise and nothing honest to measure.
   */
  function supervisionView(now: number): SupervisorView {
    const rows = new Map<AgentName, SupervisedAgentFacts>()
    for (const session of sessions.values()) {
      const role = roleOf(session.name) ?? session.role
      rows.set(session.name, {
        name: session.name,
        role,
        connected: true,
        lastActivityAt: lastActivity.get(session.name) ?? session.connectedAt,
        holdsWork: tasks.activeTaskOf(taskState, session.name) !== undefined,
        hasPendingMail: mailbox.mailboxOf(mailState, session.name).length > 0,
      })
    }
    const board = tasks.all(taskState)
    for (const task of board) {
      const held = task.agent
      if (held === undefined || rows.has(held)) continue
      if (task.status !== 'in-progress' && task.status !== 'assigned') continue
      const role = roleOf(held)
      // An unresolvable role is an agent this dojo has no record of. The
      // supervisor would not probe it anyway; inventing `worker` to make the
      // row well-typed would be the shell deciding what it does not know.
      if (role === undefined) continue
      const heldClock = board
        .filter((t) => t.agent === held && (t.status === 'in-progress' || t.status === 'assigned'))
        .reduce((hi, t) => Math.max(hi, instant(t.updatedAt, 0)), 0)
      rows.set(held, {
        name: held,
        role,
        connected: false,
        lastActivityAt: lastActivity.get(held) ?? (heldClock > 0 ? heldClock : now),
        holdsWork: true,
        hasPendingMail: mailbox.mailboxOf(mailState, held).length > 0,
      })
    }
    return {
      now,
      orchestrator: orchestratorOf(),
      tasks: board.map((t) => ({
        id: t.id,
        status: t.status,
        ...(t.blockedOn !== undefined && { blockedOn: t.blockedOn }),
        blockedSinceMs: instant(t.blockedSince ?? t.updatedAt, now),
        ...(t.resumeAt !== undefined && { resumeAtMs: instant(t.resumeAt, now) }),
      })),
      agents: [...rows.values()],
    }
  }

  // ── The executors ──────────────────────────────────────────────

  const notifierExecutor: NotifierExecutor = {
    deliver: (to, text) => sessions.get(to)?.send({ type: 'deliver', from: 'infra', text }) ?? false,
    // FIRST WRITE WINS — see the ledger's own note. `stamp` is only ever
    // called for an ACCEPTED announcement, so nothing here can record a
    // handover that did not happen.
    stamp: stampDelivery,
    // SYSTEM_STREAM, because the executor contract's `emit(type, data)` has
    // no stream to give and `NudgeData` has no agent field — so the nudge
    // record cannot say who it was for. Faithful to the old writer, and a
    // real gap in what a replayed log can tell you; noted rather than fixed
    // by sniffing the payload for a stream.
    emit: (type, data) => emitEvent(type, data),
  }

  const supervisionExecutor: SupervisionExecutor = {
    emit: (type, data) => emitEvent(type, data),
  }

  /**
   * An executor's emission — appended, and its failure SAID OUT LOUD.
   *
   * Both units are decide→effects and both advance their state as they
   * decide, so an append that fails here is an emission the unit believes it
   * made. The notifier has an outcome channel and can be told otherwise; the
   * supervisor has none, so a failed reminder or report is simply lost, with
   * no retry (codex pass, task 104). Nothing in this file can fix that — a
   * supervision outcome channel is a contract change — so the loss is at
   * least never silent, and it is recorded for G1.
   */
  function emitEvent(type: string, data: unknown): void {
    void record(type, SYSTEM_STREAM, data).catch((err: unknown) => {
      ports.log(`[jean:new] LOST EMISSION ${type}: ${String(err)}\n`)
    })
  }

  let attention: Attention | undefined
  let scheduler: Scheduler | undefined
  /** Set the instant `stop` begins — see the WS close handler. */
  let stopping = false
  /** The playbook directory watcher and its debounce, held so `stop` can
   *  release them: an fs watcher outliving its server keeps a handle open
   *  and fires reconciles into a store nobody is reading. */
  let playbookWatcher: FSWatcher | undefined
  let playbookDebounce: ReturnType<typeof setTimeout> | undefined

  /**
   * Watch the playbook directory, debounced.
   *
   * DEBOUNCED because one save is several filesystem events — an editor
   * writes, renames and touches — and each would otherwise start its own
   * scan. The reconcile is idempotent, so the cost of a redundant pass is
   * only work; the debounce is what keeps it from being work on every
   * keystroke of an auto-saving editor.
   */
  function watchPlaybooks(): void {
    if (options.dataDir === undefined) return
    const dir = resolvePath(options.dataDir, 'playbooks')
    try {
      // CREATED IF ABSENT, and that is what makes the watcher reliable
      // rather than a nicety: with no directory there is nothing to watch,
      // so a fresh dojo's FIRST playbook would be invisible until the next
      // restart (codex pass, task 106). The old system created it too — for
      // the second reason, which is that a user needs somewhere to put one.
      mkdirSync(dir, { recursive: true })
      playbookWatcher = watch(dir, () => {
        if (playbookDebounce !== undefined) clearTimeout(playbookDebounce)
        // DEBOUNCED: one save is several filesystem events, and each would
        // otherwise start its own scan.
        playbookDebounce = setTimeout(() => void reconcilePlaybooks(), 200)
      })
    } catch (err) {
      ports.log(`[jean:new] not watching playbooks: ${String(err)}\n`)
    }
  }

  // ── Caller context ─────────────────────────────────────────────

  /**
   * Who is asking.
   *
   * THE BODY IS NOT CONSULTED, and the third parameter is why. E1's version
   * fell back to `body.agent`, which was safe while the only surfaces were
   * mailbox and agents — and stopped being safe the moment E2 added routes
   * where `agent` names something else entirely: the TARGET of a trigger, the
   * new ASSIGNEE of a task, the agent being SUBSCRIBED. A header-less call to
   * any of those would have named its own subject as the caller, recorded it
   * as the actor and credited it with the activity (codex pass, task 103).
   *
   * `agent` is the per-field-polarity trap in one word: it means addressee,
   * speaker, subject and target across this API, so no generic reader of it
   * can be right everywhere. A surface that genuinely carries its caller in
   * the body passes that value in explicitly — and takes responsibility for
   * knowing which field it is.
   */
  function callerOf(req: Request, url: URL, claimed?: string): Caller {
    const named =
      req.headers.get('x-jean-agent') ??
      url.searchParams.get('agent') ??
      url.searchParams.get('for') ??
      (claimed !== undefined && claimed.length > 0 ? claimed : undefined)
    if (named === null || named === undefined) return { connected: false }
    const session = sessions.get(named)
    const role = roleOf(named)
    return { name: named, ...(role !== undefined && { role }), connected: session !== undefined }
  }

  // ── Serializers — rename only ──────────────────────────────────

  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

  const parseBody = async (req: Request) => (await req.json().catch(() => null)) as Record<string, unknown> | null

  // ── Message routing ────────────────────────────────────────────

  /**
   * One send, whichever door it came through.
   *
   * The transport attempt happens BEFORE the record on the adapter leg,
   * because `delivered` is not knowable until it has — the contract builds
   * that record as a function of the outcome for exactly this reason.
   */
  async function performSend(cmd: {
    from: AgentName | 'infra' | 'api'
    to: AgentName
    text: string
    taskId?: string
    attachments?: readonly string[]
  }): Promise<{ queued: true } | { delivered: boolean; undelivered?: string }> {
    // CONTEXT: both facts from the agents contract, live role kept SEPARATE
    // from the persisted one — the provenance the routing contract needs.
    // The peer description is the third, and it comes from the RECEIVER's own
    // registry, never from the message: a peer cannot rewrite its own
    // description per send.
    const peerDescription = ports.peerDescriptionOf(cmd.from)
    const decision = routing.decideSend(cmd, {
      liveRole: sessions.get(cmd.to)?.role,
      isDojoAgentEver: agentsModule.isDojoAgent(agentState, cmd.to),
      ...(peerDescription !== undefined && { senderPeerDescription: peerDescription }),
    })
    if (decision.route === 'queue') {
      await record('send', decision.stream, decision.data)
      return { queued: true }
    }
    // THE WHOLE MESSAGE GOES DOWN THE WIRE, not just its text. A receiver
    // reads `taskId` off the deliver frame to attribute its own reply, and
    // drops attachments it never received — so a payload of `{from, text}`
    // records a message with context and delivers one without it (codex pass,
    // task 103).
    const delivered =
      sessions.get(cmd.to)?.send({
        type: 'deliver',
        from: cmd.from,
        text: cmd.text,
        ...(cmd.taskId !== undefined && { taskId: cmd.taskId }),
        ...(cmd.attachments !== undefined && { attachments: cmd.attachments }),
      }) ?? false
    await record('send', decision.stream, decision.data(delivered))
    const notice = decision.undeliveredNotice(delivered)
    return { delivered, ...(notice !== undefined && { undelivered: notice }) }
  }

  async function handleSend(req: Request, url: URL): Promise<Response> {
    const body = await parseBody(req)
    // PARSE: grammar, not policy. A missing field is malformed input, which is
    // the adapter's own 400 — the only kind it is allowed to author.
    if (body === null || typeof body.to !== 'string' || typeof body.text !== 'string') {
      return json({ error: 'body must be { to: string, text: string }' }, 400)
    }
    if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
      return json({ error: 'attachments must be an array of strings' }, 400)
    }
    // `from` OVER HTTP IS THE BODY'S, as it always was: the CLI and peer
    // hops have no session to be identified by. Over the WS it is the
    // SESSION's and never the wire (see the frame handler) — the two doors
    // differ because only one of them can be spoofed for free. It is also
    // the ONLY field in this body that names a caller, which is why it is
    // what gets passed to `callerOf`.
    const caller = callerOf(req, url, typeof body.from === 'string' ? body.from : undefined)
    const from = caller.name ?? 'api'
    const outcome = await performSend({
      from,
      to: body.to,
      text: body.text,
      ...(typeof body.taskId === 'string' && { taskId: body.taskId }),
      ...(Array.isArray(body.attachments) && { attachments: body.attachments as string[] }),
    })
    if (caller.name !== undefined) observeActivity(caller.name)
    return json({ ok: true, ...outcome })
  }

  function handleFetch(req: Request, url: URL): Response {
    const caller = callerOf(req, url)
    if (caller.name === undefined) return json({ error: 'name the caller: ?agent= or x-jean-agent' }, 400)
    const selector = url.searchParams.get('ids')
    // PARSE STRICTLY. `?ids=a` used to filter out the unparseable value and
    // ask for an empty selection, which the mailbox answers honestly with
    // "nothing found" — a wrong answer to a question the caller never asked.
    // A malformed id is grammar, so it is a 400 here rather than an empty
    // list there (codex pass, task 101).
    const ids = selector === null ? undefined : selector.split(',').map((n) => Number.parseInt(n, 10))
    if (ids?.some((n) => !Number.isFinite(n)))
      return json({ error: 'ids must be a comma-separated list of numbers' }, 400)
    // CALL: one domain function. Which of the ids the caller may see is the
    // mailbox's decision, never this handler's.
    const selection =
      ids === undefined
        ? { events: mailbox.fetchFor(mailState, caller.name) }
        : mailbox.select(mailState, caller.name, { ids }, viewFacts())
    observeActivity(caller.name)
    // A FETCH IS CARRIAGE. The agent has now seen these events by its own
    // act, which discharges the current announcement obligation without
    // terminating the ladder — told is not done, and unhandled mail
    // re-announces on the backoff schedule (P7: seeing is not acking).
    const shown = selection.events.map((f) => f.event.id)
    stampDelivery('fetch', shown)
    attention?.carried(caller.name, shown, 'fetch')
    return json({
      events: selection.events.map((f) => ({ ...f.event, code: f.code })),
      ...('missing' in selection && selection.missing !== undefined && { missing: selection.missing }),
    })
  }

  async function handleAck(req: Request, url: URL): Promise<Response> {
    const body = await parseBody(req)
    const caller = callerOf(req, url)
    if (caller.name === undefined) return json({ error: 'name the caller: ?agent= or x-jean-agent' }, 400)
    if (body === null || !Array.isArray(body.pairs)) return json({ error: 'body must be { pairs: [{id, code}] }' }, 400)
    const pairs = body.pairs.filter((p): p is AckPair => typeof p?.id === 'number' && typeof p?.code === 'string')
    // The evidence port: what this shell handed over, and how. Absent is
    // "unknown", never "not delivered".
    const decision = mailbox.applyAck(mailState, caller.name, pairs, (eventId) => deliveryLedger.get(eventId))
    // THE APPEND IS WHAT CLEARS, not the decision. Assigning `decision.next`
    // here and then appending would leave live state with mail cleared and no
    // log event behind it if the append ever failed — state ahead of its own
    // log, which is the one thing an event-sourced shell must never be. The
    // fold applies the same clearing from the record, so there is one path
    // instead of two that have to agree (codex pass, task 101).
    await record('ack', 'system', decision.record)
    observeActivity(caller.name)
    // The marks are in the record now, so the live copies have done their
    // job — but ONLY for events nobody still holds. An event with two
    // recipients is acked twice, and dropping its mark on the first ack
    // would leave the second ack's record saying "delivered: unknown" about
    // a push this process performed. Pruned against what is still pending,
    // which is also what keeps the ledger from growing for the process's
    // lifetime.
    const stillPending = new Set(mailbox.pendingPairs(mailState).map((pair) => pair.eventId))
    for (const id of [...deliveryLedger.keys()]) if (!stillPending.has(id)) deliveryLedger.delete(id)
    return json({
      acknowledged: decision.cleared.length,
      remaining: mailbox.countsFor(mailState, caller.name, viewFacts()).total,
    })
  }

  function handleAgents(): Response {
    // R8 IN ONE LINE: `lastActivityAt` is the session's observed act or
    // nothing. The connect time is deliberately not a fallback.
    return json({
      agents: [...sessions.values()].map((s) => ({
        name: s.name,
        role: roleOf(s.name),
        connected: true,
        ...(lastActivity.get(s.name) !== undefined && { lastActivityAt: lastActivity.get(s.name) }),
        openTasks: tasks.openTaskCount(taskState, s.name),
        pending: mailbox.countsFor(mailState, s.name, viewFacts()).total,
      })),
    })
  }

  // ── The surfaces ───────────────────────────────────────────────

  const surfaceContext: SurfaceContext = {
    json,
    body: parseBody,
    callerOf,
    record,
    read: (opts) => store.read(opts),
    now: ports.now,
    observeActivity,
    tasksState: () => taskState,
    triggersState: () => triggerState,
    playbooksState: () => playbookState,
    isRosterMember,
    orchestratorOf,
    roleOf,
    lastEventAt: (taskId) => taskActivity.get(taskId),
    staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_MS,
    ...(options.dataDir !== undefined && { dataDir: options.dataDir }),
    logRetrieval: ports.logRetrieval,
  }

  /** Each surface owns its own paths and answers `undefined` for anything
   *  else, so the route table is not duplicated between here and there. */
  const surfaces = [
    taskRoutes(surfaceContext),
    triggerRoutes(surfaceContext),
    knowledgeRoutes(surfaceContext),
    playbookRoutes(surfaceContext),
  ]

  // ── The piggyback ──────────────────────────────────────────────

  /**
   * Attach the caller's inbox line to a response it already asked for, and
   * count that as the agent having been told.
   *
   * ── ATTACH-LEVEL, NOT CONFIRMED READ ──
   *
   * This records that infra PUT the line on a response headed for the agent.
   * It cannot observe the client reading it, and a response aborted
   * mid-flight is marked all the same. That is the best evidence available,
   * and the alternative — not marking — would under-report every event whose
   * only delivery was a piggyback, which is the common case.
   *
   * ── AND THE LINE IS WHY THERE IS NO SEPARATE PUSH ──
   *
   * The line going out IS the agent being told. Without the carriage report
   * the two mechanisms contradict each other: the ledger records a handover
   * while the episode still considers the events unannounced and pushes them
   * again. Note what is NOT asked here — whether the agent is busy. This is
   * a fact about the EVENTS: they have been shown.
   */
  /**
   * The inbox line — the second and last piece of presentation in the
   * adapter (the first is `renderAnnouncement`): counts and ages are the
   * mailbox's, words are ours.
   *
   * ASCII ONLY, and that is not a style note. A header value carrying an
   * em-dash throws at `Headers.set` — which, from inside the fetch handler,
   * fails the whole request. The first version of this line had one, and it
   * took down every response to a registered agent with mail. Whatever a
   * reader wants to see around this line is the client's to add.
   */
  function renderInboxLine(agent: AgentName): string {
    const now = ports.now()
    const lines = mailbox.summaryFor(mailState, agent, viewFacts(), now)
    const parts: string[] = []
    const blocking = lines.filter((line) => line.group.kind === 'blocking')
    if (blocking.length > 0) {
      const who = blocking.map((line) => `${line.from ?? 'someone'}, ${fmtAge(line.ageMs)}`).join('; ')
      parts.push(`${blocking.length} blocking (${who})`)
    }
    const queued = lines.filter((line) => line.group.kind === 'queued')
    if (queued.length > 0) {
      const oldest = queued.reduce((hi, line) => Math.max(hi, line.ageMs), 0)
      parts.push(`${queued.length} queued (oldest ${fmtAge(oldest)})`)
    }
    return parts.join(' | ')
  }

  function withInboxLine(req: Request, url: URL, res: Response): Response {
    const caller = callerOf(req, url)
    // A REGISTERED agent only: attaching a mailbox line to a response headed
    // somewhere with no mailbox is the failure in the other direction.
    if (caller.name === undefined || !isRosterMember(caller.name)) return res
    const shown = mailbox.mailboxOf(mailState, caller.name)
    if (shown.length === 0) return res // the empty case costs nothing and says nothing
    const ids = shown.map((e) => e.id)
    stampDelivery('piggyback', ids)
    attention?.carried(caller.name, ids, 'piggyback')
    const headers = new Headers(res.headers)
    headers.set('x-jean-inbox', renderInboxLine(caller.name))
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }

  // ── Attention and scheduling ───────────────────────────────────
  //
  // BEFORE `Bun.serve`, deliberately. `createAttention` validates the
  // cadences and REFUSES an invalid ladder — and a refusal after the socket
  // is bound rejects `createAdapterServer` without ever handing the caller a
  // handle to stop the listener with, so the port stays held by a server
  // nobody has a reference to (codex pass, task 104). Nothing here needs the
  // server; only the boot work below does.

  attention = createAttention({
    now: ports.now,
    log: ports.log,
    notifyView,
    supervisionView,
    notifierExecutor,
    supervisionExecutor,
    config: { ...defaultAttention(), ...options.attention },
  })

  /** Firing's two halves, in one place. The APPEND is the firing; the
   *  DELIVERY is the ordinary mail path — `trigger-fired` resolves to its
   *  target, the mailbox holds it, the notifier announces it. That is why
   *  there is no second event here and no push: a firing that also pushed
   *  would tell the agent twice and record it once. */
  async function fireTrigger(trigger: Trigger): Promise<void> {
    await record('trigger-fired', TRIGGERS_STREAM, triggers.fireData(trigger))
    if (trigger.kind === 'headless') {
      // NOT BUILT, and loud about it rather than silent: a headless firing
      // is supposed to spawn a one-shot session under a role. The event is
      // recorded (and resolves to history, exactly as §4 declares), but
      // nothing runs. Flagged for G1 — a dojo whose nightly consolidation is
      // a headless trigger would find it quietly not happening.
      ports.log(`[jean:new] trigger ${trigger.id} is headless — no spawn adapter yet; firing recorded only\n`)
    }
  }

  /**
   * Reconcile the playbook directory into the log.
   *
   * The FILES are the source of truth; the log records what changed. The
   * diff is the domain's (`decideReconcile`) and it emits NOTHING when
   * nothing changed — which is what makes this safe to call on every
   * filesystem event.
   *
   * A SCAN THAT FAILS APPENDS NOTHING. `decideReconcile` removes entries
   * whose files have vanished, so a half-read directory would emit
   * `playbook-removed` for playbooks that are sitting right there — and the
   * next scan would create them again, a log that flaps with the weather.
   * Absence is handled inside the scan; anything else abandons the pass.
   */
  let reconciling: Promise<void> | undefined
  /** A request that arrived DURING a pass. The scan takes a snapshot, so a
   *  save landing after it is invisible to the pass in flight — dropping the
   *  request would lose that edit until the next unrelated filesystem event
   *  (codex pass, task 106). One more pass, not a queue of them: the
   *  reconcile is idempotent, so a single follow-up sees everything. */
  let reconcileAgain = false

  async function reconcilePlaybooks(): Promise<void> {
    if (options.dataDir === undefined) return
    if (reconciling !== undefined) {
      reconcileAgain = true
      return reconciling
    }
    const pass = (async () => {
      do {
        reconcileAgain = false
        try {
          const files = await scanPlaybooks(resolvePath(options.dataDir as string, 'playbooks'))
          for (const decided of playbooks.decideReconcile(playbookState, files)) {
            await record(decided.type, PLAYBOOKS_STREAM, decided.data)
            ports.log(`[jean:new] playbook ${decided.type.replace('playbook-', '')}: ${decided.data.id}\n`)
          }
        } catch (err) {
          // A SCAN THAT FAILED APPENDS NOTHING — see the note above. Logged
          // and abandoned; the next filesystem event tries again.
          ports.log(`[jean:new] playbook reconcile skipped: ${String(err)}\n`)
        }
      } while (reconcileAgain)
    })()
    reconciling = pass
    try {
      await pass
    } finally {
      reconciling = undefined
    }
  }

  scheduler = createScheduler({
    now: ports.now,
    log: ports.log,
    triggersState: () => triggerState,
    fire: fireTrigger,
  })

  /** The routing table — the only conditionals here dispatch on route or
   *  method. Split out of `fetch` so the piggyback wraps every answer,
   *  including the 404. */
  async function route(req: Request, url: URL): Promise<Response> {
    if (url.pathname === '/send' && req.method === 'POST') return handleSend(req, url)
    if (url.pathname === '/events' && req.method === 'GET') return handleFetch(req, url)
    if (url.pathname === '/ack' && req.method === 'POST') return handleAck(req, url)
    if (url.pathname === '/agents' && req.method === 'GET') return handleAgents()
    for (const surface of surfaces) {
      const answer = await surface(req, url)
      if (answer !== undefined) return answer
    }
    return json({ error: 'not found' }, 404)
  }

  // ── Bun.serve ──────────────────────────────────────────────────

  const server = Bun.serve<{ name?: AgentName; session?: Session }>({
    port: options.port ?? 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/ws' && srv.upgrade(req, { data: {} })) return undefined as unknown as Response
      // COMPUTE THE ANSWER, THEN ATTACH THE LINE. The line describes the
      // mailbox as it stands AFTER the request did whatever it did — an ack
      // that emptied the mailbox must not go out under a header saying it is
      // full.
      try {
        return withInboxLine(req, url, await route(req, url))
      } catch (err) {
        // A HANDLER THAT COULD NOT FINISH SAYS SO. The case this exists for
        // is an APPEND that fails: the ack path decides, appends, and lets
        // the fold clear — so a failed append means nothing cleared, and the
        // caller must learn that rather than read a default 500 and guess.
        // Deliberately 503: the request was well-formed and the system could
        // not carry it out, which is the one honest reading.
        ports.log(`[jean:new] ${req.method} ${url.pathname} failed: ${String(err)}\n`)
        return json({ error: 'the request could not be completed', detail: String(err) }, 503)
      }
    },
    websocket: {
      message(ws, raw) {
        const msg = (() => {
          try {
            return JSON.parse(String(raw)) as {
              type?: string
              agent?: string
              role?: string
              sessionId?: string
              to?: string
              text?: string
              taskId?: string
              attachments?: string[]
            }
          } catch {
            // A frame that is not JSON is not a message. Dropping it is the
            // only honest option: there is no `type` to refuse under, and
            // closing the socket would punish a live agent for one bad line.
            return null
          }
        })()
        if (msg === null) return

        if (msg.type === 'register') {
          // PARSE, and the frame's grammar is as strict as the body's. An
          // unvalidated role was cast straight into `sessions` and became LIVE
          // TRUTH — `roleOf` returns the live role over the record, so a typo
          // in a frame outranked the dojo's own register history while the
          // agents fold quietly ignored it. Live and persisted disagreeing is
          // the exact provenance confusion D6's contract fix removed
          // (codex pass, task 101).
          const role = msg.role ?? 'worker'
          if (typeof msg.agent !== 'string' || msg.agent.length === 0) return
          if (!ROLES.has(role)) {
            ws.send(JSON.stringify({ type: 'refused', reason: 'invalid-role' }))
            ws.close()
            return
          }
          const incumbent = sessions.get(msg.agent)
          const verdict = agentsModule.decideRegistration({
            name: msg.agent,
            role: role as AgentRole,
            ...(typeof msg.sessionId === 'string' && { sessionId: msg.sessionId }),
            // THE SESSION ID IS CARRIED, so `replace` is reachable at all: a
            // same-session reconnect is a replacement, not a duplicate, and
            // without an id here every reconnect looked like a rival process.
            ...(incumbent !== undefined && {
              incumbent: { live: true, ...(incumbent.sessionId !== undefined && { sessionId: incumbent.sessionId }) },
            }),
            orchestratorConnected: [...sessions.values()].some((s) => s.role === 'sensei'),
          })
          if (verdict.kind !== 'admit' && verdict.kind !== 'replace') {
            ws.send(JSON.stringify({ type: 'refused', reason: verdict.kind }))
            ws.close()
            return
          }
          // A REPLACE CLOSES THE OLD ENTRY, it does not merely forget it.
          // Overwriting the map alone leaves the incumbent's socket open and
          // unreachable — and worse, its eventual `close` would delete the
          // map entry belonging to the session that replaced it, so the
          // NEW session would silently stop receiving anything. Hence both
          // halves: hang up here, and let the close handler below delete only
          // an entry it still owns.
          if (verdict.kind === 'replace' && incumbent !== undefined) incumbent.close()

          const session: Session = {
            name: msg.agent,
            role: role as AgentRole,
            ...(typeof msg.sessionId === 'string' && { sessionId: msg.sessionId }),
            // R8: NO activity is recorded here. Registering is not an act.
            // `connectedAt` is not activity either — it is where the window
            // of hearing nothing STARTS, read by one composer and named
            // there (see `supervisionView`).
            connectedAt: ports.now(),
            send: (payload) => {
              if (ws.readyState !== 1) return false
              ws.send(JSON.stringify(payload))
              return true
            },
            close: () => ws.close(),
          }
          ws.data.name = msg.agent
          ws.data.session = session
          sessions.set(msg.agent, session)
          // The SAME validated role goes to the log as went into the session —
          // live and persisted must not be able to disagree about what this
          // frame claimed.
          void record('register', agentStream(msg.agent), {
            agent: msg.agent,
            role: role as AgentRole,
            idle: true,
          }).then(() => ws.send(JSON.stringify({ type: 'registered', agent: msg.agent })))
          return
        }

        // EVERY OTHER FRAME SPEAKS AS ITS SESSION. `from` is `ws.data.name`
        // and never the wire: an unregistered socket has no identity to write
        // events under, and a registered one cannot borrow another's.
        const from = ws.data.name
        if (from === undefined) return
        // AND IT MUST STILL OWN THE SEAT. A replaced socket stays open until
        // its close lands, and `sessions.get(from)` would hand it the
        // SUCCESSOR's session — so the evicted process could go on speaking
        // as the agent, and its activity would reset the live one's clocks
        // (codex pass, task 104). Identity, not name.
        const session = sessions.get(from)
        if (session === undefined || session !== ws.data.session) return
        observeActivity(from)

        if (msg.type === 'reply' && typeof msg.text === 'string') {
          // ATTRIBUTION: the taskId the client carried, else the task this
          // agent currently holds — `activeTaskOf` is the board's half of the
          // question and exists for exactly this.
          //
          // A SENSEI'S REPLY REACHES NOBODY, and no rule here says so: §4
          // resolves `reply` to the orchestrator and then removes the author,
          // so an orchestrator's own reply resolves empty and becomes history.
          // The old server carried an explicit drop for this; under the
          // rewrite it is a consequence of the table.
          const taskId = msg.taskId ?? tasks.activeTaskOf(taskState, from)?.id
          const stream = taskId === undefined ? agentStream(from) : taskStream(taskId)
          void record('reply', stream, { agent: from, text: msg.text })
          return
        }

        if (msg.type === 'send' && typeof msg.to === 'string' && typeof msg.text === 'string') {
          void performSend({
            from,
            to: msg.to,
            text: msg.text,
            ...(typeof msg.taskId === 'string' && { taskId: msg.taskId }),
            ...(Array.isArray(msg.attachments) && { attachments: msg.attachments }),
          }).catch((err: unknown) => ports.log(`[jean:new] ws send ${from} → ${msg.to} failed: ${String(err)}\n`))
          return
        }

        if (msg.type === 'task-comment' && typeof msg.taskId === 'string' && typeof msg.text === 'string') {
          // The role is the SESSION's, validated at register — not a lookup
          // with a `?? 'worker'` fallback, which would invent a role for an
          // agent whose record says otherwise.
          void record('task-comment', taskStream(msg.taskId), { agent: from, role: session.role, text: msg.text })
        }
      },
      close(ws) {
        const name = ws.data.name
        if (name === undefined) return
        // ONLY IF THIS SOCKET STILL OWNS THE SEAT. A replaced session's close
        // arrives after its successor registered; deleting by name would
        // evict the live one.
        if (sessions.get(name) !== ws.data.session) return
        sessions.delete(name)
        // NOT WHILE STOPPING. A shutdown closes every socket, and each close
        // would append a `disconnect` AFTER `stop` had already waited for the
        // writes it knew about — a write starting after the drain, into a
        // store the caller believes is finished with. The note costs nothing
        // to lose: `disconnect` folds to nothing, and a restart derives
        // "nobody is connected" from having no sessions rather than from the
        // log.
        if (stopping) return
        void record('disconnect', agentStream(name), { agent: name })
      },
    },
  })

  // R9's caller, and the boot order it needs: catch up on what was missed
  // while infra was down, THEN start the job table for what is still to
  // come. Both after the replay, so the registry they read is the log's.
  //
  // And guarded, for the same reason the creation sits above `Bun.serve`: a
  // throw here would leave a bound socket with no handle to close it.
  try {
    await reconcilePlaybooks()
    watchPlaybooks()
    await scheduler.catchUpOnBoot()
    scheduler.sync()
    if (options.startTimers === true) attention.start()
  } catch (err) {
    attention.stop()
    scheduler.stop()
    server.stop(true)
    throw err
  }

  ports.log(`[jean:new] listening on ${server.port}\n`)

  return {
    port: server.port ?? 0,

    async stop() {
      if (stopping) return // idempotent: a double stop must not throw
      stopping = true
      // Everything this instance holds. A server that leaks two intervals
      // and N cron jobs into the next test file is a suite that fails
      // somewhere else, for reasons that read as a product bug.
      //
      // The clocks go FIRST, so nothing new starts while the writes finish;
      // then the appends already accepted are awaited; then the socket.
      attention?.stop()
      scheduler?.stop()
      playbookWatcher?.close()
      playbookWatcher = undefined
      if (playbookDebounce !== undefined) clearTimeout(playbookDebounce)
      playbookDebounce = undefined
      // A RECONCILE IN FLIGHT is not an append in flight yet — `drain` only
      // knows about writes already inside `record`, so a scan still running
      // would append after `stop` returned (codex pass, task 106). Wait for
      // the pass, THEN for the writes it started.
      await reconciling
      await drain()
      server.stop(true)
    },

    attachSurface(surface) {
      // THE BRIDGE'S SEAT — and it goes through the SAME DOOR as a socket.
      // The first version wrote straight into `sessions`, which let a
      // surface take a reserved name, claim the orchestrator's seat beside a
      // live one, or silently evict a connected session (codex pass, task
      // 104). A surface is a session that happens to have no socket; that is
      // the only difference it gets.
      const incumbent = sessions.get(surface.name)
      const verdict = agentsModule.decideRegistration({
        name: surface.name,
        role: surface.role,
        ...(surface.sessionId !== undefined && { sessionId: surface.sessionId }),
        ...(incumbent !== undefined && {
          incumbent: { live: true, ...(incumbent.sessionId !== undefined && { sessionId: incumbent.sessionId }) },
        }),
        orchestratorConnected: [...sessions.values()].some((s) => s.role === 'sensei'),
      })
      if (verdict.kind !== 'admit' && verdict.kind !== 'replace') {
        // Loud, and at attach time: a bridge that cannot join must fail while
        // someone is watching it start, not go quiet in production.
        throw new Error(`surface "${surface.name}" refused: ${verdict.kind}`)
      }
      if (verdict.kind === 'replace' && incumbent !== undefined) incumbent.close()

      const session: Session = {
        name: surface.name,
        role: surface.role,
        ...(surface.sessionId !== undefined && { sessionId: surface.sessionId }),
        connectedAt: ports.now(),
        send: surface.deliver,
        close: () => {
          if (sessions.get(surface.name) === session) sessions.delete(surface.name)
        },
      }
      sessions.set(surface.name, session)
      // The register event is appended so the LOG shows a `user`-role agent —
      // which is what makes the channel corpus find the conversation later,
      // whether or not the bridge is connected at the time.
      void record('register', agentStream(surface.name), { agent: surface.name, role: surface.role, idle: true })
      return () => {
        if (sessions.get(surface.name) !== session) return // already replaced
        sessions.delete(surface.name)
        if (stopping) return
        void record('disconnect', agentStream(surface.name), { agent: surface.name })
      }
    },

    async postInbound(name, text, meta) {
      // The same path a WS `reply` frame takes — a bridge does not get a
      // private one. `sentAt` and `sourceId` ride because a burst of human
      // messages otherwise collapses onto one record-time and loses its
      // order.
      const taskId = tasks.activeTaskOf(taskState, name)?.id
      await record('reply', taskId === undefined ? agentStream(name) : taskStream(taskId), {
        agent: name,
        text,
        ...(meta?.sentAt !== undefined && Number.isFinite(meta.sentAt) && { sentAt: meta.sentAt }),
        ...(meta?.sourceId !== undefined && { sourceId: meta.sourceId }),
      })
      observeActivity(name)
    },

    tick() {
      attention?.runNotifier()
      attention?.runSupervisor()
    },
  }
}

/** Replay a log into the module folds — the boot path, exported so a test can
 *  drive it without a socket. */
export function replayInto(events: readonly StoredEvent[]): {
  agents: ReturnType<typeof agentsModule.initial>
  tasks: ReturnType<typeof tasks.initial>
  mail: MailboxState
  triggers: ReturnType<typeof triggers.initial>
  playbooks: ReturnType<typeof playbooks.initial>
} {
  let agentState = agentsModule.initial()
  let taskState = tasks.initial()
  let mailState = mailbox.initial()
  let triggerState = triggers.initial()
  let playbookState = playbooks.initial()
  for (const event of events) {
    agentState = agentsModule.fold(agentState, event)
    const ctx = {
      orchestrator: agentsModule.orchestratorOf(agentState),
      subscribersOf: (taskId: string) => tasks.subscribersOf?.(taskState, taskId) ?? [],
    }
    taskState = tasks.fold(
      taskState,
      event,
      (name) => agentsModule.isDojoAgent(agentState, name),
      agentsModule.orchestratorOf(agentState),
    )
    mailState = mailbox.fold(mailState, event, (e) => resolution.resolve(e, ctx))
    triggerState = triggers.fold(triggerState, event)
    playbookState = playbooks.fold(playbookState, event)
  }
  return { agents: agentState, tasks: taskState, mail: mailState, triggers: triggerState, playbooks: playbookState }
}
