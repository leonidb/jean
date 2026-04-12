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
import type { DeliverMsg, RegisteredMsg } from '../infra/protocol.ts'
import { findDojoFrom, readRuntimeFiles } from '../probe.ts'

const AGENT_NAME = process.env.JEAN_AGENT ?? 'unnamed'
const AGENT_ROLE = process.env.JEAN_ROLE ?? 'worker'

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
    instructions:
      AGENT_ROLE === 'sensei'
        ? [
            `You are the sensei (orchestrator) in the Jean system, agent "${AGENT_NAME}".`,
            `When you receive any message from Jean, FIRST load the jean-sensei skill, then follow its instructions.`,
            `You manage the board and agents via curl to the infra URL. Discover it once per session: INFRA=$(jean infra url)`,
            `The reply tool is ONLY for reporting to the human. Use curl for all system interactions.`,
          ].join('\n')
        : [
            `You are connected to the Jean orchestration system as agent "${AGENT_NAME}".`,
            `Messages from the orchestrator arrive as <channel source="jean" ...> tags.`,
            `Use the reply tool to send messages back to the orchestrator.`,
            `When you finish a task or get stuck, just stop — the orchestrator will check on you.`,
          ].join('\n'),
  },
)

// ── Tools ──────────────────────────────────────────────────────────

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Send a message to the orchestrator through the Jean channel. ' +
        'Use this to report progress, ask questions, or share results.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: {
            type: 'string',
            description: 'The message to send to the orchestrator',
          },
        },
        required: ['text'],
      },
    },
  ],
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

    sendToInfra({ type: 'reply', from: AGENT_NAME, text: text.trim() })

    return {
      content: [{ type: 'text' as const, text: `Sent to orchestrator.` }],
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
