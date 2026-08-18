/**
 * The composed dojo — every domain module wired together in-process, the way
 * the E1 adapter will wire them behind a socket (task 102; ruled:
 * end-to-end tests must be written against the core).
 *
 * This file is the SHELL the scenarios run: it owns the log, composes every
 * injected fact from the module that owns it (R10 — seat from
 * `agents.orchestratorOf`, roles from `agents.roleOf`, roster from
 * `agents.isDojoAgent`, involvement from `tasks.subscribersOf`, membership
 * from `mailbox.mailboxOf`; no local heuristics anywhere), performs notifier
 * and supervisor effects, and plays each cast member's session per its
 * declared reliability and conduct. Scenarios stay declarative: a cast, some
 * writes, ticks, assertions.
 *
 * ── THE COMPOSITION LAWS (E1 inherits these — tracker R14) ──
 *
 * 1. FOLD ORDER within one event: agents → tasks → mailbox → notifier.
 *    Resolution's context reads the POST-fold states of the same event: a
 *    `task-created` addresses the subscribers its own derivation creates, so
 *    folding tasks first is what makes the task row deliver at all. An
 *    adapter that resolves before folding under-delivers every creation.
 * 2. AUTO-SUBSCRIPTIONS are appended AFTER their trigger event
 *    (`tasks.autoSubscriptionsFor`), each ingested through the same path —
 *    set semantics make them idempotent with the fold's own derivation.
 * 3. STATE ADVANCES ONLY THROUGH THE LOG. An ack DECIDES via `applyAck`, but
 *    the decision's `next` is discarded: the shell appends the RECORD and
 *    the fold applies it — one source of truth, and the replay path (the
 *    semantics a restart depends on) is exercised on every single ack.
 * 4. ACTIVITY is the agent's own act: speech and task transitions via
 *    `resolution.authorOf`, clearings via the ack record's `caller` — and
 *    NOT the register handshake (RULED at task 103, resolving this law's
 *    contradiction with the agents contract and R8: the harness first read
 *    session arrival as activity, which suppressed the announcement at
 *    exactly the reconnect moment the ladder exists for and granted a
 *    returning-but-still-stuck agent an unearned quiet-clock). A returning
 *    agent's waiting mail announces at the FIRST tick after reconnect, and
 *    recovery is EARNED by its first real act, never by the handshake.
 *    Machine writes carry no actor.
 *
 * The seeded rng, injected clock and monotonic log make every run replayable
 * from its seed (spec §5).
 */

import { agents } from '../agents/index.ts'
import type { RecipientsOf, ViewFacts } from '../contracts/mailbox.ts'
import type { NotifierConfig } from '../contracts/notifier.ts'
import type { SupervisorConfig, SupervisorEffect } from '../contracts/supervisor.ts'
import type { AckData } from '../contracts/vocabulary.ts'
import {
  type AgentName,
  type AgentRole,
  agentStream,
  type KindDataMap,
  type KnownKind,
  type StoredEvent,
  taskStream,
} from '../contracts/vocabulary.ts'
import {
  type CastSpec,
  createCast,
  createClock,
  createLog,
  createRng,
  type PendingPair,
  type ReplayResult,
  replayCheck,
} from '../fixture/index.ts'
import { mailbox } from '../mailbox/index.ts'
import { notifier } from '../notifier/index.ts'
import { resolution } from '../resolution/index.ts'
import { supervisor } from '../supervisor/index.ts'
import { tasks } from '../tasks/index.ts'

/** The speech kinds — the mailbox composition's `senderOf` restriction
 *  (contract: a lifecycle change by a human is an act, not speech). */
const SPEECH = new Set(['reply', 'send', 'task-comment', 'memory'])

export type DojoOptions = {
  seed?: number
  startMs?: number
  gridMs?: number
  notifier: NotifierConfig
  supervisor: SupervisorConfig
}

