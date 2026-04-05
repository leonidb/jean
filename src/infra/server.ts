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

import { dirname } from 'path'
import type { ServerWebSocket } from 'bun'
import {
  createStore, jsonlBackend, createProjection, fileSnapshotBackend,
  type StoredEvent, type EventStore,
} from '../es/index.ts'
import { canTransition, type Board, type TaskStatus } from './board.ts'
import {
  boardReducer, pendingReducer,
  taskStream, agentStream, SYSTEM_STREAM, taskIdFromStream, agentFromEvent,
  toApiEvent,
  type TaskCreatedData, type TaskStatusData, type TaskUpdatedData,
  type SendData, type AgentIdleData, type RegisterData, type AckData,
  type ReplyData, type NudgeData, type StartData, type PermissionRequestData,
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

// Slack config (optional) — loaded from .env in cwd (the .jean/ directory)
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const SLACK_CHANNEL = process.env.SLACK_CHANNEL

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

await boardProjection.catchUp()
await pendingProjection.catchUp()
await lastTaskContext.catchUp()

// ── Agent registry (transport-agnostic) ──────────────────────────

type AgentEntry = {
  role: AgentRole
  idle: boolean
  sessionId?: string
  tags: string[]
  deliver: (msg: DeliverMsg) => boolean
  close?: () => void
}

const agents = new Map<string, AgentEntry>()

function findSensei(): AgentEntry | undefined {
  for (const entry of agents.values()) {
    if (entry.role === 'sensei') return entry
  }
  return undefined
}

function deliverToAgent(agentName: string, msg: DeliverMsg): boolean {
  const entry = agents.get(agentName)
  if (!entry) return false
  return entry.deliver(msg)
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

// ── SSE subscribers ──────────────────────────────────────────────

const sseSubscribers = new Set<{ write: (data: string) => void; close: () => void }>()

function broadcastSSE(event: StoredEvent) {
  const json = JSON.stringify(toApiEvent(event))
  for (const sub of sseSubscribers) {
    try { sub.write(`data: ${json}\n\n`) } catch { sseSubscribers.delete(sub) }
  }
}

// ── Record event (append + project + side effects) ───────────────

async function record(type: string, stream: string, data: unknown): Promise<StoredEvent> {
  const sizeBefore = pendingProjection.state.length
  const event = await store.append({ stream, type, data })
  boardProjection.apply(event)
  pendingProjection.apply(event)

  const taskId = taskIdFromStream(stream)
  const agent = (data as Record<string, unknown>)?.agent as string | undefined
  process.stderr.write(`[jean] ${type}${agent ? ` agent=${agent}` : ''}${taskId ? ` task=${taskId}` : ''}\n`)

  broadcastSSE(event)

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
  if (task) return task.id
  return lastTaskContext.state.get(agentName)
}

function nextTaskId(): string {
  return String(boardProjection.state.tasks.length + 1).padStart(3, '0')
}

function resolveAgent(event: StoredEvent): string | undefined {
  const agent = agentFromEvent(event)
  if (agent) return agent
  const taskId = taskIdFromStream(event.stream)
  if (taskId) {
    const task = boardProjection.state.tasks.find(t => t.id === taskId)
    return task?.agent ?? task?.queue
  }
  return undefined
}

function pendingEvents(agent?: string): StoredEvent[] {
  if (!agent) return [...pendingProjection.state]
  return pendingProjection.state.filter(e => resolveAgent(e) === agent)
}

function pendingByAgent(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of pendingProjection.state) {
    const agent = resolveAgent(e)
    if (agent) counts[agent] = (counts[agent] ?? 0) + 1
  }
  return counts
}

// ── Sensei nudge ──────────────────────────────────────────────────

function nudgeSenseiIfIdle(force = false) {
  const sensei = findSensei()
  if (!sensei || !sensei.idle) return
  if (!force && pendingProjection.state.length === 0) return

  sensei.idle = false
  sensei.deliver({
    type: 'deliver',
    from: 'infra',
    text: 'Events pending. Check the board.',
  })
  void record('nudge', SYSTEM_STREAM, { pendingCount: pendingProjection.state.length } satisfies NudgeData)
}

// ── Slack integration (optional) ─────────────────────────────────

let slackConnected = false

async function initSlack() {
  if (!SLACK_APP_TOKEN || !SLACK_BOT_TOKEN || !SLACK_CHANNEL) return

  const { App } = await import('@slack/bolt')
  const app = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
  })

  // Derive channel name for agent registry
  let channelName = SLACK_CHANNEL
  try {
    const info = await app.client.conversations.info({ channel: SLACK_CHANNEL })
    channelName = (info.channel as { name?: string })?.name ?? SLACK_CHANNEL
  } catch { /* use channel ID as fallback */ }

  // Register Slack channel as an agent
  agents.set(channelName, {
    role: 'user',
    idle: true,
    tags: [],
    deliver: (msg) => {
      void app.client.chat.postMessage({
        channel: SLACK_CHANNEL!,
        text: `*${msg.from}*: ${msg.text}`,
      })
      return true
    },
  })

  // Listen for messages in the channel
  app.message(async ({ message }) => {
    const m = message as { channel?: string; text?: string; bot_id?: string; subtype?: string }
    // Ignore bot messages (our own) and non-matching channels
    if (m.bot_id || m.subtype) return
    if (m.channel !== SLACK_CHANNEL) return
    if (!m.text) return

    void record('reply', agentStream(channelName), {
      agent: channelName,
      text: m.text,
    } satisfies ReplyData)
  })

  await app.start()
  slackConnected = true
  process.stderr.write(`[jean] slack connected: #${channelName} (${SLACK_CHANNEL})\n`)
  void record('register', agentStream(channelName), { agent: channelName, role: 'user', idle: true } satisfies RegisterData)
}

