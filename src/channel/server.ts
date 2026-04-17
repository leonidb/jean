#!/usr/bin/env bun

/**
 * Jean channel plugin.
 *
 * MCP server with claude/channel capability. Installed per-agent.
 * Connects to the Jean infrastructure service via WebSocket and:
 *
 * - Receives messages from infrastructure → pushes to Claude via MCP notification
 * - Exposes a `reply` tool → Claude sends messages back through infrastructure
 *
 * Spawned by Claude Code as a subprocess over stdio.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { AgentRole, DeliverMsg, RegisteredMsg } from '../infra/protocol.ts'
import { findDojoFrom, readRuntimeFiles } from '../probe.ts'
import { buildInstructions, buildTools, resolveReplyTaskId } from './tools.ts'

const AGENT_NAME = process.env.JEAN_AGENT ?? 'unnamed'
const AGENT_ROLE: AgentRole = ((): AgentRole => {
  const raw = process.env.JEAN_ROLE ?? 'worker'
  if (raw === 'sensei' || raw === 'worker' || raw === 'user') return raw
  process.stderr.write(`[jean] JEAN_ROLE="${raw}" is not a known role — falling back to worker\n`)
  return 'worker'
})()

/** Locate dojo root: JEAN_DOJO env var (validated) > walk up from cwd. */
function discoverDojoRoot(): string | null {
  if (process.env.JEAN_DOJO && existsSync(resolve(process.env.JEAN_DOJO, '.jean'))) {
    return process.env.JEAN_DOJO
  }
  return findDojoFrom(process.cwd())
}

const DOJO_ROOT = discoverDojoRoot()

function discoverPort(): string {
  if (!DOJO_ROOT) return '8700'
  const { port } = readRuntimeFiles(resolve(DOJO_ROOT, '.jean'))
  return String(port ?? 8700)
}

/** Discover infra WebSocket URL: env var > port file > fallback */
function discoverInfraWsUrl(): string {
  if (process.env.JEAN_INFRA_URL) return process.env.JEAN_INFRA_URL
  return `ws://127.0.0.1:${discoverPort()}/ws`
}

/** Discover infra HTTP base URL for the `infra` tool. */
function discoverInfraHttpBase(): string {
  if (process.env.JEAN_INFRA_URL) {
    return process.env.JEAN_INFRA_URL.replace(/^ws/, 'http').replace(/\/ws$/, '')
  }
  return `http://127.0.0.1:${discoverPort()}`
}
const SESSION_ID = crypto.randomUUID()
/** Session file lives under the dojo so two dojos with same-named agents don't collide */
const SESSION_FILE = DOJO_ROOT ? resolve(DOJO_ROOT, '.jean', 'sessions', `${AGENT_NAME}.id`) : null

async function writeSessionFile() {
  if (!SESSION_FILE) return
  try {
    mkdirSync(dirname(SESSION_FILE), { recursive: true })
    await Bun.write(SESSION_FILE, SESSION_ID)
  } catch (err) {
    process.stderr.write(`[jean] failed to write session file ${SESSION_FILE}: ${err}\n`)
  }
}

// Read tags from .jean/.jean-agent.json
const AGENT_TAGS: string[] = (() => {
  const candidates = [process.env.JEAN_AGENT_DIR, resolve(process.cwd(), '.jean')].filter(Boolean) as string[]
  for (const dir of candidates) {
    try {
      const file = resolve(dir, '.jean-agent.json')
      if (existsSync(file)) {
        return JSON.parse(readFileSync(file, 'utf8')).tags ?? []
      }
    } catch {}
  }
  return []
})()

// ── MCP Server ─────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'jean', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: buildInstructions(AGENT_ROLE, AGENT_NAME),
  },
)

