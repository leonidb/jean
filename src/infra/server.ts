#!/usr/bin/env bun
/**
 * Jean infrastructure service.
 *
 * Bun HTTP/WebSocket server that:
 * - Accepts WebSocket connections from channel plugins (one per agent)
 * - Routes messages between connected agents (role-based)
 * - Manages task state via board CRUD endpoints
 * - Queues events for the sensei and delivers them reactively
 * - Receives stop hook notifications (agent went idle)
 *
 * No LLM — fast, deterministic plumbing.
 */

import type { ServerWebSocket } from 'bun'
import {
  readBoard, writeBoard, findTask, upsertTask, createTask,
  updateTaskStatus, canTransition,
  type Board, type Task, type TaskStatus,
} from './board.ts'
import type {
  InboundMsg, OutboundMsg, DeliverMsg, SendRequest,
  AgentRole, QueuedEvent, EventType,
  CreateTaskRequest, UpdateTaskRequest, UpdateStatusRequest,
} from './protocol.ts'

const PORT = Number(process.env.JEAN_PORT ?? 8700)
const BOARD_PATH = process.env.JEAN_BOARD ?? './board.json'

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

// ── Event queue (for sensei) ──────────────────────────────────────

let eventIdCounter = 0
const eventQueue: QueuedEvent[] = []

function enqueueEvent(type: EventType, agent: string, text?: string, taskId?: string) {
  const event: QueuedEvent = {
    id: ++eventIdCounter,
    type,
    agent,
    text,
    taskId,
    ts: new Date().toISOString(),
  }
  eventQueue.push(event)
  logEvent('event-queued', agent, `${type} (id=${event.id})`)
  nudgeSenseiIfIdle()
}

function pendingEvents(agent?: string): QueuedEvent[] {
  if (agent) return eventQueue.filter(e => e.agent === agent)
  return [...eventQueue]
}

function pendingByAgent(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of eventQueue) {
    counts[e.agent] = (counts[e.agent] ?? 0) + 1
  }
  return counts
}

function ackEvent(id: number): boolean {
  const idx = eventQueue.findIndex(e => e.id === id)
  if (idx < 0) return false
  eventQueue.splice(idx, 1)
  return true
}

function ackEventsUpTo(agent: string, upToId: number): number {
  let count = 0
  for (let i = eventQueue.length - 1; i >= 0; i--) {
    const e = eventQueue[i]!
    if (e.agent === agent && e.id <= upToId) {
      eventQueue.splice(i, 1)
      count++
    }
  }
  return count
}

// ── Sensei nudge ──────────────────────────────────────────────────

function nudgeSenseiIfIdle() {
  const sensei = findSensei()
  if (!sensei || !sensei.idle) return
  if (eventQueue.length === 0) return

  sensei.idle = false // prevent double-nudge
  send(sensei.ws, {
    type: 'deliver',
    from: 'infra',
    text: 'Events pending. Check the board.',
  })
  logEvent('nudge', undefined, `${eventQueue.length} events pending`)
}

// ── Log (in-memory, recent only) ──────────────────────────────────

type LogEntry = {
  ts: string
  type: string
  agent?: string
  detail?: string
}

const logEntries: LogEntry[] = []
const MAX_LOG = 200

function logEvent(type: string, agent?: string, detail?: string) {
  const e: LogEntry = { ts: new Date().toISOString(), type, agent, detail }
  logEntries.push(e)
  if (logEntries.length > MAX_LOG) logEntries.shift()
  process.stderr.write(`[jean] ${type}${agent ? ` agent=${agent}` : ''}${detail ? ` ${detail}` : ''}\n`)
}

