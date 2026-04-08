#!/usr/bin/env bun
/**
 * jean — CLI entry point.
 *
 * Commands:
 *   jean board                                  Show the kanban board
 *   jean peek <agent>                           Connect to an agent
 *   jean send <agent> <msg>                     Send a message to an agent
 *   jean status                                 Infrastructure status
 *   jean permissions [agent]                    Show permission requests
 *   jean trigger add [options]                  Create a scheduled trigger
 *   jean trigger list                           List triggers
 *   jean trigger remove <id>                    Remove a trigger
 *   jean agent add <name> [options]             Create a new agent
 *   jean agent add --existing <path> [options]  Configure existing folder
 *   jean agent list                             List agents
 *   jean agent tag <name> [tags..] [--remove]   View or manage tags
 *   jean agent remove <name> [--force] [--keep] Remove an agent
 *   jean task log <id>                          Show task event history
 *   jean playbook list                          List loaded playbooks
 *   jean infra start                            Start infrastructure server
 *   jean infra stop                             Stop infrastructure server
 *   jean infra status                           Show infrastructure status
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import {
  CONFIG_SCHEMA,
  getByPath,
  type JeanConfig,
  parseConfigValue,
  readConfig,
  setByPath,
  validateConfigKey,
  writeConfig,
} from '../infra/config.ts'

const args = process.argv.slice(2)
const command = args[0]

function discoverInfraUrl(): string {
  if (process.env.JEAN_INFRA_URL) return process.env.JEAN_INFRA_URL
  // Walk up to find .jean/infra.port
  let dir = process.cwd()
  while (dir !== dirname(dir)) {
    const portFile = resolve(dir, '.jean', 'infra.port')
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, 'utf8').trim()
      return `http://127.0.0.1:${port}`
    }
    dir = dirname(dir)
  }
  return 'http://127.0.0.1:8700' // fallback
}

const INFRA_URL = discoverInfraUrl()

async function infraFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${INFRA_URL}${path}`, init)
  } catch {
    console.error('Could not connect to Jean infrastructure. Is it running?')
    console.error(`  Expected at: ${INFRA_URL}`)
    console.error(`  Start with:  jean infra start`)
    process.exit(1)
  }
}

// ── Terminal colors ────────────────────────────────────────────────
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'

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
  case 'dojo':
    await cmdDojo(args.slice(1))
    break
  case 'config':
    cmdConfig(args.slice(1))
    break
  case 'infra':
    await cmdInfra(args.slice(1))
    break
  case 'agent':
    cmdAgent(args.slice(1))
    break
  case 'permissions':
    await cmdPermissions(args[1])
    break
  case 'trigger':
    await cmdTrigger(args.slice(1))
    break
  case 'task':
    await cmdTask(args.slice(1))
    break
  case 'playbook':
    await cmdPlaybook(args.slice(1))
    break
  default:
    printUsage()
}

// ── Commands ───────────────────────────────────────────────────────

async function cmdBoard() {
  const res = await infraFetch('/board')
  const board = (await res.json()) as { tasks: Array<Record<string, string>> }

  if (board.tasks.length === 0) {
    console.log('Board is empty.')
    return
  }

  const groups: Record<string, Array<Record<string, string>>> = {}
  for (const task of board.tasks) {
    const status = task.status ?? 'unknown'
    groups[status] ??= []
    groups[status]!.push(task)
  }

  const statusOrder = ['todo', 'assigned', 'in-progress', 'waiting', 'done', 'cancelled']
  for (const status of statusOrder) {
    const tasks = groups[status]
    if (!tasks?.length) continue

    const label = status.toUpperCase()
    const color = statusColor(status)
    console.log(`\n${color}── ${label} ${'─'.repeat(Math.max(0, 40 - label.length))}${RESET}`)

    for (const t of tasks) {
      const agent = t.agent ? ` (${t.agent})` : ''
      const queue = t.queue ? ` [${t.queue}]` : ''
      const playbook = t.playbook ? ` 📋${t.playbook}` : ''
      console.log(`  ${DIM}${t.id}${RESET} ${t.title}${DIM}${agent}${queue}${playbook}${RESET}`)
    }
  }
  console.log()
}

function cmdPeek(agent?: string) {
  if (!agent) {
    console.error('Usage: jean peek <agent-name>')
    process.exit(1)
  }

  console.log(`To connect to agent "${agent}", open its terminal or start a new session:`)
  console.log()
  console.log(`  cd <agent-folder>`)
  console.log(`  claude --dangerously-load-development-channels server:jean`)
  console.log()
  console.log('The agent will connect to Jean infrastructure automatically.')
}

async function cmdSend(agent?: string, text?: string) {
  if (!agent || !text?.trim()) {
    console.error('Usage: jean send <agent> <message>')
    process.exit(1)
  }

  const res = await infraFetch('/send', {
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
}

async function cmdStatus() {
  const [infoRes, eventsRes] = await Promise.all([infraFetch('/'), infraFetch('/events')])
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
}

async function cmdPermissions(agent?: string) {
  const qs = agent ? `?agent=${encodeURIComponent(agent)}` : ''
  const res = await infraFetch(`/permissions${qs}`)
  const { permissions } = (await res.json()) as {
    permissions: Record<string, Record<string, { count: number; samples: Record<string, unknown>[] }>>
  }

  if (Object.keys(permissions).length === 0) {
    console.log('No permission requests recorded yet.')
    return
  }

  for (const [agentName, tools] of Object.entries(permissions)) {
    console.log(`\n${BOLD}${agentName}${RESET}`)
    const sorted = Object.entries(tools).sort((a, b) => b[1].count - a[1].count)
    for (const [tool, { count, samples }] of sorted) {
      const details = summarizeSamples(tool, samples)
      const detail = details ? `  ${DIM}(${details})${RESET}` : ''
      console.log(`  ${tool.padEnd(16)} ${String(count).padStart(3)}x${detail}`)
    }
  }
  console.log()
}

function summarizeSamples(tool: string, samples: Record<string, unknown>[]): string {
  if (tool === 'Bash') {
    const cmds: Record<string, number> = {}
    for (const s of samples) {
      const cmd = String(s.command ?? '')
        .split(' ')
        .slice(0, 3)
        .join(' ')
      if (cmd) cmds[cmd] = (cmds[cmd] ?? 0) + 1
    }
    return Object.entries(cmds)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cmd, n]) => `${cmd} x${n}`)
      .join(', ')
  }
  if (tool === 'Edit' || tool === 'Write') {
    const paths = new Set(samples.map((s) => String(s.file_path ?? '')).filter(Boolean))
    if (paths.size <= 3) return [...paths].join(', ')
    return `${paths.size} files`
  }
  return ''
}

// ── Trigger subcommands ───────────────────────────────────────────

async function cmdTrigger(args: string[]) {
  const sub = args[0]
  switch (sub) {
    case 'add':
      await cmdTriggerAdd(args.slice(1))
      break
    case 'list':
      await cmdTriggerList()
      break
    case 'remove':
      await cmdTriggerRemove(args[1])
      break
    case 'fire':
      await cmdTriggerFire(args[1])
      break
    default:
      console.error('Usage: jean trigger <add|list|remove|fire>')
      process.exit(1)
  }
}

async function cmdTriggerAdd(args: string[]) {
  const cron = flagValue(args, '--cron')
  const at = flagValue(args, '--at')
  const agent = flagValue(args, '--agent')
  const prompt = flagValue(args, '--prompt')
  const id = flagValue(args, '--id')

  if (!agent || !prompt) {
    console.error('Usage: jean trigger add --agent <name> --prompt "..." [--cron "..."|--at "..."] [--id <id>]')
    process.exit(1)
  }
  if (!cron && !at) {
    console.error('Must specify --cron or --at')
    process.exit(1)
  }

  const res = await infraFetch('/triggers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(id && { id }),
      ...(cron && { cron }),
      ...(at && { at }),
      agent,
      prompt,
      actor: 'cli',
    }),
  })
  if (!res.ok) {
    const err = (await res.json()) as { error: string }
    console.error(`Error: ${err.error}`)
    process.exit(1)
  }
  const trigger = (await res.json()) as { id: string; cron?: string; at?: string }
  console.log(`${GREEN}Trigger "${trigger.id}" created.${RESET}`)
  if (trigger.cron) console.log(`  Schedule: ${trigger.cron}`)
  if (trigger.at) console.log(`  Fires at: ${trigger.at}`)
  console.log(`  Agent:    ${agent}`)
}

async function cmdTriggerList() {
  const res = await infraFetch('/triggers')
  const { triggers } = (await res.json()) as {
    triggers: Array<{
      id: string
      cron?: string
      at?: string
      agent: string
      prompt: string
      status: string
      actor: string
      lastFiredAt?: string
    }>
  }

  if (triggers.length === 0) {
    console.log('No triggers configured.')
    return
  }

  console.log()
  for (const t of triggers) {
    const schedule = t.cron ? `cron: ${t.cron}` : `at: ${t.at}`
    const statusColor = t.status === 'active' ? GREEN : DIM
    const lastFired = t.lastFiredAt ? ` ${DIM}(last: ${t.lastFiredAt.slice(0, 19)})${RESET}` : ''
    console.log(`  ${BOLD}${t.id}${RESET} ${statusColor}${t.status}${RESET} ${DIM}${schedule}${RESET}${lastFired}`)
    console.log(`    → ${t.agent}: "${t.prompt}"`)
  }
  console.log()
}

async function cmdTriggerRemove(id?: string) {
  if (!id) {
    console.error('Usage: jean trigger remove <id>')
    process.exit(1)
  }

  const res = await infraFetch(`/triggers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) {
    const err = (await res.json()) as { error: string }
    console.error(`Error: ${err.error}`)
    process.exit(1)
  }
  console.log(`Trigger "${id}" removed.`)
}

async function cmdTriggerFire(id?: string) {
  if (!id) {
    console.error('Usage: jean trigger fire <id>')
    process.exit(1)
  }

  const res = await infraFetch(`/triggers/${encodeURIComponent(id)}/fire`, { method: 'POST' })
  if (!res.ok) {
    const err = (await res.json()) as { error: string }
    console.error(`Error: ${err.error}`)
    process.exit(1)
  }
  console.log(`Trigger "${id}" fired.`)
}

// ── Task subcommands ─────────────────────────────────────────────

async function cmdTask(args: string[]) {
  const sub = args[0]
  switch (sub) {
    case 'log':
      await cmdTaskLog(args[1])
      break
    default:
      console.error('Usage: jean task <log> <id>')
      process.exit(1)
  }
}

async function cmdTaskLog(id?: string) {
  if (!id) {
    console.error('Usage: jean task log <id>')
    process.exit(1)
  }

  // Pad to 3 digits if numeric
  const taskId = /^\d+$/.test(id) ? id.padStart(3, '0') : id

  const res = await infraFetch(`/history?taskId=${encodeURIComponent(taskId)}&diagnostics=true`)
  const { events } = (await res.json()) as {
    events: Array<{
      id: number
      type: string
      ts: string
      agent?: string
      data: { text?: string; from?: string; to?: string; status?: string; [k: string]: unknown }
    }>
  }

  if (events.length === 0) {
    console.log(`No events for task ${taskId}.`)
    return
  }

  const meaningful = events.filter((e) =>
    [
      'task-created',
      'task-status',
      'task-updated',
      'send',
      'reply',
      'human-interaction',
      'permission-request',
    ].includes(e.type),
  )

  console.log(`\n${BOLD}Task ${taskId}${RESET} — ${meaningful.length} events\n`)

  for (const e of meaningful) {
    const time = e.ts.slice(0, 16).replace('T', ' ')
    const color = eventColor(e.type)
    const label = e.type.padEnd(18)
    const agent = e.agent ? ` ${DIM}${e.agent}${RESET}` : ''

    let detail = ''
    if (e.type === 'task-created') {
      const actor = e.data.actor ? ` (by ${e.data.actor})` : ''
      detail = ((e.data.title as string) ?? '') + actor
    } else if (e.type === 'task-status') {
      const actor = e.data.actor ? ` by ${e.data.actor}` : ''
      detail = `${e.data.from} → ${e.data.to}${actor}`
    } else if (e.type === 'task-updated') {
      const parts: string[] = []
      if (e.data.agent) parts.push(`agent=${e.data.agent}`)
      if (e.data.description) parts.push('description updated')
      if (e.data.actor) parts.push(`by ${e.data.actor}`)
      detail = parts.join(', ')
    } else if (e.type === 'send' || e.type === 'reply' || e.type === 'human-interaction') {
      const text = e.data.text ?? ''
      const lines = text
        .split('\n')
        .filter((l: string) => l.trim())
        .slice(0, 3)
      const truncated = lines.map((l: string) => (l.length > 120 ? `${l.slice(0, 117)}...` : l))
      if (text.split('\n').filter((l: string) => l.trim()).length > 3) truncated.push('...')
      detail = truncated.join('\n')
    } else if (e.type === 'permission-request') {
      detail = `${e.data.tool ?? '?'}`
    }

    console.log(`  ${DIM}${time}${RESET} ${color}${label}${RESET}${agent}`)
    if (detail) {
      const lines = detail.split('\n').slice(0, 3)
      for (const line of lines) {
        console.log(`  ${DIM}  ${line}${RESET}`)
      }
    }
  }
  console.log()
}

function eventColor(type: string): string {
  switch (type) {
    case 'task-created':
      return '\x1b[36m' // cyan
    case 'task-status':
      return '\x1b[33m' // yellow
    case 'send':
      return '\x1b[34m' // blue
    case 'reply':
      return '\x1b[32m' // green
    case 'human-interaction':
      return '\x1b[35m' // magenta
    case 'permission-request':
      return '\x1b[31m' // red
    default:
      return ''
  }
}

// ── Config helpers ───────────────────────────────────────────────

const VALID_KEYS = Object.keys(CONFIG_SCHEMA).join(', ')

function applyConfigEntry(config: JeanConfig, key: string, raw: string): void {
  const err = validateConfigKey(key)
  if (err) {
    console.error(err)
    console.error(`Valid keys: ${VALID_KEYS}`)
    process.exit(1)
  }
  const parsed = parseConfigValue(key, raw)
  if ('error' in parsed) {
    console.error(parsed.error)
    process.exit(1)
  }
  setByPath(config as Record<string, unknown>, key, parsed.value)
}

// ── Config subcommands ───────────────────────────────────────────

function cmdConfig(args: string[]) {
  const sub = args[0]
  switch (sub) {
    case 'set':
      cmdConfigSet(args[1], args[2])
      break
    case 'get':
      cmdConfigGet(args[1])
      break
    case 'list':
      cmdConfigList()
      break
    default:
      console.error('Usage: jean config <set|get|list>')
      process.exit(1)
  }
}

function cmdConfigSet(key?: string, raw?: string) {
  if (!key || !raw) {
    console.error('Usage: jean config set <key> <value>')
    console.error(`Valid keys: ${VALID_KEYS}`)
    process.exit(1)
  }
  const dojoRoot = findDojoRoot()
  const dataDir = resolve(dojoRoot, '.jean')
  const config = readConfig(dataDir)
  applyConfigEntry(config, key, raw)
  writeConfig(dataDir, config)
  const value = getByPath(config as Record<string, unknown>, key)
  console.log(`${key} = ${JSON.stringify(value)}`)
}

function cmdConfigGet(key?: string) {
  if (!key) {
    console.error('Usage: jean config get <key>')
    process.exit(1)
  }
  const dojoRoot = findDojoRoot()
  const dataDir = resolve(dojoRoot, '.jean')
  const config = readConfig(dataDir)
  const value = getByPath(config as Record<string, unknown>, key)
  if (value === undefined) {
    console.log(`${key}: (not set)`)
  } else {
    console.log(`${key} = ${JSON.stringify(value)}`)
  }
}

function cmdConfigList() {
  const dojoRoot = findDojoRoot()
  const dataDir = resolve(dojoRoot, '.jean')
  const config = readConfig(dataDir)
  const content = JSON.stringify(config, null, 2)
  if (content === '{}') {
    console.log('No configuration set.')
    console.log(`Valid keys: ${VALID_KEYS}`)
    return
  }
  console.log(content)
}

// ── Dojo subcommands ─────────────────────────────────────────────

async function cmdDojo(args: string[]) {
  const sub = args[0]
  switch (sub) {
    case 'init':
      cmdDojoInit(args.slice(1))
      break
    default:
      console.error('Usage: jean dojo init [path] [--key value ...]')
      process.exit(1)
  }
}

function cmdDojoInit(args: string[]) {
  // First non-flag arg is the path
  const targetPath = args.find((a) => !a.startsWith('--'))
  const dojoRoot = resolve(targetPath ?? '.')

  const jeanDir = resolve(dojoRoot, '.jean')
  if (existsSync(jeanDir)) {
    console.error(`Already a Jean dojo: ${jeanDir} exists.`)
    process.exit(1)
  }

  mkdirSync(resolve(jeanDir, 'playbooks'), { recursive: true })
  mkdirSync(resolve(jeanDir, 'context'), { recursive: true })

  const config: JeanConfig = {}
  for (let i = 0; i < args.length; i++) {
    if (!args[i]?.startsWith('--')) continue
    const key = args[i]?.slice(2)
    const raw = args[i + 1]
    if (!raw || raw.startsWith('--')) {
      console.error(`Missing value for --${key}`)
      process.exit(1)
    }
    applyConfigEntry(config, key, raw)
    i++ // skip value
  }

  if (Object.keys(config).length > 0) {
    writeConfig(jeanDir, config)
  }

  console.log(`${GREEN}Dojo initialized at ${dojoRoot}${RESET}`)
  console.log()
  console.log(`  ${dojoRoot}/`)
  console.log(`    .jean/`)
  console.log(`      playbooks/      ${DIM}← flow definitions${RESET}`)
  console.log(`      context/        ${DIM}← shared project context${RESET}`)
  if (Object.keys(config).length > 0) {
    console.log(`      jean.config.json ${DIM}← configuration${RESET}`)
  }
  console.log()
  console.log(`Next steps:`)
  console.log(`  jean infra start    ${DIM}← start infrastructure${RESET}`)
  console.log(`  jean agent add <name> ${DIM}← add your first agent${RESET}`)
}

// ── Infra subcommands ────────────────────────────────────────────

async function cmdInfra(args: string[]) {
  const sub = args[0]
  switch (sub) {
    case 'start':
      await cmdInfraStart()
      break
    case 'stop':
      await cmdInfraStop()
      break
    case 'status':
      await cmdInfraStatus()
      break
    default:
      console.error('Usage: jean infra <start|stop|status>')
      process.exit(1)
  }
}

async function cmdInfraStart() {
  const dojoRoot = findDojoRoot()
  const dataDir = resolve(dojoRoot, '.jean')
  const pidFile = resolve(dataDir, 'infra.pid')

  // Check if already running
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    try {
      process.kill(pid, 0) // test if process exists
      console.error(`Infrastructure already running (pid ${pid}).`)
      console.error('Use "jean infra stop" first.')
      process.exit(1)
    } catch {
      // Stale PID file — process is gone
    }
  }

  // Find the server entrypoint
  const serverPath = resolve(dirname(new URL(import.meta.url).pathname), '../infra/server.ts')

  const child = Bun.spawn(['bun', 'run', serverPath], {
    cwd: dataDir,
    env: { ...process.env, JEAN_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'inherit'],
  })

  // Wait briefly for the port file to appear
  const portFile = resolve(dataDir, 'infra.port')
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(200)
    if (existsSync(portFile)) break
  }

  if (existsSync(portFile)) {
    const port = readFileSync(portFile, 'utf8').trim()
    console.log(`${GREEN}Infrastructure started.${RESET}`)
    console.log(`  PID:  ${child.pid}`)
    console.log(`  Port: ${port}`)
    console.log(`  Data: ${dataDir}`)
  } else {
    console.error('Infrastructure started but port file not found. Check stderr for errors.')
  }

  // Detach — don't wait for child
  child.unref()
}

async function cmdInfraStop() {
  const dojoRoot = findDojoRoot()
  const dataDir = resolve(dojoRoot, '.jean')
  const pidFile = resolve(dataDir, 'infra.pid')

  if (!existsSync(pidFile)) {
    console.log('Infrastructure is not running (no PID file).')
    return
  }

  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  try {
    process.kill(pid, 'SIGTERM')
    console.log(`Infrastructure stopped (pid ${pid}).`)
  } catch {
    console.log(`Process ${pid} not found. Cleaning up stale PID file.`)
  }

  // Clean up in case signal handler didn't
  try {
    unlinkSync(pidFile)
  } catch {}
  try {
    unlinkSync(resolve(dataDir, 'infra.port'))
  } catch {}
}

async function cmdInfraStatus() {
  const dojoRoot = findDojoRoot()
  const dataDir = resolve(dojoRoot, '.jean')
  const pidFile = resolve(dataDir, 'infra.pid')
  const portFile = resolve(dataDir, 'infra.port')

  if (!existsSync(pidFile)) {
    console.log('Infrastructure is not running.')
    return
  }

  const pid = Number(readFileSync(pidFile, 'utf8').trim())
  let running = false
  try {
    process.kill(pid, 0)
    running = true
  } catch {}

  if (!running) {
    console.log(`Infrastructure is not running (stale PID ${pid}).`)
    return
  }

  const port = existsSync(portFile) ? readFileSync(portFile, 'utf8').trim() : '?'
  console.log(`${GREEN}Infrastructure is running.${RESET}`)
  console.log(`  PID:  ${pid}`)
  console.log(`  Port: ${port}`)
  console.log(`  Data: ${dataDir}`)
}

// ── Playbook subcommands ─────────────────────────────────────────

async function cmdPlaybook(args: string[]) {
  const sub = args[0]
  switch (sub) {
    case 'list':
      await cmdPlaybookList()
      break
    default:
      console.error('Usage: jean playbook <list>')
      process.exit(1)
  }
}

async function cmdPlaybookList() {
  const res = await infraFetch('/playbooks')
  const { playbooks } = (await res.json()) as {
    playbooks: Array<{
      id: string
      name: string
      description: string
      hash: string
      updatedAt: string
    }>
  }

  if (playbooks.length === 0) {
    console.log('No playbooks loaded.')
    return
  }

  console.log(`\n${BOLD}Playbooks${RESET}\n`)
  for (const p of playbooks) {
    const updated = p.updatedAt.slice(0, 16).replace('T', ' ')
    console.log(`  ${BOLD}${p.id}${RESET} ${DIM}(${p.hash})${RESET}`)
    if (p.description) console.log(`    ${p.description}`)
    console.log(`    ${DIM}updated: ${updated}${RESET}`)
  }
  console.log()
}

// ── Agent subcommands ─────────────────────────────────────────────

function cmdAgent(args: string[]) {
  const sub = args[0]
  switch (sub) {
    case 'add':
      cmdAgentAdd(args.slice(1))
      break
    case 'list':
      cmdAgentList()
      break
    case 'tag':
      cmdAgentTag(args.slice(1))
      break
    case 'remove':
      cmdAgentRemove(args.slice(1))
      break
    case 'start':
      cmdAgentStart(args[1])
      break
    default:
      console.error('Usage: jean agent <add|list|tag|remove|start>')
      process.exit(1)
  }
}

// ── Agent helpers ─────────────────────────────────────────────────

import type { AgentRole } from '../infra/protocol.ts'

type AgentMeta = { name: string; tags: string[]; role: AgentRole }
type AgentInfo = AgentMeta & { path: string; branch?: string }

function findDojoRoot(): string {
  let dir = process.cwd()
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, '.jean'))) return dir
    dir = dirname(dir)
  }
  console.error('Not a Jean dojo. No .jean/ directory found.')
  console.error('Run this command from within a dojo tree.')
  process.exit(1)
}

function findBareRepo(dojoRoot: string): string | null {
  const bareDir = resolve(dojoRoot, '.bare')
  return existsSync(bareDir) ? bareDir : null
}

function getWorktreeBranches(bareDir: string): Map<string, string> {
  const result = Bun.spawnSync(['git', '-C', bareDir, 'worktree', 'list', '--porcelain'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) return new Map()

  const branches = new Map<string, string>()
  let currentPath = ''

  for (const line of result.stdout.toString().split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length)
    } else if (line.startsWith('branch refs/heads/')) {
      branches.set(currentPath, line.slice('branch refs/heads/'.length))
    }
  }
  return branches
}

function readAgentMeta(agentDir: string): AgentMeta | null {
  try {
    const data = JSON.parse(readFileSync(resolve(agentDir, '.jean-agent.json'), 'utf8'))
    return {
      name: data.name ?? basename(agentDir),
      tags: data.tags ?? [],
      role: data.role ?? 'worker',
    }
  } catch {
    return null
  }
}

function writeAgentMeta(agentDir: string, meta: AgentMeta): void {
  writeFileSync(resolve(agentDir, '.jean-agent.json'), `${JSON.stringify(meta, null, 2)}\n`)
}

function discoverAgents(dojoRoot: string): AgentInfo[] {
  const bareDir = findBareRepo(dojoRoot)
  const branches = bareDir ? getWorktreeBranches(bareDir) : new Map<string, string>()
  const agents: AgentInfo[] = []

  try {
    for (const entry of readdirSync(dojoRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dirPath = resolve(dojoRoot, entry.name)
      const meta = readAgentMeta(dirPath)
      if (!meta) continue
      agents.push({ ...meta, path: dirPath, branch: branches.get(dirPath) })
    }
  } catch {
    /* can't read dojo root */
  }

  return agents
}

