#!/usr/bin/env bun
/**
 * Jean infrastructure service.
 *
 * Bun HTTP/WebSocket server that:
 * - Accepts WebSocket connections from channel plugins (one per agent)
 * - Routes messages between connected agents (role-based)
 * - Manages task state via board CRUD endpoints
 * - Records all events to a persistent history (JSONL)
 * - Queues actionable events for the sensei and delivers them reactively
 * - Receives stop hook notifications (agent went idle)
 *
 * No LLM — fast, deterministic plumbing.
 */

import { dirname, join } from 'path'
import { appendFile } from 'fs/promises'
import type { ServerWebSocket } from 'bun'
import {
  readBoard, writeBoard, findTask, upsertTask, createTask,
  updateTaskStatus, canTransition,
  type Board, type Task, type TaskStatus,
} from './board.ts'
import type {
  InboundMsg, OutboundMsg, DeliverMsg, SendRequest,
  AgentRole, EventKind, HistoryEvent,
  CreateTaskRequest, UpdateTaskRequest, UpdateStatusRequest,
} from './protocol.ts'

const PORT = Number(process.env.JEAN_PORT ?? 8700)
const BOARD_PATH = process.env.JEAN_BOARD ?? './board.json'
const HISTORY_PATH = process.env.JEAN_HISTORY ?? join(dirname(BOARD_PATH), 'history.jsonl')

// ── Agent registry (role-based) ───────────────────────────────────

type AgentSocket = ServerWebSocket<{ agent?: string; role?: AgentRole }>

type AgentEntry = {
  ws: AgentSocket
  role: AgentRole
  idle: boolean
}

const agents = new Map<string, AgentEntry>()

function findSensei(): AgentEntry | undefined {
  for (const entry of agents.values()) {
    if (entry.role === 'sensei') return entry
  }
  return undefined
}

function send(ws: AgentSocket, msg: OutboundMsg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}

function deliverToAgent(agentName: string, msg: DeliverMsg): boolean {
  const entry = agents.get(agentName)
  if (!entry) return false
  send(entry.ws, msg)
  return true
}

// ── Board cache (for sync taskId inference) ──────────────────────

let boardCache: Board = { tasks: [] }

async function cachedReadBoard(): Promise<Board> {
  boardCache = await readBoard(BOARD_PATH)
  return boardCache
}

function inferTaskId(agent?: string): string | undefined {
  if (!agent) return undefined
  const task = boardCache.tasks.find(
    t => (t.agent === agent || t.queue === agent) && (t.status === 'active' || t.status === 'blocked'),
  )
  return task?.id
}

// ── Unified event system ─────────────────────────────────────────

let eventIdCounter = 0
const pendingQueue: HistoryEvent[] = []

function isActionable(event: HistoryEvent): boolean {
  if (event.kind === 'reply') return true
  if (event.kind === 'task-created') return true
  // Only worker idle is actionable — sensei idle is informational
  if (event.kind === 'agent-idle') {
    const entry = agents.get(event.agent ?? '')
    return entry?.role !== 'sensei'
  }
  return false
}

function recordEvent(kind: EventKind, opts: { agent?: string; text?: string; taskId?: string } = {}): HistoryEvent {
  const taskId = opts.taskId ?? inferTaskId(opts.agent)
  const event: HistoryEvent = {
    id: ++eventIdCounter,
    kind,
    ts: new Date().toISOString(),
    ...(opts.agent && { agent: opts.agent }),
    ...(taskId && { taskId }),
    ...(opts.text && { text: opts.text }),
  }

  // Persist (fire-and-forget)
  void appendToHistory(event)

  // Stderr for real-time observability
  process.stderr.write(`[jean] ${event.kind}${event.agent ? ` agent=${event.agent}` : ''}${event.taskId ? ` task=${event.taskId}` : ''}${event.text ? ` ${event.text}` : ''}\n`)

  // Actionable events enter the pending queue and nudge sensei
  if (isActionable(event)) {
    pendingQueue.push(event)
    nudgeSenseiIfIdle()
  }

  return event
}

async function appendToHistory(event: HistoryEvent): Promise<void> {
  const line = JSON.stringify(event) + '\n'
  await appendFile(HISTORY_PATH, line)
}

async function loadLastEventId(): Promise<number> {
  const file = Bun.file(HISTORY_PATH)
  if (!(await file.exists())) return 0
  const text = await file.text()
  const lines = text.trimEnd().split('\n')
  if (lines.length === 0) return 0
  try {
    const last = JSON.parse(lines[lines.length - 1]!) as { id: number }
    return last.id
  } catch {
    return 0
  }
}

