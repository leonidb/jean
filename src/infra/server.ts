#!/usr/bin/env bun
/**
 * Jean infrastructure service.
 *
 * Bun HTTP/WebSocket server that:
 * - Accepts WebSocket connections from channel plugins (one per agent)
 * - Routes messages between connected agents (role-based)
 * - Manages task state derived from events (event sourcing)
 * - Queues actionable events for the sensei and delivers them reactively
 * - Receives stop hook notifications (agent went idle)
 *
 * No LLM — fast, deterministic plumbing.
 */

import { dirname } from 'path'
import type { ServerWebSocket } from 'bun'
import {
  createStore, jsonlBackend, createProjection, fileSnapshotBackend,
  type StoredEvent, type EventStore,
} from '../es/index.ts'
import { canTransition, type Board, type Task, type TaskStatus } from './board.ts'
import {
  boardReducer, pendingReducer,
  taskStream, agentStream, SYSTEM_STREAM, taskIdFromStream,
  toApiEvent,
  type TaskCreatedData, type TaskStatusData, type TaskUpdatedData,
  type SendData, type AgentIdleData, type RegisterData, type AckData,
  type ReplyData, type NudgeData, type StartData,
  type PendingState,
} from './reducers.ts'
import type {
  InboundMsg, OutboundMsg, DeliverMsg, SendRequest,
  AgentRole,
  CreateTaskRequest, UpdateTaskRequest, UpdateStatusRequest,
} from './protocol.ts'

const PORT = Number(process.env.JEAN_PORT ?? 8700)
const BOARD_PATH = process.env.JEAN_BOARD ?? './board.json'
const HISTORY_PATH = process.env.JEAN_HISTORY ?? `${dirname(BOARD_PATH)}/history.jsonl`

// ── Event store & projections ────────────────────────────────────

const store: EventStore = createStore(jsonlBackend(HISTORY_PATH))

const boardProjection = createProjection<Board>({
  name: 'board',
  store,
  reducer: boardReducer,
  initial: { tasks: [] },
  filter: { types: ['task-created', 'task-status', 'task-updated'] },
  snapshots: fileSnapshotBackend(dirname(BOARD_PATH)),
  snapshotEvery: 50,
})

const pendingProjection = createProjection<PendingState>({
  name: 'pending',
  store,
  reducer: pendingReducer,
  initial: [],
  filter: { types: ['reply', 'agent-idle', 'task-created', 'ack'] },
})

// Initialize: replay events to rebuild state
await boardProjection.catchUp()
await pendingProjection.catchUp()

// ── Agent registry (role-based, ephemeral) ───────────────────────

type AgentSocket = ServerWebSocket<{ agent?: string; role?: AgentRole }>

type AgentEntry = {
  ws: AgentSocket
  role: AgentRole
  idle: boolean
  sessionId?: string
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

// ── Record event (append + project + side effects) ───────────────

async function record(type: string, stream: string, data: unknown): Promise<StoredEvent> {
  const sizeBefore = pendingProjection.state.length
  const event = await store.append({ stream, type, data })
  boardProjection.apply(event)
  pendingProjection.apply(event)

  // Stderr for real-time observability
  const taskId = taskIdFromStream(stream)
  const agent = (data as Record<string, unknown>)?.agent as string | undefined
  process.stderr.write(`[jean] ${type}${agent ? ` agent=${agent}` : ''}${taskId ? ` task=${taskId}` : ''}\n`)

  // Nudge sensei if pending queue grew
  if (pendingProjection.state.length > sizeBefore) {
    nudgeSenseiIfIdle()
  }

  return event
}

// ── Helpers ──────────────────────────────────────────────────────

function inferTaskId(agentName?: string): string | undefined {
  if (!agentName) return undefined
  const task = boardProjection.state.tasks.find(
    t => (t.agent === agentName || t.queue === agentName) && (t.status === 'active' || t.status === 'blocked'),
  )
  return task?.id
}

function nextTaskId(): string {
  return String(boardProjection.state.tasks.length + 1).padStart(3, '0')
}

function pendingEvents(agent?: string): StoredEvent[] {
  const all = pendingProjection.state
  if (agent) {
    return all.filter(e => {
      const a = (e.data as Record<string, unknown>)?.agent as string | undefined
        ?? (e.stream.startsWith('agent-') ? e.stream.slice(6) : undefined)
        ?? (e.stream.startsWith('task-') ? boardProjection.state.tasks.find(t => t.id === taskIdFromStream(e.stream))?.queue : undefined)
      return a === agent
    })
  }
  return [...all]
}

function pendingByAgent(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of pendingProjection.state) {
    const agent = (e.data as Record<string, unknown>)?.agent as string | undefined
      ?? (e.stream.startsWith('agent-') ? e.stream.slice(6) : undefined)
    if (agent) counts[agent] = (counts[agent] ?? 0) + 1
  }
  return counts
}

