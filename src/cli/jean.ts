#!/usr/bin/env bun
/**
 * jean — CLI entry point.
 *
 * Commands:
 *   jean board              Show the kanban board
 *   jean peek <agent>       Connect to an agent (instructions)
 *   jean send <agent> <msg> Send a message to an agent via infra
 *   jean status             Show infrastructure status
 */

const args = process.argv.slice(2)
const command = args[0]

const INFRA_URL = process.env.JEAN_INFRA_URL ?? 'http://127.0.0.1:8700'

switch (command) {
  case 'board':
    await cmdBoard()
    break
  case 'peek':
    cmdPeek(args[1])
    break
  case 'send':
    await cmdSend(args[1], args.slice(2).join(' '))
    break
  case 'status':
    await cmdStatus()
    break
  default:
    printUsage()
}

// ── Commands ───────────────────────────────────────────────────────

async function cmdBoard() {
  try {
    const res = await fetch(`${INFRA_URL}/board`)
    const board = (await res.json()) as { tasks: Array<Record<string, string>> }

    if (board.tasks.length === 0) {
      console.log('Board is empty.')
      return
    }

    // Group by status
    const groups: Record<string, Array<Record<string, string>>> = {}
    for (const task of board.tasks) {
      const status = task.status ?? 'unknown'
      ;(groups[status] ??= []).push(task)
    }

    const statusOrder = ['inbox', 'active', 'blocked', 'review', 'done', 'cancelled']
    for (const status of statusOrder) {
      const tasks = groups[status]
      if (!tasks?.length) continue

      const label = status.toUpperCase()
      const color = statusColor(status)
      console.log(`\n${color}── ${label} ${'─'.repeat(Math.max(0, 40 - label.length))}${RESET}`)

      for (const t of tasks) {
        const agent = t.agent ? ` (${t.agent})` : ''
        const queue = t.queue ? ` [${t.queue}]` : ''
        console.log(`  ${DIM}${t.id}${RESET} ${t.title}${DIM}${agent}${queue}${RESET}`)
      }
    }
    console.log()
  } catch {
    console.error('Could not connect to Jean infrastructure. Is it running?')
    console.error(`  Expected at: ${INFRA_URL}`)
    console.error(`  Start with:  bun run src/infra/server.ts`)
    process.exit(1)
  }
}

function cmdPeek(agent?: string) {
  if (!agent) {
    console.error('Usage: jean peek <agent-name>')
    console.error('Example: jean peek scratch')
    process.exit(1)
  }

  console.log(`To connect to agent "${agent}", open its terminal or start a new session:`)
  console.log()
  console.log(`  cd /path/to/${agent}/worktree`)
  console.log(`  JEAN_AGENT=${agent} claude --dangerously-load-development-channels server:jean`)
  console.log()
  console.log('The agent will connect to Jean infrastructure automatically.')
}

async function cmdSend(agent?: string, text?: string) {
  if (!agent || !text?.trim()) {
    console.error('Usage: jean send <agent> <message>')
    console.error('Example: jean send scratch "investigate why caching is slow"')
    process.exit(1)
  }

  try {
    const res = await fetch(`${INFRA_URL}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: agent, from: 'cli', text }),
    })
    const result = (await res.json()) as { delivered: boolean }

    if (result.delivered) {
      console.log(`Message sent to "${agent}".`)
    } else {
      console.log(`Agent "${agent}" is not connected. Message dropped.`)
    }
  } catch {
    console.error('Could not connect to Jean infrastructure.')
    process.exit(1)
  }
}

async function cmdStatus() {
  try {
    const [infoRes, eventsRes] = await Promise.all([
      fetch(`${INFRA_URL}/`),
      fetch(`${INFRA_URL}/events`),
    ])
    const info = (await infoRes.json()) as { agents: string[] }
    const eventsData = (await eventsRes.json()) as {
      events: Array<{ ts: string; type: string; agent?: string; detail?: string }>
    }

    console.log(`\n${BOLD}Jean Infrastructure${RESET}`)
    console.log(`  URL: ${INFRA_URL}`)
    console.log(`  Connected agents: ${info.agents.length ? info.agents.join(', ') : '(none)'}`)

    if (eventsData.events.length) {
      console.log(`\n${BOLD}Recent Events${RESET}`)
      const recent = eventsData.events.slice(-10)
      for (const e of recent) {
        const time = e.ts.slice(11, 19)
        const agent = e.agent ? ` ${e.agent}` : ''
        const detail = e.detail ? ` — ${e.detail}` : ''
        console.log(`  ${DIM}${time}${RESET} ${e.type}${agent}${detail}`)
      }
    }
    console.log()
  } catch {
    console.error('Could not connect to Jean infrastructure.')
    process.exit(1)
  }
}

function printUsage() {
  console.log(`jean — multi-agent orchestration

Commands:
  jean board              Show the kanban board
  jean peek <agent>       How to connect to an agent
  jean send <agent> <msg> Send a message to an agent
  jean status             Infrastructure status

Environment:
  JEAN_INFRA_URL          Infrastructure URL (default: http://127.0.0.1:8700)`)
}

// ── Terminal colors ────────────────────────────────────────────────

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

function statusColor(status: string): string {
  switch (status) {
    case 'inbox':     return '\x1b[36m'  // cyan
    case 'active':    return '\x1b[33m'  // yellow
    case 'blocked':   return '\x1b[31m'  // red
    case 'review':    return '\x1b[35m'  // magenta
    case 'done':      return '\x1b[32m'  // green
    case 'cancelled': return '\x1b[2m'   // dim
    default:          return ''
  }
}