function findAgent(name: string, dojoRoot: string): AgentInfo | undefined {
  return discoverAgents(dojoRoot).find((a) => a.name === name)
}

function channelDir(): string {
  return resolve(dirname(Bun.main), '..', 'channel')
}

function isWorktreeDirty(path: string): boolean {
  const result = Bun.spawnSync(['git', '-C', path, 'status', '--porcelain'], { stdout: 'pipe', stderr: 'pipe' })
  return result.stdout.toString().trim().length > 0
}

// ── Agent Add ─────────────────────────────────────────────────────

function cmdAgentAdd(args: string[]) {
  const existingMode = args.includes('--existing')

  const VALID_ROLES = new Set(['worker', 'sensei', 'user'])
  const roleStr = flagValue(args, '--role') ?? 'worker'
  if (!VALID_ROLES.has(roleStr)) {
    console.error(`Invalid role "${roleStr}". Must be: worker, sensei, or user.`)
    process.exit(1)
  }
  const role = roleStr as AgentRole
  const useWorktree = args.includes('--worktree') ? true : args.includes('--no-worktree') ? false : role === 'worker' // default: workers get worktrees
  const tagsIdx = args.indexOf('--tags')
  const tags: string[] = tagsIdx >= 0 ? args.slice(tagsIdx + 1).filter((a) => !a.startsWith('--')) : []

  if (existingMode) {
    const positional = args.filter((a) => !a.startsWith('--') && !tags.includes(a) && a !== flagValue(args, '--role'))
    const targetPath = positional[0]
    if (!targetPath) {
      console.error('Usage: jean agent add --existing <path> [--role <role>] [--tags ...]')
      process.exit(1)
    }
    addExisting(resolve(targetPath), role, tags)
  } else {
    const name = args[0]
    if (!name || name.startsWith('-')) {
      console.error('Usage: jean agent add <name> [--role <role>] [--tags ...] [--worktree|--no-worktree]')
      process.exit(1)
    }
    addNew(name, role, tags, useWorktree)
  }
}

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined
}

