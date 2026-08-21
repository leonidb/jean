/**
 * The knowledge surface — search and memorize (design §5; task E2).
 *
 * The corpus is assembled here because assembling it is reading: files off
 * disk, memories off the log, comments off task streams, the human
 * conversation off the user agents' streams. What each of those READINGS
 * becomes — a search document — is the domain's transform, called and never
 * reimplemented. The line is the knowledge contract's own, quoted in
 * `corpus.ts`.
 *
 * ── THE EMPTY PROMISE IS WHY 503 EXISTS ──
 *
 * `empty: true` means "definitively not in the dojo's memory in this scope",
 * and an all-scope empty is the signal that stops an agent from falling back
 * to grepping the raw log. A source that failed to READ must therefore never
 * be reported as a source that held nothing: the walk throws, and this
 * surface answers 503 rather than handing back a smaller corpus's honest
 * "nothing found". A masked read failure is the one way this endpoint can
 * lie.
 *
 * ── SCOPE POLARITY ──
 *
 * `?scope=` (empty string) is REFUSED, `scope` absent defaults to `all`. That
 * is the domain's ruling and this file does not re-implement it: it passes
 * `url.searchParams.get('scope')` straight through, which is `null` for
 * absent and `''` for present-and-blank — the two cases the polarity ruling
 * separates. Normalising them here would erase the distinction before the
 * decision that exists to make it.
 */

import { resolve } from 'node:path'
import type { SearchDoc } from './../../domain/contracts/knowledge.ts'
import type {
  MemoryData,
  RegisterData,
  ReplyData,
  SendData,
  TaskCommentData,
} from './../../domain/contracts/vocabulary.ts'
import { agentStream, MEMORY_STREAM, SYSTEM_STREAM, taskIdFromStream } from './../../domain/contracts/vocabulary.ts'
import { knowledge } from './../../domain/knowledge/index.ts'
import { tasks } from './../../domain/tasks/index.ts'
import type { SurfaceContext } from './../context.ts'
import { consolidatedThrough, wikiDocs } from './../corpus.ts'
import { renameCorpusRefusal, renameMemoryRefusal, renameScopeRefusal } from './../refusals.ts'

