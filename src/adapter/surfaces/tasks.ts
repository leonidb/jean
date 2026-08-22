/**
 * The tasks and board surface (design §5; task E2).
 *
 * Every handler is the same five steps — parse → context → call → execute →
 * serialize — and the only judgement in the file is about GRAMMAR: is this
 * body shaped like a request at all, and does the wire value name something
 * in the vocabulary. Everything past that is `tasks.decide*`, whose typed
 * refusals `renameTaskRefusal` turns into statuses.
 *
 * ── THE WIRE VALUE → VOCABULARY VALUE STEP IS THE PARSE, NOT POLICY ──
 *
 * `STATUSES` and `BLOCKERS` below are `Record<T, true>` tables rather than
 * hand-written sets: a status or blocker added to the vocabulary does not
 * compile until it is named here. That is the same guard resolution uses over
 * `KnownKind`, and it exists because the alternative failure is silent — an
 * unlisted status would be rejected at the door as a typo, and the person who
 * added it would go looking in the domain for a rule that is not there.
 *
 * ── WHAT THIS SURFACE IS OBLIGED TO APPEND, AND DOES NOT ──
 *
 * The A-SUB forward half (append the automatic subscriptions a task-created
 * or a reassigning task-updated implies) is NOT here. It lives in the
 * server's `record`, so it cannot be forgotten by the next writer of a task
 * event — including the WS `task-comment` path, which is not in this file.
 * See `record` in server.ts.
 */

import type { BlockedOn, TaskStatus } from './../../domain/contracts/tasks.ts'
import type { AgentRole, ReplyData, SendData, TaskCommentData } from './../../domain/contracts/vocabulary.ts'
import { taskStream } from './../../domain/contracts/vocabulary.ts'
import { playbooks } from './../../domain/playbooks/index.ts'
import { tasks } from './../../domain/tasks/index.ts'
import type { SurfaceContext } from './../context.ts'
import { renameTaskRefusal } from './../refusals.ts'

/** The vocabulary's statuses, as a table so the type checks the list. */
const STATUSES: Record<TaskStatus, true> = {
  todo: true,
  assigned: true,
  'in-progress': true,
  waiting: true,
  done: true,
  cancelled: true,
}
const BLOCKERS: Record<BlockedOn, true> = { sensei: true, human: true, external: true }

const isStatus = (v: unknown): v is TaskStatus => typeof v === 'string' && v in STATUSES
const isBlocker = (v: unknown): v is BlockedOn => typeof v === 'string' && v in BLOCKERS

/** The view flags `GET /tasks/:id` understands. Unknown ones are REFUSED, not
 *  dropped: a caller that asked for a view it did not get and was told
 *  nothing has been silently answered with less than it requested. */
const INCLUDES = new Set(['comments', 'messages', 'playbook'])

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

