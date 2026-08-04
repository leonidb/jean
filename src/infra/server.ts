#!/usr/bin/env bun

/**
 * Jean infrastructure service.
 *
 * Bun HTTP/WebSocket server that:
 * - Accepts connections from agents via WebSocket or external channels (Slack)
 * - Routes messages between connected agents (transport-agnostic)
 * - Manages task state derived from events (event sourcing)
 * - Queues actionable events for the sensei and delivers them reactively
 * - Receives stop hook notifications (agent went idle)
 *
 * No LLM — fast, deterministic plumbing.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { Cron } from 'croner'
import {
  createProjection,
  createStore,
  type EventStore,
  fileSnapshotBackend,
  jsonlBackend,
  type StoredEvent,
} from '../es/index.ts'
import { INFRA_IDENTITY, type InfraInfo, probeInfra, readRuntimeFiles } from '../probe.ts'
import { type Board, canTransition, type TaskStatus } from './board.ts'
import { type Bridge, selectBridge } from './bridge.ts'
import { resolveConfig } from './config.ts'
import { resolveConnectors } from './connectors/config.ts'
import { SourceQueue } from './connectors/queue.ts'
import { createSourceConnector, sourceContext } from './connectors/source.ts'
import type { AttentionView } from './core/attention.ts'
import { createAttentionListener } from './core/attention-listener.ts'
import { createEventBus } from './core/bus.ts'
import { createDeliveryLedger } from './core/ledger.ts'
import { claimAckIds, confirmAutoClear, decideAutoClear } from './core/pre-append.ts'
import {
  inboxFor,
  blockingPendingFrom as queueBlockingPendingFrom,
  hasBlockingPending as queueHasBlockingPending,
  isBlockingEvent as queueIsBlockingEvent,
  pendingByAgent as queuePendingByAgent,
  pendingEvents as queuePendingEvents,
  resolveAgent as queueResolveAgent,
  type RoleOf,
  type TaskOwner,
} from './core/queue.ts'
import { planTriggers } from './core/triggers.ts'
import { renderInboxLine } from './inbox.ts'
import { commitConsolidation, type LibrarianPhase, recoverWikiLayout } from './librarian.ts'
import { type AgentSession, classifySession, envMs } from './liveness.ts'
import { createPeerDeliver, identityFromConfig, loadPeers, type Peer, peerLiveness } from './peers.ts'
import { ambientPorts, type InfraPorts } from './ports.ts'
import {
  AGENT_ROLES,
  type AgentRole,
  type CreateTaskRequest,
  type DeliverMsg,
  type InboundMsg,
  type OutboundMsg,
  type SendRequest,
  type UpdateStatusRequest,
  type UpdateTaskRequest,
} from './protocol.ts'
import {
  type AckData,
  type AgentIdleData,
  agentStream,
  boardReducer,
  type ClearedBy,
  type DeliveredVia,
  type HeadlessCompletedData,
  MEMORY_STREAM,
  type MemoryData,
  type MemoryScope,
  migrateBoard,
  type NudgeData,
  type PendingState,
  type PermissionRequestData,
  PLAYBOOKS_STREAM,
  type PlaybookCreatedData,
  type PlaybookRemovedData,
  type PlaybookState,
  type PlaybookUpdatedData,
  pendingReducer,
  playbookReducer,
  type RegisterData,
  type ReplyData,
  type SendData,
  type StartData,
  SYSTEM_STREAM,
  type TaskCommentData,
  type TaskCreatedData,
  type TaskRevertedData,
  type TaskStatusData,
  type TaskUpdatedData,
  TRIGGERS_STREAM,
  type Trigger,
  type TriggerCreatedData,
  type TriggerFiredData,
  type TriggerKind,
  type TriggerRemovedData,
  type TriggerState,
  type TriggerUpdatedData,
  taskIdFromStream,
  taskStream,
  toApiEvent,
  triggerReducer,
  type WikiConsolidatedData,
} from './reducers.ts'
import { upsertDojo } from './registry.ts'
import { buildIndex, search as runSearch, type SearchDoc, type SearchResult } from './retrieval.ts'
import { channelDocs, memoryDocs, type RecentMemory, type TaskInput, taskDocs, wikiDocs } from './retrieval-corpus.ts'
import { shouldCatchUp } from './trigger-catchup.ts'

/** Thrown by `createInfraServer` when the port cannot be claimed — the
 *  in-process form of what `refuseStart` used to do with `process.exit(1)`.
 *  The stderr text is already written by the time this is thrown (byte-identical
 *  to before); the CLI entrypoint at the bottom of this file turns it back into
 *  an exit code 1, so the spawned-server behaviour is unchanged. */
export class InfraStartError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InfraStartError'
  }
}

export type CreateInfraServerOptions = {
  /** Dojo `.jean` directory. Defaults to `$JEAN_DATA_DIR` (then cwd) — exactly
   *  what this module used to resolve at import time. */
  dataDir?: string
  /** Port to bind. `0` asks the OS for an ephemeral one; read the real port
   *  back from the handle. Defaults to the configured port, then 8700. */
  port?: number
  /** Refuse to start when something already holds the port, and sweep stale
   *  pid/port files. Default `true` — the CLI's behaviour.
   *
   *  MUST be `false` when `port: 0`: probing an ephemeral port is meaningless,
   *  and the stale-file sweep would unlink a live dojo's infra.pid/infra.port. */
  enforceSingleInstance?: boolean
  /** Write `infra.port`/`infra.pid` and self-register the dojo in the
   *  machine-global registry. Default `true` — the CLI's behaviour. In-process
   *  callers want `false`; that registry is shared by every dojo on the box. */
  writeRuntimeFiles?: boolean
  /** Override any subset of the port set — the ambient effects this server
   *  reaches for (clock, stderr, SSE fan-out, headless spawn, event store).
   *  Anything omitted keeps its default, and every default IS today's ambient
   *  behaviour, so `{}` and "not passed at all" are the same server. See
   *  ports.ts, including the position rule that governs `now`.
   *
   *  Replaces stage 1's standalone `spawnHeadless` option: one injection
   *  mechanism, not two. `ports.spawn` is the same knob under its port name. */
  ports?: Partial<InfraPorts>
  /** Fired at ONE precise moment: after the store and projections are up, and
   *  immediately before the single-instance check. That is exactly where the
   *  pre-refactor module body registered its process.on('exit'|'SIGINT'|
   *  'SIGTERM') handlers, and the CLI entrypoint uses this to register them at
   *  the identical point rather than earlier.
   *
   *  Why it has to be a hook and not just "register before calling the factory":
   *  the split matters on failure. A startup that dies BEFORE here — a malformed
   *  history.jsonl is the concrete path, since the JSONL backend JSON.parses
   *  every line — left the runtime files alone before this refactor. Arming the
   *  sweep any earlier would let a crashing second process delete a LIVE
   *  instance's infra.pid/infra.port. Fires regardless of
   *  `enforceSingleInstance`: it marks a position in startup, not the check. */
  onBeforeSingleInstanceCheck?: () => void
}

export type InfraHandle = {
  /** The port actually bound — resolved, so it is meaningful under `port: 0`. */
  port: number
  /** The data dir this instance is running against. */
  dataDir: string
  /** Release everything this instance holds: both intervals, every scheduled
   *  cron job, the playbook watcher and its debounce, pending register
   *  greetings, and the listening socket. Removes the runtime files too, if
   *  this instance wrote them. Idempotent.
   *
   *  KNOWN INCOMPLETE, and not fixable here: a configured chat bridge
   *  (`initBridge`) or source connector (`initSources`) keeps running. Neither
   *  interface has a stop — `Bridge` exposes only `start`, and a source
   *  connector only `start`/`connected` — so their long-polls today end when the
   *  process does. That is unchanged from before this refactor, and inert unless
   *  a bridge or connector is actually configured, but it does mean an
   *  in-process caller must not configure one and expect stop() to be complete.
   *  Giving those two interfaces a stop is its own piece of work. */
  stop: () => Promise<void>
}

/** Remove a dojo's infra.port/infra.pid. Module scope rather than closure state
 *  so the entrypoint can arm it on `process.on('exit')` BEFORE the factory runs
 *  — preserving today's ordering, in which a refused duplicate start still
 *  sweeps the files on its way out. */
function cleanupRuntimeFiles(dataDir: string) {
  try {
    unlinkSync(resolve(dataDir, 'infra.port'))
  } catch {}
  try {
    unlinkSync(resolve(dataDir, 'infra.pid'))
  } catch {}
}

/**
 * Build and start one infra instance.
 *
 * This is the file's former module body, verbatim: every `const`/`let` that used
 * to be file-scope is now closure state, so a second instance in the same
 * process is possible for the first time. Review with `git diff -w` — the bulk
 * of the diff is re-indentation.
 */
