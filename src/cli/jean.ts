#!/usr/bin/env bun
/**
 * jean — CLI entry point.
 *
 * Commands:
 *   jean board                                  Show the kanban board
 *   jean peek <dojo-path>                       Read another dojo's state from disk
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
 *   jean task undo <id> [--actor <name>]        Revert the most recent status change
 *   jean playbook list                          List loaded playbooks
 *   jean infra start                            Start infrastructure server
 *   jean infra stop                             Stop infrastructure server
 *   jean infra status                           Show infrastructure status
 *   jean infra url                              Print infra HTTP URL (http://127.0.0.1:PORT)
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, relative, resolve, sep } from 'node:path'
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
import { identityFromConfig, loadPeers, type Peer, savePeers } from '../infra/peers.ts'
import {
  allocatePort,
  pruneStale,
  readRegistry,
  registryPath,
  removeDojo,
  upsertDojo,
  writeRegistry,
} from '../infra/registry.ts'
import {
  findDojoRootFrom,
  INFRA_IDENTITY,
  isLocalInfraAlive,
  isProcessAlive,
  probeInfra,
  readRuntimeFiles,
} from '../probe.ts'
import { type LayoutSpec, pickTerminalOpener } from './terminal-layout.ts'

const args = process.argv.slice(2)
const command = args[0]

/**
 * Resolve the infra URL for the current command. No fallbacks — the dojo and
 * its port must both be unambiguous. Two specific failure modes that used to
 * succeed silently with wrong data:
 *   - cwd outside any dojo  → no idea which infra is meant
 *   - cwd in a dojo, infra stopped  → falling back to a default port silently
 *     dispatched commands to whatever dojo happened to be running there
 *     (observed: `jean board` run inside one dojo returned another dojo's board).
 * Both now fail loudly.
 */
function discoverInfraUrl(): string {
  const root = findDojoRootFrom(process.cwd())
  if (!root) {
    console.error('Not inside a Jean dojo. cd into one first.')
    process.exit(1)
  }
  const { port } = readRuntimeFiles(resolve(root, '.jean'))
  if (port === null) {
    console.error(`Infra is not running for this dojo (${basename(root)}).`)
    console.error('Start it with: jean infra start')
    process.exit(1)
  }
  return `http://127.0.0.1:${port}`
}

async function infraFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = discoverInfraUrl()
  try {
    return await fetch(`${url}${path}`, init)
  } catch {
    console.error('Could not connect to Jean infrastructure. Is it running?')
    console.error(`  Expected at: ${url}`)
    console.error(`  Start with:  jean infra start`)
    process.exit(1)
  }
}

// ── Terminal colors ────────────────────────────────────────────────
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const GREEN = '\x1b[32m'

// Dispatch is wrapped so all module-level declarations finish evaluating before
// any command handler runs — otherwise a handler reached via top-level await can
// reference a `const` declared further down that's still in its temporal dead zone.
async function main() {
  switch (command) {
    case 'board':
      await cmdBoard()
      break
    case 'peek':
      await cmdPeek(args.slice(1))
      break
    case 'peer':
      cmdPeer(args.slice(1))
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
    case 'context':
      await cmdContext(args.slice(1))
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
    case 'satori':
      cmdSatori()
      break
    case 'librarian':
      cmdLibrarian(args.slice(1))
      break
    case 'setup':
      cmdSetup()
      break
    default:
      printUsage()
  }
}

// ── Setup ─────────────────────────────────────────────────────────
//
// One-time, machine-level: register the Jean channel as a user-scope MCP server
// in ~/.claude.json. Channels are only resolvable by --dangerously-load-
// development-channels from auto-discovered config (user/project), not from
// --mcp-config — so this single global registration lets every dojo's agents
// load the channel with no per-worktree .mcp.json. The server self-identifies
// per session from the worktree's .jean-agent.json (no baked env), so one
// registration serves all agents in all dojos.

/** True if the Jean channel is registered as a user-scope MCP server in
 *  ~/.claude.json (i.e. `jean setup` has been run on this machine). Agents
 *  can only load `server:jean` when this is present. */
function isChannelRegistered(): boolean {
  try {
    const cfg = JSON.parse(readFileSync(resolve(homedir(), '.claude.json'), 'utf8'))
    return Boolean(cfg?.mcpServers?.jean)
  } catch {
    return false
  }
}