function addNew(name: string, role: AgentRole, tags: string[], useWorktree: boolean) {
  const dojoRoot = findDojoRoot()
  const agentDir = resolve(dojoRoot, name)

  // Check name uniqueness
  const existing = findAgent(name, dojoRoot)
  if (existing) {
    console.error(`Agent "${name}" already exists at ${existing.path}`)
    process.exit(1)
  }
  if (existsSync(agentDir)) {
    console.error(`Directory "${name}" already exists. Use --existing to configure it.`)
    process.exit(1)
  }

  if (useWorktree) {
    const bareDir = findBareRepo(dojoRoot)
    if (!bareDir) {
      console.error('No .bare/ directory found. Cannot create worktree.')
      console.error('Use --no-worktree to create a plain directory instead.')
      process.exit(1)
    }

    const branch = `jean/${name}`
    console.log(`Creating worktree on branch "${branch}"...`)

    let wt = Bun.spawnSync(['git', '-C', bareDir, 'worktree', 'add', `../${name}`, '-b', branch], {
      stderr: 'pipe',
      stdout: 'pipe',
    })
    if (wt.exitCode !== 0) {
      wt = Bun.spawnSync(['git', '-C', bareDir, 'worktree', 'add', `../${name}`, branch], {
        stderr: 'pipe',
        stdout: 'pipe',
      })
      if (wt.exitCode !== 0) {
        console.error(`Failed to create worktree: ${wt.stderr.toString().trim()}`)
        process.exit(1)
      }
    }

    // Write config — rollback worktree on failure
    try {
      writeJeanConfig(agentDir, name, role, tags)
    } catch (err) {
      console.error(`Failed to write agent config: ${err}`)
      console.error('Rolling back worktree...')
      Bun.spawnSync(['git', '-C', bareDir, 'worktree', 'remove', `../${name}`, '--force'], {
        stderr: 'pipe',
        stdout: 'pipe',
      })
      process.exit(1)
    }

    console.log(`\n${GREEN}Agent "${name}" created.${RESET}`)
    console.log(`  Worktree: ./${name}/`)
    console.log(`  Branch:   ${branch}`)
  } else {
    // Plain directory
    mkdirSync(agentDir)
    writeJeanConfig(agentDir, name, role, tags)

    console.log(`\n${GREEN}Agent "${name}" created.${RESET}`)
    console.log(`  Directory: ./${name}/`)
  }

  if (role !== 'worker') console.log(`  Role:     ${role}`)
  if (tags.length) console.log(`  Tags:     ${tags.join(', ')}`)
  console.log(`\nTo start:`)
  console.log(`  cd ${name} && claude --dangerously-load-development-channels server:jean`)
}

