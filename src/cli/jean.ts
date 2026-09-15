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
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
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
import {
  CONSOLIDATE_WIKI_PROMPT,
  CONSOLIDATE_WIKI_TRIGGER_ID,
  LIBRARIAN_DEFAULT_CRON,
  LIBRARIAN_DEFAULT_MODEL,
  provisionLibrarianTrigger,
} from '../infra/librarian.ts'
import { identityFromConfig, loadPeers, type Peer, savePeers } from '../infra/peers.ts'
import { allocatePort, pruneStale, readRegistry, registryPath, upsertDojo, writeRegistry } from '../infra/registry.ts'
import {
  findDojoRootFrom,
  isLocalInfraAlive,
  isOwnInfra,
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
const RED = '\x1b[31m'

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

/**
 * Ship the librarian role into a dojo: raw_context/ dir, the three consolidate-
 * wiki skills, and a settings.local.json carrying librarian permissions. Pure
 * filesystem — no running infra required — so both `jean dojo init` and the
 * standalone `jean librarian setup` share it. The trigger is provisioned
 * separately (provisionLibrarianTrigger), because it writes to the event log.
 */
function provisionLibrarianRole(dojoRoot: string, opts?: { quiet?: boolean }): void {
  const jeanDir = resolve(dojoRoot, '.jean')
  const roleDir = resolve(jeanDir, 'roles', 'librarian')
  const quiet = opts?.quiet ?? false

  // Create raw_context/ if missing — librarian reads from here, never writes.
  // Empty dir is fine; users drop source material in as they accumulate it.
  const rawContextDir = resolve(jeanDir, 'raw_context')
  if (!existsSync(rawContextDir)) {
    mkdirSync(rawContextDir, { recursive: true })
    if (!quiet)
      console.log(
        `  ${GREEN}created${RESET} ${relative(dojoRoot, rawContextDir)}/  (drop human-curated source material here)`,
      )
  }

  shipSkill(roleDir, 'consolidate-wiki')
  shipSkill(roleDir, 'consolidate-wiki-draft')
  shipSkill(roleDir, 'consolidate-wiki-review')

  // No hooks — and no longer a contrast with anything, since agents stopped
  // getting them too (see `writeJeanConfig`). A one-shot process had nothing
  // to phone home about; nothing does now.
  const settingsDir = resolve(roleDir, '.claude')
  const settingsPath = resolve(settingsDir, 'settings.local.json')
  if (!existsSync(settingsPath)) {
    mkdirSync(settingsDir, { recursive: true })
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ permissions: defaultPermissions('librarian', dojoRoot) }, null, 2)}\n`,
    )
    if (!quiet) console.log(`  ${GREEN}wrote${RESET} ${relative(dojoRoot, settingsPath)}`)
  } else if (!quiet) {
    console.log(`  ${DIM}skip${RESET}  ${relative(dojoRoot, settingsPath)} (already exists)`)
  }
}

function cmdLibrarianSetup() {
  const dojoRoot = findDojoRoot()
  provisionLibrarianRole(dojoRoot)

  console.log(`\n${GREEN}Librarian setup complete in ${dojoRoot}/.jean/roles/librarian/${RESET}`)
  console.log()
  console.log(`${DIM}New dojos get the librarian automatically at 'jean dojo init'.${RESET}`)
  console.log(`To add the consolidate-wiki trigger to THIS existing dojo (infra must be running):`)
  console.log(`  jean trigger add --kind headless --agent librarian \\`)
  console.log(
    `    --cron "${LIBRARIAN_DEFAULT_CRON}" --id ${CONSOLIDATE_WIKI_TRIGGER_ID} --model ${LIBRARIAN_DEFAULT_MODEL} \\`,
  )
  console.log(`    --prompt "${CONSOLIDATE_WIKI_PROMPT}"`)
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
  const result = (await res.json()) as { delivered?: boolean; queued?: boolean }

  // Dojo agents queue (delivery unification, 2026-08-11): the message sits in
  // the target's mailbox and infra announces it — connected now or on its next
  // connect. Adapter targets (the bridge, peers) still answer delivered/not.
  if (result.queued) {
    console.log(`Message queued for "${agent}" — infra will announce it (now if connected, else on reconnect).`)
  } else if (result.delivered) {
    console.log(`Message sent to "${agent}".`)
  } else {
    console.log(`No agent or peer named "${agent}" is known here. Nothing was sent — check the name (jean agent list).`)
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
      await cmdDojoInit(args.slice(1))
      break
    case 'move':
      await cmdDojoMove(args.slice(1))
      break
    case 'repair':
      await cmdDojoRepair(args.slice(1))
      break
    case 'export':
      await cmdDojoExport(args.slice(1))
      break
    case 'import':
      await cmdDojoImport(args.slice(1))
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
      console.error('Usage: jean dojo <init|move|repair|export|import|start|list|register|prune> ...')
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

const WORKSPACE_README = `# Workspace — the sensei's own repo

Sensei-only writes; all agents may read. Two admission classes, nothing else:
- Systems the sensei runs (cursors, snapshots, scripts) — one folder per function.
- Records the sensei wrote (writeups too rich for the lossy wiki).

Nothing lives here without a memorized wiki pointer. Commit every change.
See the \`context\` skill ("Where data lives") for the full model.
`

/** Create `.jean/workspace/` as a git repo of its own (sensei-only writes; see
 *  the context skill's data-homes model). No-ops when `workspace/.git` already
 *  exists; does not repair a partially-created workspace beyond that. All git
 *  failures are non-fatal (the folder still works as a home; history is what's
 *  lost) but warned loudly — a silent historyless workspace would recreate the
 *  exact fragility the model exists to prevent. */
function ensureWorkspace(jeanDir: string): void {
  const workspaceDir = resolve(jeanDir, 'workspace')
  mkdirSync(workspaceDir, { recursive: true })
  if (existsSync(resolve(workspaceDir, '.git'))) return
  const gitOpts = { stdout: 'pipe' as const, stderr: 'pipe' as const }
  const warn = (label: string, result: { stderr: { toString(): string } }) =>
    console.error(`warning: workspace git ${label} failed (${result.stderr.toString().trim()})`)
  const init = Bun.spawnSync(['git', 'init', '--initial-branch=main', workspaceDir], gitOpts)
  if (init.exitCode !== 0) {
    warn('init', init)
    return
  }
  if (!existsSync(resolve(workspaceDir, 'README.md'))) {
    writeFileSync(resolve(workspaceDir, 'README.md'), WORKSPACE_README)
  }
  // -A: a pre-existing (bare-folder) workspace gets its files into history too,
  // not just the README. Inline identity so the commit never depends on global
  // git config (a fresh machine without user.email would silently fail here).
  const add = Bun.spawnSync(['git', '-C', workspaceDir, 'add', '-A'], gitOpts)
  if (add.exitCode !== 0) {
    warn('add', add)
    return
  }
  const commit = Bun.spawnSync(
    [
      'git',
      '-C',
      workspaceDir,
      '-c',
      'user.name=jean',
      '-c',
      'user.email=jean@localhost',
      'commit',
      '-m',
      'workspace: initial commit',
    ],
    gitOpts,
  )
  if (commit.exitCode !== 0) warn('commit', commit)
}

