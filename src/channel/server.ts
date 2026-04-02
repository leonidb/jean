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

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { DeliverMsg, RegisteredMsg } from '../infra/protocol.ts'

const AGENT_NAME = process.env.JEAN_AGENT ?? 'unnamed'
const AGENT_ROLE = process.env.JEAN_ROLE ?? 'worker'
const INFRA_URL = process.env.JEAN_INFRA_URL ?? 'ws://127.0.0.1:8700/ws'

// ── MCP Server ─────────────────────────────────────────────────────

const mcp = new Server(
  { name: 'jean', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
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

mcp.setRequestHandler(CallToolRequestSchema, async req => {
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
      process.stderr.write(`[jean] connected to infra as "${AGENT_NAME}"\n`)
      sendToInfra({ type: 'register', agent: AGENT_NAME, role: AGENT_ROLE })
    })

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as DeliverMsg | RegisteredMsg

        switch (msg.type) {
          case 'registered':
            process.stderr.write(`[jean] registered as "${msg.agent}"\n`)
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

process.stderr.write(`[jean] channel plugin started for agent "${AGENT_NAME}"\n`)