function addExisting(targetPath: string, role: AgentRole, tags: string[]) {
  if (!existsSync(targetPath)) {
    console.error(`Directory not found: ${targetPath}`)
    process.exit(1)
  }

  const dojoRoot = findDojoRoot()
  const name = basename(targetPath)

  const existing = findAgent(name, dojoRoot)
  if (existing) {
    console.error(`Agent "${name}" already exists at ${existing.path}`)
    process.exit(1)
  }

  if (existsSync(resolve(targetPath, '.jean-agent.json'))) {
    console.error(`"${name}" is already a Jean agent.`)
    process.exit(1)
  }

  writeJeanConfig(targetPath, name, role, tags)

  console.log(`\n${GREEN}Agent "${name}" configured.${RESET}`)
  console.log(`  Path: ${targetPath}`)
  if (role !== 'worker') console.log(`  Role: ${role}`)
  if (tags.length) console.log(`  Tags: ${tags.join(', ')}`)
  console.log(`\nTo start:`)
  console.log(`  cd ${targetPath} && claude --dangerously-load-development-channels server:jean`)
}

function defaultPermissions(role: AgentRole): string[] {
  const base = ['mcp__jean__reply']
  if (role === 'sensei') {
    return [
      ...base,
      'Bash(curl:*)',
      'Bash(git log:*)',
      'Bash(git diff:*)',
      'Bash(git show:*)',
      'Bash(git status:*)',
      'Bash(gh api:*)',
      'Bash(gh pr view:*)',
      'Bash(gh pr diff:*)',
      'Bash(gh pr list:*)',
      'Bash(gh issue list:*)',
      'Bash(gh issue view:*)',
    ]
  }
  // worker and user
  return [
    ...base,
    'Read',
    'Edit',
    'Write',
    'Bash(git log:*)',
    'Bash(git diff:*)',
    'Bash(git show:*)',
    'Bash(git status:*)',
    'Bash(git branch:*)',
  ]
}

