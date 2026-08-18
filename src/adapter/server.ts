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

import { agents as agentsModule } from '../domain/agents/index.ts'
import type { AckPair, MailboxState, ViewFacts } from '../domain/contracts/mailbox.ts'
import type { AgentName, AgentRole, DeliveredVia } from '../domain/contracts/vocabulary.ts'
import { agentStream, taskIdFromStream, taskStream } from '../domain/contracts/vocabulary.ts'
import { mailbox } from '../domain/mailbox/index.ts'
import { resolution } from '../domain/resolution/index.ts'
import { routing } from '../domain/routing/index.ts'
import { tasks } from '../domain/tasks/index.ts'
import { triggers } from '../domain/triggers/index.ts'
import { createStore, jsonlBackend, memoryBackend, type StoredEvent } from '../es/index.ts'
import type { Caller, SurfaceContext } from './context.ts'
import { knowledgeRoutes } from './surfaces/knowledge.ts'
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
  ports?: Partial<AdapterPorts>
}

export type AdapterHandle = {
  port: number
  stop: () => void
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
  /** Epoch ms of the last real event on each task's stream — shell
   *  bookkeeping, and the contract asks for it as the caller's fact. */
  const taskActivity = new Map<string, number>()
  const sessions = new Map<AgentName, Session>()

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
  async function record(type: string, stream: string, data: unknown): Promise<StoredEvent> {
    const event = await store.append({ type, stream, data })
    absorb(event)
    for (const sub of tasks.autoSubscriptionsFor?.(event, isRosterMember, orchestratorOf()) ?? []) {
      await record('task-subscribed', taskStream(sub.taskId), sub.data)
    }
    return event
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
        role: roleOf(s.name),
        connected: true,
        ...(s.lastActivityAt !== undefined && { lastActivityAt: s.lastActivityAt }),
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
  const surfaces = [taskRoutes(surfaceContext), triggerRoutes(surfaceContext), knowledgeRoutes(surfaceContext)]

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
      for (const surface of surfaces) {
        const answer = await surface(req, url)
        if (answer !== undefined) return answer
      }
      return json({ error: 'not found' }, 404)
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
        const session = sessions.get(from)
        if (session === undefined) return
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
        sessions.delete(name)
        void record('disconnect', agentStream(name), { agent: name })
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
  triggers: ReturnType<typeof triggers.initial>
} {
  let agentState = agentsModule.initial()
  let taskState = tasks.initial()
  let mailState = mailbox.initial()
  let triggerState = triggers.initial()
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
  }
  return { agents: agentState, tasks: taskState, mail: mailState, triggers: triggerState }
}
