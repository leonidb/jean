/**
 * The adapter — server skeleton, WS lifecycle, and the module surfaces
 * (design §5). This is the server: it holds the socket, the timers, the files
 * and the processes, and it decides nothing.
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

import { type FSWatcher, mkdirSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { agents as agentsModule } from '../domain/agents/index.ts'
import type { HeadlessConfig, HeadlessTriggerFacts } from '../domain/contracts/headless.ts'
import type { AckPair, MailboxState, Selector, ViewFacts } from '../domain/contracts/mailbox.ts'
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
import { headless } from '../domain/headless/index.ts'
import { mailbox } from '../domain/mailbox/index.ts'
import { notifier } from '../domain/notifier/index.ts'
import { playbooks } from '../domain/playbooks/index.ts'
import { resolution } from '../domain/resolution/index.ts'
import { routing } from '../domain/routing/index.ts'
import { tasks } from '../domain/tasks/index.ts'
import { triggers } from '../domain/triggers/index.ts'
import { createStore, jsonlBackend, memoryBackend, type StoredEvent } from '../es/index.ts'
import { resolveConfig } from '../infra/config.ts'
import { identityFromConfig, loadPeers, peerReach } from '../infra/peers.ts'
import { upsertDojo } from '../infra/registry.ts'
import { INFRA_IDENTITY, probeInfra, readRuntimeFiles } from '../probe.ts'
import { type Attention, type AttentionConfig, AttentionConfigError, createAttention } from './attention.ts'
import type { Caller, SurfaceContext } from './context.ts'
import type { SupervisionExecutor } from './executors.ts'
import { runHeadless } from './headless.ts'
import { attachPeers, createHosting, type Hosting, headlessPorts } from './hosting.ts'
import { scanPlaybooks } from './playbook-files.ts'
import { createScheduler, type Scheduler } from './schedule.ts'
import { knowledgeRoutes } from './surfaces/knowledge.ts'
import { apiEvent, operationRoutes } from './surfaces/operations.ts'
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
  /**
   * Run a fired headless trigger. A PORT because the spawn subsystem is
   * processes and files — and because a suite must never spawn a real
   * claude. Default: nothing runs.
   *
   * THE RECORDER IS PASSED IN, not closed over. The launcher's version used
   * to reach for the server handle, which does not exist yet while the BOOT
   * CATCH-UP is firing — and a missed nightly consolidation is fired by
   * exactly that path, so a fast failure hit a TDZ error and wrote no
   * record at all (codex pass, task 114).
   */
  runHeadless: (
    trigger: HeadlessTriggerFacts,
    config: HeadlessConfig,
    record: (type: string, stream: string, data: unknown) => Promise<StoredEvent>,
    /** ABORT, and it is `stop`'s only lever on a run in flight (task 131,
     *  ruled 2026-08-25: stop may kill it). A boot catch-up
     *  now runs BEHIND readiness rather than in front of it, so `stop` can be
     *  called while a spawn is live — and a run that outlives its instance
     *  calls `record` into a store the caller has already drained, and races
     *  the next boot's catch-up over the same log. Killing closes both, and
     *  it is what makes the handle necessary: you cannot kill what you did
     *  not keep. */
    signal?: AbortSignal,
  ) => Promise<void>
  /** What `/status` says about the chat surface. A PORT, because the bridge
   *  is a transport this server hosts rather than owns — and because the
   *  honest answer to "is one configured" comes from the config, not from
   *  whether a session happens to be attached right now. */
  bridgeStatus: () => unknown
  /** The bridge transport's health for ONE agent — undefined unless that
   *  agent IS the bridge. Asked per row rather than matched on role here:
   *  which session is the bridge is the host's knowledge, not the server's. */
  bridgeTransport: (agent: AgentName) => unknown
  /** Whether a send to ONE agent would be ATTEMPTED — undefined unless that
   *  agent IS a peer. Same shape and same reason as `bridgeTransport`: which
   *  session is a peer, and where that peer lives, is the host's knowledge.
   *  The answer must be the deliver's own predicate, never a better one
   *  (task 129). Default: nothing is a peer. */
  peerReach: (agent: AgentName) => unknown
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
  /** The headless spawn bounds. Injected whole so a suite drives the walk
   *  without waiting out a sixty-second backoff. */
  headless?: Partial<HeadlessConfig>
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
  /** Append an event through the one write path — the fold, the
   *  auto-subscriptions and the arrival hook all follow. The headless
   *  runner needs it: its records are appended by a subsystem the server
   *  hosts rather than serves. */
  recordEvent: (type: string, stream: string, data: unknown) => Promise<StoredEvent>
  /** Infra's own word to an agent, through the ordinary routing decision.
   *  The peer hop needs it: its POST is async, so a failure lands after the
   *  synchronous `delivered` the sender was already told — this is the only
   *  path by which the truth reaches them. */
  notify: (to: AgentName, text: string) => Promise<void>
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

/** The headless bounds, with the extracted defaults: the old 60s dark-wake
 *  backoff, the 20-minute spawn ceiling the port used to hold ambiently, and
 *  the pipeline's per-phase models. */