function writeJeanConfig(agentDir: string, name: string, role: AgentRole, tags: string[]) {
  writeAgentMeta(agentDir, { name, tags, role })

  const mcpPath = resolve(agentDir, '.mcp.json')
  if (!existsSync(mcpPath)) {
    writeFileSync(
      mcpPath,
      `${JSON.stringify(
        {
          mcpServers: {
            jean: {
              command: 'bun',
              args: ['run', '--cwd', channelDir(), '--shell=bun', '--silent', 'start'],
              env: {
                JEAN_AGENT: name,
                JEAN_ROLE: role,
                JEAN_INFRA_URL: `${INFRA_URL.replace('http://', 'ws://')}/ws`,
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    )
  } else {
    console.log(`  ${DIM}Skipping .mcp.json (already exists)${RESET}`)
  }

  const settingsDir = resolve(agentDir, '.claude')
  const settingsPath = resolve(settingsDir, 'settings.local.json')
  if (!existsSync(settingsPath)) {
    mkdirSync(settingsDir, { recursive: true })
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          permissions: {
            allow: defaultPermissions(role),
          },
          enabledMcpjsonServers: ['jean'],
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `curl -s -X POST http://127.0.0.1:8700/agent-idle -H 'content-type: application/json' -d "{\\"agent\\":\\"${name}\\",\\"sessionId\\":\\"$(cat /tmp/jean-session-${name}.id 2>/dev/null)\\"}"`,
                  },
                ],
              },
            ],
            PermissionRequest: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `bun -e 'const d=JSON.parse(await Bun.stdin.text());fetch("http://127.0.0.1:8700/permissions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agent:"${name}",tool:d.tool_name,input:d.tool_input})})'`,
                    async: true,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    )
  } else {
    console.log(`  ${DIM}Skipping .claude/settings.local.json (already exists)${RESET}`)
  }
}