export function taskRoutes(ctx: SurfaceContext): (req: Request, url: URL) => Promise<Response | undefined> {
  /** The refusal → response rename, applied. */
  const refuse = (renamed: ReturnType<typeof renameTaskRefusal>) => ctx.json(renamed.body, renamed.status)

  /** The actor and the role the gates will see. PRECEDENCE IS THE DOMAIN'S
   *  (`resolveActorRole`) — the shell supplies the two inputs and nothing
   *  more: the role the caller CLAIMED, and the role the registry HAS. */
  function actorOf(req: Request, url: URL, body: Record<string, unknown>): { actor: string; role?: AgentRole } {
    // `actor` is the ONLY field in a task body that names its caller —
    // `agent` here is the assignee or the subscriber, which is a different
    // agent entirely on exactly the routes that matter.
    const caller = ctx.callerOf(req, url, str(body.actor))
    const actor = caller.name ?? 'api'
    const claimed = typeof body.actorRole === 'string' ? (body.actorRole as AgentRole) : undefined
    const role = tasks.resolveActorRole(claimed, ctx.roleOf(actor))
    return { actor, ...(role !== undefined && { role }) }
  }

  const taskOr404 = (id: string) => tasks.taskOf(ctx.tasksState(), id)

  async function create(req: Request, url: URL): Promise<Response> {
    const body = await ctx.body(req)
    if (body === null || str(body.title) === undefined || str(body.queue) === undefined) {
      return ctx.json({ error: 'body must be { title: string, queue: string, description?, playbook?, actor? }' }, 400)
    }
    const id = tasks.nextTaskId(ctx.tasksState())
    const caller = ctx.callerOf(req, url, str(body.actor))
    await ctx.record('task-created', taskStream(id), {
      title: body.title,
      description: str(body.description) ?? '',
      queue: body.queue,
      ...(str(body.playbook) !== undefined && { playbook: body.playbook }),
      actor: caller.name ?? 'api',
    })
    if (caller.name !== undefined) ctx.observeActivity(caller.name)
    return ctx.json(taskOr404(id), 201)
  }

  function list(url: URL): Response {
    // Filters are SELECTION, not judgement: an unknown status simply selects
    // nothing, which is the honest answer to "show me tasks that are X".
    const status = url.searchParams.get('status')
    const queue = url.searchParams.get('queue')
    const selected = tasks
      .all(ctx.tasksState())
      .filter(
        (t) =>
          (status === null || status === '' || t.status === status) &&
          (queue === null || queue === '' || t.queue === queue),
      )
    return ctx.json({ tasks: selected })
  }

  async function one(id: string, url: URL): Promise<Response> {
    const task = taskOr404(id)
    if (task === undefined) return refuse(renameTaskRefusal({ kind: 'unknown-task' }))
    const asked = (url.searchParams.get('include') ?? '').split(',').filter(Boolean)
    const unknown = asked.filter((k) => !INCLUDES.has(k))
    if (unknown.length > 0) {
      return ctx.json({ error: `unknown include: ${unknown.join(', ')}`, valid: [...INCLUDES] }, 400)
    }
    const include = new Set(asked)
    if (include.size === 0) return ctx.json(task)

    const events = include.has('comments') || include.has('messages') ? await ctx.read({ stream: taskStream(id) }) : []
    const enriched: Record<string, unknown> = { ...task }
    if (include.has('comments')) {
      enriched.comments = events.flatMap((e) =>
        e.type === 'task-comment'
          ? [{ ts: e.ts, from: (e.data as TaskCommentData).agent, text: (e.data as TaskCommentData).text }]
          : [],
      )
    }
    if (include.has('messages')) {
      enriched.messages = events.flatMap((e) => {
        if (e.type === 'reply')
          return [{ ts: e.ts, from: (e.data as ReplyData).agent, text: (e.data as ReplyData).text }]
        if (e.type === 'send') {
          const d = e.data as SendData
          return [{ ts: e.ts, from: d.from, to: d.agent, text: d.text }]
        }
        return []
      })
    }
    // THE INCLUDE SEAM, composed from the two owning modules: the tasks
    // module names the reference (`Task.playbook` — the playbook's ID, never
    // its frontmatter name) and the playbooks module supplies the body.
    // Neither imports the other; the shell holds them together (R10).
    //
    // E2 served `unavailable: ["playbook"]` here because no module owned
    // playbooks — flagged, ruled, and closed at D-PB. A task with no
    // reference simply gets no include: an empty `Task.playbook` means
    // absent, and `includeFor` answers undefined for it.
    if (include.has('playbook')) {
      const attached = playbooks.includeFor(ctx.playbooksState(), task.playbook)
      if (attached !== undefined) enriched.playbook = attached
    }
    return ctx.json(enriched)
  }

  async function setStatus(id: string, req: Request, url: URL): Promise<Response> {
    const body = await ctx.body(req)
    if (body === null || !isStatus(body.status)) {
      return ctx.json({ error: `body must be { status: ${Object.keys(STATUSES).join(' | ')} }` }, 400)
    }
    if (body.blockedOn !== undefined && !isBlocker(body.blockedOn)) {
      return ctx.json({ error: `blockedOn must be ${Object.keys(BLOCKERS).join(' | ')}` }, 400)
    }
    const { actor, role } = actorOf(req, url, body)
    const decision = tasks.decideStatus(ctx.tasksState(), {
      taskId: id,
      to: body.status,
      actor,
      ...(role !== undefined && { actorRole: role }),
      ...(isBlocker(body.blockedOn) && { blockedOn: body.blockedOn }),
      ...(str(body.blockedNote) !== undefined && { blockedNote: body.blockedNote as string }),
      ...(typeof body.resumeAt === 'string' && { resumeAt: body.resumeAt }),
    })
    if (!decision.ok) return refuse(renameTaskRefusal(decision.refusal))
    await ctx.record('task-status', taskStream(id), decision.data)
    ctx.observeActivity(actor)
    return ctx.json(taskOr404(id))
  }

  async function revert(id: string, req: Request, url: URL): Promise<Response> {
    const body = (await ctx.body(req)) ?? {}
    const { actor } = actorOf(req, url, body)
    const decision = tasks.decideRevert(ctx.tasksState(), id, actor)
    if (!decision.ok) return refuse(renameTaskRefusal(decision.refusal))
    await ctx.record('task-reverted', taskStream(id), decision.data)
    ctx.observeActivity(actor)
    return ctx.json({ ...taskOr404(id), reverted: { from: decision.from, to: decision.to } })
  }

  async function handoff(id: string, req: Request, url: URL): Promise<Response> {
    const body = await ctx.body(req)
    if (body === null || !isBlocker(body.blockedOn)) {
      return ctx.json(
        { error: `body must be { blockedOn: ${Object.keys(BLOCKERS).join(' | ')}, note?, resumeAt? }` },
        400,
      )
    }
    const { actor } = actorOf(req, url, body)
    const decision = tasks.decideHandoff(ctx.tasksState(), {
      taskId: id,
      blockedOn: body.blockedOn,
      actor,
      ...(str(body.note) !== undefined && { note: body.note as string }),
      ...(typeof body.resumeAt === 'string' && { resumeAt: body.resumeAt }),
    })
    if (!decision.ok) return refuse(renameTaskRefusal(decision.refusal))
    // The historical kind, restored as a first-class act by the contract —
    // the old system folded `task-blocked` and had no door that wrote one.
    await ctx.record('task-blocked', taskStream(id), decision.data)
    ctx.observeActivity(actor)
    return ctx.json(taskOr404(id))
  }

  async function update(id: string, req: Request, url: URL): Promise<Response> {
    const body = await ctx.body(req)
    if (body === null) return ctx.json({ error: 'body must be { agent?, description?, actor? }' }, 400)
    if (taskOr404(id) === undefined) return refuse(renameTaskRefusal({ kind: 'unknown-task' }))
    const { actor } = actorOf(req, url, body)
    // The reassignment path: `agent` here is what makes the server append the
    // new owner's automatic subscription (A-SUB), which is why an empty
    // string must not reach the log — `subscribe('')` is refused downstream,
    // but a blank owner on the board is a task that reads as assigned to
    // nobody-named rather than to nobody.
    await ctx.record('task-updated', taskStream(id), {
      ...(str(body.agent) !== undefined && { agent: body.agent }),
      ...(typeof body.description === 'string' && { description: body.description }),
      actor,
    })
    ctx.observeActivity(actor)
    return ctx.json(taskOr404(id))
  }

  async function subscribe(id: string, req: Request, url: URL, on: boolean): Promise<Response> {
    const body = await ctx.body(req)
    const agent = str(body?.agent)
    if (body === null || agent === undefined) return ctx.json({ error: 'body must be { agent: string }' }, 400)
    const { actor } = actorOf(req, url, body)
    const decision = on
      ? tasks.decideSubscribe?.(ctx.tasksState(), { taskId: id, agent, actor }, ctx.isRosterMember)
      : tasks.decideUnsubscribe?.(ctx.tasksState(), { taskId: id, agent, actor })
    if (decision === undefined) return ctx.json({ error: 'subscriptions unavailable' }, 501)
    if (!decision.ok) return refuse(renameTaskRefusal(decision.refusal))
    await ctx.record(on ? 'task-subscribed' : 'task-unsubscribed', taskStream(id), decision.data)
    ctx.observeActivity(actor)
    return ctx.json({ ok: true, subscribers: tasks.subscribersOf?.(ctx.tasksState(), id) ?? [] })
  }

  /**
   * The whole board, plus the staleness surfacing — and NO parameters.
   *
   * `/board` never read `searchParams`, so every filter put on it was inert:
   * `?status=in-progress` returned the complete board, with no error and no
   * warning. That is worse than having no filter at all, because the answer
   * LOOKS like the one asked for. Task 018 recorded a sensei reading six
   * closed tasks as open off the workaround this pushes people toward; the
   * writer of this commit walked into the same call the morning it was
   * written, and the 330KB truncated reply still read as an answer.
   *
   * So: any parameter is an unknown parameter here, and unknown is REFUSED —
   * the rule `GET /tasks/:id?include=` already follows two hundred lines up.
   * The refusal names the endpoint that does filter, because the dead end is
   * what sends people to `board.snapshot.json`, which is a projection
   * checkpoint lagging the live stream by up to 49 events and not a read
   * surface at all.
   */
  function board(url: URL): Response {
    const params = [...new Set(url.searchParams.keys())]
    if (params.length > 0) {
      return ctx.json(
        {
          error: `/board takes no query parameters (got: ${params.join(', ')})`,
          hint: 'GET /tasks?status=&queue= filters the same live projection',
        },
        400,
      )
    }
    const now = ctx.now()
    // STALENESS IS THE DOMAIN'S ARITHMETIC — the shell supplies the per-task
    // activity fact and the bound, and asks. Surfacing only: nothing here
    // moves a task, because statuses are the orchestrator's and single-writer.
    const stale = new Set(tasks.staleTasks(ctx.tasksState(), now, ctx.staleAfterMs, ctx.lastEventAt))
    const all = tasks.all(ctx.tasksState()).map((t) => {
      const last = ctx.lastEventAt(t.id)
      return {
        ...t,
        lastEventAt: new Date(last ?? Date.parse(t.updatedAt)).toISOString(),
        ...(stale.has(t.id) && { stale: true as const }),
      }
    })
    return ctx.json({ tasks: all })
  }

  const ID = /^\/tasks\/([^/]+)$/
  const SUB = /^\/tasks\/([^/]+)\/(status|revert|handoff|subscribe|unsubscribe)$/

  return async (req, url) => {
    const path = url.pathname
    if (path === '/tasks' && req.method === 'POST') return create(req, url)
    if (path === '/tasks' && req.method === 'GET') return list(url)
    if (path === '/board' && req.method === 'GET') return board(url)

    const sub = SUB.exec(path)
    if (sub?.[1] !== undefined) {
      const id = decodeURIComponent(sub[1])
      if (sub[2] === 'status' && req.method === 'PATCH') return setStatus(id, req, url)
      if (sub[2] === 'revert' && req.method === 'POST') return revert(id, req, url)
      if (sub[2] === 'handoff' && req.method === 'POST') return handoff(id, req, url)
      if (sub[2] === 'subscribe' && req.method === 'POST') return subscribe(id, req, url, true)
      if (sub[2] === 'unsubscribe' && req.method === 'POST') return subscribe(id, req, url, false)
      return undefined
    }

    const byId = ID.exec(path)
    if (byId?.[1] !== undefined) {
      const id = decodeURIComponent(byId[1])
      if (req.method === 'GET') return one(id, url)
      if (req.method === 'PATCH') return update(id, req, url)
    }
    return undefined
  }
}