function cmdSetup() {
  const server = resolve(channelDir(), 'server.ts')
  console.log(`Registering the Jean channel as a user-scope MCP server (~/.claude.json)...`)
  // Idempotent: drop any prior registration first (ignore "not found").
  Bun.spawnSync(['claude', 'mcp', 'remove', 'jean', '--scope', 'user'], { stdout: 'ignore', stderr: 'ignore' })
  const r = Bun.spawnSync(['claude', 'mcp', 'add', 'jean', '--scope', 'user', '--', 'bun', server], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (r.exitCode !== 0) {
    console.error('Failed to register the channel server (claude mcp add).')
    process.exit(1)
  }
  console.log(`\n${GREEN}Jean channel registered (user scope).${RESET}`)
  console.log(`  server: bun ${server}`)
  console.log(
    `  ${DIM}'jean agent start' loads it with --dangerously-load-development-channels server:jean and sets JEAN_AGENT;`,
  )
  console.log(
    `  only launched agents (JEAN_AGENT set) register — role/tags come from the worktree's .jean-agent.json.${RESET}`,
  )
}

// ── Librarian ─────────────────────────────────────────────────────
//
// The librarian is the headless Claude that consolidates the wiki. It runs
// on a `consolidate-wiki` trigger; not a persistent agent, not user-addable
// via `jean agent add`. Setup is one-time per dojo: ships the consolidate-
// wiki skill and writes a settings.local.json with librarian permissions.
// No .mcp.json — the librarian uses native Read/Edit/Write + Bash(curl).

function cmdLibrarian(args: string[]) {
  const sub = args[0]
  switch (sub) {
    case 'setup':
      cmdLibrarianSetup()
      break
    default:
      console.error('Usage: jean librarian setup')
      process.exit(1)
  }
}

function cmdLibrarianSetup() {
  const dojoRoot = findDojoRoot()
  const jeanDir = resolve(dojoRoot, '.jean')
  const roleDir = resolve(jeanDir, 'roles', 'librarian')

  // Create raw_context/ if missing — librarian reads from here, never writes.
  // Empty dir is fine; users drop source material in as they accumulate it.
  const rawContextDir = resolve(jeanDir, 'raw_context')
  if (!existsSync(rawContextDir)) {
    mkdirSync(rawContextDir, { recursive: true })
    console.log(
      `  ${GREEN}created${RESET} ${relative(dojoRoot, rawContextDir)}/  (drop human-curated source material here)`,
    )
  }

  shipSkill(roleDir, 'consolidate-wiki')
  shipSkill(roleDir, 'consolidate-wiki-draft')
  shipSkill(roleDir, 'consolidate-wiki-review')

  // No Stop/PermissionRequest hooks — one-shot process, nothing to phone home about.
  const settingsDir = resolve(roleDir, '.claude')
  const settingsPath = resolve(settingsDir, 'settings.local.json')
  if (!existsSync(settingsPath)) {
    mkdirSync(settingsDir, { recursive: true })
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ permissions: defaultPermissions('librarian', dojoRoot) }, null, 2)}\n`,
    )
    console.log(`  ${GREEN}wrote${RESET} ${relative(dojoRoot, settingsPath)}`)
  } else {
    console.log(`  ${DIM}skip${RESET}  ${relative(dojoRoot, settingsPath)} (already exists)`)
  }

  console.log(`\n${GREEN}Librarian setup complete in ${dojoRoot}/.jean/roles/librarian/${RESET}`)
  console.log()
  console.log(`Next: create the consolidate-wiki trigger`)
  console.log(`  jean trigger add --kind headless --agent librarian \\`)
  console.log(`    --cron "0 3 * * *" --id consolidate-wiki \\`)
  console.log(
    `    --prompt "Consolidate the wiki. Read .consolidator/cursor.json, fetch new memory events, distill into .jean/context/, atomically swap, advance cursor."`,
  )
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
    // biome-ignore lint/style/noNonNullAssertion: initialized by ??= above
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

async function cmdPeek(args: string[]) {
  const { formatPeekJson, formatPeekPretty, peekDojo, readCursor, writeCursor } = await import('./peek.ts')
  const pathArg = args.find((a) => !a.startsWith('--'))
  if (!pathArg) {
    console.error('Usage: jean peek <dojo-path> [--since-last | --since <id>] [--last <N>] [--json]')
    process.exit(1)
  }
  const sinceLast = args.includes('--since-last')
  const asJson = args.includes('--json')
  const sinceIdx = args.indexOf('--since')
  const lastIdx = args.indexOf('--last')
  const explicitSince = sinceIdx >= 0 ? Number(args[sinceIdx + 1]) : undefined
  const lastN = lastIdx >= 0 ? Number(args[lastIdx + 1]) : undefined

  if (sinceLast && explicitSince !== undefined) {
    console.error('Cannot combine --since-last with --since <id>. Pick one.')
    process.exit(1)
  }

  // --since-last needs a caller dojo to store the cursor in.
  const callerDojo = findDojoRootFrom(process.cwd())
  if (sinceLast && !callerDojo) {
    console.error('--since-last requires running from inside a dojo (cursor is stored there).')
    console.error('Either cd into a dojo, or use --since <id> with an explicit event id.')
    process.exit(1)
  }

  const targetPath = resolve(pathArg)
  let cursorSince: number | undefined
  if (sinceLast && callerDojo) {
    cursorSince = readCursor(callerDojo, realpathSync(targetPath)) ?? 0
  }

  const result = await peekDojo(targetPath, {
    sinceId: cursorSince ?? explicitSince,
    lastN,
  })

  if (sinceLast && callerDojo) {
    writeCursor(callerDojo, result.target.path, result.cursor.lastEventId)
  }

  console.log(asJson ? formatPeekJson(result) : formatPeekPretty(result))
}

// ── Peers ────────────────────────────────────────────────────────

function cmdPeer(args: string[]) {
  const sub = args[0]
  switch (sub) {
    case 'add':
      cmdPeerAdd(args.slice(1))
      return
    case 'list':
      cmdPeerList()
      return
    case 'remove':
      cmdPeerRemove(args[1])
      return
    case 'link':
      cmdPeerLink(args[1])
      return
    default:
      console.error('Usage: jean peer <add|list|remove|link> ...')
      console.error('  jean peer add <identity> --origin <path> --description "..."')
      console.error('  jean peer list')
      console.error('  jean peer remove <identity>')
      console.error('  jean peer link <other-dojo-path>')
      process.exit(1)
  }
}

function parseFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

function newPeerEntry(originPath: string, description: string): Peer {
  return {
    origin: { type: 'local-path', path: originPath },
    description,
    addedAt: new Date().toISOString(),
  }
}

function cmdPeerAdd(args: string[]) {
  const identity = args.find((a) => !a.startsWith('--'))
  const origin = parseFlag(args, 'origin')
  const description = parseFlag(args, 'description')

  if (!identity || !origin || !description) {
    console.error('Usage: jean peer add <identity> --origin <path> --description "<who this peer is>"')
    console.error('All three are required. Description cannot be empty.')
    process.exit(1)
  }
  if (description.trim().length === 0) {
    console.error("Description must be non-empty — it's how sensei recognizes this peer.")
    process.exit(1)
  }

  const originReal = realpathSync(resolve(origin))
  if (!existsSync(resolve(originReal, '.jean'))) {
    console.error(`Not a Jean dojo: ${originReal} (no .jean/ directory)`)
    process.exit(1)
  }

  const jeanDir = resolve(findDojoRoot(), '.jean')
  const file = loadPeers(jeanDir)
  if (file.peers[identity]) {
    console.error(`Peer "${identity}" already registered. Remove first with: jean peer remove ${identity}`)
    process.exit(1)
  }
  file.peers[identity] = newPeerEntry(originReal, description)
  savePeers(jeanDir, file)
  console.log(`${GREEN}Peer registered${RESET}`)
  console.log(`  identity:    ${identity}`)
  console.log(`  origin:      ${originReal}`)
  console.log(`  description: ${description}`)
  console.log()
  console.log(`${DIM}Restart infra to load: jean infra stop && jean infra start${RESET}`)
}

function cmdPeerList() {
  const jeanDir = resolve(findDojoRoot(), '.jean')
  const file = loadPeers(jeanDir)
  const entries = Object.entries(file.peers)
  if (entries.length === 0) {
    console.log('No peers registered.')
    console.log(`${DIM}Add one: jean peer add <identity> --origin <path> --description "..."${RESET}`)
    return
  }
  for (const [identity, peer] of entries) {
    console.log(`${BOLD}${identity}${RESET}`)
    console.log(`  origin:      ${peer.origin.type === 'local-path' ? peer.origin.path : '(non-local)'}`)
    console.log(`  description: ${peer.description}`)
    console.log(`  ${DIM}added ${peer.addedAt}${RESET}`)
  }
}

function cmdPeerRemove(identity?: string) {
  if (!identity) {
    console.error('Usage: jean peer remove <identity>')
    process.exit(1)
  }
  const jeanDir = resolve(findDojoRoot(), '.jean')
  const file = loadPeers(jeanDir)
  if (!file.peers[identity]) {
    console.error(`Peer "${identity}" not registered.`)
    process.exit(1)
  }
  delete file.peers[identity]
  savePeers(jeanDir, file)
  console.log(`Removed peer "${identity}". ${DIM}Restart infra to take effect.${RESET}`)
}

function cmdPeerLink(otherPath?: string) {
  if (!otherPath) {
    console.error('Usage: jean peer link <other-dojo-path>')
    console.error('Creates mutual registrations: this dojo <-> <other-dojo>.')
    process.exit(1)
  }
  const myDojo = findDojoRoot()
  const myJean = resolve(myDojo, '.jean')
  const otherDojo = realpathSync(resolve(otherPath))
  const otherJean = resolve(otherDojo, '.jean')
  if (!existsSync(otherJean)) {
    console.error(`Not a Jean dojo: ${otherDojo}`)
    process.exit(1)
  }
  if (otherDojo === realpathSync(myDojo)) {
    console.error('Cannot link a dojo to itself.')
    process.exit(1)
  }

  const myIdentity = identityFromConfig(myJean)
  const otherIdentity = identityFromConfig(otherJean)

  const describe = (which: string): string =>
    `Jean dojo at ${which} (auto-linked ${new Date().toISOString().slice(0, 10)} — edit in peers.json for a better description).`

  const mine = loadPeers(myJean)
  if (!mine.peers[otherIdentity]) {
    mine.peers[otherIdentity] = newPeerEntry(otherDojo, describe(otherDojo))
    savePeers(myJean, mine)
  }
  const theirs = loadPeers(otherJean)
  if (!theirs.peers[myIdentity]) {
    const myReal = realpathSync(myDojo)
    theirs.peers[myIdentity] = newPeerEntry(myReal, describe(myReal))
    savePeers(otherJean, theirs)
  }
  console.log(`${GREEN}Peer link established${RESET}`)
  console.log(`  ${myIdentity} ↔ ${otherIdentity}`)
  console.log(`${DIM}Restart both infras to load — and edit descriptions in each peers.json for clarity.${RESET}`)
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
  const [infoRes, eventsRes] = await Promise.all([infraFetch('/status'), infraFetch('/events')])
  const info = (await infoRes.json()) as { agents: Array<{ name: string }> }
  const eventsData = (await eventsRes.json()) as {
    events: Array<{ ts: string; type: string; agent?: string; detail?: string }>
  }

  const agentNames = info.agents.map((a) => a.name)
  console.log(`\n${BOLD}Jean Infrastructure${RESET}`)
  console.log(`  URL: ${discoverInfraUrl()}`)
  console.log(`  Connected agents: ${agentNames.length ? agentNames.join(', ') : '(none)'}`)

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

// ── Context (wiki) subcommands ────────────────────────────────────

async function cmdContext(args: string[]) {
  const sub = args[0]
  switch (sub) {
    case 'recent':
      await cmdContextRecent(args.slice(1))
      break
    default:
      console.error('Usage: jean context <recent>')
      process.exit(1)
  }
}

async function cmdContextRecent(args: string[]) {
  const useJson = args.includes('--json')
  const limit = parseFlag(args, 'limit')
  const since = parseFlag(args, 'since')

  const params = new URLSearchParams()
  if (limit) params.set('limit', limit)
  if (since) params.set('since', since)
  const qs = params.toString() ? `?${params.toString()}` : ''

  const res = await infraFetch(`/context/recent${qs}`)
  const data = (await res.json()) as {
    cursor: { lastEventId: number; lastConsolidatedAt?: string } | null
    events: Array<{
      id: number
      ts: string
      agent: string
      role: string
      text: string
      scope: string
      taskId?: string
    }>
  }

  if (useJson) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  const cursorLine = data.cursor
    ? `${DIM}Last consolidated: ${data.cursor.lastConsolidatedAt ?? 'unknown'} (through event #${data.cursor.lastEventId})${RESET}`
    : `${DIM}No consolidator cursor — librarian has not run yet.${RESET}`

  console.log()
  console.log(cursorLine)
  console.log(`${DIM}${data.events.length} pending memorize event(s):${RESET}`)
  console.log()

  if (data.events.length === 0) {
    console.log(`  ${DIM}(empty queue — nothing waiting for the librarian)${RESET}`)
    console.log()
    return
  }

  for (const ev of data.events) {
    const taskTag = ev.taskId ? ` ${DIM}task-${ev.taskId}${RESET}` : ''
    const scopeTag = ev.scope === 'user' ? ` ${DIM}[user]${RESET}` : ''
    console.log(`  ${BOLD}#${ev.id}${RESET} ${DIM}${ev.ts}${RESET} ${BOLD}${ev.agent}${RESET}${scopeTag}${taskTag}`)
    const lines = ev.text.split('\n')
    for (const line of lines.slice(0, 2)) console.log(`    ${line}`)
    if (lines.length > 2) console.log(`    ${DIM}...${RESET}`)
    console.log()
  }
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
  const kind = flagValue(args, '--kind')
  const model = flagValue(args, '--model')
  const retriesRaw = flagValue(args, '--retries')

  if (!agent || !prompt) {
    console.error(
      'Usage: jean trigger add --agent <name> --prompt "..." [--cron "..."|--at "..."] [--id <id>] [--kind agent|headless] [--model <model>] [--retries N]',
    )
    process.exit(1)
  }
  if (!cron && !at) {
    console.error('Must specify --cron or --at')
    process.exit(1)
  }
  if (kind !== undefined && kind !== 'agent' && kind !== 'headless') {
    console.error(`Invalid --kind "${kind}". Must be 'agent' or 'headless'.`)
    process.exit(1)
  }
  let retries: number | undefined
  if (retriesRaw !== undefined) {
    retries = Number.parseInt(retriesRaw, 10)
    if (Number.isNaN(retries) || retries < 0 || retries > 10) {
      console.error('--retries must be an integer between 0 and 10')
      process.exit(1)
    }
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
      ...(kind && { kind }),
      ...(model && { model }),
      ...(retries !== undefined && { retries }),
      actor: 'cli',
    }),
  })
  if (!res.ok) {
    const err = (await res.json()) as { error: string }
    console.error(`Error: ${err.error}`)
    process.exit(1)
  }
  const trigger = (await res.json()) as {
    id: string
    cron?: string
    at?: string
    kind?: string
    model?: string
    retries?: number
  }
  console.log(`${GREEN}Trigger "${trigger.id}" created.${RESET}`)
  if (trigger.cron) console.log(`  Schedule: ${trigger.cron}`)
  if (trigger.at) console.log(`  Fires at: ${trigger.at}`)
  console.log(`  Agent:    ${agent}${trigger.kind === 'headless' ? ' (headless)' : ''}`)
  if (trigger.model) console.log(`  Model:    ${trigger.model}`)
  if (trigger.retries) console.log(`  Retries:  ${trigger.retries}`)
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
    case 'undo':
      await cmdTaskUndo(args[1], args.slice(2))
      break
    default:
      console.error('Usage: jean task <log|undo> <id>')
      process.exit(1)
  }
}