export type Announcement = {
  at: number
  to: AgentName
  ids: readonly number[]
  accepted: boolean
  hasBlocking: boolean
  pendingCount: number
}
export type PerformedEffect = { at: number; effect: SupervisorEffect }

export function createDojo(specs: readonly CastSpec[], opts: DojoOptions) {
  const clock = createClock(opts.startMs)
  const log = createLog(clock)
  const rng = createRng(opts.seed ?? 42)
  const cast = createCast(specs)
  const byName = new Map(cast.map((a) => [a.name, a]))
  const gridMs = opts.gridMs ?? 60_000

  let agentsState = agents.initial()
  let tasksState = tasks.initial()
  let mailboxState = mailbox.initial()
  let notifierState = notifier.initial()
  let supervisorState = supervisor.initial()

  const connected = new Map<AgentName, boolean>()
  const connectedAt = new Map<AgentName, number>()
  const lastActivity = new Map<AgentName, number>()

  const announcements: Announcement[] = []
  const supervision: PerformedEffect[] = []

  const isRoster = (n: AgentName) => agents.isDojoAgent(agentsState, n)
  const seat = () => agents.orchestratorOf(agentsState)
  const viewFacts = (): ViewFacts => ({
    roleOf: (n) => agents.roleOf(agentsState, n),
    senderOf: (e) => (SPEECH.has(e.type) ? resolution.authorOf(e) : undefined),
  })
  const recipientsOf: RecipientsOf = (e) =>
    resolution.resolve(e, {
      orchestrator: seat(),
      subscribersOf: (id) => tasks.subscribersOf?.(tasksState, id) ?? [],
    })

  /** Whose own act this event is — composition law 4. `register` is
   *  deliberately NOT an act (ruled, task 103): the handshake is the
   *  transport arriving, and treating it as activity silenced the
   *  reconnect announcement. */
  function actorOf(event: StoredEvent): AgentName | undefined {
    if (event.type === 'ack') {
      const caller = (event.data as AckData | undefined)?.caller
      return typeof caller === 'string' ? caller : undefined
    }
    return resolution.authorOf(event)
  }

  function ingest(event: StoredEvent): void {
    agentsState = agents.fold(agentsState, event)
    tasksState = tasks.fold(tasksState, event, isRoster, seat())
    mailboxState = mailbox.fold(mailboxState, event, recipientsOf)
    const actor = actorOf(event)
    if (actor !== undefined) lastActivity.set(actor, clock.now())
    notifierState = notifier.observeEvent(notifierState, event, actor)
    for (const sub of tasks.autoSubscriptionsFor?.(event, isRoster, seat()) ?? []) {
      ingest(log.append('task-subscribed', taskStream(sub.taskId), sub.data))
    }
  }

  function append<K extends KnownKind>(kind: K, stream: string, data: KindDataMap[K]): StoredEvent {
    const event = log.append(kind, stream, data)
    ingest(event)
    return event
  }

  /** One session processing pass: fetch, act per reliability, speak per
   *  conduct, then ack what was acted on — through the decision, with the
   *  record appended and folded (composition law 3). */
  function wake(name: AgentName): void {
    const agent = byName.get(name)
    if (!agent) return
    const fetched = mailbox.fetchFor(mailboxState, name)
    if (fetched.length === 0) return
    const acted = agent.actsOn(
      fetched.map((f) => f.event),
      rng,
    )
    if (acted.length === 0) return
    const actedIds = new Set(acted.map((e) => e.id))
    for (const e of acted) {
      for (const u of agent.speak(e, rng)) append(u.type, u.stream, u.data)
    }
    const pairs = fetched.filter((f) => actedIds.has(f.event.id)).map((f) => ({ id: f.event.id, code: f.code }))
    const decision = mailbox.applyAck(mailboxState, name, pairs, () => 'wake')
    append('ack', 'system', decision.record)
  }

  /** One grid step: advance the clock, run the notifier over composed facts,
   *  perform its effects through the cast, then the supervisor, appending
   *  its effects as the events the census declares for them. */
  function tick(): void {
    clock.advance(gridMs)
    const now = clock.now()

    const notifierView = {
      now,
      agents: cast.map((a) => ({
        name: a.name,
        pendingIds: mailbox.mailboxOf(mailboxState, a.name).map((e) => e.id),
        hasBlocking: mailbox.countsFor(mailboxState, a.name, viewFacts()).blocking > 0,
        lastActivityAt: lastActivity.get(a.name),
      })),
    }
    const decided = notifier.decide(notifierState, notifierView, opts.notifier)
    notifierState = decided.next
    for (const effect of decided.effects) {
      const agent = byName.get(effect.to)
      const live = connected.get(effect.to) ?? false
      // The wake either reaches the session or it does not (spec §5's
      // failing role "drops wakes at a configured rate"): silent and
      // disconnected sessions refuse; unresponsive HEARS and then ignores —
      // the distinction the loud-direction bounds need, because a refused
      // wake retries at the next eligible tick while a discharged one
      // follows the ladder.
      const accepted =
        live &&
        agent !== undefined &&
        (agent.behaviour.kind === 'reliable' ||
          agent.behaviour.kind === 'unresponsive' ||
          (agent.behaviour.kind === 'failing' && !rng.chance(agent.behaviour.rate)))
      announcements.push({
        at: now,
        to: effect.to,
        ids: effect.ids,
        accepted,
        hasBlocking: effect.hasBlocking,
        pendingCount: effect.pendingCount,
      })
      notifierState = notifier.applyOutcome(notifierState, {
        kind: 'announced',
        agent: effect.to,
        ids: effect.ids,
        accepted,
      })
      if (accepted) wake(effect.to)
    }

    const supervisorView = {
      now,
      orchestrator: seat(),
      tasks: tasks.all(tasksState).map((t) => ({
        id: t.id,
        status: t.status,
        blockedOn: t.blockedOn,
        // The composer's honest floor (R10; R13: never NaN — every timestamp
        // in this harness comes from the injected clock).
        blockedSinceMs: Date.parse(t.blockedSince ?? t.updatedAt),
        resumeAtMs: t.resumeAt !== undefined ? Date.parse(t.resumeAt) : undefined,
      })),
      // THE ACTIVITY FLOORS (ruled at task 107 — the supervisor contract's
      // composition): an agent with no act ever gets the honest floor — a
      // live session measures from CONNECTION, a disconnected agent enters
      // the view only if it holds work (measuring from the task's claim),
      // and neither-connected-nor-holding is not supervised at all. The
      // NOTIFIER view above keeps the honest blank deliberately.
      agents: cast.flatMap((a) => {
        const live = connected.get(a.name) ?? false
        // The NEWEST held task's claim (the contract's words — codex pass:
        // `activeTaskOf` answers a different consumer and returns the FIRST
        // match), with R13's guard: an unparseable claim yields no floor,
        // and no honest floor means not in the view — never NaN.
        const heldClaims = tasks
          .all(tasksState)
          .filter(
            (t) => (t.status === 'in-progress' || t.status === 'waiting') && (t.agent === a.name || t.queue === a.name),
          )
          .map((t) => Date.parse(t.updatedAt))
          .filter((ms) => Number.isFinite(ms))
        const holdsWork = tasks.activeTaskOf(tasksState, a.name) !== undefined
        const floor = live ? connectedAt.get(a.name) : heldClaims.length > 0 ? Math.max(...heldClaims) : undefined
        if (!live && floor === undefined) return []
        return [
          {
            name: a.name,
            role: agents.roleOf(agentsState, a.name) ?? a.role,
            connected: live,
            lastActivityAt: lastActivity.get(a.name) ?? floor,
            holdsWork,
            hasPendingMail: mailbox.mailboxOf(mailboxState, a.name).length > 0,
          },
        ]
      }),
    }
    const supervised = supervisor.decide(supervisorState, supervisorView, opts.supervisor)
    supervisorState = supervised.next
    for (const effect of supervised.effects) {
      supervision.push({ at: now, effect })
      if (effect.kind === 'remind') {
        append('task-reminder', 'system', {
          taskId: effect.taskId,
          to: effect.to,
          text: `task ${effect.taskId} parked on ${effect.blockedOn}`,
          queued: true,
        })
      } else if (effect.kind === 'probe') {
        append('agent-probe', agentStream(effect.agent), {
          agent: effect.agent,
          quietMinutes: Math.round(effect.quietMs / 60_000),
          text: 'alive?',
          queued: true,
        })
      } else {
        append('worker-status', 'system', {
          agent: effect.subject,
          status: effect.status,
          text: `${effect.subject} ${effect.status}`,
          queued: true,
        })
      }
    }
  }

  return {
    clock,
    log,
    rng,
    cast,

    // ── Sessions ──
    register(name: AgentName, role: AgentRole): void {
      append('register', agentStream(name), { agent: name, role, idle: false })
      connected.set(name, true)
      connectedAt.set(name, clock.now())
    },
    disconnect(name: AgentName): void {
      append('disconnect', agentStream(name), { agent: name })
      connected.set(name, false)
    },
    /** Register every cast member under its spec role — the usual opening. */
    registerAll(): void {
      for (const a of cast) {
        append('register', agentStream(a.name), { agent: a.name, role: a.role, idle: false })
        connected.set(a.name, true)
        connectedAt.set(a.name, clock.now())
      }
    },

    // ── Writes (the shell's write sites) ──
    send(from: AgentName, to: AgentName, text: string): StoredEvent {
      return append('send', agentStream(to), { agent: to, from, text, queued: true })
    },
    reply(from: AgentName, text: string): StoredEvent {
      return append('reply', agentStream(from), { agent: from, text })
    },
    createTask(id: string, title: string, queue: string, actor: string): StoredEvent {
      return append('task-created', taskStream(id), { title, description: '', queue, actor })
    },
    taskStatus(id: string, data: KindDataMap['task-status']): StoredEvent {
      return append('task-status', taskStream(id), data)
    },
    comment(id: string, agent: AgentName, role: AgentRole, text: string): StoredEvent {
      return append('task-comment', taskStream(id), { agent, role, text })
    },
    reassign(id: string, to: AgentName, actor: string): StoredEvent {
      return append('task-updated', taskStream(id), { agent: to, actor })
    },
    subscribe(taskId: string, agent: AgentName, actor: string): { ok: boolean } {
      const decided = tasks.decideSubscribe?.(tasksState, { taskId, agent, actor }, isRoster)
      if (decided === undefined || !decided.ok) return { ok: false }
      append('task-subscribed', taskStream(taskId), decided.data)
      return { ok: true }
    },
    unsubscribe(taskId: string, agent: AgentName, actor: string): { ok: boolean } {
      const decided = tasks.decideUnsubscribe?.(tasksState, { taskId, agent, actor })
      if (decided === undefined || !decided.ok) return { ok: false }
      append('task-unsubscribed', taskStream(taskId), decided.data)
      return { ok: true }
    },

    // ── The loop ──
    tick,
    runFor(ms: number): void {
      for (let elapsed = 0; elapsed < ms; elapsed += gridMs) tick()
    },
    /** A deliberate agent act outside the announce loop — the session read
     *  its inbox by itself (fetch-path carriage is E-territory; this is the
     *  plain "the agent woke up on its own" case). */
    act(name: AgentName): void {
      wake(name)
    },

    // ── Reads (every one derived from the owning module) ──
    mailboxIds(name: AgentName): number[] {
      return mailbox.mailboxOf(mailboxState, name).map((e) => e.id)
    },
    mailboxEvents(name: AgentName): readonly StoredEvent[] {
      return mailbox.mailboxOf(mailboxState, name)
    },
    counts(name: AgentName) {
      return mailbox.countsFor(mailboxState, name, viewFacts())
    },
    pendingPairs(): readonly PendingPair[] {
      return mailbox.pendingPairs(mailboxState).map((p) => ({ recipient: p.recipient, eventId: p.eventId }))
    },
    task(id: string) {
      return tasks.taskOf(tasksState, id)
    },
    subscribersOf(id: string): readonly AgentName[] {
      return tasks.subscribersOf?.(tasksState, id) ?? []
    },
    seat,
    announcements: (): readonly Announcement[] => announcements,
    supervision: (): readonly PerformedEffect[] => supervision,
    reports() {
      return supervision.filter((s) => s.effect.kind === 'report')
    },
    probes() {
      return supervision.filter((s) => s.effect.kind === 'probe')
    },
    reminders() {
      return supervision.filter((s) => s.effect.kind === 'remind')
    },

    /**
     * The hindsight walk (spec §5's replay checker) over everything this
     * dojo recorded, with the context EVOLVING exactly as composition law 1
     * evolves it: shadow folds advance per event before resolution reads.
     * The pending bookkeeping is replayCheck's own — independent of the
     * mailbox state the run maintained — and the result's pending must
     * equal the mailbox's, which the caller asserts.
     */
    groundTruth(): ReplayResult {
      let shadowAgents = agents.initial()
      let shadowTasks = tasks.initial()
      const shadowRoster = (n: AgentName) => agents.isDojoAgent(shadowAgents, n)
      const ctx = {
        orchestrator: undefined as AgentName | undefined,
        subscribersOf: (id: string) => tasks.subscribersOf?.(shadowTasks, id) ?? [],
      }
      return replayCheck(log.events(), {
        resolution,
        ctx,
        observe: (event) => {
          shadowAgents = agents.fold(shadowAgents, event)
          ctx.orchestrator = agents.orchestratorOf(shadowAgents)
          shadowTasks = tasks.fold(shadowTasks, event, shadowRoster, ctx.orchestrator)
        },
        clearedPairsOf: (event) => {
          if (event.type !== 'ack') return []
          const data = event.data as AckData | undefined
          if (typeof data?.caller !== 'string' || !Array.isArray(data.cleared)) return []
          return data.cleared.map((c) => ({ recipient: data.caller as AgentName, eventId: c.eventId }))
        },
      })
    },
  }
}

