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

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { DeliverMsg, RegisteredMsg } from '../infra/protocol.ts'

const AGENT_NAME = process.env.JEAN_AGENT ?? 'unnamed'
const AGENT_ROLE = process.env.JEAN_ROLE ?? 'worker'

/** Discover infra WebSocket URL: env var > .jean/infra.port file > fallback */
function discoverInfraWsUrl(): string {
  if (process.env.JEAN_INFRA_URL) return process.env.JEAN_INFRA_URL
  let dir = process.cwd()
  while (dir !== dirname(dir)) {
    const portFile = resolve(dir, '.jean', 'infra.port')
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, 'utf8').trim()
      return `ws://127.0.0.1:${port}/ws`
    }
    dir = dirname(dir)
  }
  return 'ws://127.0.0.1:8700/ws'
}

/** Discover infra HTTP URL (for sensei instructions) */
function discoverInfraHttpUrl(): string {
  if (process.env.JEAN_INFRA_URL) {
    return process.env.JEAN_INFRA_URL.replace('ws://', 'http://').replace('/ws', '')
  }
  let dir = process.cwd()
  while (dir !== dirname(dir)) {
    const portFile = resolve(dir, '.jean', 'infra.port')
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, 'utf8').trim()
      return `http://127.0.0.1:${port}`
    }
    dir = dirname(dir)
  }
  return 'http://127.0.0.1:8700'
}

const INFRA_URL = discoverInfraWsUrl()
const INFRA_HTTP_URL = discoverInfraHttpUrl()
const SESSION_ID = crypto.randomUUID()
const SESSION_FILE = `/tmp/jean-session-${AGENT_NAME}.id`

// Read tags from .jean-agent.json if it exists in the working directory
const AGENT_TAGS: string[] = (() => {
  try {
    const file = resolve(process.cwd(), '.jean-agent.json')
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      return data.tags ?? []
    }
  } catch {
    /* no file or parse error */
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
            `You manage the board and agents via curl to ${INFRA_HTTP_URL}.`,
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
    ws = new WebSocket(INFRA_URL)

    ws.addEventListener('open', () => {
      process.stderr.write(`[jean] connected to infra as "${AGENT_NAME}" session=${SESSION_ID}\n`)
      sendToInfra({ type: 'register', agent: AGENT_NAME, role: AGENT_ROLE, sessionId: SESSION_ID, tags: AGENT_TAGS })
    })

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as DeliverMsg | RegisteredMsg

        switch (msg.type) {
          case 'registered':
            process.stderr.write(`[jean] registered as "${msg.agent}"\n`)
            // Write session ID to file so stop hook can include it
            Bun.write(SESSION_FILE, SESSION_ID).catch(() => {})
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