async function cmdTaskUndo(id: string | undefined, opts: string[]) {
  if (!id) {
    console.error('Usage: jean task undo <id> [--actor <name>]')
    process.exit(1)
  }
  const actor = flagValue(opts, '--actor') ?? 'cli'
  const res = await infraFetch(`/tasks/${id}/revert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor }),
  })
  const body = (await res.json()) as {
    error?: string
    id?: string
    status?: string
    reverted?: { from: string; to: string }
  }
  if (!res.ok || body.error) {
    console.error(`Error: ${body.error ?? res.statusText}`)
    process.exit(1)
  }
  if (body.reverted) {
    console.log(`Reverted task ${id}: ${body.reverted.from} → ${body.reverted.to}`)
  } else {
    console.log(`Reverted task ${id}. Status: ${body.status}`)
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
    case 'move':
      cmdDojoMove(args.slice(1))
      break
    case 'start':
      cmdDojoStart(args.slice(1))
      break
    case 'list':
      cmdDojoList()
      break
    case 'register':
      cmdDojoRegister()
      break
    case 'prune':
      cmdDojoPrune()
      break
    default:
      console.error('Usage: jean dojo <init|move|start|list|register|prune> ...')
      process.exit(1)
  }
}

/** Directory containing the CLI source (used for resolving co-located assets) */
function cliDir(): string {
  return dirname(Bun.main)
}

/** Read a framework skill template shipped with Jean */
function readSkillTemplate(name: string): string {
  return readFileSync(resolve(cliDir(), 'skills', `${name}.md`), 'utf8')
}

const FRAMEWORK_SKILLS: Partial<Record<AgentRole, string[]>> = {
  sensei: ['create-playbook', 'jean-sensei', 'context', 'wiki-sweep'],
  worker: ['jean-worker', 'context'],
  // Librarian is spawned headless; its skill ships into the role dir but
  // the role isn't user-addable via `jean agent add` (intentional — it's
  // infra-owned).
  // The librarian runs as three phases on each consolidate-wiki trigger:
  // draft (Haiku), review (Sonnet), commit (in-process shell). The two
  // phase-specific skills are the operative ones; the legacy single-phase
  // `consolidate-wiki` skill ships alongside them for one cycle as a
  // fallback / reference, and will be removed once multi-phase has run
  // reliably for a few weeks.
  librarian: ['consolidate-wiki', 'consolidate-wiki-draft', 'consolidate-wiki-review'],
}

/** Copy a framework skill template into `<parentDir>/.claude/skills/<name>/SKILL.md`. */
function shipSkill(parentDir: string, name: string) {
  const skillDir = resolve(parentDir, '.claude', 'skills', name)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(resolve(skillDir, 'SKILL.md'), readSkillTemplate(name))
}

function shipFrameworkSkills(jeanDir: string) {
  for (const [role, names] of Object.entries(FRAMEWORK_SKILLS)) {
    if (!names) continue
    for (const name of names) {
      shipSkill(resolve(jeanDir, 'roles', role), name)
    }
  }
}

const SEED_CONTEXT_README = `# Dojo context

Describe what this dojo is for — the project, the goals, links to external references.
Agents read everything in this directory when orienting.

Add more files alongside this one as the project's context grows.
`

function cmdDojoInit(args: string[]) {
  const useGit = args.includes('--git')
  const gitFromIdx = args.indexOf('--git-from')
  const gitFrom = gitFromIdx >= 0 ? args[gitFromIdx + 1] : undefined
  if (gitFromIdx >= 0 && (!gitFrom || gitFrom.startsWith('--'))) {
    console.error('--git-from requires a repository URL or path.')
    process.exit(1)
  }
  if (useGit && gitFrom) {
    console.error('Use either --git (fresh repo) or --git-from <repo> (clone existing), not both.')
    process.exit(1)
  }
  // First non-flag arg is the path (skip --git, --key value pairs, and the --git-from value).
  // When --git-from is absent, gitFromIdx is -1 — don't let -1+1=0 exclude the path at index 0.
  const gitFromValueIdx = gitFromIdx >= 0 ? gitFromIdx + 1 : -1
  const targetPath = args.find((a, idx) => !a.startsWith('--') && idx !== gitFromValueIdx)
  const dojoRoot = resolve(targetPath ?? '.')
  const jeanDir = resolve(dojoRoot, '.jean')

  // Validate everything that can fail before touching the filesystem. A partially
  // initialized dojo is hostile — `existsSync(jeanDir)` on a retry would claim
  // "already a dojo" even though setup never finished.
  if (existsSync(jeanDir)) {
    console.error(`Already a Jean dojo: ${jeanDir} exists.`)
    process.exit(1)
  }
  const config: JeanConfig = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg?.startsWith('--')) continue
    const key = arg.slice(2)
    if (key === 'git') continue // not a config key
    if (key === 'git-from') {
      i++ // takes a value, but the value is the repo (handled above), not a config key
      continue
    }
    const raw = args[i + 1]
    if (!raw || raw.startsWith('--')) {
      console.error(`Missing value for --${key}`)
      process.exit(1)
    }
    applyConfigEntry(config, key, raw)
    i++ // skip value
  }
  // Resolve the port against the machine-global registry (~/.jean/dojos.json):
  // auto-allocate the next free port when --port is omitted, or validate a
  // chosen one. Collision-safe against every *registered* dojo, up or down (a
  // down dojo stays registered). Caveat: a dojo that has never registered
  // (pre-registry and never started, with `jean dojo register` not run) is
  // invisible here — infra start's bind check is the backstop for that window.
  const portResult = allocatePort(config.port, dojoRoot)
  if ('error' in portResult) {
    console.error(portResult.error)
    process.exit(1)
  }
  const port = portResult.port
  config.port = port

  // Core directories
  mkdirSync(resolve(jeanDir, 'playbooks'), { recursive: true })
  mkdirSync(resolve(jeanDir, 'context'), { recursive: true })
  mkdirSync(resolve(jeanDir, 'sessions'), { recursive: true })

  // Skill hierarchy
  mkdirSync(resolve(jeanDir, '.claude', 'skills'), { recursive: true })
  shipFrameworkSkills(jeanDir)

  // Seed context so agents have a starting document to read and extend.
  writeFileSync(resolve(jeanDir, 'context', 'readme.md'), SEED_CONTEXT_README)

  // Git repo
  if (useGit || gitFrom) {
    const bareDir = resolve(jeanDir, '.bare')
    const gitOpts = { stdout: 'pipe' as const, stderr: 'pipe' as const }
    const gitCheck = (result: { exitCode: number; stderr: { toString(): string } }, label: string) => {
      if (result.exitCode !== 0) {
        console.error(`git ${label} failed: ${result.stderr.toString().trim()}`)
        process.exit(1)
      }
    }
    if (gitFrom) {
      // Wrap an existing repo: clone it bare. Preserves branches, history, the default
      // HEAD, and origin.url — the same shape as dojos that were wired this way by hand.
      // No initial commit (the repo already has history)
      // and no HEAD override (keep the source's default branch).
      gitCheck(Bun.spawnSync(['git', 'clone', '--bare', gitFrom, bareDir], gitOpts), `clone --bare ${gitFrom}`)
      // `git clone --bare` sets origin.url but NOT a fetch refspec, so `git fetch
      // origin` and `@{u}` tracking wouldn't work in the agent worktrees. Set the
      // refspec and populate refs/remotes/origin/*. The content is already present
      // from the clone, so a fetch failure (offline / auth) is non-fatal.
      gitCheck(
        Bun.spawnSync(
          ['git', '-C', bareDir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
          gitOpts,
        ),
        'config remote.origin.fetch',
      )
      const fetched = Bun.spawnSync(['git', '-C', bareDir, 'fetch', 'origin', '--quiet'], gitOpts)
      if (fetched.exitCode !== 0) {
        console.error(
          `warning: 'git fetch origin' failed (${fetched.stderr.toString().trim()}); origin.url is set — run 'git fetch' later.`,
        )
      }
    } else {
      gitCheck(Bun.spawnSync(['git', 'init', '--bare', bareDir], gitOpts), 'init --bare')
      gitCheck(
        Bun.spawnSync(['git', '-C', bareDir, 'symbolic-ref', 'HEAD', 'refs/heads/main'], gitOpts),
        'symbolic-ref',
      )
      // Initial commit with .gitignore (temp file — worktrees will have it via checkout)
      writeFileSync(resolve(dojoRoot, '.gitignore'), '.jean/\n')
      const env = { ...process.env, GIT_DIR: bareDir, GIT_WORK_TREE: dojoRoot }
      gitCheck(Bun.spawnSync(['git', 'add', '.gitignore'], { ...gitOpts, env }), 'add')
      gitCheck(Bun.spawnSync(['git', 'commit', '-m', 'Initial commit'], { ...gitOpts, env }), 'commit')
      unlinkSync(resolve(dojoRoot, '.gitignore'))
    }
    // Pre-populate the shared worktree exclude so every future agent worktree starts clean.
    ensureGitExclude(bareDir)
  }

  // Default identity = dojo dir basename, unless user provided --identity.
  // Used as the `from` field when this dojo sends to peers.
  if (config.identity === undefined) config.identity = basename(dojoRoot)

  writeConfig(jeanDir, config)

  // Record in the machine-global registry so future `jean dojo init` calls avoid this port.
  upsertDojo({ path: dojoRoot, port, identity: config.identity })

  console.log(`${GREEN}Dojo initialized at ${dojoRoot}${RESET} ${DIM}(port ${port})${RESET}`)
  console.log()
  console.log(`  ${dojoRoot}/`)
  console.log(`    .jean/`)
  if (gitFrom) {
    console.log(`      .bare/           ${DIM}← bare clone of ${gitFrom}${RESET}`)
  } else if (useGit) {
    console.log(`      .bare/           ${DIM}← git bare repo${RESET}`)
  }
  console.log(`      .claude/skills/  ${DIM}← shared dojo skills${RESET}`)
  console.log(`      roles/           ${DIM}← role-specific skills${RESET}`)
  console.log(`      playbooks/       ${DIM}← flow definitions${RESET}`)
  console.log(`      context/         ${DIM}← shared project context${RESET}`)
  console.log(`      sessions/        ${DIM}← agent session handles${RESET}`)
  console.log(`      jean.config.json ${DIM}← configuration${RESET}`)
  console.log()
  console.log(`Next steps:`)
  console.log(`  jean setup             ${DIM}← register the channel (once per machine)${RESET}`)
  console.log(`  jean satori            ${DIM}← guided setup (recommended)${RESET}`)
  console.log(`  jean agent add <name>  ${DIM}← or add agents manually${RESET}`)
  console.log(`  jean infra start       ${DIM}← then start infrastructure${RESET}`)
}