async function readHistory(opts?: { taskId?: string; last?: number }): Promise<HistoryEvent[]> {
  const file = Bun.file(HISTORY_PATH)
  if (!(await file.exists())) return []
  const text = await file.text()
  let events = text.trimEnd().split('\n')
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as HistoryEvent)
  if (opts?.taskId) {
    events = events.filter(e => e.taskId === opts.taskId)
  }
  if (opts?.last) {
    events = events.slice(-opts.last)
  }
  return events
}

// ── Pending queue helpers ────────────────────────────────────────

function pendingEvents(agent?: string): HistoryEvent[] {
  if (agent) return pendingQueue.filter(e => e.agent === agent)
  return [...pendingQueue]
}

function pendingByAgent(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of pendingQueue) {
    if (e.agent) counts[e.agent] = (counts[e.agent] ?? 0) + 1
  }
  return counts
}

function ackEvent(id: number): boolean {
  const idx = pendingQueue.findIndex(e => e.id === id)
  if (idx < 0) return false
  pendingQueue.splice(idx, 1)
  recordEvent('ack', { text: String(id) })
  return true
}

function ackEventsUpTo(agent: string, upToId: number): number {
  let count = 0
  const ackedIds: number[] = []
  for (let i = pendingQueue.length - 1; i >= 0; i--) {
    const e = pendingQueue[i]!
    if (e.agent === agent && e.id <= upToId) {
      ackedIds.push(e.id)
      pendingQueue.splice(i, 1)
      count++
    }
  }
  if (count > 0) recordEvent('ack', { agent, text: ackedIds.join(',') })
  return count
}

function ackAllUpTo(upToId: number): number {
  let count = 0
  const ackedIds: number[] = []
  for (let i = pendingQueue.length - 1; i >= 0; i--) {
    if (pendingQueue[i]!.id <= upToId) {
      ackedIds.push(pendingQueue[i]!.id)
      pendingQueue.splice(i, 1)
      count++
    }
  }
  if (count > 0) recordEvent('ack', { text: ackedIds.join(',') })
  return count
}

// ── Sensei nudge ──────────────────────────────────────────────────

function nudgeSenseiIfIdle() {
  const sensei = findSensei()
  if (!sensei || !sensei.idle) return
  if (pendingQueue.length === 0) return

  sensei.idle = false // prevent double-nudge
  send(sensei.ws, {
    type: 'deliver',
    from: 'infra',
    text: 'Events pending. Check the board.',
  })
  recordEvent('nudge', { text: `${pendingQueue.length} events pending` })
}

// ── HTTP + WebSocket server ───────────────────────────────────────

// Initialize: load counter from history, cache board, then start
const initCounter = await loadLastEventId()
eventIdCounter = initCounter
boardCache = await readBoard(BOARD_PATH).catch(() => ({ tasks: [] }))

