/**
 * The new adapter — server skeleton, WS lifecycle, mailbox + agents surfaces
 * (design §5; task E1). The old `src/infra/server.ts` keeps serving; nothing
 * here touches it.
 *
 * ── EVERY HANDLER IS THE SAME FIVE STEPS ──
 *
 * parse → resolve context → call domain → execute effects → serialize. The
 * handler makes no decision, and the file contains no conditional that is not
 * dispatching on route or method. A 400 here is a typed domain refusal
 * RENAMED, never the adapter's own judgement — which is why the refusal
 * unions exist at all.
 *
 * ── FACTS ARE COMPOSED FROM THEIR OWNING CONTRACT (R10) ──
 *
 * Nothing below derives a fact it could ask a module for. `roleOf` and
 * `isDojoAgent` come from agents; membership and classification come from
 * mailbox; recipients come from resolution. Composing them here rather than
 * re-deriving them is what keeps one question having one answer — the P2 seam
 * has nowhere to open if the shell never opens it.
 *
 * ── THREE REGISTER ROWS THIS TASK OWES, EACH WRITTEN DOWN WHERE IT LANDS ──
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
 * function deliberately does not.
 */

import { agents as agentsModule } from '../domain/agents/index.ts'
import type { AckPair, MailboxState, ViewFacts } from '../domain/contracts/mailbox.ts'
import type { AgentName, AgentRole, DeliveredVia } from '../domain/contracts/vocabulary.ts'
import { mailbox } from '../domain/mailbox/index.ts'
import { resolution } from '../domain/resolution/index.ts'
import { routing } from '../domain/routing/index.ts'
import { tasks } from '../domain/tasks/index.ts'
import { createStore, jsonlBackend, memoryBackend, type StoredEvent } from '../es/index.ts'

// ── Ports ────────────────────────────────────────────────────────

export type AdapterPorts = {
  now: () => number
  log: (line: string) => void
}

export type ServerOptions = {
  port?: number
  /** Absent = in-memory (tests). */
  dataDir?: string
  ports?: Partial<AdapterPorts>
}

export type AdapterHandle = {
  port: number
  stop: () => void
}

/** The roles a register frame may claim. Validated here because a live role
 *  outranks the persisted record, so an unchecked one becomes truth. */
const ROLES: ReadonlySet<string> = new Set<AgentRole>(['sensei', 'worker', 'user', 'peer', 'librarian'])

// ── Live sessions ────────────────────────────────────────────────

type Session = {
  name: AgentName
  role: AgentRole
  /** The registering process's own id, when it sent one — what makes a
   *  same-session reconnect a `replace` rather than a duplicate. */
  sessionId?: string
  /** The agent's OWN acts only — never the handshake (R8). */
  lastActivityAt?: number
  send: (payload: unknown) => boolean
}

// ── The server ───────────────────────────────────────────────────