export async function createInfraServer(opts: CreateInfraServerOptions = {}): Promise<InfraHandle> {
  // Options are resolved ONCE, here at the top of the factory body. Several
  // inner functions take their own `opts` parameter (runHeadlessAttempt,
  // runPhaseWithRetries) and shadow this one — reading `opts.x` deeper in the
  // body would silently read the wrong object.
  const shouldEnforceSingleInstance = opts.enforceSingleInstance !== false
  const shouldWriteRuntimeFiles = opts.writeRuntimeFiles !== false
  const portOverride = opts.port
  const onBeforeSingleInstanceCheck = opts.onBeforeSingleInstanceCheck

  const DATA_DIR = resolve(opts.dataDir ?? process.env.JEAN_DATA_DIR ?? '.')
  const config = resolveConfig(DATA_DIR)
  const HISTORY_PATH = resolve(DATA_DIR, 'history.jsonl')
  const SNAPSHOT_DIR = DATA_DIR

  // ── Ports ────────────────────────────────────────────────────────
  //
  // Bound ONCE, here, and thereafter called as `ports.x()` at each original
  // call site. Binding the functions early and calling them late is the whole
  // trick: the reference is captured at construction, but every VALUE is still
  // read at the moment the old ambient call read it. Deliberately NOT
  // destructured into bare `now`/`log` locals — `record()`'s route handler and
  // the startup catch-up block both declare their own `const now`, and a
  // factory-scope `now` would be shadowed by one and collide with the other.
  //
  // Four of the defaults are PER-INSTANCE and so cannot live in `ambientPorts`:
  // `store` is bound to this dojo's history.jsonl, `deliver` closes over this
  // instance's agent registry, and `schedule`/`unschedule` over its croner job
  // table. All four are function declarations or already-built values, so
  // referencing them here — above their definitions — is safe.
  const ports: InfraPorts = {
    now: opts.ports?.now ?? ambientPorts.now,
    log: opts.ports?.log ?? ambientPorts.log,
    spawn: opts.ports?.spawn ?? ambientPorts.spawn,
    probe: opts.ports?.probe ?? ambientPorts.probe,
    store: opts.ports?.store ?? createStore(jsonlBackend(HISTORY_PATH)),
    deliver: opts.ports?.deliver ?? deliverToAgent,
    schedule: opts.ports?.schedule ?? startCronJob,
    unschedule: opts.ports?.unschedule ?? stopCronJob,
  }

  // Chat bridge (Telegram / Slack, optional) — selected from config, wired at
  // startup by initBridge(). Null when no surface is configured.
  const bridge: Bridge | null = selectBridge(config)

  // ── Event store & projections ────────────────────────────────────

  const store: EventStore = ports.store

  const boardProjection = createProjection<Board>({
    name: 'board',
    store,
    reducer: boardReducer,
    initial: { tasks: [] },
    filter: { types: ['task-created', 'task-status', 'task-updated', 'task-reverted'] },
    snapshots: fileSnapshotBackend(SNAPSHOT_DIR),
    snapshotEvery: 50,
    migrate: migrateBoard,
  })

  const pendingProjection = createProjection<PendingState>({
    name: 'pending',
    store,
    reducer: pendingReducer,
    initial: [],
    filter: {
      types: [
        'reply',
        'task-comment',
        'register',
        'disconnect',
        'task-created',
        'trigger-fired',
        'playbook-created',
        'playbook-updated',
        'playbook-removed',
        'ack',
        'wiki-consolidated',
      ],
    },
  })

  const lastTaskContext = createProjection<Map<string, string>>({
    name: 'lastTaskContext',
    store,
    reducer: (state, event) => {
      if (event.type === 'send') {
        const taskId = taskIdFromStream(event.stream)
        const agent = (event.data as Record<string, unknown>)?.agent as string | undefined
        if (taskId && agent) {
          const next = new Map(state)
          next.set(agent, taskId)
          return next
        }
      }
      return state
    },
    initial: new Map(),
    filter: { types: ['send'] },
  })

  /**
   * Last event timestamp per task — the board's staleness signal (attention
   * phase 4; Leonid's housekeeping addition, 2026-07-25). Anything on a task's
   * stream counts as activity: status moves, comments, and the task-scoped
   * send/reply traffic that is what "someone is actually on this" looks like.
   *
   * A SEPARATE projection on purpose: the board projection is snapshotted and
   * migrated, and a surfacing-only field has no business perturbing its stored
   * shape. Costs one startup replay; no snapshot needed.
   */
  const taskActivity = createProjection<Map<string, string>>({
    name: 'taskActivity',
    store,
    reducer: (state, event) => {
      const taskId = taskIdFromStream(event.stream)
      if (!taskId) return state // reply/send also land on agent- streams
      const next = new Map(state)
      next.set(taskId, event.ts)
      return next
    },
    initial: new Map(),
    filter: {
      types: ['task-created', 'task-status', 'task-updated', 'task-reverted', 'task-comment', 'reply', 'send'],
    },
  })

  /** How long an in-progress task may go without a single event on its stream
   *  before /board flags it `stale`. A day is deliberately generous: workers go
   *  legitimately silent for hours on file/git/test work, and the target here is
   *  the forgotten task, not the quiet one. Env-tunable (tests shrink it).
   *  (Considered and rejected: flagging on the WORKER's quiet threshold instead —
   *  it fires on healthy 45-min silences. Both signals are surfaced separately —
   *  `session` on /agents, `lastEventAt` here — so the sensei can still combine
   *  them by judgment.) */
  const STALE_TASK_MS = envMs('JEAN_STALE_TASK_MS') ?? 24 * 60 * 60_000

  const triggerProjection = createProjection<TriggerState>({
    name: 'triggers',
    store,
    reducer: triggerReducer,
    initial: { triggers: [] },
    filter: { stream: TRIGGERS_STREAM },
    snapshots: fileSnapshotBackend(SNAPSHOT_DIR),
    snapshotEvery: 20,
  })

  const playbookProjection = createProjection<PlaybookState>({
    name: 'playbooks',
    store,
    reducer: playbookReducer,
    initial: { playbooks: [] },
    filter: { stream: PLAYBOOKS_STREAM },
  })

  // ── The bus ──────────────────────────────────────────────────────
  //
  // Registration order IS the order `record()` used to apply, one for one. Read
  // core/bus.ts before changing it: the dispatch tail reads post-apply
  // projection state, so ordering here is semantics. Commit 2 appends the
  // attention listener, which must stay LAST for that reason.
  //
  // The wrappers exist only because `Projection<S>` carries no `name` and its
  // `apply` returns the new state; a subscriber is `{name, apply(): void}`.
  //
  // SIX subscribers, matching catchUp()'s six. `record()` applied only five
  // until 2026-08 — `lastTaskContext` was folded at boot and never live, which
  // froze `inferTaskId()`'s fallback until restart (fixed in commit 0.5; see
  // task-context.test.ts). Naming the list is what made the discrepancy visible.
  const bus = createEventBus()
  bus.subscribe({ name: 'board', apply: (e) => void boardProjection.apply(e) })
  bus.subscribe({ name: 'pending', apply: (e) => void pendingProjection.apply(e) })
  bus.subscribe({ name: 'lastTaskContext', apply: (e) => void lastTaskContext.apply(e) })
  bus.subscribe({ name: 'taskActivity', apply: (e) => void taskActivity.apply(e) })
  bus.subscribe({ name: 'triggers', apply: (e) => void triggerProjection.apply(e) })
  bus.subscribe({ name: 'playbooks', apply: (e) => void playbookProjection.apply(e) })

  // ── The attention listener — REGISTERED LAST, and that is semantics ───
  //
  // It decides against POST-apply projection state (what is pending now, what
  // is blocking now), so every projection above must have run first. See
  // core/bus.ts. Its decisions are pure (core/attention.ts); this executor is
  // the only thing that touches the world, and it never decides anything —
  // `run()` in the listener owns the commit-iff-landed sequence.
  const attention = createAttentionListener({
    deliver: (to, text) => ports.deliver(to, { type: 'deliver', from: 'infra', text }),
    markBusy: (agent) => {
      const entry = agents.get(agent)
      if (entry) entry.idle = false
    },
    stamp: (via) => stampDelivery(via),
    emitNudge: (data) => void record('nudge', SYSTEM_STREAM, data satisfies NudgeData),
  })
  bus.subscribe({
    name: 'attention',
    // `hadBlockingBefore` is the pre-append capture from record() (race guard
    // 1) — it rides the publish context because no subscriber can reconstruct
    // it after the fact.
    apply: (e, ctx) => attention.onEvent(e, viewNow(ports.now()), ctx.hadBlockingPending),
  })

  // Replay folds the projections DIRECTLY and never touches the bus — the
  // structural separation that stops a restart re-emitting historical effects.
  // See core/bus.ts, "REPLAY NEVER PUBLISHES".
  await boardProjection.catchUp()
  await pendingProjection.catchUp()
  await lastTaskContext.catchUp()
  await taskActivity.catchUp()
  await triggerProjection.catchUp()
  await playbookProjection.catchUp()

  // ── Agent registry (transport-agnostic) ──────────────────────────

  type AgentEntry = {
    role: AgentRole
    idle: boolean
    sessionId?: string
    tags: string[]
    deliver: (msg: DeliverMsg) => boolean
    close?: () => void
    /** True while the underlying transport is still open. Used to distinguish
     *  a legitimate reconnect (old WS is dead) from a concurrent duplicate (old
     *  WS is still live — two `jean agent start <name>` processes fighting for
     *  the same slot). Peers and other non-WS agents have no live check. */
    isLive?: () => boolean
    /** Epoch ms of the last INBOUND traffic observed from this agent — any WS
     *  frame, any HTTP call carrying `x-jean-agent`, its `/agent-idle` posts, its
     *  register. Attention phase 4 (docs/attention.md §3): liveness is INFERRED
     *  from traffic infra already sees, never declared by a hook. Read-time only
     *  — see sessionOf(); it must never gate delivery. */
    lastActivityAt?: number
  }

  const agents = new Map<string, AgentEntry>()

  // Local dojo's identity — used as the `from` field on outbound peer sends, and
  // as the key under which peers look us up. Falls back to basename of dojo root.
  const MY_IDENTITY = identityFromConfig(DATA_DIR)

  // Registered peers — loaded once at startup. Each peer becomes a synthetic
  // entry in the `agents` map (role='peer') whose deliver() does an HTTP POST to
  // the peer's infra /send. Registry is static until restart — `jean peer add`
  // requires `jean infra stop` + start to take effect (acceptable for MVP).
  const peers = new Map<string, Peer>()
  {
    const loaded = loadPeers(DATA_DIR)
    for (const [identity, peer] of Object.entries(loaded.peers)) {
      peers.set(identity, peer)
      const peerDeliver = createPeerDeliver({
        peer,
        myIdentity: MY_IDENTITY,
        peerName: identity,
        onUndelivered: (sender, reason) => notifyUndelivered(sender, identity, reason),
      })
      agents.set(identity, {
        role: 'peer',
        idle: true,
        tags: [],
        deliver: (msg) => peerDeliver({ from: msg.from, text: msg.text, taskId: msg.taskId }),
      })
    }
    if (peers.size > 0) {
      ports.log(`[jean] loaded ${peers.size} peer(s): ${[...peers.keys()].join(', ')}\n`)
    }
  }

  /** The connected sensei, by NAME as well as entry: the name is what keys the
   *  attention state and what `ports.deliver` addresses, so every sensei push
   *  goes through the one port rather than reaching into the entry. */
  function findSensei(): { name: string; entry: AgentEntry } | undefined {
    for (const [name, entry] of agents) {
      if (entry.role === 'sensei') return { name, entry }
    }
    return undefined
  }

  /** The DEFAULT implementation of the `deliver` port (ports.ts). Call sites go
   *  through `ports.deliver`, which is this unless something was injected. */
  function deliverToAgent(agentName: string, msg: DeliverMsg): boolean {
    const entry = agents.get(agentName)
    if (!entry) return false
    return entry.deliver(msg)
  }

  // ── Observed liveness (attention phase 4 — docs/attention.md §3) ──
  //
  // "Talked to me 8s ago" replaces the hook-set flag. Infra bumps
  // `lastActivityAt` on any inbound traffic it already sees; the session class is
  // computed at READ time, per role (see liveness.ts for the rules), and is
  // reported on GET /agents.
  //
  // INVARIANT (binding, docs/attention.md §3): session/quiet is a HINT — it must
  // never gate delivery. Nothing in the wake/nudge/queue path may branch on it;
  // a wrong classification costs a slightly-stale board reading, never a stall.
  // The `idle` flag keeps its (already demoted) push-vs-drain role.

  /**
   * Note the last inbound traffic from `name`. Cheap and unconditional — call it
   * from every inbound path; a name we don't know is a no-op.
   *
   * FORGEABLE, AND THAT IS ACCEPTED (dual review, 2026-07-25). The HTTP caller is
   * self-declared via `x-jean-agent`, so any local process can move any agent's
   * liveness hint. This does not widen the trust model: infra binds 127.0.0.1 and
   * has no auth at all — POST /send, /events/ack and /agent-idle are equally
   * self-declared, and those DO change state. What this function writes is a hint
   * that gates nothing (see the invariant above), so the worst a forger achieves
   * is a wrong `session` value on GET /agents. Pinned by a test
   * ("forged x-jean-agent moves the hint and gates nothing"). Real authentication
   * is a separate backlog item, and only matters if a Jean dojo ever runs on a
   * machine with untrusted local users.
   */
  function touchAgent(name: string | null | undefined): void {
    if (!name) return
    const entry = agents.get(name)
    if (entry) entry.lastActivityAt = ports.now()
  }

  /** Session class at read time. A disconnected agent is normally absent from the
   *  registry entirely, which reads as offline to any caller. */
  function sessionOf(entry: AgentEntry): AgentSession {
    return classifySession(
      {
        role: entry.role,
        ...(entry.lastActivityAt !== undefined && { lastActivityAt: entry.lastActivityAt }),
        ...(entry.isLive && { transportLive: entry.isLive() }),
      },
      ports.now(),
    )
  }

  /** Tasks this agent is actively holding. IN-PROGRESS ONLY — `waiting` is paused
   *  by definition (board.ts TaskStatus), and a long-lived waiting task (the goals
   *  dojo has one open since April) must never make a worker look permanently
   *  busy. This is the dispatchability signal that replaces reading `idle`. */
  function openTaskCount(name: string): number {
    return boardProjection.state.tasks.filter((t) => t.agent === name && t.status === 'in-progress').length
  }

  /** Push a delivery-failure notice back to the sender's session, so a silent drop
   *  (unregistered/offline target, or a failed peer hop) is visible instead of the
   *  sender believing the message was sent. Bypasses routeSend so a failed notice
   *  can't recurse; no-ops when the sender isn't a locally-deliverable agent
   *  (cli/api/unknown). */
  function notifyUndelivered(sender: string, target: string, reason: string): void {
    // Through the port like every other delivery — the "no such agent" check it
    // used to do inline is what `ports.deliver` returning false already means.
    ports.deliver(sender, {
      type: 'deliver',
      from: 'infra',
      text: `⚠️ Your message to "${target}" was NOT delivered — ${reason}. Nothing was sent. Check the name (jean agent list / jean peer list); the target's infra may be down.`,
    })
  }

  /** Route a message to an agent: deliver, mark busy, record 'send' event. Shared by HTTP /send and WS 'send'. */
  async function routeSend(args: {
    from: string
    to: string
    text: string
    taskId?: string
    attachments?: string[]
  }): Promise<boolean> {
    // ── THE WELD (guard 7, entry half) ── Evaluated at ENTRY, before any
    // await: only an event already visible when this reply was INITIATED may be
    // auto-cleared. Without that, a follow-up or proactive send could ack a
    // brand-new message that arrived mid-flight and was never seen. The rule is
    // core/pre-append.ts's `decideAutoClear`; what must stay here is that
    // NOTHING AWAITS between this and the function's first statement.
    // core/boundary.test.ts asserts it structurally.
    const autoClearId: number | null = decideAutoClear({
      // Sender role falls back to persisted sensei names — the sensei's HTTP
      // send keeps working during a WS drop, and auto-clear must not silently
      // stand down then (review finding).
      senderRole: agents.get(args.from)?.role ?? (senseiNames.has(args.from) ? 'sensei' : undefined),
      targetRole: agents.get(args.to)?.role,
      // EAGER where the pre-refactor code was lazy (review finding): the old
      // version built this list only after both role checks passed. Kept eager
      // on purpose — the alternative is to repeat the role conditions at this
      // call site so they can short-circuit, which puts the rule in two places
      // that can drift, to save a `filter` over the pending queue. The read is
      // pure end to end (filter → isBlockingEvent → isUserSender → a Map get
      // and a Set has), so the only cost is that CPU.
      blockingFromTarget: blockingPendingFrom(args.to),
    })

    const delivered = ports.deliver(args.to, {
      type: 'deliver',
      from: args.from,
      text: args.text,
      taskId: args.taskId,
      attachments: args.attachments,
    })
    if (delivered) {
      const entry = agents.get(args.to)
      if (entry && entry.role === 'worker') entry.idle = false
    }
    // If the sender is a registered peer, enrich the event with the
    // locally-stored description. The peer can't rewrite this per-message —
    // it's frozen in our own peers.json until we change it.
    const senderPeer = peers.get(args.from)
    const stream = args.taskId ? taskStream(args.taskId) : agentStream(args.to)
    await record('send', stream, {
      agent: args.to,
      from: args.from,
      text: args.text,
      delivered,
      ...(args.attachments?.length && { attachments: args.attachments }),
      ...(senderPeer && { senderRole: 'peer' as const, peerDescription: senderPeer.description }),
    } satisfies SendData)
    // Tell the sender when nothing was delivered — a missing/offline target must
    // not look like a successful send (the peer HTTP hop reports its own async
    // failures via createPeerDeliver's onUndelivered).
    if (!delivered) {
      notifyUndelivered(args.from, args.to, 'no agent or peer by that name is registered here, or it is offline')
    }

    // Auto-clear-on-reply (attention phase 3, docs/attention.md §5): the sensei
    // answering a bridge user IS the ack — observation removes a bookkeeping
    // step, never adds one. THE EXACTLY-ONE RULE (sensei-review gate): auto-clear
    // fires only when exactly ONE pending blocking event exists from that user;
    // a multi-message burst requires an explicit ack, converting silent loss of
    // question #2 into a visible leftover. Double-checked: the entry-snapshot id
    // must STILL be the sole pending blocking event at the tail — a message that
    // arrived mid-flight turns this into a burst (stand down), and a concurrent
    // manual ack makes it a no-op. The recorded ack (auto:'reply') also ends the
    // blocking episode via the normal drain path.
    // KNOWN LIMITATION (review, deferred to the delivery-ledger item): bridge
    // delivery is fire-and-forget — a Telegram/Slack API failure after queueing
    // still counts as delivered, so the ack can clear a reminder for a reply the
    // human never received. Bounded: the human re-messages → fresh blocking
    // event → wake. Proper fix = bridge outcome reporting (ledger).
    if (delivered && autoClearId !== null && confirmAutoClear(autoClearId, blockingPendingFrom(args.to))) {
      await recordAck([autoClearId], 'auto-clear')
    }
    return delivered
  }

  // ── WebSocket helpers ────────────────────────────────────────────

  type AgentSocket = ServerWebSocket<{ agent?: string; role?: AgentRole }>

  function wsSend(ws: AgentSocket, msg: OutboundMsg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg))
  }

  function wsDeliver(ws: AgentSocket): (msg: DeliverMsg) => boolean {
    return (msg) => {
      if (ws.readyState !== 1) return false
      ws.send(JSON.stringify(msg))
      return true
    }
  }

  // ── Record event (append + project + side effects) ───────────────

  async function record(type: string, stream: string, data: unknown): Promise<StoredEvent> {
    // RACE GUARD 1, and its position is the guard: captured BEFORE the append,
    // because a blocking arrival starts a new wake episode only when nothing
    // blocking was already pending (burst coalescing). After the append the
    // event is in the queue and the question is unanswerable. It rides the
    // publish context to the attention listener — see core/bus.ts.
    const hadBlockingBefore = hasBlockingPending()
    const event = await store.append({ stream, type, data })
    // Synchronous and ordered: every subscriber runs to completion before this
    // returns, attention last. That is the whole of record()'s dispatch now —
    // the queue resets, the arrival decision and the three push paths all live
    // in core/attention.ts.
    bus.publish(event, { hadBlockingPending: hadBlockingBefore })
    // These two used to run BEFORE the attention dispatch, which was inline
    // below them; now attention rides the publish above, so they follow it.
    // Deliberate and inert: `syncTriggerJobs` only touches the croner job table
    // synchronously (its `fireTrigger` calls are deferred and cannot change
    // pending state before attention has already decided), and `log` carries no
    // contract at all — Leonid's ruling, see ports.ts.
    if (stream === TRIGGERS_STREAM) syncTriggerJobs()

    const taskId = taskIdFromStream(stream)
    const agent = (data as Record<string, unknown>)?.agent as string | undefined
    ports.log(`[jean] ${type}${agent ? ` agent=${agent}` : ''}${taskId ? ` task=${taskId}` : ''}\n`)

    return event
  }

  // ── Helpers ──────────────────────────────────────────────────────

  function inferTaskId(agentName?: string): string | undefined {
    if (!agentName) return undefined
    const task = boardProjection.state.tasks.find(
      (t) => (t.agent === agentName || t.queue === agentName) && (t.status === 'in-progress' || t.status === 'waiting'),
    )
    if (task) return task.id
    return lastTaskContext.state.get(agentName)
  }

  function nextTaskId(): string {
    return String(boardProjection.state.tasks.length + 1).padStart(3, '0')
  }

  // ── Queue queries ────────────────────────────────────────────────
  //
  // The answers live in core/queue.ts; these are the bindings that hand it the
  // two lookups it needs. Kept as named shims rather than inlined at ~10 call
  // sites: the bindings are the whole of what is adapter-specific here.

  /** The board lookup, as core/queue.ts's `TaskOwner`. */
  const taskOwner: TaskOwner = (taskId) => boardProjection.state.tasks.find((t) => t.id === taskId)

  function resolveAgent(event: StoredEvent): string | undefined {
    return queueResolveAgent(event, taskOwner)
  }
  function pendingEvents(agent?: string): StoredEvent[] {
    return queuePendingEvents(pendingProjection.state, taskOwner, agent)
  }
  function pendingByAgent(): Record<string, number> {
    return queuePendingByAgent(pendingProjection.state, taskOwner)
  }

  // ── Inbox summary (attention phase 1 — docs/attention.md §2) ─────
  // The pending queue is the SENSEI's queue today, so the sensei's inbox is the
  // whole of it. Workers get per-agent inboxes in phase 5.

  /** User-role identities that have EVER registered — persisted, not live.
   *  Blocking-vs-machine classification must not depend on the live registry: a
   *  briefly-disconnected bridge (or an infra restart) would otherwise demote a
   *  waiting human's messages to machine `worker:reply` — the one class that
   *  must never be missed (review finding, 2026-07-24). Seeded from history at
   *  startup, updated on every user register. */
  const userAgentNames = new Set<string>()
  /** Sensei identities that have EVER registered — persisted, symmetric to
   *  userAgentNames. The sensei's HTTP sends keep working during a WS drop, and
   *  auto-clear-on-reply must not silently stand down then (review finding). */
  const senseiNames = new Set<string>()
  for (const e of await store.read({ types: ['register'] })) {
    const d = e.data as RegisterData
    if (d.role === 'user' && d.agent) userAgentNames.add(d.agent)
    if (d.role === 'sensei' && d.agent) senseiNames.add(d.agent)
  }

  /** Role lookup: live registry first, then the persisted user set. ONE
   *  binding, shared by the blocking classification and the inbox, so the two
   *  cannot drift apart — which is the whole point of `isUserSender` being
   *  shared in the first place. */
  const roleOf: RoleOf = (n) => agents.get(n)?.role ?? (userAgentNames.has(n) ? 'user' : undefined)

  /** The sensei's inbox as of now. `agent` is left undefined — the pending
   *  queue IS the sensei's queue today, so its inbox is the whole of it. */
  function senseiInboxNow() {
    return inboxFor(pendingProjection.state, taskOwner, { now: ports.now(), roleOf })
  }

  // ── Delivery ledger (attention phase 4 — docs/attention.md "Observability") ──
  //
  // The ledger itself is core/ledger.ts. What stays here is the one binding it
  // cannot have: "everything currently pending" as the default stamp set.

  const deliveryLedger = createDeliveryLedger()
  const withDeliveredVia = deliveryLedger.withDeliveredVia

  /** THE one stamp site. Every delivery path routes through here (first-delivery-
   *  wins lives inside the ledger), so phase 5 can swap the in-memory map for
   *  mailbox-derived custody state at a single seam instead of hunting inline
   *  writes. `ids` defaults to everything currently pending — i.e. exactly what
   *  the inbox just handed over. */
  function stampDelivery(via: DeliveredVia, ids?: number[]): void {
    deliveryLedger.stamp(via, ids ?? pendingProjection.state.map((e) => e.id))
  }

  /** Ids an in-flight recordAck has claimed but not yet written. Reserved
   *  SYNCHRONOUSLY, because the write straddles an await. */
  const ackInFlight = new Set<number>()

  /**
   * The one place an `ack` event is written. Materializes the ledger for the ids
   * it actually clears and drops their in-memory entries (pending is the only
   * thing keeping them alive, and ack is the only exit from pending). Returns the
   * ids actually acked, so callers report what happened rather than what they
   * asked for.
   *
   * CONCURRENCY (review finding, deterministic repro): two acks for the same id
   * used to produce two ack events, the second carrying `clearedBy` with no
   * `deliveredVia` (the first write already dropped the ledger entry) — so a
   * reader taking the LATEST ack concluded "delivery unknown" for an event that
   * was demonstrably woken. A 20-way interleave produced 20 ack events. The
   * membership check and the claim below happen in ONE synchronous step, with no
   * await between them, so exactly one writer can own an id; everything else
   * drops out and no empty ack is ever recorded. (The race predates phase 4 —
   * duplicate acks were merely redundant before the ledger gave them a way to
   * lie.)
   */
  async function recordAck(eventIds: number[], clearedBy: ClearedBy): Promise<number[]> {
    // ── THE WELD (guard 6) ── The decision and the reservation are one
    // synchronous step. `claimAckIds` is pure and lives in core/pre-append.ts,
    // but the property that makes it a guard is right here: NO AWAIT may appear
    // between this line and the `ackInFlight.add` below, or two writers can
    // both claim the same id. core/boundary.test.ts asserts that structurally.
    const claimed = claimAckIds(eventIds, new Set(pendingProjection.state.map((e) => e.id)), ackInFlight)
    if (claimed.length === 0) return [] // already cleared, or another writer owns it
    for (const id of claimed) ackInFlight.add(id)
    try {
      const ledger = deliveryLedger.takeFor(claimed, clearedBy)
      await record('ack', SYSTEM_STREAM, {
        eventIds: claimed,
        // `auto: 'reply'` predates the ledger and stays — phase-3 QA (and the
        // sensei skill) read it; clearedBy is its generalization, not a rename.
        ...(clearedBy === 'auto-clear' && { auto: 'reply' as const }),
        ledger,
      } satisfies AckData)
      return claimed
    } finally {
      // Released only after record() has applied the ack to the pending
      // projection, so a later writer sees "not pending" rather than a free id.
      for (const id of claimed) ackInFlight.delete(id)
    }
  }

  // ── Blocking-event wake (attention phase 2 — docs/attention.md §4) ──
  // A human-origin event is BLOCKING: someone is holding a phone, unable to tell
  // thinking from broken. Blocking events wake the sensei REGARDLESS of the idle
  // flag (mid-turn injection is confirmed working and informative), so a stuck
  // Stop hook can never starve a waiting human — the measured 3-hour-stall class
  // dies here. Re-wakes escalate on a backoff schedule while blocking events
  // remain unhandled; the inbox ages climb in every piggyback in between.
  // Machine events keep the idle-gated nudge (deliberately conservative: pure
  // never-wake would regress worker-reply latency to heartbeat-period — the
  // trap the goals sensei flagged; full machine reclassification lands with the
  // turn-end drain discipline in later phases).

  /** Is this event a human waiting? Decided in core/queue.ts; the binding is
   *  the shared `roleOf` above, which is what keeps this in step with the
   *  inbox's own classification. */
  function isBlockingEvent(event: StoredEvent): boolean {
    return queueIsBlockingEvent(event, roleOf)
  }

  /** Guard 1's input, read immediately before every append. */
  function hasBlockingPending(): boolean {
    return queueHasBlockingPending(pendingProjection.state, roleOf)
  }

  /** Guard 7 asks this twice — at entry and at the tail — and compares. */
  function blockingPendingFrom(sender: string): number[] {
    return queueBlockingPendingFrom(pendingProjection.state, roleOf, sender)
  }

  /** Re-wake delays AFTER the immediate arrival wake: 2m, 5m, then every 10m.
   *  Env override (comma-separated ms) exists for tests. */
  const BLOCKING_BACKOFF_MS: number[] = (() => {
    const env = process.env.JEAN_BLOCKING_BACKOFF_MS
    if (env) {
      const arr = env
        .split(',')
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0)
      if (arr.length > 0) return arr
    }
    return [120_000, 300_000, 600_000]
  })()

  // Backoff loop: while blocking events sit unhandled, re-wake on the schedule.
  // The decision — including the self-healing unstarted-episode case — is
  // core/attention.ts's `decideBlockingTick`. This callback is a single call
  // with no branching on state, which is the acceptance check for the
  // extraction: if a timer callback still branches, it isn't done.
  const blockingTickMs = Math.min(15_000, ...BLOCKING_BACKOFF_MS)
  const blockingTick = setInterval(() => attention.tick(viewNow(ports.now())), blockingTickMs)

  /** Attach the compact inbox line as a response header when the request came
   *  from the sensei's channel plugin (`x-jean-agent`). Header-only — response
   *  bodies are never mutated, so no consumer's JSON shape can break. Skips
   *  non-sensei callers; empty inbox = no header (the empty case costs 0). */
  /** The agent behind an HTTP request, per its `x-jean-agent` header. The channel
   *  plugin percent-encodes the name (HTTP headers are Latin-1-only; a non-ASCII
   *  agent name would otherwise arrive mojibake'd and never match). */
  function callerFromHeader(req: Request): string | undefined {
    const raw = req.headers.get('x-jean-agent')
    if (!raw) return undefined
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw // not encoded — use as-is
    }
  }

  function withInboxHeader(req: Request, res: Response): Response {
    const caller = callerFromHeader(req)
    if (!caller) return res
    if (agents.get(caller)?.role !== 'sensei') return res
    const inbox = senseiInboxNow()
    if (!inbox) return res
    // ATTACH-LEVEL, NOT CONFIRMED READ (review finding [D]). Marking these
    // 'piggyback' records that infra ATTACHED the inbox line to a response headed
    // for the sensei — it cannot observe the client reading it, and a response the
    // client aborts mid-flight (or a plugin that drops the header) is stamped all
    // the same. That is the best evidence available before the phase-5 mailbox
    // model; the alternative — not stamping — would under-report every event whose
    // only delivery was a piggyback, which is the common case. Kept, with the
    // claim stated precisely here and on DeliveredVia (reducers.ts).
    stampDelivery('piggyback')
    const headers = new Headers(res.headers)
    headers.set('x-jean-inbox', renderInboxLine(inbox))
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
  }

  // ── Retrieval (wiki-first search) ─────────────────────────────────

  /** Memorize events not yet folded into the wiki (id > consolidator cursor) —
   *  the same-day slice, folded into the search corpus so today's facts are
   *  findable without waiting for the nightly librarian run. */
  async function unconsolidatedMemories(): Promise<RecentMemory[]> {
    const cursorPath = resolve(DATA_DIR, '.consolidator', 'cursor.json')
    let since = 0
    try {
      since = (JSON.parse(await Bun.file(cursorPath).text()) as { lastEventId?: number }).lastEventId ?? 0
    } catch {
      // no cursor — fresh dojo / librarian never ran; take everything.
    }
    const events = await store.read({ stream: MEMORY_STREAM, afterId: since })
    return events.map((e) => ({ id: e.id, ...(e.data as MemoryData) }))
  }

  /** Append one search to the retrieval log — operational telemetry, NOT an
   *  event (it carries private query text + snippets, stays in gitignored
   *  `.jean/`, and is for offline investigation + scoring, not the provenance
   *  record). Best-effort; a log failure never fails the search. */
  function logRetrieval(record: Record<string, unknown>): void {
    try {
      appendFileSync(resolve(DATA_DIR, 'retrieval-log.jsonl'), `${JSON.stringify(record)}\n`)
    } catch {
      // telemetry is best-effort
    }
  }

  /** Every task + its curated comments — the `tasks` search corpus. */
  async function buildTaskInputs(): Promise<TaskInput[]> {
    const commentEvents = await store.read({ types: ['task-comment'] })
    const byTask = new Map<string, string[]>()
    for (const e of commentEvents) {
      const tid = taskIdFromStream(e.stream)
      if (!tid) continue
      const arr = byTask.get(tid) ?? []
      arr.push((e.data as TaskCommentData).text)
      byTask.set(tid, arr)
    }
    return boardProjection.state.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      comments: byTask.get(t.id) ?? [],
    }))
  }

  /** The human↔agent conversation, chronological — the `channel` search corpus.
   *  Reply events on a role:'user' stream are the human; send events are the
   *  agent. Both live on the chat agent's stream (routeSend + bridge onInbound).
   *
   *  User surfaces are derived from PERSISTED `register` events, not the live
   *  `agents` map — otherwise the conversation is silently omitted whenever the
   *  bridge isn't currently connected, which would make an all-scope empty
   *  non-definitive for this source (the whole point of default-all). */
  async function buildChannelMessages(): Promise<{ who: string; text: string }[]> {
    const registers = await store.read({ types: ['register'] })
    const userAgents = new Set<string>()
    for (const e of registers) {
      const d = e.data as RegisterData
      if (d.role === 'user' && d.agent) userAgents.add(d.agent)
    }
    const rows: { at: number; who: string; text: string }[] = []
    for (const name of userAgents) {
      const events = await store.read({ stream: agentStream(name) })
      for (const e of events) {
        if (e.type === 'reply') rows.push({ at: e.id, who: 'human', text: (e.data as ReplyData).text })
        else if (e.type === 'send')
          rows.push({ at: e.id, who: (e.data as SendData).from ?? 'agent', text: (e.data as SendData).text })
      }
    }
    rows.sort((a, b) => a.at - b.at)
    return rows.map(({ who, text }) => ({ who, text }))
  }

  /** The valid `scope` values for /context/search (`all` is also the default). */
  const CONTEXT_SCOPES = ['knowledge', 'tasks', 'channel', 'all']

  /** Build the search corpus for a scope. `all` (the default) = the union of
   *  every source; `knowledge` = wiki + unconsolidated memorize; `tasks` = task
   *  comments; `channel` = the human conversation. Default-`all` makes empty
   *  recall-safe: an all-scope empty means "definitively not in the dojo's
   *  memory," whereas a narrow-scope empty rules out only that one source. */
  async function buildCorpus(scope: string): Promise<SearchDoc[]> {
    const docs: SearchDoc[] = []
    if (scope === 'knowledge' || scope === 'all') {
      docs.push(...wikiDocs(resolve(DATA_DIR, 'context')), ...memoryDocs(await unconsolidatedMemories()))
    }
    if (scope === 'tasks' || scope === 'all') {
      docs.push(...taskDocs(await buildTaskInputs()))
    }
    if (scope === 'channel' || scope === 'all') {
      docs.push(...channelDocs(await buildChannelMessages()))
    }
    return docs
  }

  // ── Sensei nudge ──────────────────────────────────────────────────

  // ── Machine-nudge episode backoff (attention phase 4) ────────────
  //
  // The goals dojo's event 10077: SIX re-nudges in ~25s on ONE deliberately-held
  // event. Not timer-driven — every turn-end posts /agent-idle, which sets
  // idle=true and calls nudgeSenseiIfIdle(), which had zero suppression. So the
  // loop rate WAS the reply rate: the sensei's own answer re-armed the interrupt
  // that produced it, and a deliberately deferred event nagged forever.
  //
  // Fix: an EPISODE (spanning a non-empty pending queue) nudges when it has
  // something new to say, not whenever the agent draws breath:
  //   1. first nudge of the episode — always;
  //   2. CONTENT CHANGED — an event entered pending since the last nudge (this is
  //      what keeps worker-reply latency at turn-end speed, the regression the
  //      goals review warned about);
  //   3. BACKOFF ELAPSED — the same held queue is worth one reminder per window.
  // Everything else is silence, on purpose. The queue is still readable (delivery
  // is pull), the piggyback still rides every infra call with climbing ages, the
  // stall watchdog is still the backstop, and blocking (human) events are a
  // separate path that this never touches.

  /** Re-nudge delays for a queue whose CONTENT hasn't changed: 1m, 2m, 5m, then
   *  every 10m. Same structure and env-override form as BLOCKING_BACKOFF_MS. */
  const NUDGE_BACKOFF_MS: number[] = (() => {
    const env = process.env.JEAN_NUDGE_BACKOFF_MS
    if (env) {
      const arr = env
        .split(',')
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0)
      if (arr.length > 0) return arr
    }
    return [60_000, 120_000, 300_000, 600_000]
  })()

  // The episode bookkeeping this backoff needs — counters, the content-changed
  // signal, the idle gate — is core/attention.ts's `decideNudge`. Its state is
  // per-agent now (sensei the only populated key), which is what makes the
  // phase-5 worker queues a matter of adding keys rather than adding globals.

  // ── Stall watchdog ────────────────────────────────────────────────
  // A missed Stop hook leaves the sensei stuck at idle:false, which suppresses
  // every nudge above: pending grows and the dojo silently stalls (recurring on
  // live dojos — worst observed: a 3-hour stall behind five queued messages).
  // Stopgap until delivery is ungated from idle (BACKLOG: attention-management
  // redesign): when pending has sat non-empty for STALL_NUDGE_AFTER_MS with no
  // nudge fired, force one that ignores the idle flag. Quiet when healthy —
  // fires only while events are actually undrained, then re-arms for a full
  // window, so a wedged sensei gets one reminder per window, not a flood.
  // The rule itself — including standing down while blocking is pending — is
  // core/attention.ts's `decideStallTick`.

  const stallEnv = Number(process.env.JEAN_STALL_NUDGE_MS)
  const STALL_NUDGE_AFTER_MS = Number.isFinite(stallEnv) && stallEnv > 0 ? stallEnv : 10 * 60_000

  /**
   * The world as the attention decisions are allowed to see it — built FRESH at
   * every decision point, never cached.
   *
   * That freshness is a guard, not a style choice: the delivered inbox and the
   * `pendingCount` recorded on the `nudge` event both come out of this one
   * snapshot, so they cannot disagree. A cached inbox is exactly the bug
   * scenario 6 pins (counts 1 → 2 → 1 — the falling leg is what a stale
   * snapshot gets wrong).
   *
   * `now` is a PARAMETER rather than a `ports.now()` call inside, so the clock
   * is read at the call site: the position rule from stage 2 (see ports.ts).
   *
   * The inbox is built only when there is someone to push to, matching the
   * pre-refactor paths — all three called `senseiInboxNow()` only after their
   * own `findSensei()` check had passed.
   */
  function viewNow(now: number): AttentionView {
    const sensei = findSensei()
    const pending = pendingProjection.state
    return {
      now,
      agent: sensei?.name ?? null,
      idle: sensei?.entry.idle ?? false,
      pendingIds: pending.map((e) => e.id),
      blockingPendingIds: pending.filter(isBlockingEvent).map((e) => e.id),
      inbox: sensei ? senseiInboxNow() : null,
      blockingBackoffMs: BLOCKING_BACKOFF_MS,
      nudgeBackoffMs: NUDGE_BACKOFF_MS,
      stallAfterMs: STALL_NUDGE_AFTER_MS,
    }
  }

  // Boot state, once, AFTER catch-up and never during it: counters at zero and
  // the stall clock armed from the replayed queue. The listener has no replay
  // path — see core/bus.ts, "REPLAY NEVER PUBLISHES".
  attention.hydrate(viewNow(ports.now()))

  // The second of the two timer callbacks, and like the first it is one call
  // with no branching on state. Both drive the SAME `core.tick`; the stall
  // check therefore also runs on the blocking interval's faster grid, which can
  // only shorten the latency AFTER its threshold, never fire before it.
  const stallTick = setInterval(() => attention.tick(viewNow(ports.now())), Math.min(STALL_NUDGE_AFTER_MS, 60_000))

  // ── Trigger scheduler ───────────────────────────────────────────

  const cronJobs = new Map<string, Cron>()

  /** What the SCHEDULE PORT has been asked to run, which is not the same thing
   *  as what croner is running: an injected port keeps its own jobs (or none),
   *  and `cronJobs` below is only the default implementation's private table.
   *  Deriving "what is scheduled" from croner would mean an injected `schedule`
   *  never produced a matching `unschedule` — the port honoured on the way in
   *  and ignored on the way out. */
  const scheduledIds = new Set<string>()

  /** The DEFAULT implementation of the `schedule` port (ports.ts) — croner, and
   *  nothing else. It decides nothing: what to schedule, what is overdue and
   *  what to cancel is core/triggers.ts's `planTriggers`. */
  function startCronJob(id: string, spec: { cron: string } | { at: string }, fire: () => void) {
    if (cronJobs.has(id)) return
    const job =
      'cron' in spec ? new Cron(spec.cron, { catch: true }, fire) : new Cron(new Date(spec.at), { catch: true }, fire)
    cronJobs.set(id, job)
    ports.log(`[jean] trigger ${id} scheduled ${'cron' in spec ? `(${spec.cron})` : `(at ${spec.at})`}\n`)
  }

  /** The DEFAULT implementation of the `unschedule` port. */
  function stopCronJob(id: string) {
    const job = cronJobs.get(id)
    if (job) {
      job.stop()
      cronJobs.delete(id)
    }
  }

  function syncTriggerJobs() {
    const plan = planTriggers(triggerProjection.state.triggers, scheduledIds, ports.now())
    // An overdue one-off fires instead of being scheduled, so it never enters
    // the scheduled set — matching the pre-refactor behaviour exactly.
    for (const trigger of plan.fireNow) void fireTrigger(trigger)
    for (const trigger of plan.schedule) {
      // The Trigger type is a discriminated union: exactly one of cron or at.
      ports.schedule(trigger.id, trigger.cron !== undefined ? { cron: trigger.cron } : { at: trigger.at }, () => {
        void fireTrigger(trigger)
      })
      scheduledIds.add(trigger.id)
    }
    for (const id of plan.unschedule) {
      ports.unschedule(id)
      scheduledIds.delete(id)
    }
  }

  function recordHeadlessFailure(triggerId: string, role: AgentRole, message: string, attempt?: number) {
    void record('headless-completed', TRIGGERS_STREAM, {
      triggerId,
      role,
      exitCode: -1,
      durationMs: 0,
      timedOut: false,
      stderrTail: String(message).slice(-2000),
      ...(attempt !== undefined && { attempt }),
    } satisfies HeadlessCompletedData)
  }

  /**
   * Backoff between attempts when a headless run fails and `retries > 0`.
   * Empirically (May 1 + May 3 dark-wake hangs), the network stack is back
   * in a healthy state within 1–2 minutes after a deep-sleep wake, so 60s
   * is enough. Exposed as a constant so tests can override.
   */
  const HEADLESS_RETRY_BACKOFF_MS = 60_000

  /** One attempt of a headless trigger run: probe → spawn → record. */
  async function runHeadlessAttempt(opts: {
    trigger: Trigger
    role: AgentRole
    model?: string
    dojoRoot: string
    attempt: number
    totalAttempts: number
    doProbe: boolean
    /**
     * Set by the multi-phase librarian pipeline to override the trigger's prompt
     * and tag phase-specific stream-json files (`<role>-<triggerId>-<tag>-<ts>.jsonl`)
     * so each phase's forensic artifacts stay separable.
     */
    phase?: { tag: LibrarianPhase; promptOverride: string }
  }): Promise<{ succeeded: boolean }> {
    const { trigger, role, model, dojoRoot, attempt, totalAttempts, doProbe, phase } = opts
    const attemptTag = totalAttempts > 1 ? ` attempt=${attempt}/${totalAttempts}` : ''
    const phaseLog = phase ? ` phase=${phase.tag}` : ''

    let probeLatencyMs: number | undefined
    if (doProbe) {
      const probe = await ports.probe()
      probeLatencyMs = probe.latencyMs
      if (!probe.ok) {
        ports.log(`[jean] trigger ${trigger.id}${attemptTag} probe failed (${probe.latencyMs}ms): ${probe.error}\n`)
        void record('headless-completed', TRIGGERS_STREAM, {
          triggerId: trigger.id,
          role,
          exitCode: -2, // probe-failed sentinel
          durationMs: probe.latencyMs,
          timedOut: false,
          stderrTail: `pre-flight probe failed: ${probe.error}`,
          probeFailed: true,
          probeLatencyMs: probe.latencyMs,
          ...(totalAttempts > 1 && { attempt }),
        } satisfies HeadlessCompletedData)
        return { succeeded: false }
      }
      ports.log(`[jean] trigger ${trigger.id}${attemptTag} probe ok (${probe.latencyMs}ms)\n`)
    }

    ports.log(
      `[jean] trigger ${trigger.id}${attemptTag}${phaseLog} fired → headless ${role}${model ? ` (${model})` : ''}\n`,
    )
    // Tee stdout to a per-run JSONL so a killed run still leaves a trace
    // showing which tool call stalled.
    const startIso = new Date(ports.now()).toISOString().replace(/[:.]/g, '-')
    const streamSinkPath = phase
      ? `.jean/.headless/${role}-${trigger.id}-${phase.tag}-${startIso}.jsonl`
      : `.jean/.headless/${role}-${trigger.id}-${startIso}.jsonl`
    try {
      const result = await ports.spawn({
        dojoRoot,
        role,
        prompt: phase?.promptOverride ?? trigger.prompt,
        streamSinkPath,
        ...(model && { model }),
      })
      const stderrTail = result.exitCode !== 0 ? result.stderr.slice(-2000) : undefined
      void record('headless-completed', TRIGGERS_STREAM, {
        triggerId: trigger.id,
        role,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        ...(stderrTail && { stderrTail }),
        ...(result.parsed?.sessionId && { sessionId: result.parsed.sessionId }),
        ...(result.parsed?.costUsd !== undefined && { costUsd: result.parsed.costUsd }),
        ...(result.parsed?.totalTokens !== undefined && { totalTokens: result.parsed.totalTokens }),
        ...(result.parsed?.model && { model: result.parsed.model }),
        ...(totalAttempts > 1 && { attempt }),
        ...(probeLatencyMs !== undefined && { probeLatencyMs }),
        streamPath: streamSinkPath,
      } satisfies HeadlessCompletedData)
      ports.log(
        `[jean] trigger ${trigger.id}${attemptTag} headless ${role} done: exit=${result.exitCode} duration=${result.durationMs}ms${result.timedOut ? ' TIMED-OUT' : ''}${result.parsed?.sessionId ? ` session=${result.parsed.sessionId}` : ''}\n`,
      )
      return { succeeded: result.exitCode === 0 }
    } catch (err) {
      recordHeadlessFailure(trigger.id, role, String(err), totalAttempts > 1 ? attempt : undefined)
      ports.log(`[jean] trigger ${trigger.id}${attemptTag} headless ${role} spawn failed: ${err}\n`)
      return { succeeded: false }
    }
  }

  /**
   * Default model per phase of the librarian's multi-phase pipeline.
   *
   * Phase 1 (draft) is mechanical bulk: read events, route to pages, write
   * structured staging output. Haiku is plenty and reliable.
   *
   * Phase 2 (review) is a coherency pass — read the staged draft, fix index
   * cross-refs, catch contradictions Haiku introduced. Sonnet is sharper here.
   *
   * Both can be overridden by setting `trigger.model` (which then applies to
   * BOTH phases — useful for "use Opus for everything" or "use Haiku for
   * everything" experiments).
   */
  const LIBRARIAN_DRAFT_MODEL = 'haiku'
  const LIBRARIAN_REVIEW_MODEL = 'sonnet'

  const DRAFT_PROMPT =
    'Run the consolidate-wiki-draft skill exactly. Phase 1 of 3 — draft only, do not swap, do not advance cursor.'
  const REVIEW_PROMPT =
    'Run the consolidate-wiki-review skill exactly. Phase 2 of 3 — proofread the staging output from phase 1, do not swap.'

  /** Run one librarian phase with the trigger's retry/backoff budget. */
  async function runPhaseWithRetries(opts: {
    trigger: Trigger
    dojoRoot: string
    phase: { tag: LibrarianPhase; promptOverride: string }
    model: string
    doProbe: boolean
    totalAttempts: number
    /** Extra success predicate beyond exit code (e.g. plan.json must exist). */
    postCheck?: () => boolean
  }): Promise<boolean> {
    const { trigger, dojoRoot, phase, model, doProbe, totalAttempts, postCheck } = opts
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const { succeeded } = await runHeadlessAttempt({
        trigger,
        role: 'librarian',
        model,
        dojoRoot,
        attempt,
        totalAttempts,
        doProbe,
        phase,
      })
      if (succeeded && (postCheck === undefined || postCheck())) return true
      if (attempt < totalAttempts) {
        ports.log(
          `[jean] trigger ${trigger.id} ${phase.tag} retrying in ${HEADLESS_RETRY_BACKOFF_MS}ms (${attempt + 1}/${totalAttempts})\n`,
        )
        await Bun.sleep(HEADLESS_RETRY_BACKOFF_MS)
      }
    }
    return false
  }

  /**
   * Multi-phase consolidation: draft → review → commit.
   *
   * Each phase has its own retry budget. A successful phase 1 is preserved
   * across phase 2 retries — we don't redo Haiku's work just because Sonnet
   * died. Phase 3 (commit) is in-process and idempotent; no retry loop needed.
   */
  async function runLibrarianMultiPhase(trigger: Trigger, dojoRoot: string) {
    const retries = trigger.retries ?? 0
    const totalAttempts = retries + 1
    // trigger.model overrides BOTH phases — single knob for "use opus everywhere"
    // or "use haiku everywhere". When unset, per-phase defaults apply.
    const draftModel = trigger.model ?? LIBRARIAN_DRAFT_MODEL
    const reviewModel = trigger.model ?? LIBRARIAN_REVIEW_MODEL
    const planPath = resolve(DATA_DIR, '.consolidator', 'plan.json')

    const draftOk = await runPhaseWithRetries({
      trigger,
      dojoRoot,
      phase: { tag: 'draft', promptOverride: DRAFT_PROMPT },
      model: draftModel,
      doProbe: retries > 0,
      totalAttempts,
      postCheck: () => existsSync(planPath),
    })
    if (!draftOk) {
      ports.log(`[jean] trigger ${trigger.id} draft phase failed all attempts; aborting\n`)
      return
    }

    // Skip probe on review — phase 1 already validated the network.
    const reviewOk = await runPhaseWithRetries({
      trigger,
      dojoRoot,
      phase: { tag: 'review', promptOverride: REVIEW_PROMPT },
      model: reviewModel,
      doProbe: false,
      totalAttempts,
    })
    if (!reviewOk) {
      // Don't commit on draft alone — review's index regen + cross-ref fixes
      // are load-bearing. Sweep plan.json so the next run starts clean;
      // pre-spawn recoverWikiLayout handles staging/.
      rmSync(planPath, { force: true })
      ports.log(`[jean] trigger ${trigger.id} review phase failed; not committing\n`)
      return
    }

    // Phase 3: commit (in-process, deterministic, no retries needed).
    try {
      const result = await commitConsolidation({
        dojoRoot,
        recordEvent: (data) => record('wiki-consolidated', SYSTEM_STREAM, data),
      })
      const anomalyCount = result.emitted.anomalies?.length ?? 0
      ports.log(
        `[jean] trigger ${trigger.id} commit done — swapped=${result.swapped} pages=${result.pageCount} anomalies=${anomalyCount}\n`,
      )
    } catch (err) {
      ports.log(`[jean] trigger ${trigger.id} commit failed: ${err}\n`)
    }
  }

  async function runHeadlessTrigger(trigger: Trigger) {
    const role = trigger.agent as AgentRole
    const dojoRoot = resolve(DATA_DIR, '..')

    if (role === 'librarian') {
      try {
        const rec = recoverWikiLayout(dojoRoot)
        if (rec.recovered !== 'none') {
          ports.log(`[jean] librarian wiki layout recovered (${rec.recovered})\n`)
        }
      } catch (err) {
        recordHeadlessFailure(trigger.id, role, `wiki layout recovery failed: ${err}`)
        ports.log(`[jean] librarian aborted: ${err}\n`)
        return
      }
      // The wiki-consolidation trigger is the only headless librarian flow we
      // ship; route it through the multi-phase pipeline. Other librarian
      // triggers (none today) would fall through to single-phase below.
      if (trigger.id === 'consolidate-wiki') {
        await runLibrarianMultiPhase(trigger, dojoRoot)
        return
      }
    }

    // Probe + retry are opt-in via `trigger.retries`. Default 0 keeps the
    // historical single-attempt behavior with no probe.
    const retries = trigger.retries ?? 0
    const totalAttempts = retries + 1
    const doProbe = retries > 0
    const model = trigger.model

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const { succeeded } = await runHeadlessAttempt({
        trigger,
        role,
        ...(model !== undefined && { model }),
        dojoRoot,
        attempt,
        totalAttempts,
        doProbe,
      })
      if (succeeded) return
      if (attempt < totalAttempts) {
        ports.log(
          `[jean] trigger ${trigger.id} retrying in ${HEADLESS_RETRY_BACKOFF_MS}ms (attempt ${attempt + 1}/${totalAttempts})\n`,
        )
        await Bun.sleep(HEADLESS_RETRY_BACKOFF_MS)
      }
    }
  }

  /** Block until a headless run for `triggerId` records its completion event.
   *  Used by the startup catch-up loop to sequentialize spawns and avoid
   *  parallel-Claude stampede. Polls every 1s up to 15 minutes. */
  async function waitForHeadlessCompletion(triggerId: string, timeoutMs = 15 * 60 * 1000): Promise<void> {
    const start = ports.now()
    while (ports.now() - start < timeoutMs) {
      const events = await store.read({ stream: TRIGGERS_STREAM })
      const completion = events.find(
        (e) =>
          e.type === 'headless-completed' &&
          (e.data as Record<string, unknown>).triggerId === triggerId &&
          new Date(e.ts).getTime() >= start,
      )
      if (completion) return
      await Bun.sleep(1000)
    }
    ports.log(`[jean] catch-up: gave up waiting for ${triggerId} after ${timeoutMs}ms\n`)
  }

  async function fireTrigger(trigger: Trigger) {
    await record('trigger-fired', TRIGGERS_STREAM, {
      triggerId: trigger.id,
      agent: trigger.agent,
      prompt: trigger.prompt,
      kind: trigger.kind,
    } satisfies TriggerFiredData)

    if (trigger.kind === 'headless') {
      // Detached: don't block the cron callback (or HTTP fire endpoint) on
      // a multi-minute Claude spawn. The headless-completed event is the
      // observable signal when the run finishes.
      void runHeadlessTrigger(trigger)
      return
    }

    const delivered = ports.deliver(trigger.agent, {
      type: 'deliver',
      from: 'trigger',
      text: trigger.prompt,
    })
    if (delivered) {
      const entry = agents.get(trigger.agent)
      if (entry && entry.role === 'worker') entry.idle = false
    }

    const taskId = inferTaskId(trigger.agent)
    const stream = taskId ? taskStream(taskId) : agentStream(trigger.agent)
    void record('send', stream, {
      agent: trigger.agent,
      from: `trigger:${trigger.id}`,
      text: trigger.prompt,
      delivered,
    } satisfies SendData)

    ports.log(`[jean] trigger ${trigger.id} fired → ${trigger.agent}\n`)
  }

  // ── Playbook file watcher ────────────────────────────────────────

  const PLAYBOOKS_DIR = resolve(DATA_DIR, 'playbooks')

  function playbookIdFromFilename(filename: string): string | null {
    if (!filename.endsWith('.md')) return null
    return basename(filename, '.md')
  }

  function hashContent(content: string): string {
    return new Bun.CryptoHasher('sha256').update(content).digest('hex').slice(0, 12)
  }

  async function readPlaybookFile(id: string): Promise<{ content: string; hash: string } | null> {
    try {
      const content = await Bun.file(resolve(PLAYBOOKS_DIR, `${id}.md`)).text()
      return { content, hash: hashContent(content) }
    } catch {
      return null
    }
  }

  let reconciling = false

  /** Scan playbook files and reconcile with projection state. */
  async function reconcilePlaybooks() {
    if (reconciling) return
    reconciling = true
    try {
      if (!existsSync(PLAYBOOKS_DIR)) {
        mkdirSync(PLAYBOOKS_DIR, { recursive: true })
        ports.log(`[jean] created ${PLAYBOOKS_DIR}\n`)
      }

      const dir = readdirSync(PLAYBOOKS_DIR)
      const ids = dir.map(playbookIdFromFilename).filter((id): id is string => id !== null)
      const entries = await Promise.all(
        ids.map(async (id) => {
          const data = await readPlaybookFile(id)
          return data ? ([id, data] as const) : null
        }),
      )

      const files = new Map<string, { content: string; hash: string }>()
      for (const entry of entries) {
        if (entry) files.set(entry[0], entry[1])
      }

      const known = new Map(playbookProjection.state.playbooks.map((p) => [p.id, p]))

      for (const [id, { content, hash }] of files) {
        const existing = known.get(id)
        if (!existing) {
          await record('playbook-created', PLAYBOOKS_STREAM, { id, content, hash } satisfies PlaybookCreatedData)
          ports.log(`[jean] playbook created: ${id}\n`)
        } else if (existing.hash !== hash) {
          await record('playbook-updated', PLAYBOOKS_STREAM, {
            id,
            content,
            hash,
            prevHash: existing.hash,
          } satisfies PlaybookUpdatedData)
          ports.log(`[jean] playbook updated: ${id}\n`)
        }
      }

      for (const [id, playbook] of known) {
        if (!files.has(id)) {
          await record('playbook-removed', PLAYBOOKS_STREAM, {
            id,
            lastHash: playbook.hash,
          } satisfies PlaybookRemovedData)
          ports.log(`[jean] playbook removed: ${id}\n`)
        }
      }
    } finally {
      reconciling = false
    }
  }

  /** The live fs.watch handle and its pending debounce — hoisted out of
   *  watchPlaybooks() so stop() can release both. An fs watcher keeps the
   *  process alive; a per-instance one that outlives its server is precisely
   *  the leak the in-process smoke test exists to catch. */
  let playbookWatcher: ReturnType<typeof watch> | null = null
  let playbookDebounce: ReturnType<typeof setTimeout> | null = null

  /** Watch playbook directory for changes. */
  function watchPlaybooks() {
    if (!existsSync(PLAYBOOKS_DIR)) return

    playbookWatcher = watch(PLAYBOOKS_DIR, (_eventType, filename) => {
      if (!filename?.endsWith('.md')) return
      // Debounce — editors often fire multiple events for one save
      if (playbookDebounce) clearTimeout(playbookDebounce)
      playbookDebounce = setTimeout(() => {
        void reconcilePlaybooks()
      }, 200)
    })
    ports.log(`[jean] watching ${PLAYBOOKS_DIR} for changes\n`)
  }

  // ── Chat bridge (Telegram / Slack, optional) ──────────────────────
  //
  // The bridge is a transport; the infra owns the operations it needs — turn an
  // inbound surface message into a `reply` event, register the surface as a
  // user-role agent it can deliver to, and persist inbound attachments under the
  // dojo so the bridge can point the sensei at a file it can open. See
  // src/infra/bridge.ts.

  const INBOX_DIR = resolve(DATA_DIR, 'inbox')

  async function initBridge() {
    if (!bridge) return
    await bridge.start({
      register: (name, send) => {
        // NO lastActivityAt (review finding [C]). Bridge registration is INFRA's
        // act at boot, not the human's — stamping it would make a chat surface
        // that has been silent for months read `session: active` for the next 45
        // minutes after every restart. The human's traffic is their inbound
        // message (see onInbound below); until one arrives, absent → `quiet`.
        agents.set(name, {
          role: 'user',
          idle: true,
          tags: [],
          deliver: (msg) => send({ from: msg.from, text: msg.text, attachments: msg.attachments }),
        })
        userAgentNames.add(name)
        void record('register', agentStream(name), {
          agent: name,
          role: 'user',
          idle: true,
        } satisfies RegisterData)
      },
      onInbound: (name, text, meta) => {
        // A human's inbound message is that identity's traffic too — it makes
        // `session` on GET /agents meaningful for bridge surfaces.
        touchAgent(name)
        void record('reply', agentStream(name), {
          agent: name,
          text,
          ...(meta?.sentAt && { sentAt: meta.sentAt }),
          ...(meta?.sourceId && { sourceId: meta.sourceId }),
        } satisfies ReplyData)
      },
      saveAttachment: (data, filename) => {
        mkdirSync(INBOX_DIR, { recursive: true })
        const safe = filename.replace(/[^\w.-]/g, '_')
        const dest = resolve(INBOX_DIR, `${ports.now()}-${safe}`)
        writeFileSync(dest, data)
        return dest
      },
    })
  }

  // ── Source connectors (email/… → work queue, read-only) ───────────
  //
  // Read-only connectors whose inbound items land in a per-instance queue the
  // sensei triages on its own cadence (a dojo playbook decides what to do with
  // them — that's not the framework's job). Inert until a `role: source`
  // connector is configured. See src/infra/connectors/ and docs/connectors.md.

  async function initSources() {
    for (const cfg of resolveConnectors(config).filter((c) => c.role === 'source')) {
      const connector = createSourceConnector(cfg)
      if (!connector) {
        ports.log(`[jean] source "${cfg.instance}" (${cfg.kind}): no implementation yet — skipped\n`)
        continue
      }
      const queue = new SourceQueue(DATA_DIR, cfg.instance)
      const attachDir = resolve(DATA_DIR, 'sources', cfg.instance, 'attachments')
      const saveAttachment = (data: Uint8Array, name: string): string => {
        mkdirSync(attachDir, { recursive: true })
        const dest = resolve(attachDir, `${ports.now()}-${name.replace(/[^\w.-]/g, '_')}`)
        writeFileSync(dest, data)
        return dest
      }
      void connector.start(sourceContext(queue, saveAttachment))
      ports.log(`[jean] source started: ${cfg.instance} (${cfg.kind})\n`)
    }
  }

  // ── Port + single-instance enforcement ───────────────────────────

  const PORT = portOverride ?? config.port ?? 8700
  /** The port actually bound. Identical to PORT for every real value; the two
   *  differ only under `port: 0`, where the OS picks and Bun.serve reports it
   *  back below. Everything that PUBLISHES a port — identity(), the runtime
   *  files, the `start` event, the listening log — reads this one, so an
   *  ephemeral instance still describes itself truthfully. */
  let boundPort = PORT
  const PORT_FILE = resolve(DATA_DIR, 'infra.port')
  const PID_FILE = resolve(DATA_DIR, 'infra.pid')

  /** Fields that can be updated on a trigger via PATCH. Schedule (cron/at) is immutable. */
  const TRIGGER_UPDATE_FIELDS = new Set(['agent', 'prompt', 'status', 'metadata'])

  /** The identity tuple returned by `/` and embedded in `/status`. Matches `InfraInfo`. */
  function identity(): InfraInfo {
    return { name: INFRA_IDENTITY, dataDir: DATA_DIR, pid: process.pid, port: boundPort }
  }

  /** Print the appropriate "can't start" error for whatever is occupying PORT,
   *  then abort the start. Used to be `process.exit(1)`; a process.exit here
   *  would kill any in-process caller (a test importing this module would simply
   *  die). The stderr text and the CLI's exit code are unchanged — the
   *  entrypoint at the bottom of the file maps InfraStartError back to exit 1. */
  function refuseStart(info: InfraInfo | null): never {
    let message: string
    if (info?.name === INFRA_IDENTITY) {
      const sameDojo = !info.dataDir || info.dataDir === DATA_DIR
      if (sameDojo) {
        const pidHint = info.pid ? `pid ${info.pid}` : 'unknown pid'
        message =
          `[jean] error: infra already running on port ${PORT} (${pidHint})\n` +
          `       use 'jean infra stop' first${info.pid ? `, or kill ${info.pid}` : ''}\n`
      } else {
        message =
          `[jean] error: port ${PORT} is used by another Jean dojo (${info.dataDir})\n` +
          `       run 'jean config set port <other>' in this dojo\n`
      }
    } else {
      message =
        `[jean] error: port ${PORT} is in use by another process\n` +
        `       run 'jean config set port <other>' to change\n`
    }
    ports.log(message)
    throw new InfraStartError(message)
  }

  /** Enforce single-instance per dojo. Clean up stale state from crashes. */
  async function enforceSingleInstance(): Promise<void> {
    // If something responds on PORT with our identity, refuse. (Same dojo → duplicate;
    // different dojo → port conflict. refuseStart picks the message.)
    const info = await probeInfra(PORT)
    if (info?.name === INFRA_IDENTITY) refuseStart(info)

    // Port might be held by a non-HTTP listener that probeInfra can't see.
    try {
      Bun.serve({ port: PORT, hostname: '127.0.0.1', fetch: () => new Response() }).stop(true)
    } catch {
      refuseStart(null)
    }

    // Port is free. Any leftover pid/port files are stale from a crash.
    const { pid: stalePid } = readRuntimeFiles(DATA_DIR)
    if (stalePid !== null) {
      ports.log(`[jean] cleaning up stale pid/port files (pid ${stalePid})\n`)
      try {
        unlinkSync(PID_FILE)
      } catch {}
      try {
        unlinkSync(PORT_FILE)
      } catch {}
    }
  }

  function writeRuntimeFiles() {
    writeFileSync(PORT_FILE, String(boundPort))
    writeFileSync(PID_FILE, String(process.pid))
    // Self-register into the machine-global dojo registry: lazy retrofit for dojos
    // created before the registry existed, and drift-correction to the bound port.
    // Guarded — the registry is a convenience and must never block infra start.
    try {
      // DATA_DIR is the dojo's .jean dir; its parent is the dojo root (same idiom
      // as elsewhere in this file). resolve handles the JEAN_DATA_DIR-unset case.
      upsertDojo({ path: resolve(DATA_DIR, '..'), port: boundPort, identity: config.identity })
    } catch {}
  }

  // The exit/SIGINT/SIGTERM handlers that used to sit HERE now live in the CLI
  // entrypoint at the bottom of this file — see the comment there for why they
  // must not be registered per-instance. This callback is the seam that keeps
  // them registered at this exact point in startup and not a moment earlier.
  onBeforeSingleInstanceCheck?.()

  if (shouldEnforceSingleInstance) await enforceSingleInstance()

  // ── HTTP + WebSocket server ───────────────────────────────────────

  type Upgrader = { upgrade(req: Request, opts: { data: Record<string, never> }): boolean }

  function handleHttp(req: Request, server: Upgrader): Response | Promise<Response> | undefined {
    const url = new URL(req.url)
    const path = url.pathname

    if (path === '/ws') {
      if (server.upgrade(req, { data: {} })) return
      return new Response('upgrade failed', { status: 400 })
    }

    // ── Task CRUD ───────────────────────────────────────────────

    if (path === '/tasks' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as CreateTaskRequest
        if (!body.title || !body.queue) {
          return Response.json({ error: 'missing title or queue' }, { status: 400 })
        }
        const taskId = nextTaskId()
        await record('task-created', taskStream(taskId), {
          title: body.title,
          description: body.description ?? '',
          queue: body.queue,
          playbook: body.playbook,
          actor: body.actor ?? 'api',
        } satisfies TaskCreatedData)
        const task = boardProjection.state.tasks.find((t) => t.id === taskId)
        return Response.json(task, { status: 201 })
      })()
    }

    if (path === '/tasks' && req.method === 'GET') {
      let tasks = boardProjection.state.tasks
      const status = url.searchParams.get('status')
      if (status) tasks = tasks.filter((t) => t.status === status)
      const queue = url.searchParams.get('queue')
      if (queue) tasks = tasks.filter((t) => t.queue === queue)
      return Response.json({ tasks })
    }

    const taskGetMatch = path.match(/^\/tasks\/(\w+)$/)
    if (taskGetMatch && req.method === 'GET') {
      return (async () => {
        const taskId = taskGetMatch[1]
        if (!taskId) return Response.json({ error: 'not found' }, { status: 404 })
        const task = boardProjection.state.tasks.find((t) => t.id === taskId)
        if (!task) return Response.json({ error: 'not found' }, { status: 404 })
        const include = new Set((url.searchParams.get('include') ?? '').split(',').filter(Boolean))
        if (include.size === 0) return Response.json(task)
        const enriched: Record<string, unknown> = { ...task }
        // Load the task's event stream once if any include flag needs it. Add new stream-backed flags here.
        const STREAM_INCLUDES = ['comments', 'messages'] as const
        const needsStream = STREAM_INCLUDES.some((k) => include.has(k))
        const events = needsStream ? await store.read({ stream: taskStream(taskId) }) : []
        if (include.has('comments')) {
          // Curated task-comment events — deliberate notes worth reading as a summary.
          enriched.comments = events.flatMap((e) => {
            if (e.type !== 'task-comment') return []
            const d = e.data as TaskCommentData
            return [{ ts: e.ts, from: d.agent, text: d.text }]
          })
        }
        if (include.has('messages')) {
          // Chat-level reply/send events — full correspondence, higher volume, useful for diagnostics.
          enriched.messages = events.flatMap((e) => {
            if (e.type === 'reply') {
              const d = e.data as ReplyData
              return [{ ts: e.ts, from: d.agent, text: d.text }]
            }
            if (e.type === 'send') {
              const d = e.data as SendData
              return [{ ts: e.ts, from: d.from, to: d.agent, text: d.text }]
            }
            return []
          })
        }
        if (include.has('playbook') && task.playbook) {
          const playbook = playbookProjection.state.playbooks.find((p) => p.id === task.playbook)
          if (playbook) {
            enriched.playbook = { id: playbook.id, name: playbook.name, content: playbook.content }
          }
        }
        return Response.json(enriched)
      })()
    }

    const statusMatch = path.match(/^\/tasks\/(\w+)\/status$/)
    if (statusMatch && req.method === 'PATCH') {
      return (async () => {
        const body = (await req.json()) as UpdateStatusRequest
        if (!body.status) {
          return Response.json({ error: 'missing status' }, { status: 400 })
        }
        const task = boardProjection.state.tasks.find((t) => t.id === statusMatch[1])
        if (!task) return Response.json({ error: 'not found' }, { status: 404 })
        if (!canTransition(task.status, body.status as TaskStatus)) {
          return Response.json({ error: `invalid transition: ${task.status} → ${body.status}` }, { status: 400 })
        }
        await record('task-status', taskStream(task.id), {
          from: task.status,
          to: body.status as TaskStatus,
          actor: body.actor ?? 'api',
        } satisfies TaskStatusData)
        const updated = boardProjection.state.tasks.find((t) => t.id === task.id)
        return Response.json(updated)
      })()
    }

    const revertMatch = path.match(/^\/tasks\/(\w+)\/revert$/)
    if (revertMatch && req.method === 'POST') {
      return (async () => {
        const taskId = revertMatch[1]
        if (!taskId) return Response.json({ error: 'not found' }, { status: 404 })
        const task = boardProjection.state.tasks.find((t) => t.id === taskId)
        if (!task) return Response.json({ error: 'not found' }, { status: 404 })
        const body = (await req.json().catch(() => ({}))) as { actor?: string }

        // Rebuild the task's status stack from its event stream.
        const events = await store.read({ stream: taskStream(taskId) })
        const stack: TaskStatus[] = []
        for (const e of events) {
          if (e.type === 'task-created') stack.push('todo')
          else if (e.type === 'task-status') stack.push((e.data as TaskStatusData).to)
          else if (e.type === 'task-reverted') {
            const target = (e.data as TaskRevertedData).to
            while (stack.length > 0 && stack[stack.length - 1] !== target) stack.pop()
          }
        }

        if (stack.length <= 1) {
          return Response.json({ error: 'nothing to revert — task has no prior status to return to' }, { status: 400 })
        }
        const from = stack[stack.length - 1] as TaskStatus
        const to = stack[stack.length - 2] as TaskStatus
        await record('task-reverted', taskStream(taskId), {
          from,
          to,
          actor: body.actor ?? 'api',
        } satisfies TaskRevertedData)
        const updated = boardProjection.state.tasks.find((t) => t.id === taskId)
        return Response.json({ ...updated, reverted: { from, to } })
      })()
    }

    const taskPatchMatch = path.match(/^\/tasks\/(\w+)$/)
    if (taskPatchMatch && req.method === 'PATCH') {
      return (async () => {
        const body = (await req.json()) as UpdateTaskRequest
        const task = boardProjection.state.tasks.find((t) => t.id === taskPatchMatch[1])
        if (!task) return Response.json({ error: 'not found' }, { status: 404 })
        await record('task-updated', taskStream(task.id), {
          ...(body.agent !== undefined && { agent: body.agent }),
          ...(body.description !== undefined && { description: body.description }),
          actor: body.actor ?? 'api',
        } satisfies TaskUpdatedData)
        const updated = boardProjection.state.tasks.find((t) => t.id === task.id)
        return Response.json(updated)
      })()
    }

    // ── Context endpoints ───────────────────────────────────────
    //
    // POST /context/memorize  — agent records a memory event (cross-task
    //   knowledge worth surfacing in the wiki).
    // POST /context/consolidated — librarian records a wiki-consolidated
    //   event at the end of a run, with anomalies for sensei to surface.
    //
    // The wiki itself lives at .jean/context/; these endpoints write the
    // events that feed it (memorize) and signal its lifecycle (consolidated).
    // See docs/llm-wiki-design.md.

    if (path === '/context/memorize' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as Partial<MemoryData>
        if (!body.agent || !body.role || !body.text?.trim()) {
          return Response.json({ error: 'memorize requires agent, role, and non-empty text' }, { status: 400 })
        }
        const scope: MemoryScope = body.scope === 'user' ? 'user' : 'dojo'
        const event = await record('memory', MEMORY_STREAM, {
          agent: body.agent,
          role: body.role,
          text: body.text.trim(),
          scope,
          ...(body.taskId && { taskId: body.taskId }),
        } satisfies MemoryData)
        return Response.json({ id: event.id })
      })()
    }

    if (path === '/context/consolidated' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as Partial<WikiConsolidatedData>
        const data: WikiConsolidatedData = {
          ...(body.pagesCreated !== undefined && { pagesCreated: body.pagesCreated }),
          ...(body.pagesUpdated !== undefined && { pagesUpdated: body.pagesUpdated }),
          ...(body.corrections !== undefined && { corrections: body.corrections }),
          ...(body.tasksDistilled !== undefined && { tasksDistilled: body.tasksDistilled }),
          ...(body.eventsProcessed !== undefined && { eventsProcessed: body.eventsProcessed }),
          ...(body.rawFilesProcessed !== undefined && { rawFilesProcessed: body.rawFilesProcessed }),
          ...(Array.isArray(body.anomalies) && body.anomalies.length > 0 && { anomalies: body.anomalies }),
        }
        const event = await record('wiki-consolidated', SYSTEM_STREAM, data)
        return Response.json({ id: event.id })
      })()
    }

    // GET /context/recent — memorize events not yet folded into the wiki
    // (id > consolidator cursor). No agent filter: different readers want
    // different views (sensei wants own writes; bootstrapping workers want
    // everyone's). Filtering is the caller's job.

    if (path === '/context/recent' && req.method === 'GET') {
      return (async () => {
        const cursorPath = resolve(DATA_DIR, '.consolidator', 'cursor.json')
        let cursor: { lastEventId: number; lastConsolidatedAt?: string } | null = null
        try {
          cursor = JSON.parse(await Bun.file(cursorPath).text()) as {
            lastEventId: number
            lastConsolidatedAt?: string
          }
        } catch {
          // No cursor file — fresh dojo or librarian has never run.
        }

        const sinceParam = url.searchParams.get('since')
        const since = sinceParam !== null ? Number(sinceParam) : (cursor?.lastEventId ?? 0)

        const limitParam = url.searchParams.get('limit')
        const limit = limitParam !== null ? Number(limitParam) : undefined

        let events = await store.read({ stream: MEMORY_STREAM, afterId: since })
        if (limit !== undefined && limit > 0) events = events.slice(-limit)

        return Response.json({
          cursor,
          events: events.map((e) => ({
            id: e.id,
            ts: e.ts,
            ...(e.data as MemoryData),
          })),
        })
      })()
    }

    // GET /context/map — the live page map (name + trigger-style description),
    // generated from page frontmatter so it never lags consolidation. The
    // agent's "which page holds X" answer, one glance.
    if (path === '/context/map' && req.method === 'GET') {
      try {
        const pages = wikiDocs(resolve(DATA_DIR, 'context')).map((d) => ({
          page: d.page,
          description: d.description,
        }))
        return Response.json({ pages, count: pages.length })
      } catch (err) {
        // Read failure ≠ empty map — surface it rather than imply "no pages."
        return Response.json(
          { error: 'the wiki could not be read', detail: err instanceof Error ? err.message : String(err) },
          { status: 503 },
        )
      }
    }

    // GET /context/search?q=…&scope=all&topN=5 — curated search over the dojo's
    // memory. `scope` defaults to `all` (wiki + unconsolidated memory + task
    // comments + human⇄agent channel), ranked together: recall-safety is the
    // default, so an all-scope empty means "definitively nowhere in the dojo's
    // memory" — the signal that kills the grep-the-raw-log reflex. Narrow to
    // knowledge/tasks/channel to search one source on purpose. Ranking is
    // field-boosted BM25 + capped fuzzy (see retrieval.ts).
    if (path === '/context/search' && req.method === 'GET') {
      return (async () => {
        const q = url.searchParams.get('q') ?? ''
        // Absent scope defaults to `all`; an INVALID scope is a caller error,
        // not a silent widen — returning all-scope hits for a typo'd
        // `scope=knowlege` would mislead a caller who meant to narrow.
        const scopeParam = url.searchParams.get('scope')
        if (scopeParam !== null && !CONTEXT_SCOPES.includes(scopeParam)) {
          return Response.json({ error: `invalid scope "${scopeParam}"`, validScopes: CONTEXT_SCOPES }, { status: 400 })
        }
        const scope = scopeParam ?? 'all'
        // Pass the raw parse through; search() clamps garbage (negative,
        // fractional, NaN) to a sane [1, MAX] rather than letting it reach
        // slice()/Math.min. Absent → undefined → search's default.
        const topNParam = url.searchParams.get('topN')
        const topN = topNParam !== null ? Number(topNParam) : undefined
        let result: SearchResult
        try {
          result = runSearch(buildIndex(await buildCorpus(scope)), q, { topN, scope })
        } catch (err) {
          // A knowledge source that fails to READ (vs. legitimately absent)
          // must not masquerade as an empty result — empty means "definitively
          // not in memory," so a masked read failure would be a lie. Surface it.
          return Response.json(
            { error: 'a knowledge source could not be read', detail: err instanceof Error ? err.message : String(err) },
            { status: 503 },
          )
        }
        logRetrieval({
          at: new Date(ports.now()).toISOString(),
          from: url.searchParams.get('from') ?? undefined,
          query: q,
          scope,
          total: result.total,
          returned: result.returned,
          empty: result.empty,
          hits: result.hits.map((h) => ({ page: h.page, source: h.source, score: h.score })),
        })
        return Response.json(result)
      })()
    }

    // ── Message routing ─────────────────────────────────────────

    if (path === '/send' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as SendRequest
        if (!body.to || !body.text) {
          return Response.json({ error: 'missing to or text' }, { status: 400 })
        }
        const delivered = await routeSend({
          from: body.from ?? 'api',
          to: body.to,
          text: body.text,
          taskId: body.taskId,
          attachments: body.attachments,
        })
        return Response.json({ delivered })
      })()
    }

    // ── Agent idle (stop hook) ──────────────────────────────────

    if (path === '/agent-idle' && (req.method === 'POST' || req.method === 'GET')) {
      return (async () => {
        let agentName: string | null = null
        let sessionId: string | undefined
        if (req.method === 'POST') {
          const body = (await req.json()) as { agent: string; sessionId?: string }
          agentName = body.agent
          sessionId = body.sessionId
        } else {
          agentName = url.searchParams.get('name')
          sessionId = url.searchParams.get('sessionId') ?? undefined
        }
        if (!agentName) {
          return Response.json({ error: 'missing agent name' }, { status: 400 })
        }

        const entry = agents.get(agentName)

        if (sessionId && entry?.sessionId && sessionId !== entry.sessionId) {
          ports.log(
            `[jean] WARNING: agent-idle for "${agentName}" from stale session ${sessionId} (current: ${entry.sessionId})\n`,
          )
          void record('agent-idle', agentStream(agentName), {
            agent: agentName,
            role: entry.role,
            stale: true,
            hookSessionId: sessionId,
            currentSessionId: entry.sessionId,
          })
          return Response.json({ ok: false, error: 'stale session', currentSessionId: entry.sessionId })
        }

        if (!entry) {
          ports.log(`[jean] WARNING: agent-idle for "${agentName}" but agent is not connected\n`)
          void record('agent-idle', agentStream(agentName), { agent: agentName, role: 'unknown', disconnected: true })
          return Response.json({ ok: false, error: 'agent not connected' })
        }

        // A Stop-hook post is inbound traffic like any other (phase 4 §3) — it
        // sharpens liveness even though it no longer carries correctness.
        touchAgent(agentName)
        entry.idle = true
        const role = entry.role
        const taskId = inferTaskId(agentName)
        const stream = taskId ? taskStream(taskId) : agentStream(agentName)
        await record('agent-idle', stream, { agent: agentName, role } satisfies AgentIdleData)

        if (role === 'sensei') {
          attention.nudge(viewNow(ports.now()))
        }

        return Response.json({ ok: true })
      })()
    }

    // ── Permission tracking ──────────────────────────────────────

    if (path === '/permissions' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as { agent: string; tool: string; input?: Record<string, unknown> }
        if (!body.agent || !body.tool) {
          return Response.json({ error: 'missing agent or tool' }, { status: 400 })
        }
        await record('permission-request', agentStream(body.agent), {
          agent: body.agent,
          tool: body.tool,
          input: body.input ?? {},
        } satisfies PermissionRequestData)
        return Response.json({ ok: true })
      })()
    }

    if (path === '/permissions' && req.method === 'GET') {
      return (async () => {
        const agentFilter = url.searchParams.get('agent') ?? undefined
        const permEvents = await store.read({
          types: ['permission-request'],
          ...(agentFilter && { stream: agentStream(agentFilter) }),
        })

        type ToolStats = { count: number; samples: Record<string, unknown>[] }
        const byAgent: Record<string, Record<string, ToolStats>> = {}
        for (const e of permEvents) {
          const d = e.data as PermissionRequestData
          byAgent[d.agent] ??= {}
          // biome-ignore lint/style/noNonNullAssertion: initialized by ??= above
          const agentMap = byAgent[d.agent]!
          agentMap[d.tool] ??= { count: 0, samples: [] }
          // biome-ignore lint/style/noNonNullAssertion: initialized by ??= above
          const entry = agentMap[d.tool]!
          entry.count++
          if (entry.samples.length < 5) entry.samples.push(d.input)
        }

        return Response.json({ permissions: byAgent })
      })()
    }

    // ── Trigger CRUD ────────────────────────────────────────────

    if (path === '/triggers' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as {
          id?: string
          cron?: string
          at?: string
          agent: string
          prompt: string
          kind?: TriggerKind
          model?: string
          retries?: number
          actor?: string
          metadata?: Record<string, unknown>
        }
        if (!body.agent || !body.prompt) {
          return Response.json({ error: 'missing agent or prompt' }, { status: 400 })
        }
        if (!body.cron && !body.at) {
          return Response.json({ error: 'must specify cron or at' }, { status: 400 })
        }
        if (body.cron && body.at) {
          return Response.json({ error: 'cron and at are mutually exclusive' }, { status: 400 })
        }
        if (body.cron) {
          try {
            new Cron(body.cron)
          } catch {
            return Response.json({ error: 'invalid cron expression' }, { status: 400 })
          }
        }
        if (body.at) {
          const d = new Date(body.at)
          if (Number.isNaN(d.getTime())) {
            return Response.json({ error: 'invalid datetime for at' }, { status: 400 })
          }
        }
        const kind: TriggerKind = body.kind ?? 'agent'
        if (kind !== 'agent' && kind !== 'headless') {
          return Response.json({ error: `invalid kind "${body.kind}", must be 'agent' or 'headless'` }, { status: 400 })
        }
        if (kind === 'headless') {
          // For headless triggers the `agent` field is the role name. Validate
          // against the canonical role list so misspellings fail at create
          // time rather than on first fire.
          if (!(AGENT_ROLES as readonly string[]).includes(body.agent)) {
            return Response.json(
              {
                error: `headless trigger requires 'agent' to be a valid role; got "${body.agent}". Valid: ${AGENT_ROLES.join(', ')}`,
              },
              { status: 400 },
            )
          }
        } else if (body.model) {
          // model only takes effect for headless invocations — agent triggers
          // route into a running Claude Code session with a fixed model.
          // Reject loudly so users don't think they configured something
          // that's silently doing nothing.
          return Response.json(
            { error: "model is only valid for headless triggers; set kind: 'headless' or remove model" },
            { status: 400 },
          )
        }
        if (body.retries !== undefined) {
          if (!Number.isInteger(body.retries) || body.retries < 0 || body.retries > 10) {
            return Response.json({ error: 'retries must be an integer between 0 and 10' }, { status: 400 })
          }
          if (kind !== 'headless' && body.retries > 0) {
            // Same reason as `model`: agent triggers don't have an attempt cycle
            // to retry — they message a running session.
            return Response.json(
              { error: "retries is only valid for headless triggers; set kind: 'headless' or remove retries" },
              { status: 400 },
            )
          }
        }

        const id = body.id ?? crypto.randomUUID().slice(0, 8)
        if (triggerProjection.state.triggers.some((t) => t.id === id)) {
          return Response.json({ error: 'trigger ID already exists' }, { status: 409 })
        }

        await record('trigger-created', TRIGGERS_STREAM, {
          id,
          cron: body.cron,
          at: body.at,
          agent: body.agent,
          prompt: body.prompt,
          kind,
          ...(body.model && { model: body.model }),
          ...(body.retries !== undefined && body.retries > 0 && { retries: body.retries }),
          actor: body.actor ?? 'api',
          metadata: body.metadata,
        } satisfies TriggerCreatedData)

        const trigger = triggerProjection.state.triggers.find((t) => t.id === id)
        return Response.json(trigger, { status: 201 })
      })()
    }

    if (path === '/triggers' && req.method === 'GET') {
      let triggers = triggerProjection.state.triggers
      const status = url.searchParams.get('status')
      if (status) triggers = triggers.filter((t) => t.status === status)
      const agent = url.searchParams.get('agent')
      if (agent) triggers = triggers.filter((t) => t.agent === agent)
      return Response.json({ triggers })
    }

    const triggerId = path.match(/^\/triggers\/([^/]+)$/)?.[1]

    if (triggerId && req.method === 'GET') {
      const trigger = triggerProjection.state.triggers.find((t) => t.id === triggerId)
      if (!trigger) return Response.json({ error: 'not found' }, { status: 404 })
      return Response.json(trigger)
    }

    if (triggerId && req.method === 'PATCH') {
      return (async () => {
        const body = (await req.json()) as Record<string, unknown>
        const trigger = triggerProjection.state.triggers.find((t) => t.id === triggerId)
        if (!trigger) return Response.json({ error: 'not found' }, { status: 404 })
        if ('cron' in body || 'at' in body) {
          return Response.json(
            { error: 'schedule is immutable; delete and recreate the trigger to change cron or at' },
            { status: 400 },
          )
        }
        // Reject unknown fields — no silent drops.
        const unknown = Object.keys(body).filter((k) => !TRIGGER_UPDATE_FIELDS.has(k))
        if (unknown.length > 0) {
          return Response.json({ error: `unknown fields: ${unknown.join(', ')}` }, { status: 400 })
        }
        const update: Omit<TriggerUpdatedData, 'id'> = {}
        if ('agent' in body) {
          if (typeof body.agent !== 'string') {
            return Response.json({ error: 'agent must be a string' }, { status: 400 })
          }
          update.agent = body.agent
        }
        if ('prompt' in body) {
          if (typeof body.prompt !== 'string') {
            return Response.json({ error: 'prompt must be a string' }, { status: 400 })
          }
          update.prompt = body.prompt
        }
        if ('status' in body) {
          if (body.status !== 'active' && body.status !== 'disabled') {
            return Response.json({ error: 'status must be "active" or "disabled"' }, { status: 400 })
          }
          update.status = body.status
        }
        if ('metadata' in body) {
          if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
            return Response.json({ error: 'metadata must be a JSON object (not array)' }, { status: 400 })
          }
          update.metadata = body.metadata as Record<string, unknown>
        }
        await record('trigger-updated', TRIGGERS_STREAM, {
          id: triggerId,
          ...update,
        } satisfies TriggerUpdatedData)
        return Response.json({ ...trigger, ...update })
      })()
    }

    if (triggerId && req.method === 'DELETE') {
      return (async () => {
        const trigger = triggerProjection.state.triggers.find((t) => t.id === triggerId)
        if (!trigger) return Response.json({ error: 'not found' }, { status: 404 })
        await record('trigger-removed', TRIGGERS_STREAM, {
          id: triggerId,
        } satisfies TriggerRemovedData)
        return Response.json({ ok: true })
      })()
    }

    const triggerFireMatch = path.match(/^\/triggers\/([^/]+)\/fire$/)
    if (triggerFireMatch && req.method === 'POST') {
      return (async () => {
        const trigger = triggerProjection.state.triggers.find((t) => t.id === triggerFireMatch[1])
        if (!trigger) return Response.json({ error: 'not found' }, { status: 404 })
        await fireTrigger(trigger)
        return Response.json({ ok: true, triggerId: trigger.id })
      })()
    }

    // ── Playbook endpoints ──────────────────────────────────────

    if (path === '/playbooks' && req.method === 'GET') {
      const playbooks = playbookProjection.state.playbooks.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        hash: p.hash,
        updatedAt: p.updatedAt,
      }))
      return Response.json({ playbooks })
    }

    const playbookMatch = path.match(/^\/playbooks\/([^/]+)$/)
    if (playbookMatch && req.method === 'GET') {
      const playbook = playbookProjection.state.playbooks.find((p) => p.id === playbookMatch[1])
      if (!playbook) return Response.json({ error: 'not found' }, { status: 404 })
      return Response.json(playbook)
    }

    // ── Event endpoints ─────────────────────────────────────────

    if (path === '/events' && req.method === 'GET') {
      const agent = url.searchParams.get('agent') ?? undefined
      return Response.json({ events: pendingEvents(agent).map(withDeliveredVia) })
    }

    // Inbox summary (attention phase 1) — the WS-path channel tools
    // (reply/comment) fetch this after a successful send to append the
    // piggyback line; also handy for QA. `inbox: null` when empty.
    if (path === '/inbox' && req.method === 'GET') {
      const inbox = senseiInboxNow()
      return Response.json({ inbox, line: inbox ? renderInboxLine(inbox) : null })
    }

    if (path === '/events/pending') {
      const agent = url.searchParams.get('agent') ?? undefined
      return Response.json({ events: pendingEvents(agent).map(withDeliveredVia) })
    }

    if (path === '/events/agents') {
      return Response.json({ agents: pendingByAgent() })
    }

    const ackMatch = path.match(/^\/events\/(\d+)\/ack$/)
    if (ackMatch && req.method === 'POST') {
      return (async () => {
        const id = Number(ackMatch[1])
        // recordAck rechecks membership itself; `ok` reflects what it actually
        // cleared, so a duplicate/racing ack reads false instead of claiming a
        // second clear of the same event.
        const acked = await recordAck([id], 'ack')
        return Response.json({ ok: acked.length > 0 })
      })()
    }

    if (path === '/events/ack' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as { upToId?: number; ids?: number[]; agent?: string }
        // Two forms (attention phase 3): `upToId` = drain-all sugar (the common
        // pattern — everything read gets acked in one call); `ids` = selective
        // per-event ack (handle the human, leave the machine events queued).
        const hasIds = Array.isArray(body.ids)
        const hasUpToId = body.upToId !== undefined
        if (!hasUpToId && !hasIds) {
          return Response.json({ error: 'pass upToId (drain-all) or ids (selective)' }, { status: 400 })
        }
        if (hasUpToId && hasIds) {
          return Response.json({ error: 'upToId and ids are mutually exclusive' }, { status: 400 })
        }
        let toAck: StoredEvent[]
        if (hasIds) {
          const valid = (body.ids as unknown[]).filter((n): n is number => Number.isInteger(n) && (n as number) > 0)
          // Empty or all-invalid ids is a caller bug — fail loud, not a silent
          // success-shaped no-op (a model passing string ids would otherwise
          // believe it acked and the nudge loop resumes).
          if (valid.length === 0) {
            return Response.json({ error: 'ids must contain positive integer event ids' }, { status: 400 })
          }
          const wanted = new Set(valid)
          // Intersect with what's actually pending — acking a non-pending id is
          // a harmless no-op, not an error (it may have been auto-cleared already).
          toAck = pendingProjection.state.filter((e) => wanted.has(e.id))
        } else {
          if (!Number.isInteger(body.upToId) || (body.upToId as number) < 1) {
            return Response.json({ error: 'upToId must be a positive integer' }, { status: 400 })
          }
          toAck = pendingProjection.state.filter((e) => e.id <= (body.upToId as number))
        }
        if (body.agent) {
          toAck = toAck.filter((e) => resolveAgent(e) === body.agent)
        }
        // Report what was actually cleared by THIS call: with concurrent acks,
        // the ids this request selected may already be owned by another writer.
        const acked = await recordAck(
          toAck.map((e) => e.id),
          'ack',
        )
        // `remaining` is a SNAPSHOT at reply time, not a transactional count: a
        // request that loses the race returns before the winner's append lands,
        // so it can report one too many (review nit [J]). Left as-is on purpose —
        // no reordering inside this handler can see another request's in-flight
        // write; making it exact means awaiting the overlapping writers, i.e. a
        // shared ack queue, which is disproportionate for a display-only field
        // (and is subsumed by the phase-5 mailbox model). `acknowledged` — the
        // field a caller acts on — is always exact.
        return Response.json({ acknowledged: acked.length, remaining: pendingProjection.state.length })
      })()
    }

    // ── History endpoint ────────────────────────────────────────

    if (path === '/history') {
      return (async () => {
        const taskId = url.searchParams.get('taskId') ?? undefined
        const last = url.searchParams.get('last')
        const raw = url.searchParams.get('raw') === 'true'
        const stream = url.searchParams.get('stream') ?? (taskId ? taskStream(taskId) : undefined)
        const includeDiagnostics = url.searchParams.get('diagnostics') === 'true'
        let events = await store.read({ stream })
        if (!includeDiagnostics) events = events.filter((e) => e.type !== 'permission-request')
        if (last) events = events.slice(-Number(last))
        return Response.json({ events: raw ? events : events.map(toApiEvent) })
      })()
    }

    // ── Info endpoints ──────────────────────────────────────────

    if (path === '/board') {
      // Staleness surfacing (attention phase 4). `openTasks` is only trustworthy
      // as a dispatchability signal if in-progress stays truthful, and the known
      // failure mode is a task nobody parked: every task carries `lastEventAt`,
      // and an in-progress task with nothing on its stream for JEAN_STALE_TASK_MS
      // is flagged `stale`.
      //
      // SURFACING ONLY — no auto-demotion, ever. Statuses are sensei-owned and
      // single-writer; infra inform, it does not obligate. The sensei's
      // housekeeping ritual decides: ping the worker, or park it to `waiting`.
      const now = ports.now()
      const tasks = boardProjection.state.tasks.map((t) => {
        // Pre-phase-4 tasks have no recorded stream activity in this projection's
        // replay window; updatedAt is the honest floor.
        const lastEventAt = taskActivity.state.get(t.id) ?? t.updatedAt
        const quietMs = now - Date.parse(lastEventAt)
        const stale = t.status === 'in-progress' && Number.isFinite(quietMs) && quietMs >= STALE_TASK_MS
        return { ...t, lastEventAt, ...(stale && { stale: true as const }) }
      })
      return Response.json({ ...boardProjection.state, tasks })
    }

    if (path === '/agents') {
      // Liveness is only probed for peers (local agents are "live" by
      // definition — they hold an open WS). Probe in parallel; per-peer
      // results are cached for 5s inside peerLiveness().
      //
      // ATTENTION PHASE 4 — the field split (docs/attention.md §3). `idle` was
      // asked two unrelated questions ("is a turn in flight?" and "is this agent
      // available for work?") and answered both badly; a sensei reading it could
      // see looks-busy-when-free and defer dispatch. Now:
      //   session   — liveness, from OBSERVED traffic (active|quiet|offline)
      //   openTasks — availability, from the board (in-progress only)
      // Strictly ADDITIVE: `idle` keeps its exact meaning and position so no
      // existing dispatch logic breaks; it's deprecated, not removed. The
      // sanctioned dispatchability read is openTasks === 0 && session !== 'offline'.
      // PEER SHAPE IS UNTOUCHED — skip-if-silent pings and channel-identity
      // routing key on the peer `liveness` field exactly as it is.
      return (async () => {
        const list = await Promise.all(
          [...agents.entries()].map(async ([name, entry]) => {
            const base = { name, role: entry.role, idle: entry.idle, tags: entry.tags }
            if (entry.role === 'peer') {
              const peer = peers.get(name)
              return { ...base, liveness: peer ? await peerLiveness(peer) : 'unknown' }
            }
            return {
              ...base,
              session: sessionOf(entry),
              openTasks: openTaskCount(name),
              ...(entry.lastActivityAt !== undefined && {
                lastActivityAt: new Date(entry.lastActivityAt).toISOString(),
              }),
            }
          }),
        )
        return Response.json({ agents: list })
      })()
    }

    // Identity: minimal, used by probes to verify "is this our jean infra?"
    if (path === '/') {
      return Response.json(identity())
    }

    // Full status: identity + live projection state, used by humans / CLI.
    if (path === '/status') {
      const sensei = findSensei()
      // Bridge health (task 006): `connected` alone was the whole of what we knew
      // while inbound lagged 9 minutes on 2026-07-25. `pollGapMs` is aged HERE, at
      // read time, because a wedged poll loop cannot report on itself; the inbound
      // lags carry the surface-side stall the poll loop structurally cannot see.
      // See the failure-class note in src/infra/bridge.ts.
      const bridgeHealth = bridge?.health()
      return Response.json({
        ...identity(),
        agents: [...agents.entries()].map(([n, e]) => ({ name: n, role: e.role })),
        sensei: sensei ? { connected: true, idle: sensei.entry.idle } : { connected: false },
        pendingEvents: pendingProjection.state.length,
        activeTriggers: triggerProjection.state.triggers.filter((t) => t.status === 'active').length,
        bridge:
          bridge && bridgeHealth
            ? {
                configured: true,
                kind: bridge.kind,
                connected: bridge.connected(),
                target: bridge.target,
                lastPollAt: bridgeHealth.lastPollAt,
                pollGapMs: bridgeHealth.lastPollAt === null ? null : ports.now() - bridgeHealth.lastPollAt,
                lastPollOkAt: bridgeHealth.lastPollOkAt,
                consecutiveFailures: bridgeHealth.consecutiveFailures,
                lastInboundAt: bridgeHealth.lastInboundAt,
                lastInboundLagMs: bridgeHealth.lastInboundLagMs,
                maxInboundLagMs: bridgeHealth.maxInboundLagMs,
              }
            : { configured: false },
      })
    }

    return new Response('not found', { status: 404 })
  }

  /** In-flight sensei connect greetings (the 500 ms timer in the register
   *  handler). Tracked only so stop() can cancel the ones still pending — a
   *  server that has been stopped must not hold the process open for half a
   *  second per recent sensei connect. */
  const greetingTimers = new Set<ReturnType<typeof setTimeout>>()

  const httpServer = Bun.serve<{ agent?: string; role?: AgentRole }>({
    port: PORT,
    hostname: '127.0.0.1',

    // Thin wrapper: compute the response, then attach the inbox piggyback
    // (docs/attention.md §2 — the compact line rides as a response header on
    // sensei channel-tool requests; empty inbox = no header, zero cost).
    async fetch(req, server) {
      // Observed liveness (attention phase 4 §3): an agent's HTTP call IS the
      // proof it's alive — bump before handling, so even a request that errors
      // still counts as traffic.
      touchAgent(callerFromHeader(req))
      const res = await handleHttp(req, server)
      if (res === undefined) return undefined // WS upgrade path
      return withInboxHeader(req, res)
    },

    websocket: {
      open(_ws) {},

      close(ws) {
        const agent = ws.data.agent
        if (agent) {
          agents.delete(agent)
          void record('disconnect', agentStream(agent), { agent })
        }
      },

      message(ws, raw) {
        try {
          const msg = JSON.parse(String(raw)) as InboundMsg

          // Any frame from a registered session is proof of life (phase 4 §3).
          // Keyed on the SESSION's agent, never the wire's `from` — same
          // anti-spoofing rule the send path uses. (`register` has no entry yet;
          // it sets lastActivityAt on creation below.)
          touchAgent(ws.data.agent)

          switch (msg.type) {
            case 'register': {
              const role = msg.role ?? 'worker'

              // Handle existing agent with same name.
              const existing = agents.get(msg.agent)
              if (existing && existing.deliver !== wsDeliver(ws)) {
                const sameSession = !!msg.sessionId && !!existing.sessionId && msg.sessionId === existing.sessionId
                const existingStillLive = existing.isLive?.() ?? false
                // Concurrent duplicate: old WS is still live AND the newcomer has
                // a different sessionId. This is two `jean agent start <name>`
                // processes fighting for the same slot. Without this guard, each
                // kick spawns a reconnect that kicks the other, ping-ponging
                // forever and firing a nudge on every cycle. Keep the incumbent;
                // reject the newcomer and tell its plugin to stop reconnecting.
                if (!sameSession && existingStillLive) {
                  wsSend(ws, {
                    type: 'deliver',
                    from: 'infra',
                    text: `ERROR: agent "${msg.agent}" is already connected from another session (${existing.sessionId ?? 'unknown'}). This session will be closed — only one process per agent name. Stop the other 'jean agent start ${msg.agent}' if this one is the intended instance.`,
                  })
                  wsSend(ws, {
                    type: 'error',
                    code: 'duplicate-session',
                    agent: msg.agent,
                    message: 'Another session is already registered for this agent name.',
                  })
                  ws.close()
                  // Route a one-shot notice to sensei so the human has at least one
                  // visible surface to learn about the rejection. Without this,
                  // sensei is blind (we deliberately suppressed the register
                  // event to avoid the nudge-flood problem) and the newcomer's
                  // stderr is easy to miss inside a Claude Code TUI.
                  //
                  // The fourth direct sensei push, and it goes through the port
                  // like the other three — it is adapter-initiated (not an
                  // attention decision), but "the port covers every delivery" is
                  // only worth something if it has no exceptions.
                  //
                  // PRE-EXISTING, LEFT ALONE: `sensei.entry.deliver !==
                  // wsDeliver(ws)` is always true, because wsDeliver returns a
                  // fresh closure on every call. The intent was "don't notify
                  // the sensei about its own rejected duplicate". Preserved
                  // verbatim — this is a behaviour-preserving stage, and the
                  // condition is reported rather than quietly fixed.
                  const sensei = findSensei()
                  if (sensei && sensei.entry.deliver !== wsDeliver(ws)) {
                    ports.deliver(sensei.name, {
                      type: 'deliver',
                      from: 'infra',
                      text:
                        `Notice: rejected a duplicate \`${msg.agent}\` session attempt. ` +
                        `The existing session (sessionId ${existing.sessionId ?? 'unknown'}) is still connected; ` +
                        `the attempted session (sessionId ${msg.sessionId ?? 'unknown'}) was closed. ` +
                        `If the human may have started \`jean agent start ${msg.agent}\` twice by accident, ` +
                        `let them know — only one process per agent name is allowed, and the duplicate's plugin ` +
                        `has been told to stop reconnecting.`,
                    })
                  }
                  break
                }
                // Old WS is dead (or same session reconnecting) — replace cleanly.
                if (!sameSession) {
                  if (ws.data.agent) ws.data.agent = undefined
                  existing.close?.()
                }
                agents.delete(msg.agent)
              }

              // Only one sensei allowed
              if (role === 'sensei') {
                const existingSensei = findSensei()
                if (existingSensei) {
                  wsSend(ws, {
                    type: 'deliver',
                    from: 'infra',
                    text: 'ERROR: Another sensei is already connected. Only one sensei per dojo. This connection will be ignored.',
                  })
                  break
                }
              }

              ws.data.agent = msg.agent
              ws.data.role = msg.role
              // ATTENTION PHASE 4: register no longer derives `idle` from the
              // board. A freshly-connected session has no turn in flight — that
              // is all `idle` means now. Deriving it from task state was the
              // looks-busy-when-free bug: a sensei holding an in-progress task
              // registered idle:false and suppressed its OWN nudges from second
              // one (docs/attention.md §3). Task-state now travels as `openTasks`
              // on GET /agents, where it can't be mistaken for a session hint.
              // RegisterData keeps the `idle` field — event shape unchanged.
              const idle = true
              const sessionId = msg.sessionId
              agents.set(msg.agent, {
                role,
                idle,
                sessionId,
                tags: msg.tags ?? [],
                // Registering IS traffic — the session's first observed activity.
                lastActivityAt: ports.now(),
                deliver: wsDeliver(ws),
                close: () => {
                  ws.data.agent = undefined
                  ws.close()
                },
                isLive: () => ws.readyState === 1,
              })
              wsSend(ws, { type: 'registered', agent: msg.agent, role })
              if (role === 'user') userAgentNames.add(msg.agent)
              if (role === 'sensei') senseiNames.add(msg.agent)
              void record('register', agentStream(msg.agent), {
                agent: msg.agent,
                role,
                idle,
                sessionId,
              } satisfies RegisterData)

              if (role === 'sensei') {
                const greeting = setTimeout(() => {
                  greetingTimers.delete(greeting)
                  ports.deliver(msg.agent, {
                    type: 'deliver',
                    from: 'infra',
                    text: 'You just connected. Check the board and events to get up to date.',
                  })
                }, 500)
                greetingTimers.add(greeting)
              }
              // Worker/user register events enter pending via the reducer; the post-record nudge
              // in record() wakes the sensei if idle. No explicit nudge needed here.
              break
            }

            case 'reply': {
              const sender = agents.get(msg.from)
              if (sender?.role === 'sensei') {
                ports.log(
                  `[jean] dropping reply from sensei ${msg.from} — sensei must use send with an explicit recipient\n`,
                )
                break
              }
              // Prefer taskId carried on the message (flowed through from deliver); fall back to inference for legacy clients.
              const taskId = msg.taskId ?? inferTaskId(msg.from)
              const stream = taskId ? taskStream(taskId) : agentStream(msg.from)
              void record('reply', stream, { agent: msg.from, text: msg.text } satisfies ReplyData)
              break
            }

            case 'send': {
              // `from` comes from the WS session, never the wire — prevents spoofing.
              const from = ws.data.agent
              if (!from || !msg.to || !msg.text) break
              routeSend({ from, to: msg.to, text: msg.text, taskId: msg.taskId, attachments: msg.attachments }).catch(
                (err) => {
                  ports.log(`[jean] ws send from ${from} → ${msg.to} failed: ${err}\n`)
                },
              )
              break
            }

            case 'task-comment': {
              // `from` comes from the WS session. Comment requires an explicit taskId from the sender.
              const from = ws.data.agent
              if (!from || !msg.taskId || !msg.text) break
              const role = agents.get(from)?.role ?? 'worker'
              void record('task-comment', taskStream(msg.taskId), {
                agent: from,
                role,
                text: msg.text,
              } satisfies TaskCommentData)
              break
            }
          }
        } catch {
          // Ignore malformed messages
        }
      },
    },
  })

  // ── Startup ──────────────────────────────────────────────────────
  //
  // ORDERING IS UNCHANGED, DELIBERATELY. Bun.serve is already listening above,
  // so this block runs while the socket accepts connections — the same window
  // that exists today. Serializing it before the listen would arguably be
  // better, but it is a behaviour change and this stage is a move, not a
  // rewrite. Callers that need "started" to mean "fully caught up" get it: the
  // factory's promise resolves only after this block completes.

  // `port` is optional in Bun's types (a unix-socket server has none); we always
  // bind TCP, so the fallback is unreachable and just keeps the type honest.
  boundPort = httpServer.port ?? PORT

  if (shouldWriteRuntimeFiles) writeRuntimeFiles()
  ports.log(`[jean] listening on port ${boundPort} (data: ${DATA_DIR})\n`)

  void record('start', SYSTEM_STREAM, { port: boundPort } satisfies StartData)
  await initBridge()
  await initSources()

  // Start scheduled trigger jobs from projection state
  syncTriggerJobs()

  // Catch up: if a cron trigger has lastFiredAt older than the most recent
  // scheduled time, fire it once on startup. Handles "machine was off when
  // the nightly run was due." Sequential await for headless triggers so we
  // don't stampede multiple parallel Claude spawns when many are overdue.
  // See src/infra/trigger-catchup.ts.
  {
    const now = new Date(ports.now())
    for (const trigger of triggerProjection.state.triggers) {
      if (trigger.status !== 'active') continue
      if (!shouldCatchUp(trigger, now)) continue
      ports.log(`[jean] trigger ${trigger.id} catch-up fire on startup (last fired ${trigger.lastFiredAt})\n`)
      if (trigger.kind === 'headless') {
        await fireTrigger(trigger)
        // For headless catch-up specifically, wait for the spawn to actually
        // complete before launching the next — fireTrigger detaches the
        // spawn so we have to track it via the headless-completed event.
        await waitForHeadlessCompletion(trigger.id)
      } else {
        void fireTrigger(trigger)
      }
    }
  }

  // Reconcile playbooks with files on disk, then watch for changes
  await reconcilePlaybooks()
  watchPlaybooks()

  /** Release every handle this instance holds. Nothing on the CLI path calls
   *  this — the process simply exits — so it is new surface, not changed
   *  behaviour. It exists because `bun test` runs all 43 files in ONE process:
   *  an instance that outlives its test leaks a listening socket, two
   *  intervals, N cron jobs and an fs watcher into every file that follows. */
  let stopped = false
  async function stop(): Promise<void> {
    if (stopped) return // idempotent — a double stop must not throw
    stopped = true
    clearInterval(blockingTick)
    clearInterval(stallTick)
    // Everything the schedule port was asked to run — not croner's own table,
    // which an injected port never populates.
    for (const id of [...scheduledIds]) ports.unschedule(id)
    scheduledIds.clear()
    if (playbookDebounce) clearTimeout(playbookDebounce)
    playbookDebounce = null
    playbookWatcher?.close()
    playbookWatcher = null
    for (const timer of greetingTimers) clearTimeout(timer)
    greetingTimers.clear()
    // Symmetry: an instance that wrote the runtime files removes them. The CLI
    // path never reaches here (its process.on('exit') hook does the sweep).
    if (shouldWriteRuntimeFiles) cleanupRuntimeFiles(DATA_DIR)
    await httpServer.stop(true)
  }

  return {
    port: boundPort,
    dataDir: DATA_DIR,
    stop,
  }
}