// ── Tools ──────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: buildTools(AGENT_ROLE),
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  if (req.params.name === 'reply') {
    const text = args.text as string
    if (!text?.trim()) {
      return {
        content: [{ type: 'text' as const, text: 'Empty message — nothing sent.' }],
        isError: true,
      }
    }
    const taskId = resolveReplyTaskId(args, lastDeliverTaskId)

    sendToInfra({ type: 'reply', from: AGENT_NAME, text: text.trim(), ...(taskId && { taskId }) })

    return {
      content: [{ type: 'text' as const, text: `Sent to orchestrator${taskId ? ` (task ${taskId})` : ''}.` }],
    }
  }

  if (req.params.name === 'send') {
    const to = (args.to as string)?.trim()
    const text = (args.text as string)?.trim()
    const taskId = (args.taskId as string | undefined)?.trim() || undefined
    if (!to || !text) {
      return {
        content: [{ type: 'text' as const, text: 'send requires non-empty `to` and `text`.' }],
        isError: true,
      }
    }
    sendToInfra({ type: 'send', from: AGENT_NAME, to, text, ...(taskId && { taskId }) })
    return {
      content: [{ type: 'text' as const, text: `Sent to ${to}${taskId ? ` (task ${taskId})` : ''}.` }],
    }
  }

  if (req.params.name === 'infra') {
    const method = typeof args.method === 'string' ? args.method.toUpperCase() : ''
    const path = typeof args.path === 'string' ? args.path : ''
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      return {
        content: [{ type: 'text' as const, text: `infra: invalid method "${args.method}"` }],
        isError: true,
      }
    }
    if (AGENT_ROLE !== 'sensei' && method !== 'GET') {
      return {
        content: [
          {
            type: 'text' as const,
            text: `infra: ${AGENT_ROLE}s are read-only — only GET is allowed. Ask the sensei via reply if you need a state change.`,
          },
        ],
        isError: true,
      }
    }
    if (!path.startsWith('/')) {
      return {
        content: [{ type: 'text' as const, text: 'infra: path must start with "/"' }],
        isError: true,
      }
    }
    const url = `${discoverInfraHttpBase()}${path}`
    try {
      const init: RequestInit = { method }
      if (args.body !== undefined && method !== 'GET') {
        init.body = JSON.stringify(args.body)
        init.headers = { 'content-type': 'application/json' }
      }
      const res = await fetch(url, init)
      const raw = await res.text()
      const MAX_BODY = 48 * 1024
      const body =
        raw.length > MAX_BODY
          ? `${raw.slice(0, MAX_BODY)}\n\n[truncated: ${raw.length - MAX_BODY} more bytes — use pagination]`
          : raw
      return {
        content: [{ type: 'text' as const, text: `${res.status} ${res.statusText}\n${body}` }],
        ...(res.status >= 400 && { isError: true }),
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `infra: request failed — ${err}` }],
        isError: true,
      }
    }
  }

  return {
    content: [{ type: 'text' as const, text: `Unknown tool: ${req.params.name}` }],
    isError: true,
  }
})

// ── Infrastructure WebSocket connection ────────────────────────────

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
/** Most recent deliver's taskId — attached to outbound replies so the server doesn't have to infer it. */
let lastDeliverTaskId: string | undefined

function deliver(from: string, text: string, meta: Record<string, string> = {}) {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        from,
        agent: AGENT_NAME,
        ts: new Date().toISOString(),
        ...meta,
      },
    },
  })
}

function sendToInfra(msg: object) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  } else {
    process.stderr.write(`[jean] not connected to infra, message dropped\n`)
  }
}

function connectToInfra() {
  try {
    const url = discoverInfraWsUrl()
    ws = new WebSocket(url)

    ws.addEventListener('open', () => {
      process.stderr.write(`[jean] connected to infra at ${url} as "${AGENT_NAME}" session=${SESSION_ID}\n`)
      sendToInfra({ type: 'register', agent: AGENT_NAME, role: AGENT_ROLE, sessionId: SESSION_ID, tags: AGENT_TAGS })
    })

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as DeliverMsg | RegisteredMsg

        switch (msg.type) {
          case 'registered':
            process.stderr.write(`[jean] registered as "${msg.agent}"\n`)
            writeSessionFile()
            break

          case 'deliver':
            if (msg.taskId) lastDeliverTaskId = msg.taskId
            deliver(msg.from, msg.text, msg.taskId ? { taskId: msg.taskId } : {})
            break
        }
      } catch {
        // Ignore malformed messages
      }
    })

    ws.addEventListener('close', () => {
      process.stderr.write(`[jean] disconnected from infra, reconnecting...\n`)
      scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      // close event will fire after this
    })
  } catch {
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectToInfra()
  }, 2000)
}

// ── Start ──────────────────────────────────────────────────────────

await mcp.connect(new StdioServerTransport())
connectToInfra()

// Detect parent death: when Claude exits, stdin closes. SDK doesn't handle this (PR #1613).
process.stdin.on('end', () => {
  process.stderr.write(`[jean] stdin closed (parent died), shutting down\n`)
  ws?.close()
  process.exit(0)
})

process.stderr.write(`[jean] channel plugin started for agent "${AGENT_NAME}"\n`)