// ── jean dojo list / register (machine-global registry) ──────────

function cmdDojoList() {
  const entries = readRegistry()
  console.log(`${DIM}registry: ${registryPath()}${RESET}`)
  if (entries.length === 0) {
    console.log('No dojos registered. Run `jean dojo register` in a dojo, or `jean infra start` (auto-registers).')
    return
  }
  for (const e of [...entries].sort((a, b) => a.port - b.port)) {
    const flags: string[] = []
    if (!existsSync(e.path)) {
      flags.push('STALE: path missing')
    } else {
      const cfg = readConfig(resolve(e.path, '.jean'))
      if (cfg.port !== undefined && cfg.port !== e.port) flags.push(`DRIFT: config port is ${cfg.port}`)
    }
    const note = flags.length ? `  ${DIM}(${flags.join('; ')})${RESET}` : ''
    console.log(`  ${e.port}  ${e.identity ?? '?'}  ${DIM}${e.path}${RESET}${note}`)
  }
}

function cmdDojoRegister() {
  const dojoRoot = findDojoRoot()
  const cfg = readConfig(resolve(dojoRoot, '.jean'))
  if (cfg.port === undefined) {
    console.error(
      `No port set in ${resolve(dojoRoot, '.jean', 'jean.config.json')}. Set one with: jean config set port <N>`,
    )
    process.exit(1)
  }
  upsertDojo({ path: dojoRoot, port: cfg.port, identity: cfg.identity })
  console.log(`Registered ${cfg.identity ?? basename(dojoRoot)} (port ${cfg.port}) → ${registryPath()}`)
}

/** Drop registry entries whose dojo directory no longer exists — the cleanup
 *  for the "I rm'd the dojo folder" case (you can't `cd` in to deregister). */
function cmdDojoPrune() {
  const before = readRegistry()
  const after = pruneStale(before)
  writeRegistry(after)
  const dropped = before.length - after.length
  console.log(
    dropped === 0
      ? 'Registry clean — no stale entries.'
      : `Pruned ${dropped} stale ${dropped === 1 ? 'entry' : 'entries'} → ${registryPath()}`,
  )
}