// ── CLI entrypoint ────────────────────────────────────────────────
//
// Everything above is a library; this is the only part that runs when the file
// is executed directly — `bun run src/infra/server.ts`, which is what
// `jean infra start` spawns (src/cli/jean.ts).
//
// The signal/exit handlers live HERE and nowhere else. Registered per-instance
// inside the factory they would accumulate one listener set per
// createInfraServer() call in a test process, and cleanupRuntimeFiles would
// unlink a real dojo's runtime files.
//
// They are registered through onBeforeSingleInstanceCheck rather than up front,
// so that their arming point is the SAME point in startup as before the
// refactor: after the store and projections are up, immediately before the
// single-instance check. A failure earlier than that (malformed history.jsonl)
// therefore still leaves the runtime files alone, and a refused duplicate start
// still sweeps them — both exactly as they did before.
if (import.meta.main) {
  const dataDir = resolve(process.env.JEAN_DATA_DIR ?? '.')
  try {
    await createInfraServer({
      onBeforeSingleInstanceCheck: () => {
        process.on('exit', () => cleanupRuntimeFiles(dataDir))
        process.on('SIGINT', () => process.exit(0))
        process.on('SIGTERM', () => process.exit(0))
      },
    })
  } catch (err) {
    // refuseStart has already written the same stderr text it always wrote.
    if (err instanceof InfraStartError) process.exit(1)
    throw err
  }
}