function defaultHeadless(): HeadlessConfig {
  return {
    retryBackoffMs: envMs('JEAN_HEADLESS_RETRY_BACKOFF_MS', 60_000),
    spawnTimeoutMs: envMs('JEAN_HEADLESS_TIMEOUT_MS', 1_200_000),
    librarianDraftModel: process.env.JEAN_LIBRARIAN_DRAFT_MODEL ?? 'haiku',
    librarianReviewModel: process.env.JEAN_LIBRARIAN_REVIEW_MODEL ?? 'sonnet',
  }
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
    bridgeStatus: () => ({ configured: false }),
    bridgeTransport: () => undefined,
    peerReach: () => undefined,
    runHeadless: async () => {},
    ...options.ports,
  }
  // THE LOG IS `history.jsonl`, and that one string is the switch.
  //
  // Every real dojo's events live in `<dataDir>/history.jsonl` — the old
  // server's name for the same file, in the same format (R12 replayed these
  // exact files through these exact folds). The adapter defaulted to
  // `events.jsonl` while nothing but its own tests read it, which would have
  // meant the new server booting against an EMPTY log on a dojo with months
  // of history: every projection blank, every mailbox empty, and the
  // fallback's same-log guarantee false in both directions. Caught by codex
  // fact-checking the runbook (task 110).
  const store = createStore(options.dataDir ? jsonlBackend(`${options.dataDir}/history.jsonl`) : memoryBackend())

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
      // THE PINNED PREDICATE (ruled, task 115 — the live probe-loop bug),
      // read from the tasks module rather than re-derived here. This
      // composition used to borrow a query written for messaging, whose
      // notion of engagement counted `waiting`, so every parked task's holder
      // rode the stuck clock in a probe→ack→probe loop. The status filter
      // that replaced it was correct and still a second copy of the rule;
      // this is the one place it is stated.
      const load = tasks.supervisionLoadOf(taskState, session.name)
      rows.set(session.name, {
        name: session.name,
        role,
        connected: true,
        lastActivityAt: lastActivity.get(session.name) ?? session.connectedAt,
        engaged: load.engaged,
        // OWNER-ONLY, straight from the predicate (task 132) — this composer
        // does not re-derive it, and the gap from `engaged` is the predicate's
        // to explain rather than this file's to reconcile.
        engagedTaskIds: load.engagedTaskIds,
        holdsUndone: load.holdsUndone,
        hasPendingMail: mailbox.mailboxOf(mailState, session.name).length > 0,
      })
    }
    const board = tasks.all(taskState)
    for (const task of board) {
      // OWNER OR QUEUE (codex pass, task 115): the pinned predicate names
      // both — a queue-only assigned claim (old-log shapes predate Q-1's
      // owner-setting) must still put its disconnected holder in the view.
      // A queue naming a non-agent bucket falls out at the role guard.
      //
      // EVERY task offers its names, and `newestStallingClaim` decides who
      // stays: membership is the predicate's answer, not a status filter
      // here agreeing with it. A holder of nothing but parked work has no
      // stalling claim, so it is not supervised — and that stays true
      // without this loop knowing which statuses stall.
      for (const held of [task.agent, task.queue]) {
        if (held === undefined || rows.has(held)) continue
        const role = roleOf(held)
        // An unresolvable role is an agent this dojo has no record of. The
        // supervisor would not probe it anyway; inventing `worker` to make the
        // row well-typed would be the shell deciding what it does not know.
        if (role === undefined) continue
        const load = tasks.supervisionLoadOf(taskState, held)
        // MEMBERSHIP IS THE BOARD FACT; the floor is separate evidence
        // (ruled, task 115). Holding stalling work is what puts a
        // disconnected agent here at all.
        if (!load.holdsStalling) continue
        // THE HONEST-EVIDENCE HIERARCHY. An observed act is the strongest
        // floor there is — it is a thing that happened, where a board claim
        // only dates a row. Only with neither is the row skipped: that is the
        // corrupt-log corner (a stamp our own writer never produces), and it
        // is the one place silence is the safe answer. Flooring at `now`
        // instead would read as inclusion and never accumulate quiet, so the
        // row could never alarm. Also keeps R13's promise: no NaN leaves here.
        const floor = lastActivity.get(held) ?? instant(load.newestStallingClaim, Number.NaN)
        if (!Number.isFinite(floor)) continue
        rows.set(held, {
          name: held,
          role,
          connected: false,
          // The registry forgets a session's clock; the board does not.
          lastActivityAt: floor,
          // Inert for the down branch (which keys on silence alone), set
          // honestly: this row exists BECAUSE it holds stalling work.
          engaged: load.engaged,
          engagedTaskIds: load.engagedTaskIds,
          holdsUndone: load.holdsUndone,
          hasPendingMail: mailbox.mailboxOf(mailState, held).length > 0,
        })
      }
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
    // AN EXPLICIT QUESTION OUTRANKS AMBIENT IDENTITY. `?for=` and `?agent=`
    // NAME a mailbox; the header merely says who is holding the phone — and
    // the plugin attaches it to EVERY call, so a header that won would turn
    // `?for=someone-else` into a read of the caller's own mailbox and answer
    // the wrong question without ever saying so (codex pass, task 109).
    const named =
      url.searchParams.get('for') ??
      url.searchParams.get('agent') ??
      decodeHeaderName(req.headers.get('x-jean-agent')) ??
      (claimed !== undefined && claimed.length > 0 ? claimed : undefined)
    if (named === null || named === undefined) return { connected: false }
    const session = sessions.get(named)
    const role = roleOf(named)
    return { name: named, ...(role !== undefined && { role }), connected: session !== undefined }
  }

  /**
   * The agent name off the header, decoded.
   *
   * HTTP headers are Latin-1 only, so the plugin percent-encodes the name —
   * "infra decodes", says the comment beside it — and a raw non-ASCII name
   * would otherwise make `fetch` throw on every call. Reading it undecoded
   * means an agent called `chat 42` asks after the mailbox of `chat%2042`,
   * which nobody registered: an empty inbox, forever, with nothing failing
   * (codex pass, task 109).
   *
   * A value that is not valid encoding is used AS-IS rather than refused —
   * a literal `%` in a name is far likelier than a caller trying to smuggle
   * one, and the old surface made the same call.
   */
  function decodeHeaderName(raw: string | null): string | undefined {
    if (raw === null || raw.length === 0) return undefined
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
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

  /** One event on the wire: the API shape plus its ack code and whatever
   *  this process knows about how it was handed over. */
  const wireEvent = (event: StoredEvent, code: string) => ({
    ...apiEvent(event),
    stream: event.stream,
    ...(deliveryLedger.get(event.id) !== undefined && { deliveredVia: deliveryLedger.get(event.id) }),
    code,
  })

  /**
   * The fetch rung — the ONLY response carrying ack codes, and two readings
   * of it.
   *
   * ADDRESSED (`?agent=`, `?for=`, or the `x-jean-agent` header): one agent
   * reading ITS mailbox, through the same membership the counts and summary
   * describe, so the three rungs are three renderings of one list rather
   * than three answers. It is also a DELIVERY — under P5 this is how an
   * agent obtains a code — so it stamps and reports carriage.
   *
   * OBSERVER (no identity at all — `jean status`, a dashboard): the whole
   * pending set, and NO STAMP. Stamping here would record a delivery to
   * nobody, and first-write-wins would let whichever observer looked first
   * become the recorded carrier of everyone's mail. E1 answered this read
   * with a 400 and `jean status` would have broken at the switch.
   */
  function handleFetch(req: Request, url: URL): Response {
    const caller = callerOf(req, url)
    const idsParam = url.searchParams.get('ids')
    const fromParam = url.searchParams.get('from')
    const typeParam = url.searchParams.get('type')
    const selectors = [idsParam, fromParam, typeParam].filter((p) => p !== null)
    // AT MOST ONE. Two selectors is an ambiguous question, and answering the
    // first would be the silently-ignored-parameter defect this endpoint
    // refuses everywhere else.
    if (selectors.length > 1) return json({ error: 'pass at most one selector — ids, from, or type' }, 400)

    if (caller.name === undefined) {
      if (selectors.length > 0) {
        return json({ error: 'a selector reads ONE mailbox — pass ?agent=<name> or the x-jean-agent header' }, 400)
      }
      // THE OBSERVER READ. Every pending event once, in log order — the
      // union of every mailbox, which is `pendingPairs` deduped by event.
      const seen = new Set<number>()
      const observed: StoredEvent[] = []
      for (const pair of mailbox.pendingPairs(mailState)) {
        if (seen.has(pair.eventId)) continue
        seen.add(pair.eventId)
        const held = mailbox.fetchFor(mailState, pair.recipient).find((f) => f.event.id === pair.eventId)
        if (held !== undefined) observed.push(held.event)
      }
      observed.sort((a, b) => a.id - b.id)
      return json({ events: observed.map((event) => wireEvent(event, mailbox.codeFor(event))) })
    }

    // PARSE STRICTLY, per selector. `?ids=a` used to filter out the
    // unparseable value and ask for an empty selection, which the mailbox
    // answers honestly with "nothing found" — a wrong answer to a question
    // the caller never asked (codex pass, task 101). Every token must be a
    // plain decimal, INCLUDING the empty ones a stray comma produces
    // (`1,,2`, `1,`): filtering those would quietly normalize a malformed
    // list, which is the silent-repair twin of the same defect.
    let selector: Selector | undefined
    if (idsParam !== null) {
      const tokens = idsParam.split(',').map((t) => t.trim())
      if (tokens.some((t) => !/^\d+$/.test(t))) {
        return json({ error: 'ids must be a comma-separated list of event ids, e.g. ?ids=41,42' }, 400)
      }
      const ids = [...new Set(tokens.map(Number))]
      // Past MAX_SAFE_INTEGER two distinct digit strings collapse to one
      // float, so `missing` could name ids the caller never sent.
      if (ids.some((id) => !Number.isSafeInteger(id))) return json({ error: 'ids out of range' }, 400)
      selector = { ids }
    } else if (fromParam !== null) {
      if (fromParam.length === 0) return json({ error: 'from needs a sender name' }, 400)
      selector = { from: fromParam }
    } else if (typeParam !== null) {
      if (typeParam.length === 0) return json({ error: 'type needs a summary type key' }, 400)
      selector = { type: typeParam }
    }

    // CALL: one domain function. Which of the events the caller may see is
    // the mailbox's decision, never this handler's.
    const selection =
      selector === undefined
        ? { events: mailbox.fetchFor(mailState, caller.name) }
        : mailbox.select(mailState, caller.name, selector, viewFacts())
    observeActivity(caller.name)
    // A FETCH IS CARRIAGE. The agent has now seen these events by its own
    // act, which discharges the current announcement obligation without
    // terminating the ladder — told is not done, and unhandled mail
    // re-announces on the backoff schedule (P7: seeing is not acking).
    const shown = selection.events.map((f) => f.event.id)
    stampDelivery('fetch', shown)
    attention?.carried(caller.name, shown, 'fetch')
    return json({
      events: selection.events.map((f) => wireEvent(f.event, f.code)),
      ...('missing' in selection && selection.missing !== undefined && { missing: selection.missing }),
    })
  }

  /**
   * The two cheap rungs, and the grouped view under them.
   *
   * NO ACK CODES HERE, deliberately: a code on a cheap rung would make the
   * cheap rung sufficient to CLEAR, and read-before-ack would hold only by
   * convention (P5). The identity comes from `?for=` or the header, and
   * without one there is no mailbox to describe — these rungs have no
   * observer reading.
   */
  function handleMailboxView(req: Request, url: URL, view: 'counts' | 'summary'): Response {
    const caller = callerOf(req, url)
    if (caller.name === undefined) return json({ error: 'pass ?for=<agent> or the x-jean-agent header' }, 400)
    const facts = viewFacts()
    return json(
      view === 'counts'
        ? { counts: mailbox.countsFor(mailState, caller.name, facts) }
        : { summary: mailbox.summaryFor(mailState, caller.name, facts, ports.now()) },
    )
  }

  /**
   * The grouped view — the triage payload.
   *
   * REGROUPING, NOT DECIDING. Every key here comes from the mailbox's own
   * `groupOf` classification, so the `from` and `type` keys an agent reads
   * off this view are exactly the keys `GET /events?from=`/`?type=` accepts:
   * one classification, three renderings, no translation gap. The counting
   * and the ages are aggregation for display — the same shaping
   * `renderInboxLine` does, which is why they sit beside each other.
   *
   * NOT CARRIED OVER: the old view's per-message `kinds` (photo/file/text,
   * sniffed from the text). That is a content classification no module owns,
   * no consumer parses, and inventing it here would be the adapter deciding.
   * Flagged rather than reimplemented.
   */
  function inboxOf(agent: AgentName): {
    blocking: { from: string; ids: number[]; count: number; waitedMs: number; preview: string }[]
    queued: { count: number; byType: Record<string, number>; oldestMs: number }
  } | null {
    const lines = mailbox.summaryFor(mailState, agent, viewFacts(), ports.now())
    if (lines.length === 0) return null
    const blocking = new Map<
      string,
      { from: string; ids: number[]; count: number; waitedMs: number; preview: string }
    >()
    const byType: Record<string, number> = {}
    let queued = 0
    let oldestMs = 0
    for (const line of lines) {
      if (line.group.kind === 'blocking') {
        const from = line.group.from
        const entry = blocking.get(from) ?? { from, ids: [], count: 0, waitedMs: 0, preview: '' }
        entry.ids.push(line.id)
        entry.count++
        // The OLDEST age and the LATEST preview: a ten-message burst must not
        // look fresh while the human has waited eight minutes, and the useful
        // preview is the one they sent last.
        entry.waitedMs = Math.max(entry.waitedMs, line.ageMs)
        entry.preview = line.preview
        blocking.set(from, entry)
        continue
      }
      queued++
      byType[line.group.type] = (byType[line.group.type] ?? 0) + 1
      oldestMs = Math.max(oldestMs, line.ageMs)
    }
    return { blocking: [...blocking.values()], queued: { count: queued, byType, oldestMs } }
  }

  function handleInbox(req: Request, url: URL): Response {
    const caller = callerOf(req, url)
    // FOR THE CALLER, whoever it is. A worker's `reply` travels over the
    // socket and has no response to attach a header to, which is why this
    // surface exists at all.
    const inbox = caller.name === undefined ? null : inboxOf(caller.name)
    return json({ inbox, line: caller.name === undefined ? null : renderInboxLine(caller.name) || null })
  }

  async function handleAck(req: Request, url: URL): Promise<Response> {
    const body = await parseBody(req)
    const caller = callerOf(req, url)
    if (caller.name === undefined) return json({ error: 'name the caller: ?agent= or x-jean-agent' }, 400)
    if (body === null || !Array.isArray(body.pairs)) return json({ error: 'body must be { pairs: [{id, code}] }' }, 400)
    const pairs = body.pairs.filter(
      (p): p is AckPair => Number.isInteger((p as AckPair)?.id) && typeof (p as AckPair)?.code === 'string',
    )
    // EMPTY OR ALL-MALFORMED IS A CALLER BUG — loud, not a success-shaped
    // no-op. A model that passed the wrong shape would otherwise believe it
    // acked, and be announced at forever.
    if (pairs.length === 0) return json({ error: 'pairs must contain {id, code} objects' }, 400)
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

  /**
   * THE GREET, MINTED AT REGISTRATION (task 133).
   *
   * ── AFTER THE REGISTER RECORD, NOT BESIDE IT ──
   *
   * The mailbox read must see the world the registration created. Minting
   * before the append would test a mailbox that does not yet know this agent
   * exists, and the whole mechanism is that one read: mail waiting means no
   * greet, and an empty mailbox means one.
   *
   * ── AND THE DECISION IS THE DOMAIN'S ──
   *
   * This composes the fact and performs the effect; which seats qualify and
   * what an empty mailbox implies are `greetOnRegistration`'s, pinned in its
   * conformance. The shell must not learn the role table — that is how two
   * copies of a rule start disagreeing.
   *
   * ── ORDINARY MAIL, WHICH IS WHY THERE IS NO PUSH HERE ──
   *
   * The greet is recorded and nothing else. The notifier's arrival hook then
   * announces it, the ladder repeats it, and an ack clears it, exactly as for
   * anything else in the mailbox. The previous implementation of this idea
   * was a raw `deliver` with no mailbox entry — told and unrecorded, which is
   * the shape task 053 exists to catch.
   */
  function mintGreet(agent: AgentName, role: AgentRole, session: Session): void {
    // ONLY THE SESSION THAT STILL HOLDS THE SEAT MINTS. A `replace` leaves the
    // evicted socket's `.then()` still queued, so without this both
    // registrations reach the mint and each can read the mailbox before the
    // other's greet has folded — two greets for one seat. Raised by the codex
    // round; I could NOT reproduce it in six attempts of two concurrent
    // same-session registrations (two registers, one greet, every time), so
    // the window is either very small or closed by the store's write
    // serialization. The guard goes in anyway: it is the identity check this
    // file already makes at its message and close paths two hundred lines
    // below, it costs one comparison, and "I could not make it happen" is a
    // weaker statement than the guard it would be replacing.
    if (sessions.get(agent) !== session) return
    const greet = notifier.greetOnRegistration({
      name: agent,
      role,
      pendingIds: mailbox.mailboxOf(mailState, agent).map((e) => e.id),
    })
    if (greet === undefined) return
    void record('greet', agentStream(greet.to), { agent: greet.to, queued: true })
  }

  function handleAgents(): Response {
    // R8 IN ONE LINE: `lastActivityAt` is the session's observed act or
    // nothing. The connect time is deliberately not a fallback.
    return json({
      agents: [...sessions.values()].map((s) => {
        // SNAPSHOT ONCE. The port reads a live poll counter; calling it twice
        // to test presence and then to emit lets one row's answer disagree
        // with itself across the two reads (codex pass, task 121).
        const transport = ports.bridgeTransport(s.name)
        // THE SAME SNAPSHOT-ONCE RULE, and the same nesting rule below.
        const peer = ports.peerReach(s.name)
        return {
          name: s.name,
          role: roleOf(s.name),
          // ABOUT THE SESSION, and for a peer that is a stub attached at boot
          // from `peers.json` — never a claim that the other dojo is up. It
          // said exactly that about two dead dojos while `send` refused them
          // correctly, which is task 129; the `peer` fact below is the answer,
          // and it is the sender's own predicate rather than a better one.
          connected: true,
          ...(lastActivity.get(s.name) !== undefined && { lastActivityAt: lastActivity.get(s.name) }),
          openTasks: tasks.openTaskCount(taskState, s.name),
          pending: mailbox.countsFor(mailState, s.name, viewFacts()).total,
          // NESTED, and the nesting is the point: this row's `connected` is
          // about the SESSION, and a transport `connected` beside it would be
          // two different facts under one word. Present only on the bridge.
          ...(transport !== undefined && { transport }),
          ...(peer !== undefined && { peer }),
        }
      }),
    })
  }

  // ── The surfaces ───────────────────────────────────────────────

  const surfaceContext: SurfaceContext = {
    json,
    body: parseBody,
    callerOf,
    record,
    fireTrigger: (trigger) => fireTrigger(trigger),
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
    operationRoutes(surfaceContext),
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

  // THE BOUNDS ARE CONFIGURATION, validated before anything can spawn: an
  // infinite backoff never comes due and a zero timeout kills every run.
  const headlessConfig: HeadlessConfig = { ...defaultHeadless(), ...options.headless }
  const headlessValid = headless.validateConfig(headlessConfig)
  if (!headlessValid.ok) {
    throw new AttentionConfigError(`invalid headless configuration: ${headlessValid.refusal.field}`)
  }

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
  async function fireTrigger(trigger: Trigger, opts?: { awaitRun?: boolean; signal?: AbortSignal }): Promise<void> {
    await record('trigger-fired', TRIGGERS_STREAM, triggers.fireData(trigger))
    if (trigger.kind !== 'headless') return
    const run = ports.runHeadless(
      {
        id: trigger.id,
        kind: trigger.kind,
        agent: trigger.agent,
        prompt: trigger.prompt,
        ...(trigger.model !== undefined && { model: trigger.model }),
        ...(trigger.retries !== undefined && { retries: trigger.retries }),
      },
      headlessConfig,
      record,
      // ONLY THE BOOT CATCH-UP CARRIES ONE. An ordinary cron firing outlives
      // nothing in particular and `stop` has no claim on it; the catch-up is
      // the run that can still be in flight when `stop` is called, because it
      // is the one readiness stopped waiting for.
      opts?.signal,
    )
    // THE FIRING IS THE EVENT; THE RUN IS A PROCESS — normally detached,
    // because a consolidation is half an hour and the trigger that started
    // it is one appended event.
    //
    // EXCEPT ON CATCH-UP. Several triggers can be overdue after a laptop was
    // shut, and launching their spawns in parallel is a stampede of Claude
    // processes on one machine; the old startup loop awaited each headless
    // run for exactly this reason (codex pass, task 114).
    if (opts?.awaitRun === true) {
      await run.catch((err: unknown) => ports.log(`[jean:new] headless ${trigger.id} failed: ${String(err)}\n`))
      return
    }
    void run.catch((err: unknown) => ports.log(`[jean:new] headless ${trigger.id} failed: ${String(err)}\n`))
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
    fire: (trigger, opts) => fireTrigger(trigger, opts),
  })

  /**
   * The identity probe — `GET /`.
   *
   * Not on the inventory's blocker list and found while grepping for the
   * others: `probeInfra` fetches this to decide whether a jean infra is
   * running at a port, and EVERY CLI command goes through that discovery.
   * Without it the new server answers 404, the probe reads null, and the
   * operator is told the infra is not running — while it serves every other
   * route perfectly.
   */
  function handleIdentity(): Response {
    return json({
      name: INFRA_IDENTITY,
      dataDir: options.dataDir ?? '',
      pid: process.pid,
      port: server.port ?? 0,
    })
  }

  /** The operator's first command. Identity, who is connected, and the two
   *  numbers that say whether anything is backed up. */
  function handleStatus(): Response {
    const orchestrator = orchestratorOf()
    const seated = orchestrator === undefined ? undefined : sessions.get(orchestrator)
    return json({
      name: INFRA_IDENTITY,
      dataDir: options.dataDir ?? '',
      pid: process.pid,
      port: server.port ?? 0,
      agents: [...sessions.values()].map((session) => ({ name: session.name, role: roleOf(session.name) })),
      sensei: seated === undefined ? { connected: false } : { connected: true, name: orchestrator },
      // Every pending PAIR is one agent's copy; the count operators care
      // about is how many events are unhandled somewhere.
      pendingEvents: new Set(mailbox.pendingPairs(mailState).map((pair) => pair.eventId)).size,
      activeTriggers: triggers.all(triggerState).filter((t) => t.status === 'active').length,
      // FROM THE PORT, not inferred from live sessions. A configured bridge
      // that has not attached yet — or has died — is `configured: true` and
      // disconnected, which is the distinction an operator reading this at
      // 3am actually needs; inferring it from whether a `user` session exists
      // answers a different question and calls it the same name.
      bridge: ports.bridgeStatus(),
    })
  }

  /** The routing table — the only conditionals here dispatch on route or
   *  method. Split out of `fetch` so the piggyback wraps every answer,
   *  including the 404. */
  async function route(req: Request, url: URL): Promise<Response> {
    if (url.pathname === '/' && req.method === 'GET') return handleIdentity()
    if (url.pathname === '/status' && req.method === 'GET') return handleStatus()
    if (url.pathname === '/send' && req.method === 'POST') return handleSend(req, url)
    if (url.pathname === '/events' && req.method === 'GET') return handleFetch(req, url)
    if (url.pathname === '/events/counts' && req.method === 'GET') return handleMailboxView(req, url, 'counts')
    if (url.pathname === '/events/summary' && req.method === 'GET') return handleMailboxView(req, url, 'summary')
    if (url.pathname === '/inbox' && req.method === 'GET') return handleInbox(req, url)
    // TWO PATHS, ONE HANDLER. The channel plugin ships separately from the
    // server and POSTs `/events/ack`; the adapter's own name for it is
    // `/ack`. The compat route lives here because the server is the half
    // that can be upgraded — an alias, never a second implementation.
    if ((url.pathname === '/ack' || url.pathname === '/events/ack') && req.method === 'POST') {
      return handleAck(req, url)
    }
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
          }).then(() => {
            ws.send(JSON.stringify({ type: 'registered', agent: msg.agent }))
            mintGreet(msg.agent as AgentName, role as AgentRole, session)
          })
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
          // THE RECORDING RULE (vocabulary.ts, ruled task 116): an untagged
          // reply records to the agent's own stream. There is no fallback to
          // whatever task the agent happens to hold — deliberate task-scoping
          // is the caller's to claim, and `comment` is the durable
          // task-writing verb.
          //
          // A SENSEI'S REPLY REACHES NOBODY, and no rule here says so: §4
          // resolves `reply` to the orchestrator and then removes the author,
          // so an orchestrator's own reply resolves empty and becomes history.
          // The old server carried an explicit drop for this; under the
          // rewrite it is a consequence of the table.
          const stream = msg.taskId === undefined ? agentStream(from) : taskStream(msg.taskId)
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
    // NOT AWAITED — the whole of task 131 (ruled 2026-08-25: readiness must
    // not wait for the headless run). This line used to be `await`ed, so
    // READINESS — every runtime file below, both attention clocks, the
    // bridge, peer attach and the registry upsert — waited on a headless
    // spawn. On
    // 2026-08-24 that was seven minutes with the dojo live and doorless, its
    // own errors pointing in a circle: `agent start` said "start infra
    // first", `infra start` said "already running".
    //
    // The catch-up still runs, still serialized, still fires the whole
    // overdue backlog. What changed is who waits for it: nobody. Its promise
    // is held by the scheduler so `stop` can kill it — see `Scheduler.stop`,
    // and note this is a kill and not a drain, because a stop that waited out
    // a consolidation is the same hostage-taking at the other end.
    //
    // A rejection here would otherwise be an unhandled rejection on a path
    // nobody awaits, so it is said out loud instead — the loud direction this
    // file takes everywhere else.
    void scheduler.catchUpOnBoot().catch((err: unknown) => {
      ports.log(`[jean:new] boot catch-up failed: ${String(err)}\n`)
    })
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
      //
      // ALWAYS THE AGENT'S OWN STREAM (ruled task 116). Human speech is never
      // task-filed: there is no taskId to carry on this path and no inference
      // to make from one — a person who means a task says so.
      await record('reply', agentStream(name), {
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

    recordEvent: (type, stream, data) => record(type, stream, data),

    async notify(to, text) {
      await performSend({ from: 'infra', to, text })
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

// ── CLI entrypoint ────────────────────────────────────────────────
//
// Everything above is a library; this is the only part that runs when the file
// is executed directly — `bun run src/adapter/server.ts`, which is what
// `jean infra start` spawns. It mirrors the old server's launcher: resolve the
// data dir, enforce one instance per dojo, bind, write the runtime files the
// CLI polls for, and sweep them on the way out.

/** Remove a dojo's runtime files. Best-effort in both directions: a file that
 *  is not there is the normal case on a clean exit path that already ran. */
function cleanupRuntimeFiles(dataDir: string): void {
  for (const name of ['infra.port', 'infra.pid']) {
    try {
      unlinkSync(resolvePath(dataDir, name))
    } catch {}
  }
}

/**
 * Refuse to start, in the old server's words.
 *
 * The message matters as much as the refusal: an operator who typed `jean
 * infra start` twice needs to be told which of the two things happened —
 * their own dojo is already up, or something else owns the port.
 */
class InfraStartError extends Error {}

/**
 * One instance per dojo.
 *
 * ONE PROBE, AND THEN THE REAL BIND IS THE TEST. The old launcher also
 * SPECULATIVELY bound the port and released it to see whether it was free —
 * and that probe bound `127.0.0.1` while the server itself binds the
 * wildcard, so the two are not the same question. Measured on the boot
 * check: with an unrelated process listening on `*:8791` over IPv6, the
 * speculative bind SUCCEEDED on IPv4 loopback, the real bind then failed,
 * and the operator got a raw `EADDRINUSE` stack trace instead of the
 * sentence this function exists to produce. Letting the one real bind answer
 * the question makes a mismatch impossible.
 */
async function enforceSingleInstance(dataDir: string, port: number): Promise<void> {
  const live = await probeInfra(port)
  if (live?.name === INFRA_IDENTITY) {
    const sameDojo = live.dataDir === '' || live.dataDir === dataDir
    throw new InfraStartError(
      sameDojo
        ? `Infrastructure already running for this dojo (pid ${live.pid}, port ${port}). Use "jean infra stop" first.`
        : `Port ${port} is held by another dojo's infra (${live.dataDir}). Set a different \`port\` in jean.config.json.`,
    )
  }
  // Nothing jean-shaped is answering, so any pid/port files still sitting
  // there are a crash's leftovers rather than a running server's.
  const { pid: stale } = readRuntimeFiles(dataDir)
  if (stale !== null) {
    process.stderr.write(`[jean:new] cleaning up stale pid/port files (pid ${stale})\n`)
    cleanupRuntimeFiles(dataDir)
  }
}

/** The bind, with its one expected failure renamed. Anything else is a bug
 *  and keeps its stack. */
async function startOrRefuse(options: ServerOptions & { port: number }): Promise<AdapterHandle> {
  try {
    return await createAdapterServer(options)
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
      throw new InfraStartError(`Port ${options.port} is in use by something that is not a jean infra.`)
    }
    throw err
  }
}

if (import.meta.main) {
  const dataDir = resolvePath(process.env.JEAN_DATA_DIR ?? '.')
  // `resolveConfig`, not `readConfig`: the env overrides the file, and
  // `JEAN_PORT` is how an operator moves a dojo off a taken port without
  // editing its config. Reading the file alone would bind and probe the
  // wrong port while looking like it obeyed (codex pass, task 111).
  const config = resolveConfig(dataDir)
  const port = config.port ?? 8700
  try {
    await enforceSingleInstance(dataDir, port)

    // The bridge is selected before the server exists, because `/status` must
    // be able to answer "is one configured" from the first request — hosting
    // holds it and hands the answer over as a port.
    let hosting: Hosting | undefined
    // ONE SNAPSHOT OF THE PEER REGISTRY, read here and used by both halves.
    // The registry is static until restart — `jean peer add` requires a stop
    // and start, and the old wiring said so in as many words — so a
    // per-send re-read would let the ENRICHMENT see a peer that outbound
    // routing has no session for, and disagree with itself between two
    // reads of one file (codex pass, task 113).
    const peers = loadPeers(dataDir).peers
    const infra = await startOrRefuse({
      dataDir,
      port,
      // THE TIMERS RUN IN PRODUCTION. Off by default because a test suite
      // must not inherit a clock; on here, because without them nothing ever
      // announces and the whole attention system is inert.
      startTimers: true,
      ports: {
        log: (line) => process.stderr.write(line),
        bridgeStatus: () => hosting?.bridgeStatus() ?? { configured: false },
        bridgeTransport: (agent) => hosting?.transportFor(agent),
        // THE RECEIVER'S OWN DESCRIPTION of a peer — from this dojo's
        // registry, never from the message, which is the routing contract's
        // enrichment rule in one line.
        peerDescriptionOf: (name) => peers[name]?.description,
        // THE SENDER'S OWN PREDICATE, asked without sending — so a row and a
        // send cannot answer differently about the same peer (task 129).
        peerReach: (name) => {
          const peer = peers[name]
          return peer === undefined ? undefined : peerReach(peer)
        },
        // THE SPAWN SUBSYSTEM, and only in production: a run is processes
        // and files, so a suite gets the default no-op and drives the walk
        // against stubs instead.
        runHeadless: (trigger, headlessConfig, record, signal) =>
          runHeadless(
            trigger,
            headlessConfig,
            headlessPorts({
              dataDir,
              now: () => Date.now(),
              log: (line) => process.stderr.write(line),
              record: (data) => record('headless-completed', TRIGGERS_STREAM, data),
              recordConsolidated: (data) => record('wiki-consolidated', SYSTEM_STREAM, data),
            }),
            signal,
          ),
      },
    })

    // ── THE HANDLERS ARE ARMED HERE, AND NOT EARLIER ──
    //
    // The old launcher armed them immediately BEFORE its single-instance
    // check, and that ordering has a bite: a second `jean infra start`
    // refuses, exits, and its exit handler sweeps the runtime files of the
    // server that is still running — leaving a live infra that no CLI
    // command can discover. Arming after a successful bind keeps every
    // property the old comment names (a crash still cleans up; a failure
    // before the bind still leaves the files alone) and drops that one.
    // Deliberate deviation from "mirror the old block"; flagged in handover.
    process.on('exit', () => cleanupRuntimeFiles(dataDir))
    process.on('SIGINT', () => process.exit(0))
    process.on('SIGTERM', () => process.exit(0))

    // ── PEERS BEFORE THE READINESS SIGNAL ──
    //
    // The port file's appearance is what tells the CLI the dojo is up, so
    // everything a first request could need must already be true. Peers
    // attach SYNCHRONOUSLY and cost nothing, and a send arriving in the gap
    // would find no session and record `delivered: false` about a peer that
    // is perfectly reachable (codex pass, task 113).
    attachPeers(infra, peers, (line) => process.stderr.write(line), identityFromConfig(dataDir))

    writeFileSync(resolvePath(dataDir, 'infra.port'), String(infra.port))
    writeFileSync(resolvePath(dataDir, 'infra.pid'), String(process.pid))
    // A convenience, and never a reason to fail a start.
    try {
      upsertDojo({ path: resolvePath(dataDir, '..'), port: infra.port, identity: config.identity })
    } catch {}

    // ── THE BRIDGE AFTER IT ──
    //
    // Its `start` resolves when the TRANSPORT does, which is a network round
    // trip and sometimes a long one. A dojo must be discoverable while its
    // chat surface is still shaking hands, and a transport that never
    // connects must not take the dojo with it — the old launcher put it here
    // for the same reason.
    hosting = createHosting(infra, config, dataDir, (line) => process.stderr.write(line))
    void hosting.start().catch((err: unknown) => {
      process.stderr.write(`[jean:new] bridge failed to start: ${String(err)}\n`)
    })
  } catch (err) {
    if (err instanceof InfraStartError) {
      process.stderr.write(`${err.message}\n`)
      process.exit(1)
    }
    throw err
  }
}