// ── Agent List ────────────────────────────────────────────────────

function cmdAgentList() {
  const dojoRoot = findDojoRoot()
  const agents = discoverAgents(dojoRoot)

  if (!agents.length) {
    console.log('No agents found. Create one with: jean agent add <name>')
    return
  }

  console.log()
  for (const a of agents) {
    const tags = a.tags.length ? ` ${DIM}[${a.tags.join(', ')}]${RESET}` : ''
    const branch = a.branch ? ` ${DIM}(${a.branch})${RESET}` : ''
    const role = a.role !== 'worker' ? ` ${DIM}${a.role}${RESET}` : ''
    console.log(`  ${BOLD}${a.name}${RESET}${role}${tags}${branch}`)
  }
  console.log()
}

// ── Agent Tag ─────────────────────────────────────────────────────

function cmdAgentTag(args: string[]) {
  const name = args[0]
  if (!name || name.startsWith('-')) {
    console.error('Usage: jean agent tag <name> [tags...] [--remove]')
    process.exit(1)
  }

  const dojoRoot = findDojoRoot()
  const agent = findAgent(name, dojoRoot)
  if (!agent) {
    console.error(`Agent "${name}" not found.`)
    process.exit(1)
    return
  }

  const removeMode = args.includes('--remove')
  const tags = args.slice(1).filter((a) => a !== '--remove')

  if (!tags.length) {
    console.log(`Tags for "${name}": ${agent.tags.join(', ') || '(none)'}`)
    return
  }

  const meta = readAgentMeta(agent.path)!
  if (removeMode) {
    meta.tags = meta.tags.filter((t) => !tags.includes(t))
  } else {
    const existing = new Set(meta.tags)
    for (const t of tags) existing.add(t)
    meta.tags = [...existing]
  }

  writeAgentMeta(agent.path, meta)
  console.log(`Tags for "${name}": ${meta.tags.join(', ') || '(none)'}`)
}