// ── Dojo move: relocate a dojo on disk ───────────────────────────

/**
 * Move the current dojo to a new path, repairing git worktrees. Jean bakes no
 * absolute path into agent config (the channel server is user-scoped and agents
 * self-identify from cwd), so a move is just relocate + `git worktree repair`.
 * Intended to keep a dojo move down to a single command — critical-path for
 * organizing command-center dojo layouts.
 */
function cmdDojoMove(args: string[]) {
  const oldRoot = realpathSync(findDojoRoot())
  const targetArg = args.find((a) => !a.startsWith('--'))
  if (!targetArg) {
    console.error('Usage: jean dojo move <new-path>')
    process.exit(1)
  }
  // Resolve the destination through the parent's realpath so symlink-equivalent
  // paths compare correctly (macOS /var ↔ /private/var is the classic trap).
  const newRootArg = resolve(targetArg)
  const newParent = dirname(newRootArg)
  mkdirSync(newParent, { recursive: true })
  const newRoot = resolve(realpathSync(newParent), basename(newRootArg))

  if (newRoot === oldRoot) {
    console.error('Destination is the same as the current dojo root.')
    process.exit(1)
  }
  if (existsSync(newRoot)) {
    console.error(`Destination already exists: ${newRoot}`)
    process.exit(1)
  }
  // Moving into self would orphan everything — refuse.
  if (newRoot.startsWith(`${oldRoot}${sep}`)) {
    console.error(`Cannot move a dojo into itself: ${newRoot} is inside ${oldRoot}`)
    process.exit(1)
  }

  // Infra must be stopped — PID files and open sockets don't survive the move.
  const dataDir = resolve(oldRoot, '.jean')
  const { pid } = readRuntimeFiles(dataDir)
  if (pid !== null && isProcessAlive(pid)) {
    console.error(`Infra is running (pid ${pid}). Run 'jean infra stop' first.`)
    process.exit(1)
  }

  // Capture port/identity from the still-present old config before moving, so we
  // can repoint the registry afterward without re-reading from the moved tree.
  const movedCfg = readConfig(dataDir)

  renameSync(oldRoot, newRoot)
  // Our own cwd may have been inside the old root — now a ghost inode, which
  // makes any posix_spawn fail with ENOENT. Rebase onto the new root before
  // touching worktrees or agent configs.
  if (process.cwd().startsWith(oldRoot)) process.chdir(newRoot)

  // Repoint the machine-global registry at the new location. removeDojo is
  // required (upsert no longer prunes neighbors); re-add under the new path
  // when the dojo has a port to track.
  removeDojo(oldRoot)
  if (movedCfg.port !== undefined) {
    upsertDojo({ path: newRoot, port: movedCfg.port, identity: movedCfg.identity })
  }

  // Discover agent worktrees by scanning for .jean/.jean-agent.json — we can't
  // use discoverAgents() yet because it calls `git worktree list`, which reads
  // stale gitdir pointers and drops all worktrees until repair runs.
  const agentPaths: string[] = []
  try {
    for (const entry of readdirSync(newRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const p = resolve(newRoot, entry.name)
      if (existsSync(resolve(p, '.jean', '.jean-agent.json'))) agentPaths.push(p)
    }
  } catch {}

  // Git worktrees store absolute gitdir pointers on both ends (bare→worktree
  // and worktree→bare). `worktree repair` with explicit paths rewrites both.
  const bareDir = resolve(newRoot, '.jean', '.bare')
  if (existsSync(bareDir) && agentPaths.length > 0) {
    const repair = Bun.spawnSync(['git', '-C', bareDir, 'worktree', 'repair', ...agentPaths], {
      cwd: newRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (repair.exitCode !== 0) {
      console.error('git worktree repair failed:')
      console.error(repair.stderr.toString().trim())
      process.exit(1)
    }
  }

  // No agent config to rewrite — Jean bakes no absolute path into a worktree.
  // Each agent self-identifies from its .jean-agent.json (cwd-derived) and walks
  // up to the dojo root; hook paths in settings.local.json and --add-dir args are
  // all relative and survive the move.

  console.log(`${GREEN}Dojo moved${RESET}`)
  console.log(`  From: ${oldRoot}`)
  console.log(`  To:   ${newRoot}`)
  if (process.cwd().startsWith(oldRoot)) {
    console.log()
    console.log(`${DIM}Your shell is still on the old path — cd to the new location.${RESET}`)
  }
  console.log()
  console.log(`${DIM}Note: Claude Code session history is keyed by absolute cwd.${RESET}`)
  console.log(`${DIM}Past sessions from the old path won't be found by 'claude -c' here.${RESET}`)
}

// ── Dojo start: split current terminal tab into infra + agent panes ──

/**
 * Split the current terminal tab into infra + sensei + workers panes.
 * Layout decisions and platform-specific scripting live in
 * `terminal-layout.ts`; this command just discovers the dojo's agents,
 * builds a platform-agnostic LayoutSpec, and hands it to whichever
 * terminal opener matches the current platform.
 *
 * No custom guard for "infra already running" — the existing duplicate-detect
 * inside `jean infra start` will fail loudly in the infra pane, while the
 * agent panes connect to the running infra normally.
 */
function cmdDojoStart(args: string[]) {
  const opener = pickTerminalOpener()
  if (!opener) {
    console.error(`No terminal layout implementation for platform=${process.platform}.`)
    console.error('Currently supported: macOS + iTerm2. Add more in src/cli/terminal-layout.ts.')
    process.exit(1)
  }

  const dojoRoot = findDojoRoot()
  const all = discoverAgents(dojoRoot)

  // Filter: positional names take precedence; --only <a,b,c> as alt syntax.
  const positional = args.filter((a) => !a.startsWith('--'))
  const onlyIdx = args.indexOf('--only')
  const flagList = onlyIdx >= 0 && args[onlyIdx + 1] ? args[onlyIdx + 1]!.split(',') : []
  const wanted = new Set([...positional, ...flagList].map((s) => s.trim()).filter(Boolean))
  const filtered = wanted.size > 0 ? all.filter((a) => wanted.has(a.name)) : all

  if (wanted.size > 0) {
    const missing = [...wanted].filter((w) => !all.some((a) => a.name === w))
    if (missing.length > 0) {
      console.error(`Unknown agents: ${missing.join(', ')}`)
      process.exit(1)
    }
  }

  // Senseis go in middle column. Peers have no local process; skip them.
  const senseis = filtered.filter((a) => a.role === 'sensei').map((a) => a.name)
  const workers = filtered.filter((a) => a.role === 'worker').map((a) => a.name)
  const sensei = senseis.at(-1)

  if (!sensei && workers.length === 0) {
    console.error('No sensei or worker agents to open. Add some with: jean agent add <name>')
    process.exit(1)
  }

  const spec: LayoutSpec = {
    dojoRoot,
    infra: { command: 'jean infra start' },
    sensei: sensei ? { name: sensei, command: `jean agent start ${sensei}` } : undefined,
    workers: workers.map((w) => ({ name: w, command: `jean agent start ${w}` })),
  }

  const { exitCode, stderr } = opener.open(spec)
  if (exitCode !== 0) {
    console.error(`${opener.name} failed:`)
    console.error(stderr.trim())
    process.exit(1)
  }

  console.log(`${GREEN}Tab laid out via ${opener.name}:${RESET}`)
  console.log(`  ${DIM}left:${RESET}   infra`)
  if (sensei) console.log(`  ${DIM}middle:${RESET} ${sensei} ${DIM}(sensei)${RESET}`)
  if (workers.length > 0) {
    const where = sensei ? 'right' : 'middle/right'
    console.log(`  ${DIM}${where}:${RESET}  ${workers.join(', ')} ${DIM}(workers, stacked)${RESET}`)
  }
}

// ── Satori: guided dojo setup ────────────────────────────────────

function cmdSatori() {
  const dojoRoot = findDojoRoot()
  const jeanDir = resolve(dojoRoot, '.jean')

  // Refresh the satori skill on every launch so dojos initialized before this
  // command existed pick up edits, and so skill changes land without re-init.
  shipSkill(jeanDir, 'satori')

  console.log(`${GREEN}Starting Satori setup in ${dojoRoot}${RESET}`)
  console.log(`${DIM}Answer a few questions to bootstrap this dojo. Exit with Ctrl+D when done.${RESET}`)
  console.log()

  // Pass an initial positional prompt so Claude Code produces the first turn
  // instead of waiting on stdin. Without this the human sees a silent prompt
  // and has to type something to kick Satori off — which defeats "speak first".
  const result = Bun.spawnSync(
    [
      'claude',
      '--add-dir',
      '.jean',
      '--append-system-prompt',
      'Load the satori skill immediately and follow its instructions. Start by checking the dojo state.',
      'Begin the Satori intake now. Follow the satori skill — speak first, introduce yourself, and start the intake questions in the same message.',
    ],
    { cwd: dojoRoot, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
  )
  process.exit(result.exitCode ?? 1)
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
    case 'url':
      cmdInfraUrl()
      break
    default:
      console.error('Usage: jean infra <start|stop|status|url>')
      process.exit(1)
  }
}

function cmdInfraUrl() {
  const dataDir = resolve(findDojoRoot(), '.jean')
  const { port } = readRuntimeFiles(dataDir)
  if (port === null) {
    console.error('Infrastructure is not running. Use "jean infra start".')
    process.exit(1)
  }
  console.log(`http://127.0.0.1:${port}`)
}

async function cmdInfraStart() {
  const dataDir = resolve(findDojoRoot(), '.jean')

  // Friendlier pre-check: refuse before spawning if we can confirm a live duplicate.
  // (The server also enforces this; we do it here to avoid spawn-and-die noise.)
  const existing = readRuntimeFiles(dataDir)
  if (existing.pid !== null && existing.port !== null && isProcessAlive(existing.pid)) {
    const info = await probeInfra(existing.port)
    if (info?.name === INFRA_IDENTITY && info.dataDir === dataDir) {
      console.error(`Infrastructure already running (pid ${existing.pid}, port ${existing.port}).`)
      console.error('Use "jean infra stop" first.')
      process.exit(1)
    }
  }

  const serverPath = resolve(cliDir(), '../infra/server.ts')
  const child = Bun.spawn(['bun', 'run', serverPath], {
    cwd: dataDir,
    env: { ...process.env, JEAN_DATA_DIR: dataDir },
    stdio: ['ignore', 'ignore', 'inherit'],
  })

  // Poll the port file: server writes it after successful bind.
  let startedPort: number | null = null
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(200)
    const rt = readRuntimeFiles(dataDir)
    if (rt.port !== null) {
      startedPort = rt.port
      break
    }
  }

  if (startedPort !== null) {
    console.log(`${GREEN}Infrastructure started.${RESET}`)
    console.log(`  PID:  ${child.pid}`)
    console.log(`  Port: ${startedPort}`)
    console.log(`  Data: ${dataDir}`)
  } else {
    console.error('Infrastructure started but port file not found. Check stderr for errors.')
  }

  child.unref()
}

async function cmdInfraStop() {
  const dataDir = resolve(findDojoRoot(), '.jean')
  const { pid } = readRuntimeFiles(dataDir)

  if (pid === null) {
    console.log('Infrastructure is not running (no PID file).')
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
    console.log(`Infrastructure stopped (pid ${pid}).`)
  } catch {
    console.log(`Process ${pid} not found. Cleaning up stale PID file.`)
  }

  // Clean up in case signal handler didn't
  try {
    unlinkSync(resolve(dataDir, 'infra.pid'))
  } catch {}
  try {
    unlinkSync(resolve(dataDir, 'infra.port'))
  } catch {}
}

async function cmdInfraStatus() {
  const dataDir = resolve(findDojoRoot(), '.jean')
  const { pid, port } = readRuntimeFiles(dataDir)

  if (pid === null) {
    console.log('Infrastructure is not running.')
    return
  }
  if (!isProcessAlive(pid)) {
    console.log(`Infrastructure is not running (stale PID ${pid}).`)
    return
  }

  console.log(`${GREEN}Infrastructure is running.${RESET}`)
  console.log(`  PID:  ${pid}`)
  console.log(`  Port: ${port ?? '?'}`)
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
    case 'sync-permissions':
      cmdAgentSyncPermissions(args.slice(1))
      break
    case 'sync-skills':
      cmdAgentSyncSkills(args.slice(1))
      break
    default:
      console.error('Usage: jean agent <add|list|tag|remove|start|sync-permissions|sync-skills>')
      process.exit(1)
  }
}

// ── Agent helpers ─────────────────────────────────────────────────

import type { AgentRole } from '../infra/protocol.ts'
import { defaultPermissions, mergePermissions } from './permissions.ts'

/** Roles users can add via `jean agent add`. A subset of AGENT_ROLES from
 *  protocol.ts: 'peer' is registered via `jean peer add`, and 'librarian'
 *  is infra-spawned via `jean librarian setup`. */
const USER_ADDABLE_ROLES: readonly AgentRole[] = ['worker', 'sensei', 'user']

type AgentMeta = { name: string; tags: string[]; role: AgentRole }
type AgentInfo = AgentMeta & { path: string; branch?: string }

function findDojoRoot(): string {
  const root = findDojoRootFrom(process.cwd())
  if (root) return root
  console.error('Not a Jean dojo. No .jean/ directory found.')
  console.error('Run this command from within a dojo tree.')
  process.exit(1)
}

function findBareRepo(dojoRoot: string): string | null {
  const bareDir = resolve(dojoRoot, '.jean', '.bare')
  return existsSync(bareDir) ? bareDir : null
}

const GIT_EXCLUDE_MARKER = '# Jean agent config (managed by jean)'
const GIT_EXCLUDE_ENTRIES = ['.jean/', '.claude/settings.local.json']

/** Ensure .bare/info/exclude has entries to hide Jean files from git status in all worktrees */
function ensureGitExclude(bareDir: string): void {
  const excludePath = resolve(bareDir, 'info', 'exclude')
  let content = ''
  try {
    content = readFileSync(excludePath, 'utf8')
  } catch {}
  if (content.includes(GIT_EXCLUDE_MARKER)) return
  mkdirSync(resolve(bareDir, 'info'), { recursive: true })
  const block = `\n${GIT_EXCLUDE_MARKER}\n${GIT_EXCLUDE_ENTRIES.join('\n')}\n`
  writeFileSync(excludePath, content + block)
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
    const data = JSON.parse(readFileSync(resolve(agentDir, '.jean', '.jean-agent.json'), 'utf8'))
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
  const jeanDir = resolve(agentDir, '.jean')
  mkdirSync(jeanDir, { recursive: true })
  writeFileSync(resolve(jeanDir, '.jean-agent.json'), `${JSON.stringify(meta, null, 2)}\n`)
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
  return resolve(cliDir(), '..', 'channel')
}

/** Compute --add-dir flags for agent launch. The channel's MCP server is
 *  auto-discovered from the user-scope registration in ~/.claude.json (added
 *  once per machine by `jean setup`), so the new CC's
 *  --dangerously-load-development-channels can resolve `server:jean`; no
 *  --mcp-config and no per-worktree .mcp.json needed. */
function agentLaunchFlags(agentDir: string): string {
  const dojoRoot = findDojoRoot()
  const jeanDir = resolve(dojoRoot, '.jean')
  const relJean = relative(agentDir, jeanDir)
  const meta = readAgentMeta(agentDir)
  const role = meta?.role ?? 'worker'
  return `--add-dir .jean --add-dir ${relJean} --add-dir ${relJean}/roles/${role}`
}

function isWorktreeDirty(path: string): boolean {
  const result = Bun.spawnSync(['git', '-C', path, 'status', '--porcelain'], { stdout: 'pipe', stderr: 'pipe' })
  return result.stdout.toString().trim().length > 0
}

// ── Agent Add ─────────────────────────────────────────────────────

function cmdAgentAdd(args: string[]) {
  const existingMode = args.includes('--existing')

  const roleStr = flagValue(args, '--role') ?? 'worker'
  if (!(USER_ADDABLE_ROLES as readonly string[]).includes(roleStr)) {
    console.error(`Invalid role "${roleStr}". Must be: worker, sensei, or user.`)
    process.exit(1)
  }
  const role = roleStr as AgentRole
  const useWorktree = !args.includes('--no-worktree') // default: all agents get worktrees
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
      console.error('No .jean/.bare/ directory found. Cannot create worktree.')
      console.error('Initialize with: jean dojo init --git')
      process.exit(1)
    }

    const branch = `jean/${name}`
    console.log(`Creating worktree on branch "${branch}"...`)

    // Create worktree directly at dojo/<name>/ (no wrapper/work split)
    let wt = Bun.spawnSync(['git', '-C', bareDir, 'worktree', 'add', agentDir, '-b', branch], {
      stderr: 'pipe',
      stdout: 'pipe',
    })
    if (wt.exitCode !== 0) {
      wt = Bun.spawnSync(['git', '-C', bareDir, 'worktree', 'add', agentDir, branch], {
        stderr: 'pipe',
        stdout: 'pipe',
      })
      if (wt.exitCode !== 0) {
        console.error(`Failed to create worktree: ${wt.stderr.toString().trim()}`)
        process.exit(1)
      }
    }

    // Write agent config — rollback worktree on failure
    try {
      writeJeanConfig(agentDir, name, role, tags, dojoRoot)
      ensureGitExclude(bareDir)
    } catch (err) {
      console.error(`Failed to write agent config: ${err}`)
      console.error('Rolling back worktree...')
      Bun.spawnSync(['git', '-C', bareDir, 'worktree', 'remove', agentDir, '--force'], {
        stderr: 'pipe',
        stdout: 'pipe',
      })
      process.exit(1)
    }

    console.log(`\n${GREEN}Agent "${name}" created.${RESET}`)
    console.log(`  Worktree: ./${name}/`)
    console.log(`  Branch:   ${branch}`)
  } else {
    mkdirSync(agentDir)
    writeJeanConfig(agentDir, name, role, tags, dojoRoot)

    console.log(`\n${GREEN}Agent "${name}" created.${RESET}`)
    console.log(`  Directory: ./${name}/`)
  }

  if (role !== 'worker') console.log(`  Role:     ${role}`)
  if (tags.length) console.log(`  Tags:     ${tags.join(', ')}`)
  console.log(`\nTo start:`)
  console.log(`  jean agent start ${name}`)
  console.log(
    `\n${DIM}Or manually: cd ${name} && JEAN_AGENT=${name} claude ${agentLaunchFlags(agentDir)} --dangerously-load-development-channels server:jean${RESET}`,
  )
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

  if (existsSync(resolve(targetPath, '.jean', '.jean-agent.json'))) {
    console.error(`"${name}" is already a Jean agent.`)
    process.exit(1)
  }

  writeJeanConfig(targetPath, name, role, tags, dojoRoot)

  console.log(`\n${GREEN}Agent "${name}" configured.${RESET}`)
  console.log(`  Path: ${targetPath}`)
  if (role !== 'worker') console.log(`  Role: ${role}`)
  if (tags.length) console.log(`  Tags: ${tags.join(', ')}`)
  console.log(`\nTo start:`)
  console.log(`  jean agent start ${name}`)
  console.log(
    `\n${DIM}Or manually: cd ${targetPath} && JEAN_AGENT=${name} claude ${agentLaunchFlags(targetPath)} --dangerously-load-development-channels server:jean${RESET}`,
  )
}