// ── Sensei nudge ──────────────────────────────────────────────────

function nudgeSenseiIfIdle(reason?: string) {
  const sensei = findSensei()
  if (!sensei || !sensei.idle) return

  // Check if there's actually something to nudge about
  if (!reason && pendingProjection.state.length === 0) return

  sensei.idle = false // prevent double-nudge
  send(sensei.ws, {
    type: 'deliver',
    from: 'infra',
    text: 'Events pending. Check the board.',
  })
  void record('nudge', SYSTEM_STREAM, { pendingCount: pendingProjection.state.length } satisfies NudgeData)
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
        const taskId = nextTaskId()
        const event = await record('task-created', taskStream(taskId), {
          title: body.title,
          description: body.description ?? '',
          queue: body.queue,
          playbook: body.playbook,
        } satisfies TaskCreatedData)
        const task = boardProjection.state.tasks.find(t => t.id === taskId)
        return Response.json(task, { status: 201 })
      })()
    }

    // GET /tasks — list tasks
    if (path === '/tasks' && req.method === 'GET') {
      let tasks = boardProjection.state.tasks
      const status = url.searchParams.get('status')
      if (status) tasks = tasks.filter(t => t.status === status)
      const queue = url.searchParams.get('queue')
      if (queue) tasks = tasks.filter(t => t.queue === queue)
      return Response.json({ tasks })
    }

    // GET /tasks/:id
    const taskGetMatch = path.match(/^\/tasks\/(\w+)$/)
    if (taskGetMatch && req.method === 'GET') {
      const task = boardProjection.state.tasks.find(t => t.id === taskGetMatch[1])
      if (!task) return Response.json({ error: 'not found' }, { status: 404 })
      return Response.json(task)
    }

    // PATCH /tasks/:id/status — transition status
    const statusMatch = path.match(/^\/tasks\/(\w+)\/status$/)
    if (statusMatch && req.method === 'PATCH') {
      return (async () => {
        const body = (await req.json()) as UpdateStatusRequest
        if (!body.status) {
          return Response.json({ error: 'missing status' }, { status: 400 })
        }
        const task = boardProjection.state.tasks.find(t => t.id === statusMatch[1])
        if (!task) return Response.json({ error: 'not found' }, { status: 404 })
        if (!canTransition(task.status, body.status as TaskStatus)) {
          return Response.json(
            { error: `invalid transition: ${task.status} → ${body.status}` },
            { status: 400 },
          )
        }
        await record('task-status', taskStream(task.id), {
          from: task.status,
          to: body.status,
        } satisfies TaskStatusData)
        const updated = boardProjection.state.tasks.find(t => t.id === task.id)
        return Response.json(updated)
      })()
    }

    // PATCH /tasks/:id — update fields
    const taskPatchMatch = path.match(/^\/tasks\/(\w+)$/)
    if (taskPatchMatch && req.method === 'PATCH') {
      return (async () => {
        const body = (await req.json()) as UpdateTaskRequest
        const task = boardProjection.state.tasks.find(t => t.id === taskPatchMatch[1])
        if (!task) return Response.json({ error: 'not found' }, { status: 404 })
        await record('task-updated', taskStream(task.id), {
          ...(body.agent !== undefined && { agent: body.agent }),
          ...(body.description !== undefined && { description: body.description }),
        } satisfies TaskUpdatedData)
        const updated = boardProjection.state.tasks.find(t => t.id === task.id)
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
        if (delivered) {
          const entry = agents.get(body.to)
          if (entry) entry.idle = false
        }
        const stream = body.taskId ? taskStream(body.taskId) : agentStream(body.to)
        void record('send', stream, {
          agent: body.to,
          from: body.from ?? 'api',
          text: body.text,
          delivered,
        } satisfies SendData)
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

        // Validate session ID if provided — flag stale stop hooks
        if (sessionId && entry?.sessionId && sessionId !== entry.sessionId) {
          process.stderr.write(`[jean] WARNING: agent-idle for "${agentName}" from stale session ${sessionId} (current: ${entry.sessionId})\n`)
          void record('agent-idle', agentStream(agentName), {
            agent: agentName,
            role: entry.role,
            stale: true,
            hookSessionId: sessionId,
            currentSessionId: entry.sessionId,
          })
          return Response.json({ ok: false, error: 'stale session', currentSessionId: entry.sessionId })
        }

        // Agent not connected — stop hook from a disconnected agent
        if (!entry) {
          process.stderr.write(`[jean] WARNING: agent-idle for "${agentName}" but agent is not connected\n`)
          void record('agent-idle', agentStream(agentName), { agent: agentName, role: 'unknown', disconnected: true })
          return Response.json({ ok: false, error: 'agent not connected' })
        }

        entry.idle = true
        const role = entry.role
        const taskId = inferTaskId(agentName)
        const stream = taskId ? taskStream(taskId) : agentStream(agentName)
        await record('agent-idle', stream, { agent: agentName, role } satisfies AgentIdleData & { agent: string })

        // If sensei just went idle, check for pending work
        if (role === 'sensei') {
          nudgeSenseiIfIdle()
        }

        return Response.json({ ok: true })
      })()
    }

    // ── Event endpoints ─────────────────────────────────────────

    // GET /events — pending actionable events (optionally filtered by agent)
    if (path === '/events' && req.method === 'GET') {
      const agent = url.searchParams.get('agent') ?? undefined
      return Response.json({ events: pendingEvents(agent).map(toApiEvent) })
    }

    // GET /events/pending — alias for /events
    if (path === '/events/pending') {
      const agent = url.searchParams.get('agent') ?? undefined
      return Response.json({ events: pendingEvents(agent).map(toApiEvent) })
    }

    // GET /events/agents — agents with pending event counts
    if (path === '/events/agents') {
      return Response.json({ agents: pendingByAgent() })
    }

    // POST /events/:id/ack — acknowledge a single event
    const ackMatch = path.match(/^\/events\/(\d+)\/ack$/)
    if (ackMatch && req.method === 'POST') {
      return (async () => {
        const id = Number(ackMatch[1])
        const exists = pendingProjection.state.some(e => e.id === id)
        if (!exists) return Response.json({ ok: false })
        await record('ack', SYSTEM_STREAM, { eventIds: [id] } satisfies AckData)
        return Response.json({ ok: true })
      })()
    }

    // POST /events/ack — batch ack events up to ID
    if (path === '/events/ack' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as { upToId: number; agent?: string }
        if (!body.upToId) {
          return Response.json({ error: 'missing upToId' }, { status: 400 })
        }
        let toAck = pendingProjection.state.filter(e => e.id <= body.upToId)
        if (body.agent) {
          toAck = toAck.filter(e => {
            const a = (e.data as Record<string, unknown>)?.agent as string | undefined
              ?? (e.stream.startsWith('agent-') ? e.stream.slice(6) : undefined)
            return a === body.agent
          })
        }
        const eventIds = toAck.map(e => e.id)
        if (eventIds.length > 0) {
          await record('ack', SYSTEM_STREAM, { eventIds } satisfies AckData)
        }
        return Response.json({ acknowledged: eventIds.length })
      })()
    }

    // ── History endpoint ────────────────────────────────────────

    // GET /history — full persistent event history
    // ?taskId=001 — filter by task
    // ?stream=agent-scratch — filter by stream
    // ?last=50 — last N events
    // ?raw=true — return raw StoredEvents (with stream, data) instead of translated ApiEvents
    if (path === '/history') {
      return (async () => {
        const taskId = url.searchParams.get('taskId') ?? undefined
        const last = url.searchParams.get('last')
        const raw = url.searchParams.get('raw') === 'true'
        const stream = url.searchParams.get('stream') ?? (taskId ? taskStream(taskId) : undefined)
        let events = await store.read({ stream })
        if (last) events = events.slice(-Number(last))
        return Response.json({ events: raw ? events : events.map(toApiEvent) })
      })()
    }

    // ── Info endpoints ──────────────────────────────────────────

    // GET /board — read the board
    if (path === '/board') {
      return Response.json(boardProjection.state)
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
        pendingEvents: pendingProjection.state.length,
      })
    }

    return new Response('not found', { status: 404 })
  },

  websocket: {
    idleTimeout: 10, // detect dead connections within 10 seconds
    open(ws) {
      // ws-open is pre-registration, no agent info yet
    },

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

        switch (msg.type) {
          case 'register': {
            const role = msg.role ?? 'worker'

            // Handle existing agent with same name
            const existing = agents.get(msg.agent)
            if (existing && existing.ws !== ws) {
              if (msg.sessionId && existing.sessionId && msg.sessionId === existing.sessionId) {
                // Same session reconnecting — update the WebSocket
              } else {
                // New session replacing old one — clean up old socket
                existing.ws.data.agent = undefined
                existing.ws.close()
              }
              agents.delete(msg.agent)
            }

            // Only one sensei allowed — reject different agent trying to be sensei
            if (role === 'sensei') {
              const existingSensei = findSensei()
              if (existingSensei && existingSensei.ws !== ws) {
                send(ws, { type: 'deliver', from: 'infra', text: 'ERROR: Another sensei is already connected. Only one sensei per dojo. This connection will be ignored.' })
                break
              }
            }

            ws.data.agent = msg.agent
            ws.data.role = msg.role
            const hasActiveTask = boardProjection.state.tasks.some(
              t => t.agent === msg.agent && (t.status === 'active' || t.status === 'blocked'),
            )
            const idle = !hasActiveTask
            const sessionId = msg.sessionId
            agents.set(msg.agent, { ws, role, idle, sessionId })
            send(ws, { type: 'registered', agent: msg.agent, role })
            void record('register', agentStream(msg.agent), { agent: msg.agent, role, idle, sessionId } satisfies RegisterData & { agent: string; sessionId?: string })

            if (role === 'sensei') {
              // Always nudge sensei on connect — get up to date
              // Delay slightly to ensure the channel plugin is ready to receive
              setTimeout(() => {
                send(ws, {
                  type: 'deliver',
                  from: 'infra',
                  text: 'You just connected. Check the board and events to get up to date.',
                })
              }, 500)
            } else if (idle) {
              // Worker connected — nudge sensei if there's work
              if (pendingProjection.state.length > 0) {
                nudgeSenseiIfIdle()
              } else {
                const hasWork = boardProjection.state.tasks.some(
                  t => t.status === 'inbox' || t.status === 'active' || t.status === 'blocked',
                )
                if (hasWork) nudgeSenseiIfIdle('worker connected, board has work')
              }
            }
            break
          }

          case 'reply': {
            const sender = agents.get(msg.from)
            const taskId = inferTaskId(msg.from)
            const stream = taskId ? taskStream(taskId) : agentStream(msg.from)
            if (sender?.role !== 'sensei') {
              void record('reply', stream, { agent: msg.from, text: msg.text } satisfies ReplyData & { agent: string })
            } else {
              void record('send', stream, { agent: msg.from, from: msg.from, text: msg.text, delivered: true } satisfies SendData & { agent: string })
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

// Heartbeat: ping all connected agents every 5 seconds to detect dead connections
setInterval(() => {
  for (const [name, entry] of agents) {
    entry.ws.ping()
  }
}, 5000)

void record('start', SYSTEM_STREAM, { port: PORT } satisfies StartData)