// ── HTTP + WebSocket server ───────────────────────────────────────

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
        const board = await readBoard(BOARD_PATH)
        const task = createTask({
          title: body.title,
          description: body.description ?? '',
          queue: body.queue,
          playbook: body.playbook,
        })
        const updated = upsertTask(board, task)
        await writeBoard(BOARD_PATH, updated)
        logEvent('task-created', undefined, `${task.id}: ${task.title}`)
        enqueueEvent('task-created', task.queue, task.title, task.id)
        return Response.json(task, { status: 201 })
      })()
    }

    // GET /tasks — list tasks
    if (path === '/tasks' && req.method === 'GET') {
      return (async () => {
        const board = await readBoard(BOARD_PATH)
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
        const board = await readBoard(BOARD_PATH)
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
        const board = await readBoard(BOARD_PATH)
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
        logEvent('task-status', undefined, `${task.id}: ${task.status} → ${body.status}`)
        return Response.json(updated)
      })()
    }

    // PATCH /tasks/:id — update fields
    const taskPatchMatch = path.match(/^\/tasks\/(\w+)$/)
    if (taskPatchMatch && req.method === 'PATCH') {
      return (async () => {
        const body = (await req.json()) as UpdateTaskRequest
        const board = await readBoard(BOARD_PATH)
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
        logEvent('task-updated', undefined, `${task.id}`)
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
        logEvent('send', body.to, delivered ? 'delivered' : 'agent not connected')
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

        logEvent('idle', agent)

        // If this is the sensei going idle, nudge if events pending
        if (entry?.role === 'sensei') {
          nudgeSenseiIfIdle()
        } else {
          // Worker went idle — queue event for sensei
          enqueueEvent('agent-idle', agent)
        }

        return Response.json({ ok: true })
      })()
    }

    // ── Event queue endpoints ───────────────────────────────────

    // GET /events/pending — all pending events (or filtered by agent)
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

    // POST /events/ack — batch ack events up to ID for an agent
    if (path === '/events/ack' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as { agent: string; upToId: number }
        if (!body.agent || !body.upToId) {
          return Response.json({ error: 'missing agent or upToId' }, { status: 400 })
        }
        const count = ackEventsUpTo(body.agent, body.upToId)
        return Response.json({ acknowledged: count })
      })()
    }

    // ── Info endpoints ──────────────────────────────────────────

    // GET /board — read the board
    if (path === '/board') {
      return (async () => {
        const board = await readBoard(BOARD_PATH)
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

    // GET /events — recent log
    if (path === '/events') {
      return Response.json({ events: logEntries })
    }

    // GET / — health check
    if (path === '/') {
      const sensei = findSensei()
      return Response.json({
        name: 'jean-infra',
        agents: [...agents.entries()].map(([n, e]) => ({ name: n, role: e.role })),
        sensei: sensei ? { connected: true, idle: sensei.idle } : { connected: false },
        pendingEvents: eventQueue.length,
      })
    }

    return new Response('not found', { status: 404 })
  },

  websocket: {
    open(ws) {
      logEvent('ws-open')
    },

    close(ws) {
      const agent = ws.data.agent
      if (agent) {
        agents.delete(agent)
        logEvent('disconnect', agent)
      }
    },

    message(ws, raw) {
      try {
        const msg = JSON.parse(String(raw)) as InboundMsg

        switch (msg.type) {
          case 'register': {
            ws.data.agent = msg.agent
            ws.data.role = msg.role
            agents.set(msg.agent, { ws, role: msg.role ?? 'worker', idle: false })
            send(ws, { type: 'registered', agent: msg.agent, role: msg.role ?? 'worker' })
            logEvent('register', msg.agent, `role=${msg.role ?? 'worker'}`)

            // If sensei just connected and events are pending, nudge
            if (msg.role === 'sensei' && eventQueue.length > 0) {
              const entry = agents.get(msg.agent)
              if (entry) {
                entry.idle = true // treat fresh connect as idle
                nudgeSenseiIfIdle()
              }
            }
            break
          }

          case 'reply': {
            logEvent('reply', msg.from, msg.text)
            // Queue as event for sensei (not direct delivery)
            enqueueEvent('reply', msg.from, msg.text)
            break
          }
        }
      } catch {
        // Ignore malformed messages
      }
    },
  },
})

logEvent('start', undefined, `listening on http://127.0.0.1:${PORT}`)