function writeJeanConfig(agentDir: string, name: string, role: AgentRole, tags: string[], dojoRoot: string) {
  writeAgentMeta(agentDir, { name, tags, role })

  // No per-worktree .mcp.json. The channel server is registered ONCE per machine
  // in user scope (~/.claude.json) via `jean setup`; the new CC's
  // --dangerously-load-development-channels resolves `server:jean` from that
  // auto-discovered config. The server self-identifies per session from this
  // worktree's .jean-agent.json (written above) — no per-agent env, no path baked in.

  // settings.local.json → agentDir/.claude/ (Claude Code discovers from cwd)
  const relJean = relative(agentDir, resolve(dojoRoot, '.jean'))
  const settingsDir = resolve(agentDir, '.claude')
  const settingsPath = resolve(settingsDir, 'settings.local.json')
  if (!existsSync(settingsPath)) {
    mkdirSync(settingsDir, { recursive: true })
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          permissions: defaultPermissions(role, dojoRoot),
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `JEAN_PORT=$(cat ${relJean}/infra.port 2>/dev/null || echo 8700); curl -s -X POST http://127.0.0.1:$JEAN_PORT/agent-idle -H 'content-type: application/json' -d "{\\"agent\\":\\"${name}\\",\\"sessionId\\":\\"$(cat ${relJean}/sessions/${name}.id 2>/dev/null)\\"}"`,
                  },
                ],
              },
            ],
            PermissionRequest: [
              {
                hooks: [
                  {
                    type: 'command',
                    command: `bun -e 'const{readFileSync:r,existsSync:e}=require("fs");const p=e("${relJean}/infra.port")?r("${relJean}/infra.port","utf8").trim():"8700";const d=JSON.parse(await Bun.stdin.text());fetch("http://127.0.0.1:"+p+"/permissions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agent:"${name}",tool:d.tool_name,input:d.tool_input})})'`,
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

  // Agent-specific skills → agentDir/.jean/.claude/skills/
  mkdirSync(resolve(agentDir, '.jean', '.claude', 'skills'), { recursive: true })
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

// ── Agent Sync Permissions ────────────────────────────────────────
//
// Union-merges current defaultPermissions into each existing agent's
// settings.local.json. `jean agent add` only writes settings on first
// creation; this command keeps existing dojos current as framework
// defaults evolve.

function cmdAgentSyncPermissions(args: string[]) {
  const dryRun = args.includes('--dry-run')
  const dojoRoot = findDojoRoot()

  type Target = { name: string; role: AgentRole; settingsPath: string }
  const targets: Target[] = []

  for (const a of discoverAgents(dojoRoot)) {
    targets.push({
      name: a.name,
      role: a.role,
      settingsPath: resolve(a.path, '.claude', 'settings.local.json'),
    })
  }

  // Librarian lives outside the agent worktree convention.
  const librarianDir = resolve(dojoRoot, '.jean', 'roles', 'librarian')
  if (existsSync(librarianDir)) {
    targets.push({
      name: 'librarian',
      role: 'librarian',
      settingsPath: resolve(librarianDir, '.claude', 'settings.local.json'),
    })
  }

  if (targets.length === 0) {
    console.log('No agents found.')
    return
  }

  console.log()
  let totalChanges = 0
  let touchedAgents = 0

  for (const t of targets) {
    const label = `${BOLD}${t.name}${RESET}${DIM} (${t.role})${RESET}`

    if (!existsSync(t.settingsPath)) {
      console.log(`  ${DIM}skip${RESET}  ${label} — no settings.local.json`)
      continue
    }

    let json: Record<string, unknown>
    try {
      json = JSON.parse(readFileSync(t.settingsPath, 'utf8')) as Record<string, unknown>
    } catch {
      console.log(`  ${DIM}error${RESET} ${label} — invalid JSON, skipping`)
      continue
    }

    const expected = defaultPermissions(t.role, dojoRoot)
    const existing = (json.permissions ?? {}) as Partial<{ allow: string[]; deny: string[] }>
    const { merged, addedAllow, addedDeny } = mergePermissions(existing, expected)

    if (addedAllow.length === 0 && addedDeny.length === 0) {
      console.log(`  ${DIM}ok${RESET}    ${label} — already current`)
      continue
    }

    console.log(`  ${GREEN}sync${RESET}  ${label}`)
    for (const rule of addedAllow) console.log(`    ${GREEN}+${RESET} Allow: ${rule}`)
    for (const rule of addedDeny) console.log(`    ${GREEN}+${RESET} Deny:  ${rule}`)
    totalChanges += addedAllow.length + addedDeny.length
    touchedAgents++

    if (!dryRun) {
      json.permissions = merged
      writeFileSync(t.settingsPath, `${JSON.stringify(json, null, 2)}\n`)
    }
  }

  console.log()
  if (totalChanges === 0) {
    console.log(`${DIM}All ${targets.length} agent(s) already current.${RESET}`)
    return
  }

  if (dryRun) {
    console.log(
      `${DIM}Dry run — ${totalChanges} rule(s) would be added across ${touchedAgents} agent(s). Re-run without --dry-run to apply.${RESET}`,
    )
  } else {
    console.log(`${GREEN}Synced ${totalChanges} rule(s) across ${touchedAgents} agent(s).${RESET}`)
    console.log(`${DIM}Note: running agents continue with their loaded permissions until next restart.${RESET}`)
  }
}

// ── Agent Sync Skills ─────────────────────────────────────────────
//
// Re-applies framework skill files from src/cli/skills/ to existing
// role dirs. Unlike sync-permissions, no merge — skills are framework-
// owned (agents shouldn't edit them); copy if missing or different.

function cmdAgentSyncSkills(args: string[]) {
  const dryRun = args.includes('--dry-run')
  const dojoRoot = findDojoRoot()

  type Target = { role: AgentRole; skillName: string; destPath: string }
  const targets: Target[] = []

  for (const [role, skillNames] of Object.entries(FRAMEWORK_SKILLS)) {
    if (!skillNames) continue
    const roleDir = resolve(dojoRoot, '.jean', 'roles', role)
    if (!existsSync(roleDir)) continue
    for (const name of skillNames) {
      targets.push({
        role: role as AgentRole,
        skillName: name,
        destPath: resolve(roleDir, '.claude', 'skills', name, 'SKILL.md'),
      })
    }
  }

  if (targets.length === 0) {
    console.log('No role dirs found. Run `jean agent add` or `jean librarian setup` first.')
    return
  }

  console.log()
  let added = 0
  let updated = 0
  let okCount = 0

  for (const t of targets) {
    const label = `${BOLD}${t.role}${RESET}/${t.skillName}`
    const expected = readSkillTemplate(t.skillName)

    if (!existsSync(t.destPath)) {
      console.log(`  ${GREEN}add${RESET}    ${label}`)
      added++
      if (!dryRun) {
        mkdirSync(dirname(t.destPath), { recursive: true })
        writeFileSync(t.destPath, expected)
      }
      continue
    }

    if (readFileSync(t.destPath, 'utf8') === expected) {
      console.log(`  ${DIM}ok${RESET}     ${label}`)
      okCount++
    } else {
      console.log(`  ${GREEN}update${RESET} ${label}`)
      updated++
      if (!dryRun) writeFileSync(t.destPath, expected)
    }
  }

  console.log()
  const changes = added + updated
  if (changes === 0) {
    console.log(`${DIM}All ${targets.length} framework skill(s) already current.${RESET}`)
    return
  }

  if (dryRun) {
    console.log(
      `${DIM}Dry run — ${added} skill(s) would be added, ${updated} updated. Re-run without --dry-run to apply.${RESET}`,
    )
  } else {
    console.log(
      `${GREEN}Synced ${changes} skill(s) (${added} new, ${updated} updated, ${okCount} already current).${RESET}`,
    )
    console.log(`${DIM}Note: agents pick up updated skills on their next session start.${RESET}`)
  }
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

  const meta = readAgentMeta(agent.path)
  if (!meta) {
    console.error(`Could not read metadata for agent "${name}".`)
    process.exit(1)
  }
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
    rmSync(resolve(agent.path, '.jean'), { recursive: true, force: true })
    rmSync(resolve(agent.path, '.claude', 'settings.local.json'), { force: true })
    console.log(`Removed Jean config from "${name}". Directory kept at ${agent.path}`)
    return
  }

  if (agent.branch !== undefined) {
    // Worktree agent: check dirty state, remove via git
    if (!force && isWorktreeDirty(agent.path)) {
      console.error(`Agent "${name}" has uncommitted changes. Use --force to remove anyway.`)
      process.exit(1)
    }

    const bareDir = findBareRepo(dojoRoot)
    if (!bareDir) {
      console.error('No .jean/.bare/ directory found. Cannot remove worktree.')
      process.exit(1)
    }
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
      console.log(`  Branch "${agent.branch}" still exists. Delete with: git -C .jean/.bare branch -d ${agent.branch}`)
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

  // Refuse to launch if the channel isn't registered for this machine — the
  // `--dangerously-load-development-channels server:jean` flag below would
  // resolve nothing and the agent would come up with no channel (no reply /
  // memorize / register), silently. `jean setup` is a once-per-machine step.
  if (!isChannelRegistered()) {
    console.error('The Jean channel is not registered on this machine.')
    console.error('Run it once per machine first: jean setup')
    process.exit(1)
  }

  // Refuse to spawn an agent into a dojo with no running infra. The channel
  // plugin would silently retry-loop while the agent's tools fail one by one
  // — confusing and easy to miss. The plugin's retry loop is for transient
  // drops mid-session, not for missing infra at session start.
  if (!isLocalInfraAlive(resolve(dojoRoot, '.jean'))) {
    console.error(`Infra is not running for this dojo (${basename(dojoRoot)}).`)
    console.error('Start it first with: jean infra start')
    process.exit(1)
  }

  console.log(`Starting agent "${name}" in ${agent.path}...`)
  const flags = agentLaunchFlags(agent.path).split(' ')
  // Identity via env is REQUIRED, not redundant: the channel registers a session
  // into the dojo ONLY when JEAN_AGENT is set (see IS_LAUNCHED_AGENT in
  // src/channel/server.ts). A `.jean-agent.json` file in the worktree is
  // deliberately NOT sufficient — the channel is registered machine-wide, so any
  // stray `claude`/`claude -p` whose cwd is this worktree would otherwise read the
  // file and register as this agent, colliding with the real one. CC propagates
  // this process env to the stdio MCP servers it spawns; the channel reads
  // JEAN_AGENT/JEAN_ROLE/JEAN_DOJO from it (role/tags still fall back to the file).
  // Do NOT drop JEAN_AGENT — without it the agent loads the channel but never registers.
  const result = Bun.spawnSync(['claude', ...flags, '--dangerously-load-development-channels', 'server:jean'], {
    cwd: agent.path,
    env: {
      ...process.env,
      JEAN_AGENT: name,
      JEAN_ROLE: agent.role,
      JEAN_DOJO: dojoRoot,
      JEAN_AGENT_DIR: resolve(agent.path, '.jean'),
    },
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
  jean dojo init [path] [--port <N>] [--git | --git-from <repo>]    Initialize a new dojo
    --port <N>        TCP port for this dojo's infra (optional; auto-allocated from ~/.jean/dojos.json if omitted)
    --git             Create a fresh bare git repo at .jean/.bare/
    --git-from <repo> Clone an existing repo (URL or local path) as .jean/.bare/ — wrap it
    --<key> <value>   Any config key (e.g. --telegram.chatId "12345678")
  jean dojo list                              Show all registered dojos and their ports (~/.jean/dojos.json)
  jean dojo register                          Register the current dojo into ~/.jean/dojos.json
  jean dojo prune                             Drop registry entries whose dojo folder was deleted
  jean dojo move <new-path>                   Move this dojo to a new location
  jean dojo start [agents...] [--only a,b,c]  Lay out current iTerm tab: infra | sensei | workers
                                              (macOS + iTerm2; current shell becomes the infra pane)
  jean satori                                 Guided dojo setup (interactive)
  jean config set <key> <value>               Set a config value
  jean config get <key>                       Get a config value
  jean config list                            Show all config
  jean infra start                            Start infrastructure server
  jean infra stop                             Stop infrastructure server
  jean infra status                           Show infrastructure status
  jean infra url                              Print infra HTTP URL

  jean board                                  Show the kanban board
  jean send <agent> <msg>                     Send a message to an agent
  jean status                                 Infrastructure status + recent events
  jean permissions [agent]                    Show permission requests by agent
  jean context recent [--since <id>] [--limit <N>] [--json]
                                              Memorize events not yet consolidated into the wiki

  jean task log <id>                          Show task event history
  jean task undo <id> [--actor <name>]        Revert the most recent status change
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
  jean agent sync-permissions [--dry-run]     Refresh existing agents' settings.local.json
                                              with current framework defaults (additive)
  jean agent sync-skills [--dry-run]          Refresh existing role dirs' SKILL.md files
                                              from src/cli/skills/ (overwrite if changed)

  jean peek <dojo-path>                       Read another dojo's state from disk
    --since-last     Only events since last peek; updates cursor
    --since <id>     Only events with id > <id>; no cursor update
    --last <N>       Tail N recent significant events (default 20)
    --json           Machine-readable output
  jean peer add <id> --origin <path> --description "..."
                                              Register another dojo as a peer
  jean peer list                              List registered peers
  jean peer remove <id>                       Unregister a peer
  jean peer link <other-dojo-path>            Register mutually with another dojo`)
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

await main()