// ── Agent Remove ──────────────────────────────────────────────────

function cmdAgentRemove(args: string[]) {
  const name = args.find((a) => !a.startsWith('-'))
  const force = args.includes('--force')
  const keep = args.includes('--keep')

  if (!name) {
    console.error('Usage: jean agent remove <name> [--force] [--keep]')
    process.exit(1)
    return
  }

  const dojoRoot = findDojoRoot()
  const agent = findAgent(name, dojoRoot)
  if (!agent) {
    console.error(`Agent "${name}" not found.`)
    process.exit(1)
    return
  }

  if (keep) {
    rmSync(resolve(agent.path, '.jean-agent.json'), { force: true })
    console.log(`Removed Jean config from "${name}". Directory kept at ${agent.path}`)
    return
  }

  if (agent.branch !== undefined) {
    // Worktree agent: check dirty state, remove via git
    if (!force && isWorktreeDirty(agent.path)) {
      console.error(`Agent "${name}" has uncommitted changes. Use --force to remove anyway.`)
      process.exit(1)
    }

    const bareDir = findBareRepo(dojoRoot)!
    const result = Bun.spawnSync(
      ['git', '-C', bareDir, 'worktree', 'remove', agent.path, ...(force ? ['--force'] : [])],
      { stderr: 'pipe', stdout: 'pipe' },
    )
    if (result.exitCode !== 0) {
      console.error(`Failed to remove worktree: ${result.stderr.toString().trim()}`)
      process.exit(1)
    }

    console.log(`${GREEN}Agent "${name}" removed.${RESET}`)
    if (agent.branch) {
      console.log(`  Branch "${agent.branch}" still exists. Delete with: git -C .bare branch -d ${agent.branch}`)
    }
  } else {
    // Plain directory agent: remove directory
    if (!force) {
      console.error(`Agent "${name}" is a plain directory. Use --force to delete it.`)
      process.exit(1)
    }
    rmSync(agent.path, { recursive: true })
    console.log(`${GREEN}Agent "${name}" removed.${RESET}`)
  }
}

