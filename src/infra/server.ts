#!/usr/bin/env bun
/**
 * Jean infrastructure service.
 *
 * Bun HTTP/WebSocket server that:
 * - Accepts WebSocket connections from channel plugins (one per agent)
 * - Routes messages between connected agents
 * - Receives stop hook notifications (agent went idle)
 * - Serves board state
 *
 * No LLM — fast, deterministic plumbing.
 */

import type { ServerWebSocket } from 'bun'
import { readBoard, writeBoard, findTask, upsertTask, createTask, type Board } from './board.ts'
import type {
  InboundMsg,
  OutboundMsg,
  DeliverMsg,
  SendRequest,
} from './protocol.ts'

const PORT = Number(process.env.JEAN_PORT ?? 8700)
const BOARD_PATH = process.env.JEAN_BOARD ?? './board.json'

// ── Agent registry ─────────────────────────────────────────────────

type AgentSocket = ServerWebSocket<{ agent?: string }>

const agents = new Map<string, AgentSocket>()

function send(ws: AgentSocket, msg: OutboundMsg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}

function deliverToAgent(agentName: string, msg: DeliverMsg): boolean {
  const ws = agents.get(agentName)
  if (!ws) return false
  send(ws, msg)
  return true
}

// ── Event log (in-memory, recent only) ─────────────────────────────

type Event = {
  ts: string
  type: string
  agent?: string
  detail?: string
}

const events: Event[] = []
const MAX_EVENTS = 100

function logEvent(type: string, agent?: string, detail?: string) {
  const e: Event = { ts: new Date().toISOString(), type, agent, detail }
  events.push(e)
  if (events.length > MAX_EVENTS) events.shift()
  process.stderr.write(`[jean] ${type}${agent ? ` agent=${agent}` : ''}${detail ? ` ${detail}` : ''}\n`)
}

// ── HTTP + WebSocket server ────────────────────────────────────────

Bun.serve<{ agent?: string }>({
  port: PORT,
  hostname: '127.0.0.1',

  fetch(req, server) {
    const url = new URL(req.url)

    // WebSocket upgrade for channel plugins
    if (url.pathname === '/ws') {
      if (server.upgrade(req, { data: {} })) return
      return new Response('upgrade failed', { status: 400 })
    }

    // POST /send — push a message to an agent
    if (url.pathname === '/send' && req.method === 'POST') {
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

    // POST /agent-idle — stop hook notification
    if (url.pathname === '/agent-idle' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as { agent: string }
        const agent = body.agent ?? url.searchParams.get('name')
        if (!agent) {
          return Response.json({ error: 'missing agent name' }, { status: 400 })
        }
        logEvent('idle', agent)

        // Forward idle notification to orchestrator
        deliverToAgent('orchestrator', {
          type: 'deliver',
          from: 'infra',
          text: `Agent "${agent}" went idle (stop hook fired). Check on it.`,
        })
        return Response.json({ ok: true })
      })()
    }

    // GET /agent-idle — stop hook via GET (simpler curl usage)
    if (url.pathname === '/agent-idle' && req.method === 'GET') {
      const agent = url.searchParams.get('name')
      if (!agent) {
        return Response.json({ error: 'missing ?name=' }, { status: 400 })
      }
      logEvent('idle', agent)
      deliverToAgent('orchestrator', {
        type: 'deliver',
        from: 'infra',
        text: `Agent "${agent}" went idle (stop hook fired). Check on it.`,
      })
      return Response.json({ ok: true })
    }

    // GET /board — read the board
    if (url.pathname === '/board') {
      return (async () => {
        const board = await readBoard(BOARD_PATH)
        return Response.json(board)
      })()
    }

    // GET /agents — list connected agents
    if (url.pathname === '/agents') {
      return Response.json({
        agents: [...agents.keys()],
      })
    }

    // GET /events — recent event log
    if (url.pathname === '/events') {
      return Response.json({ events })
    }

    // GET / — health check
    if (url.pathname === '/') {
      return Response.json({
        name: 'jean-infra',
        agents: [...agents.keys()],
        taskCount: 0,
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
            agents.set(msg.agent, ws)
            send(ws, { type: 'registered', agent: msg.agent })
            logEvent('register', msg.agent)
            break
          }

          case 'reply': {
            // Agent sent a reply via its `reply` tool — route to orchestrator
            logEvent('reply', msg.from, msg.text)
            deliverToAgent('orchestrator', {
              type: 'deliver',
              from: msg.from,
              text: msg.text,
            })
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