export async function createAdapterServer(options: ServerOptions = {}): Promise<AdapterHandle> {
  const ports: AdapterPorts = { now: () => Date.now(), log: () => {}, ...options.ports }
  const store = createStore(options.dataDir ? jsonlBackend(`${options.dataDir}/events.jsonl`) : memoryBackend())

  // Folded state, one projection per module — rebuilt by replay, evolved by
  // append. Kept as plain values: every fold is a pure domain function.
  let agentState = agentsModule.initial()
  let taskState = tasks.initial()
  let mailState = mailbox.initial()
  const sessions = new Map<AgentName, Session>()

  const orchestratorOf = () => agentsModule.orchestratorOf(agentState)
  const isRosterMember = (name: AgentName) => agentsModule.isDojoAgent(agentState, name)

  /** The resolution context, composed — never re-derived (R10). */
  const resolutionContext = () => ({
    orchestrator: orchestratorOf(),
    subscribersOf: (taskId: string) => tasks.subscribersOf?.(taskState, taskId) ?? [],
  })

  /** The mailbox's view facts, composed the same way: role from agents,
   *  sender from resolution. Two contracts, no third opinion. */
  const viewFacts = (): ViewFacts => ({
    roleOf: (name) => agentsModule.roleOf(agentState, name, sessions.get(name)?.role),
    senderOf: (event) => resolution.authorOf(event),
  })

  /** Fold one appended event into every projection, in one place, so no
   *  caller can update one and forget another. */
  function absorb(event: StoredEvent): void {
    agentState = agentsModule.fold(agentState, event)
    taskState = tasks.fold(taskState, event, isRosterMember, orchestratorOf())
    mailState = mailbox.fold(mailState, event, (e) => resolution.resolve(e, resolutionContext()))
  }

  async function record(type: string, stream: string, data: unknown): Promise<StoredEvent> {
    const event = await store.append({ type, stream, data })
    absorb(event)
    return event
  }

  // THE BOOT REPLAY. Without this the projections start empty while the store
  // keeps counting ids from disk, so a restarted dojo would answer every
  // membership, routing and mailbox question from nothing while its log said
  // otherwise — the log IS the state, and a shell that does not read it has
  // silently invented a second one (codex pass, task 101).
  for (const event of await store.read()) absorb(event)

  /** An agent's own act. The ONLY writer of `lastActivityAt` — see R8, and
   *  guarded for R13: a clock port that ever returned NaN would write a fact
   *  that fails every comparison, and a notifier finding no bound satisfied
   *  announces on every tick. NaN reads LOUD, so it never becomes a fact. */
  function observeActivity(name: AgentName): void {
    const session = sessions.get(name)
    const at = ports.now()
    if (session !== undefined && Number.isFinite(at)) session.lastActivityAt = at
  }

  // ── Caller context ─────────────────────────────────────────────

  type Caller = { name?: AgentName; role?: AgentRole; connected: boolean }

  function callerOf(req: Request, url: URL, body?: Record<string, unknown>): Caller {
    const named =
      req.headers.get('x-jean-agent') ??
      url.searchParams.get('agent') ??
      url.searchParams.get('for') ??
      (typeof body?.agent === 'string' ? body.agent : undefined)
    if (named === null || named === undefined) return { connected: false }
    const session = sessions.get(named)
    return {
      name: named,
      role: agentsModule.roleOf(agentState, named, session?.role),
      connected: session !== undefined,
    }
  }

  // ── Serializers — rename only ──────────────────────────────────

  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

  // ── The surfaces ───────────────────────────────────────────────

  async function handleSend(req: Request, url: URL): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    // PARSE: grammar, not policy. A missing field is malformed input, which is
    // the adapter's own 400 — the only kind it is allowed to author.
    if (body === null || typeof body.to !== 'string' || typeof body.text !== 'string') {
      return json({ error: 'body must be { to: string, text: string }' }, 400)
    }
    const caller = callerOf(req, url, body)
    const to = body.to

    // CONTEXT: both facts from the agents contract, live role kept SEPARATE
    // from the persisted one — the provenance the routing contract needs.
    const decision = routing.decideSend(
      {
        from: caller.name ?? 'api',
        to,
        text: body.text,
        ...(typeof body.taskId === 'string' && { taskId: body.taskId }),
      },
      { liveRole: sessions.get(to)?.role, isDojoAgentEver: agentsModule.isDojoAgent(agentState, to) },
    )
    if (caller.name !== undefined) observeActivity(caller.name)

    if (decision.route === 'queue') {
      await record('send', decision.stream, decision.data)
      return json({ ok: true, queued: true })
    }
    // EXECUTE: the transport attempt happens before the record, because
    // `delivered` is not knowable until it has.
    const delivered = sessions.get(to)?.send({ type: 'deliver', from: caller.name ?? 'api', text: body.text }) ?? false
    await record('send', decision.stream, decision.data(delivered))
    const notice = decision.undeliveredNotice(delivered)
    return json({ ok: true, delivered, ...(notice !== undefined && { undelivered: notice }) })
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
    return json({
      events: selection.events.map((f) => ({ ...f.event, code: f.code })),
      ...('missing' in selection && selection.missing !== undefined && { missing: selection.missing }),
    })
  }

  async function handleAck(req: Request, url: URL): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const caller = callerOf(req, url, body ?? undefined)
    if (caller.name === undefined) return json({ error: 'name the caller: ?agent= or x-jean-agent' }, 400)
    if (body === null || !Array.isArray(body.pairs)) return json({ error: 'body must be { pairs: [{id, code}] }' }, 400)
    const pairs = body.pairs.filter((p): p is AckPair => typeof p?.id === 'number' && typeof p?.code === 'string')
    // The evidence port: what this shell handed over, and how. Absent is
    // "unknown", never "not delivered".
    const decision = mailbox.applyAck(mailState, caller.name, pairs, () => undefined as DeliveredVia | undefined)
    // THE APPEND IS WHAT CLEARS, not the decision. Assigning `decision.next`
    // here and then appending would leave live state with mail cleared and no
    // log event behind it if the append ever failed — state ahead of its own
    // log, which is the one thing an event-sourced shell must never be. The
    // fold applies the same clearing from the record, so there is one path
    // instead of two that have to agree (codex pass, task 101).
    await record('ack', 'system', decision.record)
    observeActivity(caller.name)
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
        role: agentsModule.roleOf(agentState, s.name, s.role),
        connected: true,
        ...(s.lastActivityAt !== undefined && { lastActivityAt: s.lastActivityAt }),
        pending: mailbox.countsFor(mailState, s.name, viewFacts()).total,
      })),
    })
  }

  // ── Bun.serve ──────────────────────────────────────────────────

  const server = Bun.serve<{ name?: AgentName }>({
    port: options.port ?? 0,
    async fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === '/ws' && srv.upgrade(req, { data: {} })) return undefined as unknown as Response

      // The routing table — the only conditionals in this file dispatch here.
      if (url.pathname === '/send' && req.method === 'POST') return handleSend(req, url)
      if (url.pathname === '/events' && req.method === 'GET') return handleFetch(req, url)
      if (url.pathname === '/ack' && req.method === 'POST') return handleAck(req, url)
      if (url.pathname === '/agents' && req.method === 'GET') return handleAgents()
      return json({ error: 'not found' }, 404)
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as {
          type?: string
          agent?: string
          role?: string
          sessionId?: string
        }
        // PARSE, and the frame's grammar is as strict as the body's. An
        // unvalidated role was cast straight into `sessions` and became LIVE
        // TRUTH — `roleOf` returns the live role over the record, so a typo
        // in a frame outranked the dojo's own register history while the
        // agents fold quietly ignored it. Live and persisted disagreeing is
        // the exact provenance confusion D6's contract fix removed
        // (codex pass, task 101).
        const role = msg.role ?? 'worker'
        if (msg.type !== 'register' || typeof msg.agent !== 'string' || msg.agent.length === 0) return
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
        ws.data.name = msg.agent
        sessions.set(msg.agent, {
          name: msg.agent,
          role: role as AgentRole,
          ...(typeof msg.sessionId === 'string' && { sessionId: msg.sessionId }),
          // R8: NO `lastActivityAt` here. Registering is not an act.
          send: (payload) => {
            if (ws.readyState !== 1) return false
            ws.send(JSON.stringify(payload))
            return true
          },
        })
        // The SAME validated role goes to the log as went into the session —
        // live and persisted must not be able to disagree about what this
        // frame claimed.
        void record('register', `agent-${msg.agent}`, {
          agent: msg.agent,
          role: role as AgentRole,
          idle: true,
        }).then(() => ws.send(JSON.stringify({ type: 'registered', agent: msg.agent })))
      },
      close(ws) {
        const name = ws.data.name
        if (name === undefined) return
        sessions.delete(name)
        void record('disconnect', `agent-${name}`, { agent: name })
      },
    },
  })

  ports.log(`[jean:new] listening on ${server.port}\n`)
  return { port: server.port ?? 0, stop: () => server.stop(true) }
}

/** Replay a log into the module folds — the boot path, exported so a test can
 *  drive it without a socket. */
export function replayInto(events: readonly StoredEvent[]): {
  agents: ReturnType<typeof agentsModule.initial>
  tasks: ReturnType<typeof tasks.initial>
  mail: MailboxState
} {
  let agentState = agentsModule.initial()
  let taskState = tasks.initial()
  let mailState = mailbox.initial()
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
  }
  return { agents: agentState, tasks: taskState, mail: mailState }
}
