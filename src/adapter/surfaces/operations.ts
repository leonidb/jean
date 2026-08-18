/**
 * The log-reading surfaces — history and permissions (task E4).
 *
 * Both are reads of the event log with no module behind them, which is why
 * they sit together and why neither decides anything: `/history` is "the
 * stream, serialized", and `/permissions` is "the permission-request events,
 * counted per agent per tool". The one judgement either makes is which shape
 * to hand back, and both shapes are fixed by their live callers — `jean task
 * log` and `jean permissions`, whose parsing is what these were written
 * against.
 *
 * ── THE API EVENT SHAPE ──
 *
 * `{id, type, ts, taskId?, agent?, data}` — the old `toApiEvent`, matched
 * field for field because the CLI reads `agent` for its display column and
 * `data` for everything else. See `apiEvent` for the one part of it worth an
 * argument.
 */

import type { PermissionRequestData } from './../../domain/contracts/vocabulary.ts'
import { agentFromStream, taskIdFromStream, taskStream } from './../../domain/contracts/vocabulary.ts'
import type { StoredEvent } from './../../es/index.ts'
import type { SurfaceContext } from './../context.ts'

/**
 * One event as the CLI reads it.
 *
 * `agent` IS THE POLYMORPHIC READ, and it is here deliberately and only
 * here: `data.agent` means addressee on a `send`, speaker on a `reply`,
 * subject on a `register`, target on a `trigger-fired` — which is exactly
 * why resolution refuses to read it and answers per kind instead. This is a
 * DISPLAY column in `jean task log`, not an addressing decision, and the old
 * surface derived it this way; matching it is what "the caller cannot tell"
 * means.
 *
 * RULED (task 110): BLESSED as display-only parity — no module home. A
 * per-kind module answer would be shape without a consumer: the only
 * reader is a human eye on an operator column, and a wrong guess costs a
 * mislabelled row, never a misrouted message. The blessing's conditions:
 * the read stays confined to THIS function; the label stays; and nothing
 * anywhere may consume `apiEvent().agent` as a FACT — anything needing
 * "who is this event about" uses `resolution.authorOf`, which answers per
 * kind or honestly declines.
 */
export function apiEvent(event: StoredEvent): Record<string, unknown> {
  const taskId = taskIdFromStream(event.stream)
  const named = (event.data as { agent?: unknown } | null)?.agent
  const agent = typeof named === 'string' ? named : agentFromStream(event.stream)
  return {
    id: event.id,
    type: event.type,
    ts: event.ts,
    ...(taskId !== undefined && { taskId }),
    ...(agent !== undefined && { agent }),
    data: event.data,
  }
}

export function operationRoutes(ctx: SurfaceContext): (req: Request, url: URL) => Promise<Response | undefined> {
  /**
   * The stream, serialized. `?taskId=` names a task's stream, `?stream=`
   * names one directly, `?last=N` takes the tail, `?raw=true` returns the
   * envelope untouched.
   *
   * PERMISSION REQUESTS ARE HIDDEN unless asked for. There are thousands of
   * them on a busy dojo and they are diagnostics; a task log that drowned in
   * them would not be read. `jean task log` passes `diagnostics=true`, which
   * is the whole reason the flag exists.
   */
  async function history(url: URL): Promise<Response> {
    const taskId = url.searchParams.get('taskId')
    const explicit = url.searchParams.get('stream')
    const stream = explicit ?? (taskId !== null && taskId.length > 0 ? taskStream(taskId) : undefined)
    const lastParam = url.searchParams.get('last')
    const last = lastParam === null ? undefined : Number(lastParam)
    if (last !== undefined && (!Number.isFinite(last) || last < 0)) {
      return ctx.json({ error: 'last must be a non-negative number' }, 400)
    }

    let events = await ctx.read(stream === undefined ? {} : { stream })
    if (url.searchParams.get('diagnostics') !== 'true') {
      events = events.filter((e) => e.type !== 'permission-request')
    }
    if (last !== undefined && last > 0) events = events.slice(-last)
    const raw = url.searchParams.get('raw') === 'true'
    return ctx.json({ events: raw ? events : events.map(apiEvent) })
  }

  /**
   * Permission requests, counted per agent per tool, with a few samples.
   *
   * A HISTORICAL READER, and only that (ruled, task 109). The POST that fed
   * this lived in a generated settings hook, and the hooks are retired with
   * the old server — so nothing new is written here. `jean permissions`
   * keeps working over the requests already in the log, which is the whole
   * of what the surface is for now.
   *
   * Aggregation, not a decision: the events say what was asked for, and this
   * counts them. The sample cap is presentation — five is enough to see the
   * shape of what a tool is being asked to do, and a full dump of every
   * input on a month-old dojo is a response nobody reads.
   */
  async function permissions(url: URL): Promise<Response> {
    const filter = url.searchParams.get('agent')
    const events = await ctx.read({ types: ['permission-request'] })
    const byAgent: Record<string, Record<string, { count: number; samples: unknown[] }>> = {}
    for (const event of events) {
      const data = event.data as PermissionRequestData | null
      if (typeof data?.agent !== 'string' || typeof data.tool !== 'string') continue
      if (filter !== null && filter.length > 0 && data.agent !== filter) continue
      let tools = byAgent[data.agent]
      if (tools === undefined) {
        tools = {}
        byAgent[data.agent] = tools
      }
      let entry = tools[data.tool]
      if (entry === undefined) {
        entry = { count: 0, samples: [] }
        tools[data.tool] = entry
      }
      entry.count++
      if (entry.samples.length < 5) entry.samples.push(data.input ?? {})
    }
    return ctx.json({ permissions: byAgent })
  }

  return async (req, url) => {
    if (url.pathname === '/history' && req.method === 'GET') return history(url)
    if (url.pathname === '/permissions' && req.method === 'GET') return permissions(url)
    return undefined
  }
}