// ── Agent Start ───────────────────────────────────────────────────

function cmdAgentStart(name?: string) {
  if (!name) {
    console.error('Usage: jean agent start <name>')
    process.exit(1)
  }

  const dojoRoot = findDojoRoot()
  const agent = findAgent(name, dojoRoot)
  if (!agent) {
    console.error(`Agent "${name}" not found.`)
    process.exit(1)
    return
  }

  console.log(`Starting agent "${name}" in ${agent.path}...`)
  const result = Bun.spawnSync(['claude', '--dangerously-load-development-channels', 'server:jean'], {
    cwd: agent.path,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  process.exit(result.exitCode ?? 0)
}

// ── Usage ─────────────────────────────────────────────────────────

function printUsage() {
  console.log(`jean — multi-agent orchestration (v0.1.0)

Commands:
  jean dojo init [path] [--key value ...]      Initialize a new dojo
  jean config set <key> <value>               Set a config value
  jean config get <key>                       Get a config value
  jean config list                            Show all config
  jean infra start                            Start infrastructure server
  jean infra stop                             Stop infrastructure server
  jean infra status                           Show infrastructure status

  jean board                                  Show the kanban board
  jean send <agent> <msg>                     Send a message to an agent
  jean status                                 Infrastructure status + recent events
  jean permissions [agent]                    Show permission requests by agent

  jean task log <id>                          Show task event history
  jean playbook list                          List loaded playbooks

  jean trigger add [options]                  Create a scheduled trigger
    --cron "expr"     Cron schedule (recurring)
    --at "datetime"   ISO datetime (one-off)
    --agent <name>    Target agent
    --prompt "text"   Message to deliver
    --id <id>         Optional trigger ID
  jean trigger list                           List triggers
  jean trigger fire <id>                      Fire a trigger now
  jean trigger remove <id>                    Remove a trigger

  jean agent add <name> [options]             Create a new agent
    --role <role>     Agent role (default: worker)
    --tags <tags...>  Tags for routing
    --worktree        Force worktree creation (default for workers)
    --no-worktree     Create plain directory (default for non-workers)
  jean agent add --existing <path> [options]  Configure existing folder
  jean agent list                             List agents
  jean agent tag <name> [tags...] [--remove]  View or manage tags
  jean agent remove <name> [--force] [--keep] Remove an agent
  jean agent start <name>                     Start an agent

  jean peek <agent>                           How to connect to an agent

Environment:
  JEAN_INFRA_URL          Infrastructure URL (overrides port discovery)
  JEAN_PORT               Fixed port for infra server (default: auto-select from 8700)
  JEAN_DATA_DIR           Data directory (default: .jean/ in dojo root)`)
}

function statusColor(status: string): string {
  switch (status) {
    case 'todo':
      return '\x1b[36m' // cyan
    case 'assigned':
      return '\x1b[34m' // blue
    case 'in-progress':
      return '\x1b[33m' // yellow
    case 'waiting':
      return '\x1b[35m' // magenta
    case 'done':
      return '\x1b[32m' // green
    case 'cancelled':
      return '\x1b[2m' // dim
    default:
      return ''
  }
}