Bun.serve<{ agent?: string; role?: AgentRole }>({
  port: PORT,
  hostname: '127.0.0.1',

  fetch(req, server) {
    const url = new URL(req.url)
    const path = url.pathname

    // WebSocket upgrade for channel plugins
    if (path === '/ws') {
      if (server.upgrade(req, { data: {} })) return
      return new Response('upgrade failed', { status: 400 })
    }

    // ── Task CRUD ───────────────────────────────────────────────

    // POST /tasks — create a task
    if (path === '/tasks' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as CreateTaskRequest
        if (!body.title || !body.queue) {
          return Response.json({ error: 'missing title or queue' }, { status: 400 })
        }
        const board = await cachedReadBoard()
        const task = createTask({
          title: body.title,
          description: body.description ?? '',
          queue: body.queue,
          playbook: body.playbook,
        })
        const updated = upsertTask(board, task)
        await writeBoard(BOARD_PATH, updated)
        boardCache = updated
        recordEvent('task-created', { agent: task.queue, text: task.title, taskId: task.id })
        return Response.json(task, { status: 201 })
      })()
    }

    // GET /tasks — list tasks
    if (path === '/tasks' && req.method === 'GET') {
      return (async () => {
        const board = await cachedReadBoard()
        let tasks = board.tasks
        const status = url.searchParams.get('status')
        if (status) tasks = tasks.filter(t => t.status === status)
        const queue = url.searchParams.get('queue')
        if (queue) tasks = tasks.filter(t => t.queue === queue)
        return Response.json({ tasks })
      })()
    }

    // GET /tasks/:id
    const taskGetMatch = path.match(/^\/tasks\/(\w+)$/)
    if (taskGetMatch && req.method === 'GET') {
      return (async () => {
        const board = await cachedReadBoard()
        const task = findTask(board, taskGetMatch[1]!)
        if (!task) return Response.json({ error: 'not found' }, { status: 404 })
        return Response.json(task)
      })()
    }

    // PATCH /tasks/:id/status — transition status
    const statusMatch = path.match(/^\/tasks\/(\w+)\/status$/)
    if (statusMatch && req.method === 'PATCH') {
      return (async () => {
        const body = (await req.json()) as UpdateStatusRequest
        if (!body.status) {
          return Response.json({ error: 'missing status' }, { status: 400 })
        }
        const board = await cachedReadBoard()
        const task = findTask(board, statusMatch[1]!)
        if (!task) return Response.json({ error: 'not found' }, { status: 404 })
        if (!canTransition(task.status, body.status as TaskStatus)) {
          return Response.json(
            { error: `invalid transition: ${task.status} → ${body.status}` },
            { status: 400 },
          )
        }
        const updated = updateTaskStatus(task, body.status as TaskStatus)
        const newBoard = upsertTask(board, updated)
        await writeBoard(BOARD_PATH, newBoard)
        boardCache = newBoard
        recordEvent('task-status', { taskId: task.id, text: `${task.status} → ${body.status}` })
        return Response.json(updated)
      })()
    }

    // PATCH /tasks/:id — update fields
    const taskPatchMatch = path.match(/^\/tasks\/(\w+)$/)
    if (taskPatchMatch && req.method === 'PATCH') {
      return (async () => {
        const body = (await req.json()) as UpdateTaskRequest
        const board = await cachedReadBoard()
        const task = findTask(board, taskPatchMatch[1]!)
        if (!task) return Response.json({ error: 'not found' }, { status: 404 })
        const updated: Task = {
          ...task,
          ...body.agent !== undefined && { agent: body.agent },
          ...body.description !== undefined && { description: body.description },
          updatedAt: new Date().toISOString(),
        }
        const newBoard = upsertTask(board, updated)
        await writeBoard(BOARD_PATH, newBoard)
        boardCache = newBoard
        recordEvent('task-updated', { taskId: task.id, text: task.id })
        return Response.json(updated)
      })()
    }

    // ── Message routing ─────────────────────────────────────────

    // POST /send — push a message to an agent
    if (path === '/send' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as SendRequest
        if (!body.to || !body.text) {
          return Response.json({ error: 'missing to or text' }, { status: 400 })
        }
        const delivered = deliverToAgent(body.to, {
          type: 'deliver',
          from: body.from ?? 'api',
          text: body.text,
          taskId: body.taskId,
        })
        // Agent just received work — mark as not idle
        if (delivered) {
          const entry = agents.get(body.to)
          if (entry) entry.idle = false
        }
        recordEvent('send', {
          agent: body.to,
          taskId: body.taskId,
          text: `from=${body.from ?? 'api'} ${delivered ? 'delivered' : 'not connected'}: ${body.text}`,
        })
        return Response.json({ delivered })
      })()
    }

    // ── Agent idle (stop hook) ──────────────────────────────────

    if (path === '/agent-idle' && (req.method === 'POST' || req.method === 'GET')) {
      return (async () => {
        let agent: string | null = null
        if (req.method === 'POST') {
          const body = (await req.json()) as { agent: string }
          agent = body.agent
        } else {
          agent = url.searchParams.get('name')
        }
        if (!agent) {
          return Response.json({ error: 'missing agent name' }, { status: 400 })
        }

        const entry = agents.get(agent)
        if (entry) entry.idle = true

        // If this is the sensei going idle, nudge if events pending
        if (entry?.role === 'sensei') {
          recordEvent('agent-idle', { agent })
          // Re-check: sensei is now idle, maybe events arrived while it was busy
          nudgeSenseiIfIdle()
        } else {
          // Worker went idle — actionable event for sensei
          recordEvent('agent-idle', { agent })
        }

        return Response.json({ ok: true })
      })()
    }

    // ── Event endpoints ─────────────────────────────────────────

    // GET /events — pending actionable events (optionally filtered by agent)
    if (path === '/events' && req.method === 'GET') {
      const agent = url.searchParams.get('agent') ?? undefined
      return Response.json({ events: pendingEvents(agent) })
    }

    // GET /events/pending — alias for /events (backward compat)
    if (path === '/events/pending') {
      const agent = url.searchParams.get('agent') ?? undefined
      return Response.json({ events: pendingEvents(agent) })
    }

    // GET /events/agents — agents with pending event counts
    if (path === '/events/agents') {
      return Response.json({ agents: pendingByAgent() })
    }

    // POST /events/:id/ack — acknowledge a single event
    const ackMatch = path.match(/^\/events\/(\d+)\/ack$/)
    if (ackMatch && req.method === 'POST') {
      const ok = ackEvent(Number(ackMatch[1]))
      return Response.json({ ok })
    }

    // POST /events/ack — batch ack events up to ID (optionally filtered by source agent)
    if (path === '/events/ack' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as { upToId: number; agent?: string }
        if (!body.upToId) {
          return Response.json({ error: 'missing upToId' }, { status: 400 })
        }
        if (body.agent) {
          const count = ackEventsUpTo(body.agent, body.upToId)
          return Response.json({ acknowledged: count })
        }
        const count = ackAllUpTo(body.upToId)
        return Response.json({ acknowledged: count })
      })()
    }

    // ── History endpoint ────────────────────────────────────────

    // GET /history — full persistent event history
    if (path === '/history') {
      return (async () => {
        const taskId = url.searchParams.get('taskId') ?? undefined
        const last = url.searchParams.get('last')
        const events = await readHistory({
          taskId,
          last: last ? Number(last) : undefined,
        })
        return Response.json({ events })
      })()
    }

    // ── Info endpoints ──────────────────────────────────────────

    // GET /board — read the board
    if (path === '/board') {
      return (async () => {
        const board = await cachedReadBoard()
        return Response.json(board)
      })()
    }

    // GET /agents — list connected agents with roles
    if (path === '/agents') {
      const list = [...agents.entries()].map(([name, entry]) => ({
        name,
        role: entry.role,
        idle: entry.idle,
      }))
      return Response.json({ agents: list })
    }

    // GET / — health check
    if (path === '/') {
      const sensei = findSensei()
      return Response.json({
        name: 'jean-infra',
        agents: [...agents.entries()].map(([n, e]) => ({ name: n, role: e.role })),
        sensei: sensei ? { connected: true, idle: sensei.idle } : { connected: false },
        pendingEvents: pendingQueue.length,
      })
    }

    return new Response('not found', { status: 404 })
  },

  websocket: {
    open(ws) {
      // ws-open is pre-registration, no agent info yet — skip recording
    },

    close(ws) {
      const agent = ws.data.agent
      if (agent) {
        agents.delete(agent)
        recordEvent('disconnect', { agent })
      }
    },

    message(ws, raw) {
      try {
        const msg = JSON.parse(String(raw)) as InboundMsg

        switch (msg.type) {
          case 'register': {
            ws.data.agent = msg.agent
            ws.data.role = msg.role
            const role = msg.role ?? 'worker'
            // Determine idle state from board: if agent has an active task, it's busy
            const hasActiveTask = boardCache.tasks.some(
              t => t.agent === msg.agent && (t.status === 'active' || t.status === 'blocked'),
            )
            const idle = !hasActiveTask
            agents.set(msg.agent, { ws, role, idle })
            send(ws, { type: 'registered', agent: msg.agent, role })
            recordEvent('register', { agent: msg.agent, text: `role=${role} idle=${idle}` })

            if (role === 'sensei' && idle) {
              // Sensei just connected idle — nudge if work exists
              if (pendingQueue.length > 0) {
                nudgeSenseiIfIdle()
              } else {
                const hasWork = boardCache.tasks.some(
                  t => t.status === 'inbox' || t.status === 'active' || t.status === 'blocked',
                )
                if (hasWork) nudgeSenseiIfIdle()
              }
            }
            break
          }

          case 'reply': {
            // Only queue replies from workers — sensei replies go to history only
            const sender = agents.get(msg.from)
            if (sender?.role !== 'sensei') {
              recordEvent('reply', { agent: msg.from, text: msg.text })
            } else {
              // Sensei reply: record as informational (not actionable)
              // Use 'send' kind since it's sensei communicating outward
              recordEvent('send', { agent: msg.from, text: msg.text })
            }
            break
          }
        }
      } catch {
        // Ignore malformed messages
      }
    },
  },
})

recordEvent('start', { text: `listening on http://127.0.0.1:${PORT}` })