export type Dojo = ReturnType<typeof createDojo>

/**
 * The R12 measurement path: replay a REAL log through the composed folds —
 * agents, tasks, mailbox — with the context evolving per composition law 1.
 * Returns the wall-clock cost and the resulting sizes; correctness of the
 * result is G1's shakedown question, cost is this one's (tracker R12).
 */
export function replayComposed(events: readonly StoredEvent[]) {
  let agentsState = agents.initial()
  let tasksState = tasks.initial()
  let mailboxState = mailbox.initial()
  const isRoster = (n: AgentName) => agents.isDojoAgent(agentsState, n)
  const recipientsOf: RecipientsOf = (e) =>
    resolution.resolve(e, {
      orchestrator: agents.orchestratorOf(agentsState),
      subscribersOf: (id) => tasks.subscribersOf?.(tasksState, id) ?? [],
    })
  const startedAt = performance.now()
  for (const event of events) {
    agentsState = agents.fold(agentsState, event)
    tasksState = tasks.fold(tasksState, event, isRoster, agents.orchestratorOf(agentsState))
    mailboxState = mailbox.fold(mailboxState, event, recipientsOf)
  }
  const durationMs = performance.now() - startedAt
  return {
    durationMs,
    events: events.length,
    tasks: tasks.all(tasksState).length,
    pendingPairs: mailbox.pendingPairs(mailboxState).length,
  }
}