// ── HTTP + WebSocket server ───────────────────────────────────────

Bun.serve<{ agent?: string; role?: AgentRole }>({
  port: PORT,
  hostname: '127.0.0.1',

  fetch(req, server) {
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
        } satisfies TaskCreatedData)
        const task = boardProjection.state.tasks.find(t => t.id === taskId)
        return Response.json(task, { status: 201 })
      })()
    }

    if (path === '/tasks' && req.method === 'GET') {
      let tasks = boardProjection.state.tasks
      const status = url.searchParams.get('status')
      if (status) tasks = tasks.filter(t => t.status === status)
      const queue = url.searchParams.get('queue')
      if (queue) tasks = tasks.filter(t => t.queue === queue)
      return Response.json({ tasks })
    }

    const taskGetMatch = path.match(/^\/tasks\/(\w+)$/)
    if (taskGetMatch && req.method === 'GET') {
      const task = boardProjection.state.tasks.find(t => t.id === taskGetMatch[1])
      if (!task) return Response.json({ error: 'not found' }, { status: 404 })
      return Response.json(task)
    }

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
          if (entry && entry.role === 'worker') entry.idle = false
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

        if (!entry) {
          process.stderr.write(`[jean] WARNING: agent-idle for "${agentName}" but agent is not connected\n`)
          void record('agent-idle', agentStream(agentName), { agent: agentName, role: 'unknown', disconnected: true })
          return Response.json({ ok: false, error: 'agent not connected' })
        }

        entry.idle = true
        const role = entry.role
        const taskId = inferTaskId(agentName)
        const stream = taskId ? taskStream(taskId) : agentStream(agentName)
        await record('agent-idle', stream, { agent: agentName, role } satisfies AgentIdleData)

        if (role === 'sensei') {
          nudgeSenseiIfIdle()
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

        const byAgent: Record<string, Record<string, { count: number; samples: Record<string, unknown>[] }>> = {}
        for (const e of permEvents) {
          const d = e.data as PermissionRequestData
          const agentMap = byAgent[d.agent] ??= {}
          const entry = agentMap[d.tool] ??= { count: 0, samples: [] }
          entry.count++
          if (entry.samples.length < 5) entry.samples.push(d.input)
        }

        return Response.json({ permissions: byAgent })
      })()
    }

    // ── Event endpoints ─────────────────────────────────────────

    if (path === '/events' && req.method === 'GET') {
      const agent = url.searchParams.get('agent') ?? undefined
      return Response.json({ events: pendingEvents(agent).map(toApiEvent) })
    }

    if (path === '/events/pending') {
      const agent = url.searchParams.get('agent') ?? undefined
      return Response.json({ events: pendingEvents(agent).map(toApiEvent) })
    }

    if (path === '/events/agents') {
      return Response.json({ agents: pendingByAgent() })
    }

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

    if (path === '/events/ack' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as { upToId: number; agent?: string }
        if (!body.upToId) {
          return Response.json({ error: 'missing upToId' }, { status: 400 })
        }
        let toAck = pendingProjection.state.filter(e => e.id <= body.upToId)
        if (body.agent) {
          toAck = toAck.filter(e => resolveAgent(e) === body.agent)
        }
        const eventIds = toAck.map(e => e.id)
        if (eventIds.length > 0) {
          await record('ack', SYSTEM_STREAM, { eventIds } satisfies AckData)
        }
        return Response.json({ acknowledged: eventIds.length })
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
        if (!includeDiagnostics) events = events.filter(e => e.type !== 'permission-request')
        if (last) events = events.slice(-Number(last))
        return Response.json({ events: raw ? events : events.map(toApiEvent) })
      })()
    }

    // ── SSE stream ──────────────────────────────────────────────

    if (path === '/stream') {
      return (async () => {
        const lastId = await store.lastId()
        const stream = new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder()
            const sub = {
              write: (data: string) => controller.enqueue(encoder.encode(data)),
              close: () => controller.close(),
            }
            sub.write(`data: ${JSON.stringify({ type: 'connected', lastEventId: lastId })}\n\n`)
            sseSubscribers.add(sub)
            req.signal.addEventListener('abort', () => {
              sseSubscribers.delete(sub)
            })
          },
        })
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          },
        })
      })()
    }

    // ── Info endpoints ──────────────────────────────────────────

    if (path === '/board') {
      return Response.json(boardProjection.state)
    }

    if (path === '/agents') {
      const list = [...agents.entries()].map(([name, entry]) => ({
        name,
        role: entry.role,
        idle: entry.idle,
        tags: entry.tags,
      }))
      return Response.json({ agents: list })
    }

    if (path === '/') {
      const sensei = findSensei()
      return Response.json({
        name: 'jean-infra',
        agents: [...agents.entries()].map(([n, e]) => ({ name: n, role: e.role })),
        sensei: sensei ? { connected: true, idle: sensei.idle } : { connected: false },
        pendingEvents: pendingProjection.state.length,
        slack: SLACK_APP_TOKEN
          ? { configured: true, connected: slackConnected, channel: SLACK_CHANNEL }
          : { configured: false },
      })
    }

    return new Response('not found', { status: 404 })
  },

  websocket: {
    open(ws) {},

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
            if (existing && existing.deliver !== wsDeliver(ws)) {
              if (msg.sessionId && existing.sessionId && msg.sessionId === existing.sessionId) {
                // Same session reconnecting
              } else {
                // New session replacing old one
                if (ws.data.agent) ws.data.agent = undefined
                existing.close?.()
              }
              agents.delete(msg.agent)
            }

            // Only one sensei allowed
            if (role === 'sensei') {
              const existingSensei = findSensei()
              if (existingSensei) {
                wsSend(ws, { type: 'deliver', from: 'infra', text: 'ERROR: Another sensei is already connected. Only one sensei per dojo. This connection will be ignored.' })
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
            agents.set(msg.agent, {
              role,
              idle,
              sessionId,
              tags: msg.tags ?? [],
              deliver: wsDeliver(ws),
              close: () => { ws.data.agent = undefined; ws.close() },
            })
            wsSend(ws, { type: 'registered', agent: msg.agent, role })
            void record('register', agentStream(msg.agent), { agent: msg.agent, role, idle, sessionId } satisfies RegisterData)

            if (role === 'sensei') {
              setTimeout(() => {
                deliverToAgent(msg.agent, {
                  type: 'deliver',
                  from: 'infra',
                  text: 'You just connected. Check the board and events to get up to date.',
                })
              }, 500)
            } else if (idle) {
              if (pendingProjection.state.length > 0) {
                nudgeSenseiIfIdle()
              } else {
                const hasWork = boardProjection.state.tasks.some(
                  t => t.status === 'inbox' || t.status === 'active' || t.status === 'blocked',
                )
                if (hasWork) nudgeSenseiIfIdle(true)
              }
            }
            break
          }

          case 'reply': {
            const sender = agents.get(msg.from)
            const taskId = inferTaskId(msg.from)
            const stream = taskId ? taskStream(taskId) : agentStream(msg.from)
            if (sender?.role !== 'sensei') {
              void record('reply', stream, { agent: msg.from, text: msg.text } satisfies ReplyData)
            } else {
              void record('send', stream, { agent: msg.from, from: msg.from, text: msg.text, delivered: true } satisfies SendData)
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

// ── Startup ──────────────────────────────────────────────────────

void record('start', SYSTEM_STREAM, { port: PORT } satisfies StartData)
await initSlack()