async function cmdDojoInit(args: string[]) {
  const useGit = args.includes('--git')
  const noLibrarian = args.includes('--no-librarian')
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
    if (key === 'no-librarian') continue // boolean flag, not a config key
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

  // Sensei's workspace (own git repo) — the maintained-state home beyond
  // wiki/raw_context. See the context skill ("Where data lives").
  ensureWorkspace(jeanDir)

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

  // Provision the librarian here — init is the ONE place a dojo is configured.
  // Ships the role (skills + permissions) and writes the consolidate-wiki trigger
  // into the brand-new event log: infra is down, so the direct append is
  // race-free, and the first `infra start` replays + schedules it. Deliberately
  // never reconciled on restart (see provisionLibrarianTrigger). --no-librarian
  // opts out (throwaway/experimental dojos that don't want a nightly wiki run).
  let librarianProvisioned = false
  if (!noLibrarian) {
    provisionLibrarianRole(dojoRoot, { quiet: true })
    await provisionLibrarianTrigger({ historyPath: resolve(jeanDir, 'history.jsonl') })
    librarianProvisioned = true
  }

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
  console.log(`      workspace/       ${DIM}← sensei's own repo (state + records)${RESET}`)
  console.log(`      sessions/        ${DIM}← agent session handles${RESET}`)
  console.log(`      jean.config.json ${DIM}← configuration${RESET}`)
  console.log()
  if (librarianProvisioned) {
    console.log(
      `${GREEN}Librarian scheduled${RESET} ${DIM}— consolidates memory → wiki nightly (${LIBRARIAN_DEFAULT_CRON}, ${LIBRARIAN_DEFAULT_MODEL}); first run after 'infra start'.${RESET}`,
    )
    console.log(
      `  ${DIM}see it: jean trigger list   ·   turn it off: jean trigger remove ${CONSOLIDATE_WIKI_TRIGGER_ID}${RESET}`,
    )
    console.log()
  }
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
 * Move the current dojo to a new path, then repair it there. Intended to keep
 * a dojo move down to a single command — critical-path for organizing
 * command-center dojo layouts.
 */
async function cmdDojoMove(args: string[]) {
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
  // Same-machine, pre-rename, so a live pid is trustworthy here in a way a
  // COPIED pid file is not (repairDojo below presumes copied state is stale;
  // this check is what stops the rename itself, before repair ever runs).
  const dataDir = resolve(oldRoot, '.jean')
  const { pid } = readRuntimeFiles(dataDir)
  if (pid !== null && isProcessAlive(pid)) {
    console.error(`Infra is running (pid ${pid}). Run 'jean infra stop' first.`)
    process.exit(1)
  }

  renameSync(oldRoot, newRoot)
  // Our own cwd may have been inside the old root — now a ghost inode, which
  // makes any posix_spawn fail with ENOENT. Rebase onto the new root before
  // repairing.
  if (process.cwd().startsWith(oldRoot)) process.chdir(newRoot)

  console.log(`${GREEN}Dojo moved${RESET}`)
  console.log(`  From: ${oldRoot}`)
  console.log(`  To:   ${newRoot}`)
  console.log()

  // Everything that records the old path — worktrees, agent permissions, the
  // registry — gets fixed up by the same repair a copy-to-a-new-machine needs.
  await repairDojo(newRoot)

  if (process.cwd().startsWith(oldRoot)) {
    console.log()
    console.log(`${DIM}Your shell is still on the old path — cd to the new location.${RESET}`)
  }
  console.log()
  console.log(`${DIM}Note: Claude Code session history is keyed by absolute cwd.${RESET}`)
  console.log(`${DIM}Past sessions from the old path won't be found by 'claude -c' here.${RESET}`)
}

// ── Dojo repair: fix a dojo's records of where it lives ──────────

/**
 * Parse an absolute DIRECTORY-glob Edit rule (`Edit(//path/**)`, what
 * `fileRule`'s default emits) back to the filesystem path it targets.
 *
 * Returns null for anything else — including the framework's one absolute
 * EXACT-FILE rule, `Edit(//<worktree>/.mcp.json)` (the self-escalation deny,
 * permissions.ts:215). That file is never supposed to exist — Jean writes no
 * per-worktree .mcp.json by design — so an existence check would strip that
 * deny on every single repair, forever. Only the directory-glob form, whose
 * target is supposed to exist, is checked.
 */
function absoluteGlobRuleTarget(rule: string): string | null {
  const m = /^Edit\(\/\/(.+)\/\*\*\)$/.exec(rule)
  return m ? `/${m[1]}` : null
}

type RepairOpts = { dryRun?: boolean }

/** What repair found that the caller might want to act on — `jean dojo
 *  import` uses this to decide which next-step hints are worth printing;
 *  `cmdDojoRepair` and `cmdDojoMove` just let it fall on the floor. */
type RepairSummary = {
  channelMissing: boolean
  droppedPeers: string[]
  /** Set when the registry step could not register this dojo — no port
   *  configured, or the configured one collides with another existing-path
   *  dojo. Not a failure (nothing errored; the dojo just isn't registered
   *  yet), but a caller printing "Done." unconditionally would bury it. */
  registryIncomplete: string | null
}

/**
 * Bring every record of this dojo's own absolute path up to date with
 * `dojoRoot` — wherever it actually is right now. Used standalone, after a
 * dojo directory is copied to a new machine, and by `cmdDojoMove`, for which
 * a move is exactly this repair run at a path that didn't exist a moment ago.
 *
 * Presumes copied state is stale rather than assuming anything is running —
 * this is typically the FIRST command run after a copy. The one refusal is a
 * VERIFIED one: the recorded port answers, right now, as this dojo's own
 * infra — `enforceSingleInstance`'s own rule (server.ts), applied here
 * instead of at a start.
 */
async function repairDojo(dojoRoot: string, opts: RepairOpts = {}): Promise<RepairSummary> {
  const dryRun = opts.dryRun ?? false
  const plan = dryRun ? 'would ' : ''
  const dataDir = resolve(dojoRoot, '.jean')
  const bareDir = resolve(dataDir, '.bare')

  if (existsSync(bareDir) && !Bun.which('git')) {
    console.error(`This dojo has a git bare repo (${bareDir}) but 'git' is not on PATH.`)
    // Named explicitly rather than "re-run": a caller reaching repairDojo via
    // import has already extracted to dojoRoot, and re-running import itself
    // would refuse — the destination now exists. `jean dojo repair` is the
    // one recovery command that's always correct here, from any caller.
    console.error(`Install git, then run 'jean dojo repair' from inside ${dojoRoot}.`)
    process.exit(1)
  }

  // ── Runtime files — presumed stale until PROVEN otherwise ────────
  //
  // A recorded pid being alive proves nothing on its own: pids get reused,
  // and on a freshly copied dojo it is a coincidence by construction. The one
  // question worth asking is the one `enforceSingleInstance` already asks at
  // every infra start — does the recorded port answer, right now, as THIS
  // dojo's own infra? Everything else (no pid, a dead pid, a live pid that
  // answers as someone else's infra or doesn't answer at all) is stale copied
  // data, removed by default rather than guessed about.
  const pidFile = resolve(dataDir, 'infra.pid')
  const portFile = resolve(dataDir, 'infra.port')
  const { pid, port } = readRuntimeFiles(dataDir)
  if (pid === null && port === null) {
    console.log(`  ${DIM}runtime${RESET}      no stale runtime files`)
  } else {
    let verifiedOurs = false
    if (pid !== null && port !== null && isProcessAlive(pid)) {
      let info = await probeInfra(port)
      if (info === null) {
        // A loaded machine can be slow to answer right after a copy — one retry.
        await new Promise((r) => setTimeout(r, 2000))
        info = await probeInfra(port)
      }
      verifiedOurs = isOwnInfra(info, dataDir)
    }
    if (verifiedOurs) {
      console.error(`Infra is running for this dojo (pid ${pid}, port ${port}). Run 'jean infra stop' first.`)
      process.exit(1)
    }
    console.log(
      `  ${DIM}runtime${RESET}      ${plan}remove stale infra.pid / infra.port${pid !== null ? ` (pid ${pid})` : ''}`,
    )
    if (!dryRun) {
      rmSync(pidFile, { force: true })
      rmSync(portFile, { force: true })
    }
  }

  // ── Git worktrees ──────────────────────────────────────────────
  //
  // Discover agent dirs by scanning for .jean/.jean-agent.json directly —
  // NOT discoverAgents()/`git worktree list`, which reads exactly the stale
  // pointers this step exists to fix, and returns nothing until it has run.
  // A top-level directory with no .jean-agent.json is unofficial (a plain
  // `main/` checkout with no agent identity is one) — reported
  // as unrecognised, never touched. Not every agent is a worktree: a `--no-
  // worktree` agent has no `.git` at all, and an `--existing` agent can wrap
  // its OWN independent repo (a `.git` DIRECTORY, not a worktree of this
  // dojo's bare) — only a `.git` FILE names a worktree admin entry, so only
  // those are worktree-repaired; every agent still gets permissions.
  //
  // The two pointer files are written DIRECTLY rather than by calling `git
  // worktree repair` — measured (git 2.39) that command does more than fix
  // the paths given to it: run from a COPY whose SOURCE dojo still exists on
  // the same machine, it follows the copy's (still-stale, blindly-copied)
  // admin entries to the SOURCE's still-valid `.git` files and REWRITES
  // THOSE — cross-wiring a dojo nobody asked to touch, including worktrees
  // never named on the command line, while leaving the copy's own worktree
  // pointing at the SOURCE's bare. Exit 0 throughout; `git status` succeeds
  // on both sides while pointing at the wrong object stores. Writing only
  // the two files this agent's OWN entry needs — read fresh from its own
  // (stale but textually intact) `.git` file, written only under dojoRoot —
  // cannot reach outside the dojo at all, so it cannot reach the source.
  const worktreePaths: string[] = []
  const unrecognised: string[] = []
  try {
    for (const entry of readdirSync(dojoRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const p = resolve(dojoRoot, entry.name)
      if (existsSync(resolve(p, '.jean', '.jean-agent.json'))) {
        const gitPath = resolve(p, '.git')
        if (existsSync(gitPath) && statSync(gitPath).isFile()) worktreePaths.push(p)
      } else {
        unrecognised.push(entry.name)
      }
    }
  } catch {}

  if (!existsSync(bareDir)) {
    console.log(`  ${DIM}worktrees${RESET}    skip — no .jean/.bare`)
  } else if (worktreePaths.length === 0) {
    console.log(`  ${DIM}worktrees${RESET}    no agent worktrees found`)
  } else {
    const fixed: string[] = []
    const unrepairable: string[] = []
    for (const p of worktreePaths) {
      const gitFile = resolve(p, '.git')
      const match = /^gitdir: (.+)$/.exec(readFileSync(gitFile, 'utf8').trim())
      const entryName = match?.[1] ? basename(match[1]) : null
      const entryDir = entryName ? resolve(bareDir, 'worktrees', entryName) : null
      if (!entryDir || !existsSync(entryDir)) {
        unrepairable.push(basename(p))
        continue
      }
      // The entry is chosen by the basename of whatever this agent's `.git`
      // names — which a foreign worktree, elsewhere, whose directory happens
      // to share this one's name would also produce. Only reuse an entry
      // whose OWN last-recorded worktree path already agrees with this
      // directory's name: a real copy/move keeps the directory's name, so
      // its stale entry still names `.../<this name>/.git`; anything else is
      // an entry that belongs to someone else and is left unrepaired rather
      // than attached to the wrong agent.
      const entryGitdirFile = resolve(entryDir, 'gitdir')
      const recordedPath = existsSync(entryGitdirFile) ? readFileSync(entryGitdirFile, 'utf8').trim() : null
      if (!recordedPath || basename(dirname(recordedPath)) !== basename(p)) {
        unrepairable.push(basename(p))
        continue
      }
      fixed.push(basename(p))
      if (dryRun) continue
      writeFileSync(gitFile, `gitdir: ${entryDir}\n`)
      writeFileSync(entryGitdirFile, `${gitFile}\n`)
    }
    if (fixed.length > 0) {
      console.log(`  ${DIM}worktrees${RESET}    ${plan}repair ${fixed.length} agent(s): ${fixed.join(', ')}`)
    }
    if (unrepairable.length > 0) {
      console.log(
        `  ${DIM}worktrees${RESET}    could not repair (no .jean/.bare/worktrees entry matches this agent): ${unrepairable.join(', ')}`,
      )
    }
  }
  if (unrecognised.length > 0) {
    console.log(
      `  ${DIM}worktrees${RESET}    unrecognised, not touched: ${unrecognised.join(', ')} ${DIM}(no .jean-agent.json)${RESET}`,
    )
  }

  // ── Registry ───────────────────────────────────────────────────
  //
  // Not carried between machines — on a fresh machine this is the first
  // entry, and pruning is a no-op. Prune first (drops a move's now-vanished
  // old path), then upsert — but never into a port collision: that would
  // otherwise put two dojos on one port with no warning until the second
  // infra failed to bind.
  const cfg = readConfig(dataDir)
  const beforeRegistry = readRegistry()
  const afterRegistry = pruneStale(beforeRegistry)
  const droppedCount = beforeRegistry.length - afterRegistry.length
  if (!dryRun) writeRegistry(afterRegistry)
  const prunedNote =
    droppedCount > 0 ? `; ${plan}prune ${droppedCount} stale ${droppedCount === 1 ? 'entry' : 'entries'}` : ''
  let registryIncomplete: string | null = null
  if (cfg.port === undefined) {
    registryIncomplete = 'no port in jean.config.json — jean config set port <N>, then jean dojo register'
    console.log(`  ${DIM}registry${RESET}     ${registryIncomplete}${prunedNote}`)
  } else {
    const alloc = allocatePort(cfg.port, dojoRoot)
    if ('error' in alloc) {
      const free = allocatePort(undefined, dojoRoot)
      const freeNote = 'port' in free ? ` Next free port: ${free.port}.` : ''
      registryIncomplete = `${alloc.error}${freeNote}`
      console.log(`  ${DIM}registry${RESET}     ${registryIncomplete}${prunedNote}`)
    } else {
      if (!dryRun) upsertDojo({ path: dojoRoot, port: cfg.port, identity: cfg.identity })
      console.log(`  ${DIM}registry${RESET}     ${plan}register at ${registryPath()} (port ${cfg.port})${prunedNote}`)
    }
  }

  // ── Permissions ────────────────────────────────────────────────
  //
  // Same merge logic `jean agent sync-permissions` runs, regenerating every
  // agent's (and the librarian's) rules for the current path — plus, only
  // here, dropping any remaining absolute DIRECTORY rule whose target no
  // longer exists: old-root leftovers and senseiWritePaths ghosts alike.
  console.log(`  ${DIM}permissions${RESET}`)
  const permResult = syncAgentPermissions(dojoRoot, { dryRun, indent: '    ', dropDeadAbsolute: true })
  if (permResult.targetCount === 0) {
    // syncAgentPermissions already printed "No agents found." at this indent.
  } else if (permResult.totalChanges === 0) {
    console.log(`    ${DIM}all ${permResult.targetCount} agent(s) already current${RESET}`)
  } else {
    console.log(`    ${plan}sync ${permResult.totalChanges} rule(s) across ${permResult.touchedAgents} agent(s)`)
  }

  // ── Peers ──────────────────────────────────────────────────────
  //
  // Not carried between machines either — re-established with `jean peer
  // link` once every dojo involved is up again. Same rule as permissions:
  // check the recorded path; if it doesn't exist, drop the record and say so.
  const peersFile = loadPeers(dataDir)
  const peerEntries = Object.entries(peersFile.peers)
  const dead = peerEntries.filter(
    ([, peer]) => peer.origin.type !== 'local-path' || !existsSync(resolve(peer.origin.path, '.jean')),
  )
  if (dead.length > 0 && !dryRun) {
    for (const [id] of dead) delete peersFile.peers[id]
    savePeers(dataDir, peersFile)
  }
  if (peerEntries.length === 0) {
    console.log(`  ${DIM}peers${RESET}        none registered`)
  } else if (dead.length === 0) {
    console.log(`  ${DIM}peers${RESET}        ${peerEntries.length} registered, all resolve`)
  } else {
    console.log(`  ${DIM}peers${RESET}        ${plan}drop ${dead.length} unresolved:`)
    for (const [id] of dead) {
      console.log(`                 ${id} — once it's up at its new location: jean peer link <path>`)
    }
  }

  // ── Machine checks — reported only; none of this is this dojo's to fix ──
  const channelMissing = !isChannelRegistered()
  if (channelMissing) {
    console.log(`  ${DIM}channel${RESET}      not registered on this machine — run: jean setup`)
  }
  if (cfg.telegram?.botToken) {
    console.log(
      `  ${DIM}telegram${RESET}     botToken is set — Telegram allows one poller per token: stop the source machine's infra before starting here`,
    )
  }

  return { channelMissing, droppedPeers: dead.map(([id]) => id), registryIncomplete }
}

async function cmdDojoRepair(args: string[]) {
  const dryRun = args.includes('--dry-run')
  if (args.some((a) => !a.startsWith('--'))) {
    console.error('Usage: jean dojo repair [--dry-run]')
    console.error('Run from inside the dojo whose records need to point here.')
    process.exit(1)
  }
  // realpath before any comparison this run makes — macOS /var ↔ /private/var
  // is the classic trap, and every generated permission rule is wrong under
  // a symlinked root otherwise (move already does this for the same reason).
  const dojoRoot = realpathSync(findDojoRoot())
  console.log(`${GREEN}${dryRun ? 'Dry run: would repair' : 'Repairing'} dojo at ${dojoRoot}${RESET}`)
  console.log()
  await repairDojo(dojoRoot, { dryRun })
  console.log()
  console.log(`${GREEN}${dryRun ? 'Dry run complete — nothing was written.' : 'Done.'}${RESET}`)
}

// ── Dojo export / import: move a dojo between machines ───────────

/** How many sample dirty paths to name before falling back to "+N more" —
 *  a worktree with hundreds of uncommitted paths (measured, in the wild)
 *  would otherwise scroll the whole pre-flight off screen. */
const DIRTY_SAMPLE_SIZE = 3

type RepoCheck =
  | { kind: 'error'; message: string }
  | {
      kind: 'ok'
      dirty: boolean
      dirtyCount: number
      /** Up to DIRTY_SAMPLE_SIZE paths, for a glimpse of what's uncommitted. */
      dirtySample: string[]
      /** HEAD isn't on a branch at all — distinct from "on a branch with no
       *  upstream". Decided by `symbolic-ref`'s own exit code, not by
       *  matching git's (locale-dependent) error text against the `@{u}`
       *  lookup below, which fails the same way — exit 128 — for both. */
      detached: boolean
      /** A branch has `branch.<name>.merge` configured (it once had an
       *  upstream), but the remote-tracking ref itself is gone — distinct
       *  from never having one configured. Decided by `git config --get`'s
       *  exit code on that key, once more not by matching error text. */
      upstreamGone: boolean
      upstream: string | null
      ahead: number
      behind: number
    }

/** `git status`/upstream state for one repo — an agent worktree, `.jean/context`,
 *  or `.jean/workspace`. A branch with no upstream reports that explicitly:
 *  ahead/behind have no meaning there, and reporting zero for both would read
 *  as clean when it is really undefined. A git command that itself fails —
 *  not "no upstream", an actual error — is reported as an error rather than
 *  silently folded into "clean". */
function checkGitRepo(dir: string): RepoCheck {
  const status = Bun.spawnSync(['git', '-C', dir, 'status', '--porcelain'], { stdout: 'pipe', stderr: 'pipe' })
  if (status.exitCode !== 0) {
    return { kind: 'error', message: status.stderr.toString().trim() || `git status exited ${status.exitCode}` }
  }
  const dirtyLines = status.stdout
    .toString()
    .split('\n')
    .filter((l) => l.trim().length > 0)
  // Porcelain format: a 2-char status code, a space, then the path.
  const dirtySample = dirtyLines.slice(0, DIRTY_SAMPLE_SIZE).map((l) => l.slice(3))

  const onBranch = Bun.spawnSync(['git', '-C', dir, 'symbolic-ref', '-q', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' })
  const detached = onBranch.exitCode !== 0

  const upstreamCheck = Bun.spawnSync(['git', '-C', dir, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (upstreamCheck.exitCode !== 0) {
    // "Never configured" and "configured, but the remote-tracking ref is
    // gone" fail the @{u} lookup identically (exit 128); branch.<name>.merge
    // being SET is what tells them apart — only meaningful on a branch.
    let upstreamGone = false
    if (!detached) {
      const branchName = onBranch.stdout
        .toString()
        .trim()
        .replace(/^refs\/heads\//, '')
      const configured = Bun.spawnSync(['git', '-C', dir, 'config', '--get', `branch.${branchName}.merge`], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      upstreamGone = configured.exitCode === 0
    }
    return {
      kind: 'ok',
      dirty: dirtyLines.length > 0,
      dirtyCount: dirtyLines.length,
      dirtySample,
      detached,
      upstreamGone,
      upstream: null,
      ahead: 0,
      behind: 0,
    }
  }
  const upstream = upstreamCheck.stdout.toString().trim()
  // left-right with a THREE-dot range gives both counts in one call:
  // "<behind>\t<ahead>\n" — commits only reachable from @{u} (left), then
  // only from HEAD (right). Measured.
  const counts = Bun.spawnSync(['git', '-C', dir, 'rev-list', '--left-right', '--count', '@{u}...HEAD'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (counts.exitCode !== 0) {
    return { kind: 'error', message: counts.stderr.toString().trim() || `git rev-list exited ${counts.exitCode}` }
  }
  const [left, right] = counts.stdout.toString().trim().split(/\s+/)
  return {
    kind: 'ok',
    dirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    dirtySample,
    detached,
    upstreamGone: false,
    upstream,
    ahead: Number(right ?? 0),
    behind: Number(left ?? 0),
  }
}

function formatGitRepoCheck(label: string, check: RepoCheck): string {
  if (check.kind === 'error') return `${label}: git check failed (${check.message})`
  const parts: string[] = []
  if (check.dirty) {
    const remainder = check.dirtyCount - check.dirtySample.length
    const sample = check.dirtySample.join(', ') + (remainder > 0 ? `, +${remainder} more` : '')
    parts.push(`${check.dirtyCount} uncommitted change(s) (${sample})`)
  }
  if (check.detached) parts.push('detached HEAD — not on a branch')
  else if (check.upstreamGone) parts.push('upstream branch is gone')
  else if (check.upstream === null) parts.push('no upstream')
  else {
    if (check.ahead > 0) parts.push(`${check.ahead} unpushed commit(s) to ${check.upstream}`)
    if (check.behind > 0) parts.push(`${check.behind} behind ${check.upstream}`)
  }
  if (parts.length === 0) return `${label}: clean, up to date with ${check.upstream}`
  return `${label}: ${parts.join(', ')}`
}

/** Single-quote a string for verbatim use in a POSIX shell command line —
 *  for printed instructions meant to be copy-pasted, where the path itself
 *  (a dojo directory) is not under our control and may contain a space. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(1)} ${units[i]}`
}

/** Top-level dojo-root entries, split into carried agent directories (a dir
 *  with .jean/.jean-agent.json) and everything else. Files count too, unlike
 *  repair's worktree-only scan — a stray FILE at the root (a hand-written
 *  script, say) is just as much "will not travel" as a stray directory. */
function scanDojoRootEntries(dojoRoot: string): { agentPaths: string[]; unrecognised: string[] } {
  const agentPaths: string[] = []
  const unrecognised: string[] = []
  for (const entry of readdirSync(dojoRoot, { withFileTypes: true })) {
    if (entry.name === '.jean') continue
    const p = resolve(dojoRoot, entry.name)
    if (entry.isDirectory() && existsSync(resolve(p, '.jean', '.jean-agent.json'))) {
      agentPaths.push(p)
    } else {
      unrecognised.push(entry.name)
    }
  }
  return { agentPaths, unrecognised }
}

/**
 * Archive a dojo for moving to another machine. Refuses only on a VERIFIED
 * live infra for THIS dojo (the same probe `repair` uses) — a tar of a dojo
 * whose own infra is still appending to history.jsonl tears it mid-write.
 *
 * The pre-flight states the contract and shows what it found; a stray
 * top-level entry or an absolute path is reported, never silently dropped or
 * silently carried. What travels is the bare repo — committed-to-any-branch
 * survives, uncommitted work is the dojo's own risk to accept.
 */
async function cmdDojoExport(args: string[]) {
  const yesFlag = args.includes('--yes')
  const outIdx = args.indexOf('--out')
  const outArg = outIdx >= 0 ? args[outIdx + 1] : undefined
  if (outIdx >= 0 && (!outArg || outArg.startsWith('--'))) {
    console.error('--out requires a file path.')
    process.exit(1)
  }
  const unexpected = args.filter((a, i) => a !== '--yes' && a !== '--out' && !(outIdx >= 0 && i === outIdx + 1))
  if (unexpected.length > 0) {
    console.error('Usage: jean dojo export [--out <file>] [--yes]')
    console.error(`Unexpected argument: ${unexpected[0]}`)
    process.exit(1)
  }

  const dojoRoot = realpathSync(findDojoRoot())
  const dataDir = resolve(dojoRoot, '.jean')
  const dojoName = basename(dojoRoot)
  const cfg = readConfig(dataDir)

  // The exclude patterns built below rely on bsdtar/libarchive glob
  // semantics (the `^` anchor and backslash-escapes); GNU tar reads `^` as a
  // literal, so every anchored exclude would silently match nothing but
  // `node_modules` would still work, and unrecognised entries would travel.
  // Refuse up front rather than archive something the excludes never
  // actually applied to.
  const tarVersion = Bun.spawnSync(['tar', '--version'], { stdout: 'pipe', stderr: 'pipe' })
  if (!tarVersion.stdout.toString().includes('bsdtar')) {
    console.error("This command's exclude patterns assume bsdtar (macOS's default tar).")
    console.error("The 'tar' on this PATH is not bsdtar.")
    process.exit(1)
  }

  // .jean/context and .jean/workspace are git repos BY REQUIREMENT (dojo init
  // git-inits workspace; the librarian git-inits context on its first run) —
  // present but not a git repo is a dojo that predates that design, and
  // export refuses rather than silently archiving a non-repo where a repo
  // belongs. Absent is fine (nothing to export); this is a hard stop before
  // the pre-flight prompt, not a pre-flight finding — export does not fix it
  // itself, since that would mutate the source dojo for an operation meant
  // to only read it.
  for (const [label, dir] of [
    ['.jean/context', resolve(dataDir, 'context')],
    ['.jean/workspace', resolve(dataDir, 'workspace')],
  ] as const) {
    if (existsSync(dir) && !existsSync(resolve(dir, '.git'))) {
      // Single-quoted so the printed commands work verbatim, copy-pasted,
      // even when the dojo's own path contains a space.
      const q = shellQuote(dir)
      console.error(`${label} exists but is not a git repository — it is meant to always be one.`)
      console.error('Fix it first, then re-run export:')
      console.error(`  git -C ${q} init -q -b main`)
      console.error(`  git -C ${q} add -A`)
      console.error(`  git -C ${q} commit -q -m "initial commit"`)
      process.exit(1)
    }
  }

  // Validate the destination before the pre-flight prompt — a doomed export
  // should fail fast, not after the user has already said yes.
  const dateStamp = new Date().toISOString().slice(0, 10)
  // The dojo's directory name, not `cfg.identity` — identity is free text
  // and may contain a `/`, which would otherwise land inside a path.
  const defaultOut = resolve(dirname(dojoRoot), `${dojoName}-${dateStamp}.tar.gz`)
  const outArgResolved = resolve(outArg ?? defaultOut)
  const outParent = dirname(outArgResolved)
  if (!existsSync(outParent)) {
    console.error(`--out's directory does not exist: ${outParent}`)
    process.exit(1)
  }
  // Resolve the parent through realpath before the inside-dojo comparison —
  // a symlinked parent (e.g. a shortcut into the dojo) would otherwise
  // compare unequal to the (already realpath'd) dojoRoot while writing
  // physically inside it, which tar would then try to archive into itself.
  const outPath = resolve(realpathSync(outParent), basename(outArgResolved))
  if (outPath === dojoRoot || outPath.startsWith(`${dojoRoot}${sep}`)) {
    console.error(`Refusing to write the archive inside the dojo itself: ${outPath}`)
    process.exit(1)
  }
  // Atomically claim the destination now, rather than an existsSync check
  // separate from whatever later creates the file — that gap is exactly the
  // window import's own destination check had to close (see cmdDojoImport).
  // `tar -cf` itself has no no-clobber option; it happily overwrites, so the
  // claim is a zero-byte placeholder tar's own write then fills in.
  try {
    writeFileSync(outPath, '', { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      console.error(`Archive already exists: ${outPath}`)
      process.exit(1)
    }
    throw err
  }
  // From here on, any refusal must give up the claim rather than leave an
  // empty, orphaned placeholder where an archive never actually landed.
  const abort = (message: string): never => {
    rmSync(outPath, { force: true })
    console.error(message)
    process.exit(1)
  }

  const { pid, port } = readRuntimeFiles(dataDir)
  if (pid !== null && port !== null && isProcessAlive(pid)) {
    let info = await probeInfra(port)
    if (info === null) {
      await new Promise((r) => setTimeout(r, 2000))
      info = await probeInfra(port)
    }
    if (isOwnInfra(info, dataDir)) {
      abort(`Infra is running for this dojo (pid ${pid}, port ${port}). Run 'jean infra stop' first.`)
    }
  }

  const { agentPaths, unrecognised } = scanDojoRootEntries(dojoRoot)

  console.log(`${GREEN}Pre-flight: ${dojoRoot}${RESET}`)
  console.log()

  const repos: { label: string; path: string }[] = [
    ...agentPaths.map((p) => ({ label: basename(p), path: p })),
    { label: '.jean/context', path: resolve(dataDir, 'context') },
    { label: '.jean/workspace', path: resolve(dataDir, 'workspace') },
  ]
  for (const r of repos) {
    if (!existsSync(resolve(r.path, '.git'))) continue
    console.log(`  ${formatGitRepoCheck(r.label, checkGitRepo(r.path))}`)
  }

  if (unrecognised.length > 0) {
    console.log()
    for (const name of unrecognised) console.log(`  ${name}: unrecognised top-level entry — will not travel`)
  }

  // A relative senseiWritePaths entry resolves against the dojo root and
  // survives a move fine; only absolute-style (leading `/` or `~/`) ones name
  // a fixed machine location that may not exist, or mean something else, on
  // the destination.
  const writePaths = (cfg.senseiWritePaths ?? []).filter((p) => p.startsWith('/') || p.startsWith('~/'))
  const peersFile = loadPeers(dataDir)
  const peerEntries = Object.entries(peersFile.peers).filter(
    (e): e is [string, Peer & { origin: { type: 'local-path'; path: string } }] => e[1].origin.type === 'local-path',
  )
  if (writePaths.length > 0 || peerEntries.length > 0) {
    console.log()
    for (const p of writePaths) console.log(`  senseiWritePaths: ${p}`)
    for (const [id, peer] of peerEntries) console.log(`  peer ${id}: ${peer.origin.path}`)
  }

  const credentialKeys = [
    cfg.telegram?.botToken ? 'telegram.botToken' : null,
    cfg.slack?.appToken ? 'slack.appToken' : null,
    cfg.slack?.botToken ? 'slack.botToken' : null,
  ].filter((k): k is string => k !== null)
  if (credentialKeys.length > 0) {
    console.log()
    for (const key of credentialKeys) console.log(`  config carries ${key}`)
  }

  const bareDir = resolve(dataDir, '.bare')
  if (existsSync(bareDir)) {
    const remote = Bun.spawnSync(['git', '-C', bareDir, 'remote', 'get-url', 'origin'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (remote.exitCode === 0) {
      console.log()
      console.log(`  .jean/.bare remote: ${remote.stdout.toString().trim()}`)
    }
  }

  console.log()

  if (!yesFlag) {
    if (process.stdin.isTTY !== true) {
      abort('Not a terminal — pass --yes to export non-interactively.')
    }
    // Bun's confirm() itself only accepts a bare y/Y — measured: typing
    // "yes" returns false and cancels, despite the [y/N] confirm() shows.
    // prompt() plus our own match accepts either.
    const answer = prompt(
      'Commit what you want kept — uncommitted work is not guaranteed to travel. Proceed with export? [y/N]',
    )
    if (!answer || !/^y(es)?$/i.test(answer.trim())) {
      abort('Export cancelled.')
    }
  }

  // Anchored to the archive's own root (^<dojoName>/…) — an unanchored pattern
  // matches its name at ANY depth, which silently drops the wrong thing:
  // bare `main` took `.jean/.bare/refs/heads/main` with it (a branch ref, not
  // a stray worktree), and even a two-segment `<dojoName>/main` matched a
  // coincidental deeper occurrence of the same relative suffix elsewhere in a
  // worktree (measured). `node_modules` alone stays unanchored on purpose —
  // every depth of it is exactly what should go.
  //
  // Every path component built from something we did not write ourselves
  // (the dojo's own name, an unrecognised entry's name) is escaped: bsdtar
  // exclude patterns are shell-style globs, so a literal `*`, `?`, `[`, `]`
  // or `\` in a real directory name is otherwise read as a wildcard —
  // measured: an unrecognised entry named exactly `*` excluded the ENTIRE
  // archive (every root child, including .jean and every agent), silently,
  // exit 0. The hand-written relPath patterns below keep their one
  // INTENTIONAL wildcard (`infra.log*`, for a rotated log) unescaped.
  const escapeGlob = (s: string) => s.replace(/[\\*?[\]]/g, '\\$&')
  const dojoNameEscaped = escapeGlob(dojoName)
  const anchor = (relPath: string) => `^${dojoNameEscaped}/${relPath}`
  const anchorLiteral = (name: string) => `^${dojoNameEscaped}/${escapeGlob(name)}`
  const excludes = [
    'node_modules',
    anchor('.jean/.headless'),
    anchor('.jean/.consolidator/runs'),
    anchor('.jean/.consolidator/staging'),
    anchor('.jean/sessions'),
    anchor('.jean/infra.pid'),
    anchor('.jean/infra.port'),
    anchor('.jean/infra.log*'),
    anchor('.jean/board.snapshot.json'),
    anchor('.jean/triggers.snapshot.json'),
    ...unrecognised.map((name) => anchorLiteral(name)),
  ]
  const tarArgs = ['tar', '-czf', outPath, '-C', dirname(dojoRoot)]
  for (const e of excludes) tarArgs.push('--exclude', e)
  tarArgs.push(dojoName)

  // COPYFILE_DISABLE: macOS bsdtar's own opt-out for AppleDouble (._*)
  // sidecar files — determinism, not a security concern either way.
  const tar = Bun.spawnSync(tarArgs, {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (tar.exitCode !== 0) {
    rmSync(outPath, { force: true })
    console.error('tar failed:')
    console.error(tar.stderr.toString().trim())
    process.exit(1)
  }

  const size = statSync(outPath).size
  console.log(`${GREEN}Exported${RESET}`)
  console.log(`  ${outPath} ${DIM}(${formatBytes(size)})${RESET}`)
  console.log()
  console.log(`On the new machine: ${BOLD}jean dojo import ${shellQuote(basename(outPath))}${RESET}`)
}

/**
 * Unpack an exported dojo and bring its records up to date for wherever it
 * landed. Repair is the whole of the fix-up (worktree pointers, permissions,
 * registry, peers, stale runtime files) — this only unpacks and calls it.
 */
async function cmdDojoImport(args: string[]) {
  const positional = args.filter((a) => !a.startsWith('--'))
  const archiveArg = positional[0]
  if (!archiveArg || positional.length > 2) {
    console.error('Usage: jean dojo import <archive> [path]')
    process.exit(1)
  }
  const archivePath = resolve(archiveArg)
  if (!existsSync(archivePath)) {
    console.error(`Archive not found: ${archivePath}`)
    process.exit(1)
  }

  // List before extracting — `--strip-components 1` assumes exactly one
  // top-level directory; anything else (a corrupt archive, or one that
  // isn't a dojo export at all) would otherwise mix unrelated trees into
  // the target instead of failing cleanly.
  const list = Bun.spawnSync(['tar', '-tf', archivePath], { stdout: 'pipe', stderr: 'pipe' })
  if (list.exitCode !== 0) {
    console.error(`Not a readable tar archive: ${archivePath}`)
    console.error(list.stderr.toString().trim())
    process.exit(1)
  }
  const entries = list.stdout
    .toString()
    .split('\n')
    .filter((l) => l.trim().length > 0)
  const topLevelNames = new Set(entries.map((l) => l.split('/')[0]))
  if (topLevelNames.size !== 1) {
    console.error(`Expected exactly one top-level entry in the archive, found ${topLevelNames.size}: ${archivePath}`)
    process.exit(1)
  }
  const [archiveRoot] = topLevelNames
  if (!entries.includes(`${archiveRoot}/.jean/jean.config.json`)) {
    console.error(`Archive does not contain .jean/jean.config.json — doesn't look like a dojo export: ${archivePath}`)
    process.exit(1)
  }

  const targetPath = resolve(positional[1] ?? archiveRoot ?? '')
  mkdirSync(dirname(targetPath), { recursive: true })
  // Non-recursive, and not preceded by its own existsSync: this IS the
  // existence check, atomically — a plain mkdirSync throws EEXIST if the
  // path is already there, rather than the check-then-create gap a separate
  // existsSync would leave (another process could create the target in
  // between, and a recursive mkdir would then silently succeed against it,
  // with extraction proceeding to write into — and a later failure removing
  // — a directory this invocation never made).
  try {
    mkdirSync(targetPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      console.error(`Destination already exists: ${targetPath}`)
      process.exit(1)
    }
    throw err
  }
  const extract = Bun.spawnSync(['tar', '-xpf', archivePath, '-C', targetPath, '--strip-components', '1'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (extract.exitCode !== 0) {
    console.error('tar extraction failed:')
    console.error(extract.stderr.toString().trim())
    rmSync(targetPath, { recursive: true, force: true })
    process.exit(1)
  }

  console.log(`${GREEN}Imported${RESET}`)
  console.log(`  ${archivePath}`)
  console.log(`  → ${targetPath}`)
  console.log()

  const dojoRoot = realpathSync(targetPath)
  const summary = await repairDojo(dojoRoot)

  if (summary.registryIncomplete) {
    // Not a failure — nothing errored — but printing a bare "Done." here
    // would read as success while the dojo is silently unregistered.
    console.log(`${DIM}Registration incomplete:${RESET} ${summary.registryIncomplete}`)
    console.log()
  }

  console.log(`${DIM}Next:${RESET}`)
  console.log(`  ${DIM}bun install${RESET} in each agent worktree — node_modules was excluded`)
  if (summary.channelMissing) console.log(`  ${DIM}jean setup${RESET} — no channel registered on this machine yet`)
  console.log(`  ${DIM}jean agent sync-skills${RESET} — this machine's Jean may ship newer skills`)
  for (const id of summary.droppedPeers) {
    console.log(`  ${DIM}jean peer link <path-to-${id}>${RESET} once ${id} is up on this machine`)
  }
  console.log(
    `  ${DIM}attachments referenced by old messages are in .jean/inbox/ under their original filenames${RESET}`,
  )
  console.log(`  ${DIM}jean infra start${RESET} when ready`)
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

/** Beyond this, the log is rotated at the next start. One generation is kept:
 *  enough to survive the restart you perform WHILE diagnosing, which is when
 *  the previous run's tail is the thing you need. */
const INFRA_LOG_CAP_BYTES = 5_000_000

/**
 * Prepare `.jean/infra.log` for a new run and return its path.
 *
 * ROTATION HAPPENS HERE, AT START, and nowhere else — deliberately. A running
 * server that policed its own log size would need to reopen the file under a
 * writer that is a raw fd shared with a spawned process, and a truncation
 * racing a write is how log files acquire half-lines. A restart is the natural
 * seam, and a server up long enough to grow past the cap is a server nobody is
 * restarting, whose log is the least of it. Stated rather than hidden: between
 * restarts this file grows without bound.
 */
function openInfraLog(dataDir: string): string {
  const path = resolve(dataDir, 'infra.log')
  try {
    if (statSync(path).size > INFRA_LOG_CAP_BYTES) renameSync(path, `${path}.1`)
  } catch {
    // No log yet, or an unreadable one — either way the append below creates
    // what it needs. A rotation failure must never stop infra from starting.
  }
  // The boot marker, so a reader can tell one run's lines from the last's —
  // the file is append-only across restarts and otherwise runs together.
  try {
    appendFileSync(path, `\n[jean] ── infra start ${new Date().toISOString()} ──\n`)
  } catch {
    /* the spawn's own fd is the real writer; this line is a courtesy */
  }
  return path
}

/**
 * Hold the machine awake for as long as the server lives — on AC power only.
 *
 * ── WHY A DOJO ASSERTS THIS ──
 *
 * A laptop hosting live dojos is a server, and a server that idle-sleeps stops
 * being one. On 2026-08-21 this machine's maintenance-sleep cycles turned the
 * Telegram bridge's steady poll into hourly batches of messages, which read for
 * forty-five minutes as a transport outage; the transport was fine and the host
 * was asleep. Task 121's detector now names that case after the fact. This
 * removes the most common cause of it.
 *
 * ── WHY `-s`, AND WHY A SIDECAR ──
 *
 * `-s` is "prevent system sleep, valid only when running on AC power" — which
 * is exactly the ruling. The kernel calls it `PreventSystemSleep`; `-i` takes a
 * different one, `PreventUserIdleSystemSleep`, which holds on battery as well,
 * and a dojo has no business draining a laptop somebody carried away from a
 * desk. (Both names are measured, not read off the man page — `pmset -g
 * assertions` reports them, and the test below reads it.) Neither flag touches
 * lid-close sleep, which stays as it is: shutting the lid still means sleep,
 * and that is the operator saying so.
 *
 * The `-w pid` form takes the assertion and releases it when that pid exits,
 * so the sidecar dies with the server and there is nothing to clean up —
 * including on a crash, where no cleanup code of ours would have run. The
 * alternative, wrapping the spawn as `caffeinate -s bun run server.ts`, would
 * have made `child.pid` caffeinate's rather than the server's: `infra stop`
 * reads the pid file the server writes, so the two would diverge, and the PID
 * this command prints would no longer be the one an operator can kill.
 */
function keepMachineAwake(serverPid: number, logPath: string): string | null {
  // caffeinate is macOS's. Elsewhere there is no facility to report on.
  if (process.platform !== 'darwin') return null
  try {
    const sitter = Bun.spawn(['caffeinate', '-s', '-w', String(serverPid)], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    sitter.unref()
    return `idle sleep prevented while this runs (AC power only, pid ${sitter.pid})`
  } catch (err) {
    // A dojo starts without it. The assertion is a courtesy to the host
    // machine, never a precondition for serving — but it is written down,
    // because the next hourly-batch diagnosis will want to know it was absent.
    try {
      appendFileSync(logPath, `[jean] power assertion NOT taken: ${String(err)}\n`)
    } catch {}
    return null
  }
}

async function cmdInfraStart() {
  const dataDir = resolve(findDojoRoot(), '.jean')

  // Friendlier pre-check: refuse before spawning if we can confirm a live duplicate.
  // (The server also enforces this; we do it here to avoid spawn-and-die noise.)
  const existing = readRuntimeFiles(dataDir)
  if (existing.pid !== null && existing.port !== null && isProcessAlive(existing.pid)) {
    const info = await probeInfra(existing.port)
    if (isOwnInfra(info, dataDir)) {
      console.error(`Infrastructure already running (pid ${existing.pid}, port ${existing.port}).`)
      console.error('Use "jean infra stop" first.')
      process.exit(1)
    }
  }

  const serverPath = resolve(cliDir(), '../adapter/server.ts')
  const logPath = openInfraLog(dataDir)
  const logFd = openSync(logPath, 'a')
  const child = Bun.spawn(['bun', 'run', serverPath], {
    cwd: dataDir,
    env: { ...process.env, JEAN_DATA_DIR: dataDir },
    // BOTH STREAMS TO THE FILE. Previously stdout was discarded and stderr was
    // `inherit`, which reads as "the operator will see it" and is only true
    // while the launching terminal lives: the server detaches, the shell exits,
    // and the fd leads nowhere. That is not a theoretical loss — on the night
    // this was written the Telegram bridge failed for 45 minutes and printed
    // its one transition line, `[jean] telegram poll error: … — retrying`,
    // into a terminal nobody was reading, so the only record of WHY was gone.
    stdio: ['ignore', logFd, logFd],
  })
  // The child holds its own copy; the parent's would otherwise outlive this
  // command and pin the file.
  closeSync(logFd)

  // BEFORE THE POLL, not after — the poll is six seconds and the assertion
  // costs nothing to take early. `bun run <file>` execs in place (measured), so
  // `child.pid` IS the server's own pid: the one it writes to `infra.pid`, and
  // the one `infra stop` kills.
  //
  // NOT the server's whole lifetime, and the gap is named rather than papered
  // over: between the spawn above and caffeinate registering on that pid, the
  // server is up unasserted. Closing it would mean the wrapper form, whose cost
  // is the pid divergence described on `keepMachineAwake` — a worse trade for a
  // window measured in milliseconds, against idle sleep measured in minutes.
  // The same window is the only place pid reuse could bite, and it would
  // require this pid to die AND be recycled inside it (codex pass, task 122).
  const awake = keepMachineAwake(child.pid, logPath)

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
    console.log(`  Log:  ${logPath}`)
    // Said out loud, because it changes how the operator's machine behaves.
    if (awake !== null) console.log(`  ${DIM}Sleep: ${awake}${RESET}`)
  } else {
    // NAMING THE FILE, not "check stderr": the whole point of the change above
    // is that there is no stderr to check once this command returns.
    console.error(`Infrastructure started but port file not found. Check ${logPath} for errors.`)
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
  //
  // NO HOOKS. A new agent used to get two — a Stop hook POSTing to
  // `/agent-idle` and a PermissionRequest hook POSTing to `/permissions` —
  // and both intakes were retired by ruling during the rewrite: there is no
  // `/agent-idle` route at all, and `POST /permissions` is pinned at 404 with
  // only the GET surviving. The generation code outlived them; 117's brief
  // scoped it and the deletion caught the other site, not this one. So every
  // agent created since the switch got two hooks that spawn a process per
  // turn-end and per permission request to POST at nothing.
  //
  // The design lesson they carried is not lost, it is inverted: the supervisor
  // no longer asks an agent to report its own liveness (task 115's predicate
  // reads observed activity instead), which is why nothing needs to replace
  // them. Hooks already written into existing agent dirs stay dojo-local
  // cleanup — this only stops new ones being made.
  const settingsDir = resolve(agentDir, '.claude')
  const settingsPath = resolve(settingsDir, 'settings.local.json')
  if (!existsSync(settingsPath)) {
    mkdirSync(settingsDir, { recursive: true })
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          permissions: defaultPermissions(role, dojoRoot, {
            worktree: agentDir,
            senseiWritePaths: readConfig(resolve(dojoRoot, '.jean')).senseiWritePaths,
          }),
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

/**
 * Regenerate every agent's (and the librarian's) settings.local.json against
 * current framework defaults for `dojoRoot` — the shared logic behind `jean
 * agent sync-permissions` and `jean dojo repair`. Union-merge, so it only
 * adds what's missing; see `mergePermissions` for what little it removes.
 */
function syncAgentPermissions(
  dojoRoot: string,
  opts: { dryRun?: boolean; indent?: string; dropDeadAbsolute?: boolean } = {},
): { targetCount: number; totalChanges: number; touchedAgents: number } {
  const dryRun = opts.dryRun ?? false
  const pre = opts.indent ?? ''
  const dropDeadAbsolute = opts.dropDeadAbsolute ?? false

  const senseiWritePaths = readConfig(resolve(dojoRoot, '.jean')).senseiWritePaths

  // `worktree` scopes the write fence; undefined for the librarian, which is
  // not worktree-fenced and legitimately keeps bare Edit/Write.
  type Target = { name: string; role: AgentRole; settingsPath: string; worktree?: string }
  const targets: Target[] = []

  for (const a of discoverAgents(dojoRoot)) {
    targets.push({
      name: a.name,
      role: a.role,
      settingsPath: resolve(a.path, '.claude', 'settings.local.json'),
      worktree: a.path,
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
    console.log(`${pre}No agents found.`)
    return { targetCount: 0, totalChanges: 0, touchedAgents: 0 }
  }

  let totalChanges = 0
  let touchedAgents = 0

  for (const t of targets) {
    const label = `${BOLD}${t.name}${RESET}${DIM} (${t.role})${RESET}`

    if (!existsSync(t.settingsPath)) {
      console.log(`${pre}${DIM}skip${RESET}  ${label} — no settings.local.json`)
      continue
    }

    let json: Record<string, unknown>
    try {
      json = JSON.parse(readFileSync(t.settingsPath, 'utf8')) as Record<string, unknown>
    } catch {
      console.log(`${pre}${DIM}error${RESET} ${label} — invalid JSON, skipping`)
      continue
    }

    const expected = defaultPermissions(t.role, dojoRoot, { worktree: t.worktree, senseiWritePaths })
    const existing = (json.permissions ?? {}) as Partial<{ allow: string[]; deny: string[] }>
    // Fenced roles must SHED bare Edit/Write (a scoped grant is defeated while
    // the bare one survives). The librarian keeps them — it has no worktree
    // fence, so nothing to shed.
    const obsoleteAllow = t.worktree ? ['Edit', 'Write'] : []
    const { merged, addedAllow, addedDeny, removedAllow, removedDeny } = mergePermissions(existing, expected, {
      obsoleteAllow,
    })

    // Repair-only: drop any remaining absolute DIRECTORY rule whose target no
    // longer exists — old-root leftovers and senseiWritePaths ghosts alike.
    // (Not part of plain sync-permissions — see absoluteGlobRuleTarget for why
    // the framework's one exact-file rule is deliberately excluded.)
    const isDead = (rule: string) => {
      const target = absoluteGlobRuleTarget(rule)
      return target !== null && !existsSync(target)
    }
    const deadAllow = dropDeadAbsolute ? merged.allow.filter(isDead) : []
    const deadDeny = dropDeadAbsolute ? merged.deny.filter(isDead) : []
    const finalAllow = deadAllow.length ? merged.allow.filter((r) => !deadAllow.includes(r)) : merged.allow
    const finalDeny = deadDeny.length ? merged.deny.filter((r) => !deadDeny.includes(r)) : merged.deny

    const changes =
      addedAllow.length +
      addedDeny.length +
      removedAllow.length +
      removedDeny.length +
      deadAllow.length +
      deadDeny.length
    if (changes === 0) {
      console.log(`${pre}${DIM}ok${RESET}    ${label} — already current`)
      continue
    }

    console.log(`${pre}${GREEN}sync${RESET}  ${label}`)
    for (const rule of removedAllow)
      console.log(`${pre}  ${RED}-${RESET} Allow: ${rule} ${DIM}(obsolete/inert)${RESET}`)
    for (const rule of removedDeny)
      console.log(`${pre}  ${RED}-${RESET} Deny:  ${rule} ${DIM}(inert Write rule)${RESET}`)
    for (const rule of deadAllow)
      console.log(`${pre}  ${RED}-${RESET} Allow: ${rule} ${DIM}(target does not exist)${RESET}`)
    for (const rule of deadDeny)
      console.log(`${pre}  ${RED}-${RESET} Deny:  ${rule} ${DIM}(target does not exist)${RESET}`)
    for (const rule of addedAllow) console.log(`${pre}  ${GREEN}+${RESET} Allow: ${rule}`)
    for (const rule of addedDeny) console.log(`${pre}  ${GREEN}+${RESET} Deny:  ${rule}`)
    totalChanges += changes
    touchedAgents++

    if (!dryRun) {
      json.permissions = { allow: finalAllow, deny: finalDeny }
      writeFileSync(t.settingsPath, `${JSON.stringify(json, null, 2)}\n`)
    }
  }

  return { targetCount: targets.length, totalChanges, touchedAgents }
}

function cmdAgentSyncPermissions(args: string[]) {
  const dryRun = args.includes('--dry-run')
  const dojoRoot = findDojoRoot()

  console.log()
  const { targetCount, totalChanges, touchedAgents } = syncAgentPermissions(dojoRoot, { dryRun })
  if (targetCount === 0) return

  console.log()
  if (totalChanges === 0) {
    console.log(`${DIM}All ${targetCount} agent(s) already current.${RESET}`)
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
    // Worktree agent: check dirty/check-failed state, remove via git. Reuses
    // export's own git-status classification rather than a second, narrower
    // one — a worktree whose `.git` names a missing bare fails `git status`
    // itself (exit non-zero), which a stdout-only dirty check silently reads
    // as "clean" and would let `remove` destroy without --force.
    if (!force) {
      const check = checkGitRepo(agent.path)
      if (check.kind === 'error') {
        console.error(`Agent "${name}": git status check failed (${check.message}). Use --force to remove anyway.`)
        process.exit(1)
      }
      if (check.dirty) {
        console.error(`Agent "${name}" has uncommitted changes. Use --force to remove anyway.`)
        process.exit(1)
      }
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
  jean dojo repair                            Fix records of this dojo's own path (after a copy or manual move)
  jean dojo export [--out <file>] [--yes]     Archive this dojo to move it to another machine
  jean dojo import <archive> [path]           Unpack an exported dojo and repair it in place
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