export function knowledgeRoutes(ctx: SurfaceContext): (req: Request, url: URL) => Promise<Response | undefined> {
  /** Memorize events the librarian has not folded into the wiki yet, so a
   *  fact written this morning is findable now rather than tomorrow. */
  async function unconsolidated(): Promise<{ id: number; text: string; agent?: string; taskId?: string }[]> {
    const since = ctx.dataDir === undefined ? 0 : await consolidatedThrough(ctx.dataDir)
    const events = await ctx.read({ stream: MEMORY_STREAM, afterId: since })
    return events.filter((e) => e.type === 'memory').map((e) => ({ id: e.id, ...(e.data as MemoryData) }))
  }

  /** Every task with its curated comments — a task is a container like a
   *  page, so it is one document, not one per comment. */
  async function taskInputs(): Promise<{ id: string; title: string; description?: string; comments: string[] }[]> {
    const comments = await ctx.read({ types: ['task-comment'] })
    const byTask = new Map<string, string[]>()
    for (const e of comments) {
      const id = taskIdFromStream(e.stream)
      if (id === undefined) continue
      byTask.set(id, [...(byTask.get(id) ?? []), (e.data as TaskCommentData).text])
    }
    return tasks
      .all(ctx.tasksState())
      .map((t) => ({ id: t.id, title: t.title, description: t.description, comments: byTask.get(t.id) ?? [] }))
  }

  /**
   * The human↔agent conversation, chronological.
   *
   * The user agents come from PERSISTED register events, never the live
   * session map: derived from who is connected, the whole conversation would
   * vanish from the corpus whenever the bridge happened to be down — and an
   * all-scope empty would stop meaning "definitively not in memory" exactly
   * when it was least true.
   */
  async function channelMessages(): Promise<{ who: string; text: string }[]> {
    const registers = await ctx.read({ types: ['register'] })
    const users = new Set<string>()
    for (const e of registers) {
      const d = e.data as RegisterData
      if (d?.role === 'user' && typeof d.agent === 'string') users.add(d.agent)
    }
    const rows: { at: number; who: string; text: string }[] = []
    for (const name of users) {
      for (const e of await ctx.read({ stream: agentStream(name) })) {
        if (e.type === 'reply') rows.push({ at: e.id, who: 'human', text: (e.data as ReplyData).text })
        else if (e.type === 'send') {
          const d = e.data as SendData
          rows.push({ at: e.id, who: d.from ?? 'agent', text: d.text })
        }
      }
    }
    rows.sort((a, b) => a.at - b.at)
    return rows.map(({ who, text }) => ({ who, text }))
  }

  async function corpusFor(scope: string): Promise<SearchDoc[]> {
    const docs: SearchDoc[] = []
    if (scope === 'knowledge' || scope === 'all') {
      if (ctx.dataDir !== undefined) docs.push(...wikiDocs(resolve(ctx.dataDir, 'context')))
      docs.push(...knowledge.memoryDocs(await unconsolidated()))
    }
    if (scope === 'tasks' || scope === 'all') docs.push(...knowledge.taskDocs(await taskInputs()))
    if (scope === 'channel' || scope === 'all') docs.push(...knowledge.channelDocs(await channelMessages()))
    return docs
  }

  async function search(url: URL): Promise<Response> {
    const decision = knowledge.resolveScope(url.searchParams.get('scope'))
    if (!decision.ok) {
      const renamed = renameScopeRefusal(decision.valid, url.searchParams.get('scope') ?? '')
      return ctx.json({ ...renamed.body, validScopes: renamed.validScopes }, renamed.status)
    }
    const scope = decision.scope
    const q = url.searchParams.get('q') ?? ''
    // Passed RAW: `search` clamps garbage (negative, fractional, NaN) into a
    // sane bound itself, and a shell that pre-clamped would be deciding.
    const topNParam = url.searchParams.get('topN')
    const topN = topNParam === null ? undefined : Number(topNParam)

    let docs: SearchDoc[]
    try {
      docs = await corpusFor(scope)
    } catch (err) {
      return ctx.json(
        { error: 'a knowledge source could not be read', detail: err instanceof Error ? err.message : String(err) },
        503,
      )
    }
    const built = knowledge.buildIndex(docs)
    if (!built.ok) {
      const renamed = renameCorpusRefusal(built.refusal)
      return ctx.json(renamed.body, renamed.status)
    }
    const result = knowledge.search(built.index, q, { scope, ...(topN !== undefined && { topN }) })
    // TELEMETRY NEVER FAILS A SEARCH. The port is best-effort by contract —
    // it writes private query text to a gitignored file for offline scoring —
    // and an unguarded call turns a full-disk or a permissions change into a
    // 500 on a search that already succeeded (codex pass, task 103). The
    // answer is computed above; nothing below it may take it away.
    try {
      ctx.logRetrieval({
        at: new Date(ctx.now()).toISOString(),
        from: url.searchParams.get('from') ?? undefined,
        query: q,
        scope,
        total: result.total,
        returned: result.returned,
        empty: result.empty,
        hits: result.hits.map((h) => ({ page: h.page, source: h.source, score: h.score })),
      })
    } catch {
      // Best-effort, and that is the whole of it.
    }
    return ctx.json(result)
  }

  async function memorize(req: Request, url: URL): Promise<Response> {
    const body = await ctx.body(req)
    if (body === null) return ctx.json({ error: 'body must be a JSON object' }, 400)
    // `agent` on a memorize body IS its caller — the one route where the
    // field means the author, so the one route that passes it.
    const caller = ctx.callerOf(req, url, typeof body.agent === 'string' ? body.agent : undefined)
    const decision = knowledge.admitMemory({
      ...(typeof body.agent === 'string' ? { agent: body.agent } : caller.name !== undefined && { agent: caller.name }),
      ...(typeof body.role === 'string'
        ? { role: body.role as MemoryData['role'] }
        : caller.role !== undefined && { role: caller.role }),
      ...(typeof body.text === 'string' && { text: body.text }),
      ...(typeof body.scope === 'string' && { scope: body.scope }),
      ...(typeof body.taskId === 'string' && { taskId: body.taskId }),
    })
    if (!decision.ok) {
      const renamed = renameMemoryRefusal(decision.refusal)
      return ctx.json(renamed.body, renamed.status)
    }
    const event = await ctx.record('memory', MEMORY_STREAM, decision.data)
    if (caller.name !== undefined) ctx.observeActivity(caller.name)
    return ctx.json({ ok: true, id: event.id })
  }

  /**
   * The unconsolidated slice, read plainly (task E3 — the CLI calls this).
   *
   * Cursor bookkeeping is the adapter's by the knowledge contract's own
   * division of labour, and this endpoint is that bookkeeping made visible:
   * where the librarian got to, and what has happened since. `?since=`
   * overrides the cursor for a caller that wants its own window; `?limit=`
   * takes the most recent N, because the interesting end of an
   * unconsolidated slice is the new end.
   */
  async function recent(url: URL): Promise<Response> {
    const cursor = ctx.dataDir === undefined ? 0 : await consolidatedThrough(ctx.dataDir)
    const sinceParam = url.searchParams.get('since')
    const parsedSince = sinceParam === null ? Number.NaN : Number(sinceParam)
    if (sinceParam !== null && !Number.isFinite(parsedSince)) {
      return ctx.json({ error: 'since must be a number' }, 400)
    }
    const limitParam = url.searchParams.get('limit')
    const parsedLimit = limitParam === null ? Number.NaN : Number(limitParam)
    if (limitParam !== null && !Number.isFinite(parsedLimit)) {
      return ctx.json({ error: 'limit must be a number' }, 400)
    }
    const since = Number.isFinite(parsedSince) ? parsedSince : cursor
    let events = (await ctx.read({ stream: MEMORY_STREAM, afterId: since })).filter((e) => e.type === 'memory')
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) events = events.slice(-parsedLimit)
    return ctx.json({
      cursor: { lastEventId: cursor },
      events: events.map((e) => ({ id: e.id, ts: e.ts, ...(e.data as MemoryData) })),
    })
  }

  /**
   * The librarian's end-of-run record.
   *
   * A RECORDED FACT, and nothing more (ruled at A-HL; routing repinned at
   * task 119): its shape is the vocabulary's, its resolution is MAIL to
   * the orchestrator (admission-gated — the flag below), and its consumers
   * read it from the mailbox and the log. No module grows a fold for it —
   * a fold with no reader would be shape without a keeper — so this
   * surface is a thin append of a census shape, and the numbers on it are
   * the
   * consolidator's own count of what it did.
   */
  async function consolidated(req: Request): Promise<Response> {
    const body = await ctx.body(req)
    if (body === null) return ctx.json({ error: 'body must be a JSON object' }, 400)
    const numeric = (key: string): Record<string, number> => {
      const value = body[key]
      return typeof value === 'number' && Number.isFinite(value) ? { [key]: value } : {}
    }
    const event = await ctx.record('wiki-consolidated', SYSTEM_STREAM, {
      ...numeric('pagesCreated'),
      ...numeric('pagesUpdated'),
      ...numeric('corrections'),
      ...numeric('tasksDistilled'),
      ...numeric('eventsProcessed'),
      ...numeric('rawFilesProcessed'),
      ...(Array.isArray(body.anomalies) && { anomalies: body.anomalies.map(String) }),
      // The admission flag (task 119): the summary mails the orchestrator.
      queued: true,
    })
    return ctx.json({ ok: true, id: event.id })
  }

  return async (req, url) => {
    if (url.pathname === '/context/search' && req.method === 'GET') return search(url)
    if (url.pathname === '/context/consolidated' && req.method === 'POST') return consolidated(req)
    if (url.pathname === '/context/recent' && req.method === 'GET') return recent(url)
    if (url.pathname === '/context/memorize' && req.method === 'POST') return memorize(req, url)
    return undefined
  }
}
