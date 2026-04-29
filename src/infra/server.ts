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

import { existsSync, mkdirSync, readdirSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { ServerWebSocket } from 'bun'
import { Cron } from 'croner'
import {
  createProjection,
  createStore,
  type EventStore,
  fileSnapshotBackend,
  jsonlBackend,
  type StoredEvent,
} from '../es/index.ts'
import { INFRA_IDENTITY, type InfraInfo, probeInfra, readRuntimeFiles } from '../probe.ts'
import { type Board, canTransition, type TaskStatus } from './board.ts'
import { resolveConfig } from './config.ts'
import { createPeerDeliver, identityFromConfig, loadPeers, type Peer, peerLiveness } from './peers.ts'
import type {
  AgentRole,
  CreateTaskRequest,
  DeliverMsg,
  InboundMsg,
  OutboundMsg,
  SendRequest,
  UpdateStatusRequest,
  UpdateTaskRequest,
} from './protocol.ts'
import {
  type AckData,
  type AgentIdleData,
  agentFromEvent,
  agentStream,
  boardReducer,
  MEMORY_STREAM,
  type MemoryData,
  type MemoryScope,
  migrateBoard,
  type NudgeData,
  type PendingState,
  type PermissionRequestData,
  PLAYBOOKS_STREAM,
  type PlaybookCreatedData,
  type PlaybookRemovedData,
  type PlaybookState,
  type PlaybookUpdatedData,
  pendingReducer,
  playbookReducer,
  type RegisterData,
  type ReplyData,
  type SendData,
  type StartData,
  SYSTEM_STREAM,
  type TaskCommentData,
  type TaskCreatedData,
  type TaskRevertedData,
  type TaskStatusData,
  type TaskUpdatedData,
  TRIGGERS_STREAM,
  type Trigger,
  type TriggerCreatedData,
  type TriggerFiredData,
  type TriggerRemovedData,
  type TriggerState,
  type TriggerUpdatedData,
  taskIdFromStream,
  taskStream,
  toApiEvent,
  triggerReducer,
} from './reducers.ts'

const DATA_DIR = resolve(process.env.JEAN_DATA_DIR ?? '.')
const config = resolveConfig(DATA_DIR)
const HISTORY_PATH = resolve(DATA_DIR, 'history.jsonl')
const SNAPSHOT_DIR = DATA_DIR

// Slack config (optional)
const SLACK_APP_TOKEN = config.slack?.appToken
const SLACK_BOT_TOKEN = config.slack?.botToken
const SLACK_CHANNEL = config.slack?.channel

// ── Event store & projections ────────────────────────────────────

const store: EventStore = createStore(jsonlBackend(HISTORY_PATH))

const boardProjection = createProjection<Board>({
  name: 'board',
  store,
  reducer: boardReducer,
  initial: { tasks: [] },
  filter: { types: ['task-created', 'task-status', 'task-updated', 'task-reverted'] },
  snapshots: fileSnapshotBackend(SNAPSHOT_DIR),
  snapshotEvery: 50,
  migrate: migrateBoard,
})

const pendingProjection = createProjection<PendingState>({
  name: 'pending',
  store,
  reducer: pendingReducer,
  initial: [],
  filter: {
    types: [
      'reply',
      'task-comment',
      'register',
      'disconnect',
      'task-created',
      'trigger-fired',
      'playbook-created',
      'playbook-updated',
      'playbook-removed',
      'ack',
    ],
  },
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

const triggerProjection = createProjection<TriggerState>({
  name: 'triggers',
  store,
  reducer: triggerReducer,
  initial: { triggers: [] },
  filter: { stream: TRIGGERS_STREAM },
  snapshots: fileSnapshotBackend(SNAPSHOT_DIR),
  snapshotEvery: 20,
})

const playbookProjection = createProjection<PlaybookState>({
  name: 'playbooks',
  store,
  reducer: playbookReducer,
  initial: { playbooks: [] },
  filter: { stream: PLAYBOOKS_STREAM },
})

await boardProjection.catchUp()
await pendingProjection.catchUp()
await lastTaskContext.catchUp()
await triggerProjection.catchUp()
await playbookProjection.catchUp()

// ── Agent registry (transport-agnostic) ──────────────────────────

type AgentEntry = {
  role: AgentRole
  idle: boolean
  sessionId?: string
  tags: string[]
  deliver: (msg: DeliverMsg) => boolean
  close?: () => void
  /** True while the underlying transport is still open. Used to distinguish
   *  a legitimate reconnect (old WS is dead) from a concurrent duplicate (old
   *  WS is still live — two `jean agent start <name>` processes fighting for
   *  the same slot). Peers and other non-WS agents have no live check. */
  isLive?: () => boolean
}

const agents = new Map<string, AgentEntry>()

// Local dojo's identity — used as the `from` field on outbound peer sends, and
// as the key under which peers look us up. Falls back to basename of dojo root.
const MY_IDENTITY = identityFromConfig(DATA_DIR)

// Registered peers — loaded once at startup. Each peer becomes a synthetic
// entry in the `agents` map (role='peer') whose deliver() does an HTTP POST to
// the peer's infra /send. Registry is static until restart — `jean peer add`
// requires `jean infra stop` + start to take effect (acceptable for MVP).
const peers = new Map<string, Peer>()
{
  const loaded = loadPeers(DATA_DIR)
  for (const [identity, peer] of Object.entries(loaded.peers)) {
    peers.set(identity, peer)
    agents.set(identity, {
      role: 'peer',
      idle: true,
      tags: [],
      deliver: (msg) =>
        createPeerDeliver({ peer, myIdentity: MY_IDENTITY })({
          from: msg.from,
          text: msg.text,
          taskId: msg.taskId,
        }),
    })
  }
  if (peers.size > 0) {
    process.stderr.write(`[jean] loaded ${peers.size} peer(s): ${[...peers.keys()].join(', ')}\n`)
  }
}

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

/** Route a message to an agent: deliver, mark busy, record 'send' event. Shared by HTTP /send and WS 'send'. */
async function routeSend(args: { from: string; to: string; text: string; taskId?: string }): Promise<boolean> {
  const delivered = deliverToAgent(args.to, {
    type: 'deliver',
    from: args.from,
    text: args.text,
    taskId: args.taskId,
  })
  if (delivered) {
    const entry = agents.get(args.to)
    if (entry && entry.role === 'worker') entry.idle = false
  }
  // If the sender is a registered peer, enrich the event with the
  // locally-stored description. The peer can't rewrite this per-message —
  // it's frozen in our own peers.json until we change it.
  const senderPeer = peers.get(args.from)
  const stream = args.taskId ? taskStream(args.taskId) : agentStream(args.to)
  await record('send', stream, {
    agent: args.to,
    from: args.from,
    text: args.text,
    delivered,
    ...(senderPeer && { senderRole: 'peer' as const, peerDescription: senderPeer.description }),
  } satisfies SendData)
  return delivered
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
    try {
      sub.write(`data: ${json}\n\n`)
    } catch {
      sseSubscribers.delete(sub)
    }
  }
}

// ── Record event (append + project + side effects) ───────────────

async function record(type: string, stream: string, data: unknown): Promise<StoredEvent> {
  const sizeBefore = pendingProjection.state.length
  const event = await store.append({ stream, type, data })
  boardProjection.apply(event)
  pendingProjection.apply(event)
  triggerProjection.apply(event)
  playbookProjection.apply(event)
  if (stream === TRIGGERS_STREAM) syncTriggerJobs()

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
    (t) => (t.agent === agentName || t.queue === agentName) && (t.status === 'in-progress' || t.status === 'waiting'),
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
    const task = boardProjection.state.tasks.find((t) => t.id === taskId)
    return task?.agent ?? task?.queue
  }
  return undefined
}

function pendingEvents(agent?: string): StoredEvent[] {
  if (!agent) return [...pendingProjection.state]
  return pendingProjection.state.filter((e) => resolveAgent(e) === agent)
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

function nudgeSenseiIfIdle() {
  const sensei = findSensei()
  if (!sensei?.idle) return
  if (pendingProjection.state.length === 0) return

  sensei.idle = false
  sensei.deliver({
    type: 'deliver',
    from: 'infra',
    text: 'Events pending. Check the board.',
  })
  void record('nudge', SYSTEM_STREAM, { pendingCount: pendingProjection.state.length } satisfies NudgeData)
}

// ── Trigger scheduler ───────────────────────────────────────────

const cronJobs = new Map<string, Cron>()

function startTriggerJob(trigger: Trigger) {
  if (cronJobs.has(trigger.id)) return
  const callback = () => {
    void fireTrigger(trigger)
  }
  // Trigger type is a discriminated union: exactly one of cron or at.
  let job: Cron
  let desc: string
  if (trigger.cron !== undefined) {
    job = new Cron(trigger.cron, { catch: true }, callback)
    desc = `(${trigger.cron})`
  } else {
    job = new Cron(new Date(trigger.at), { catch: true }, callback)
    desc = `(at ${trigger.at})`
  }
  cronJobs.set(trigger.id, job)
  process.stderr.write(`[jean] trigger ${trigger.id} scheduled ${desc}\n`)
}

function stopTriggerJob(id: string) {
  const job = cronJobs.get(id)
  if (job) {
    job.stop()
    cronJobs.delete(id)
  }
}

function syncTriggerJobs() {
  const active = new Set<string>()
  for (const trigger of triggerProjection.state.triggers) {
    if (trigger.status !== 'active') continue
    active.add(trigger.id)

    if (cronJobs.has(trigger.id)) continue

    // One-off trigger whose time has passed — fire immediately
    if (trigger.at && new Date(trigger.at).getTime() <= Date.now()) {
      void fireTrigger(trigger)
      continue
    }

    startTriggerJob(trigger)
  }

  // Stop jobs for triggers no longer active
  for (const id of cronJobs.keys()) {
    if (!active.has(id)) stopTriggerJob(id)
  }
}

async function fireTrigger(trigger: Trigger) {
  await record('trigger-fired', TRIGGERS_STREAM, {
    triggerId: trigger.id,
    agent: trigger.agent,
    prompt: trigger.prompt,
  } satisfies TriggerFiredData)

  const delivered = deliverToAgent(trigger.agent, {
    type: 'deliver',
    from: 'trigger',
    text: trigger.prompt,
  })
  if (delivered) {
    const entry = agents.get(trigger.agent)
    if (entry && entry.role === 'worker') entry.idle = false
  }

  const taskId = inferTaskId(trigger.agent)
  const stream = taskId ? taskStream(taskId) : agentStream(trigger.agent)
  void record('send', stream, {
    agent: trigger.agent,
    from: `trigger:${trigger.id}`,
    text: trigger.prompt,
    delivered,
  } satisfies SendData)

  process.stderr.write(`[jean] trigger ${trigger.id} fired → ${trigger.agent}\n`)
}

// ── Playbook file watcher ────────────────────────────────────────

const PLAYBOOKS_DIR = resolve(DATA_DIR, 'playbooks')

function playbookIdFromFilename(filename: string): string | null {
  if (!filename.endsWith('.md')) return null
  return basename(filename, '.md')
}

function hashContent(content: string): string {
  return new Bun.CryptoHasher('sha256').update(content).digest('hex').slice(0, 12)
}

async function readPlaybookFile(id: string): Promise<{ content: string; hash: string } | null> {
  try {
    const content = await Bun.file(resolve(PLAYBOOKS_DIR, `${id}.md`)).text()
    return { content, hash: hashContent(content) }
  } catch {
    return null
  }
}

let reconciling = false

/** Scan playbook files and reconcile with projection state. */
async function reconcilePlaybooks() {
  if (reconciling) return
  reconciling = true
  try {
    if (!existsSync(PLAYBOOKS_DIR)) {
      mkdirSync(PLAYBOOKS_DIR, { recursive: true })
      process.stderr.write(`[jean] created ${PLAYBOOKS_DIR}\n`)
    }

    const dir = readdirSync(PLAYBOOKS_DIR)
    const ids = dir.map(playbookIdFromFilename).filter((id): id is string => id !== null)
    const entries = await Promise.all(
      ids.map(async (id) => {
        const data = await readPlaybookFile(id)
        return data ? ([id, data] as const) : null
      }),
    )

    const files = new Map<string, { content: string; hash: string }>()
    for (const entry of entries) {
      if (entry) files.set(entry[0], entry[1])
    }

    const known = new Map(playbookProjection.state.playbooks.map((p) => [p.id, p]))

    for (const [id, { content, hash }] of files) {
      const existing = known.get(id)
      if (!existing) {
        await record('playbook-created', PLAYBOOKS_STREAM, { id, content, hash } satisfies PlaybookCreatedData)
        process.stderr.write(`[jean] playbook created: ${id}\n`)
      } else if (existing.hash !== hash) {
        await record('playbook-updated', PLAYBOOKS_STREAM, {
          id,
          content,
          hash,
          prevHash: existing.hash,
        } satisfies PlaybookUpdatedData)
        process.stderr.write(`[jean] playbook updated: ${id}\n`)
      }
    }

    for (const [id, playbook] of known) {
      if (!files.has(id)) {
        await record('playbook-removed', PLAYBOOKS_STREAM, {
          id,
          lastHash: playbook.hash,
        } satisfies PlaybookRemovedData)
        process.stderr.write(`[jean] playbook removed: ${id}\n`)
      }
    }
  } finally {
    reconciling = false
  }
}

/** Watch playbook directory for changes. */
function watchPlaybooks() {
  if (!existsSync(PLAYBOOKS_DIR)) return

  let debounce: ReturnType<typeof setTimeout> | null = null
  watch(PLAYBOOKS_DIR, (_eventType, filename) => {
    if (!filename?.endsWith('.md')) return
    // Debounce — editors often fire multiple events for one save
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      void reconcilePlaybooks()
    }, 200)
  })
  process.stderr.write(`[jean] watching ${PLAYBOOKS_DIR} for changes\n`)
}

// ── Slack integration (optional) ─────────────────────────────────

let slackConnected = false

async function initSlack() {
  if (!SLACK_APP_TOKEN || !SLACK_BOT_TOKEN || !SLACK_CHANNEL) return
  // Capture into const so narrowed type survives across closures.
  const channelId = SLACK_CHANNEL

  const { App } = await import('@slack/bolt')
  const app = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
  })

  // Derive channel name for agent registry
  let channelName = channelId
  try {
    const info = await app.client.conversations.info({ channel: channelId })
    channelName = (info.channel as { name?: string })?.name ?? channelId
  } catch {
    /* use channel ID as fallback */
  }

  // Register Slack channel as an agent
  agents.set(channelName, {
    role: 'user',
    idle: true,
    tags: [],
    deliver: (msg) => {
      void app.client.chat.postMessage({
        channel: channelId,
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
  void record('register', agentStream(channelName), {
    agent: channelName,
    role: 'user',
    idle: true,
  } satisfies RegisterData)
}

// ── Port + single-instance enforcement ───────────────────────────

const PORT = config.port ?? 8700
const PORT_FILE = resolve(DATA_DIR, 'infra.port')
const PID_FILE = resolve(DATA_DIR, 'infra.pid')

/** Fields that can be updated on a trigger via PATCH. Schedule (cron/at) is immutable. */
const TRIGGER_UPDATE_FIELDS = new Set(['agent', 'prompt', 'status', 'metadata'])

/** The identity tuple returned by `/` and embedded in `/status`. Matches `InfraInfo`. */
function identity(): InfraInfo {
  return { name: INFRA_IDENTITY, dataDir: DATA_DIR, pid: process.pid, port: PORT }
}

/** Print the appropriate "can't start" error for whatever is occupying PORT and exit. */
function refuseStart(info: InfraInfo | null): never {
  if (info?.name === INFRA_IDENTITY) {
    const sameDojo = !info.dataDir || info.dataDir === DATA_DIR
    if (sameDojo) {
      const pidHint = info.pid ? `pid ${info.pid}` : 'unknown pid'
      process.stderr.write(
        `[jean] error: infra already running on port ${PORT} (${pidHint})\n` +
          `       use 'jean infra stop' first${info.pid ? `, or kill ${info.pid}` : ''}\n`,
      )
    } else {
      process.stderr.write(
        `[jean] error: port ${PORT} is used by another Jean dojo (${info.dataDir})\n` +
          `       run 'jean config set port <other>' in this dojo\n`,
      )
    }
  } else {
    process.stderr.write(
      `[jean] error: port ${PORT} is in use by another process\n` +
        `       run 'jean config set port <other>' to change\n`,
    )
  }
  process.exit(1)
}

/** Enforce single-instance per dojo. Clean up stale state from crashes. */
async function enforceSingleInstance(): Promise<void> {
  // If something responds on PORT with our identity, refuse. (Same dojo → duplicate;
  // different dojo → port conflict. refuseStart picks the message.)
  const info = await probeInfra(PORT)
  if (info?.name === INFRA_IDENTITY) refuseStart(info)

  // Port might be held by a non-HTTP listener that probeInfra can't see.
  try {
    Bun.serve({ port: PORT, hostname: '127.0.0.1', fetch: () => new Response() }).stop(true)
  } catch {
    refuseStart(null)
  }

  // Port is free. Any leftover pid/port files are stale from a crash.
  const { pid: stalePid } = readRuntimeFiles(DATA_DIR)
  if (stalePid !== null) {
    process.stderr.write(`[jean] cleaning up stale pid/port files (pid ${stalePid})\n`)
    try {
      unlinkSync(PID_FILE)
    } catch {}
    try {
      unlinkSync(PORT_FILE)
    } catch {}
  }
}

function writeRuntimeFiles() {
  writeFileSync(PORT_FILE, String(PORT))
  writeFileSync(PID_FILE, String(process.pid))
}

function cleanupRuntimeFiles() {
  try {
    unlinkSync(PORT_FILE)
  } catch {}
  try {
    unlinkSync(PID_FILE)
  } catch {}
}

process.on('exit', cleanupRuntimeFiles)
process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))

await enforceSingleInstance()

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
          actor: body.actor ?? 'api',
        } satisfies TaskCreatedData)
        const task = boardProjection.state.tasks.find((t) => t.id === taskId)
        return Response.json(task, { status: 201 })
      })()
    }

    if (path === '/tasks' && req.method === 'GET') {
      let tasks = boardProjection.state.tasks
      const status = url.searchParams.get('status')
      if (status) tasks = tasks.filter((t) => t.status === status)
      const queue = url.searchParams.get('queue')
      if (queue) tasks = tasks.filter((t) => t.queue === queue)
      return Response.json({ tasks })
    }

    const taskGetMatch = path.match(/^\/tasks\/(\w+)$/)
    if (taskGetMatch && req.method === 'GET') {
      return (async () => {
        const taskId = taskGetMatch[1]
        if (!taskId) return Response.json({ error: 'not found' }, { status: 404 })
        const task = boardProjection.state.tasks.find((t) => t.id === taskId)
        if (!task) return Response.json({ error: 'not found' }, { status: 404 })
        const include = new Set((url.searchParams.get('include') ?? '').split(',').filter(Boolean))
        if (include.size === 0) return Response.json(task)
        const enriched: Record<string, unknown> = { ...task }
        // Load the task's event stream once if any include flag needs it. Add new stream-backed flags here.
        const STREAM_INCLUDES = ['comments', 'messages'] as const
        const needsStream = STREAM_INCLUDES.some((k) => include.has(k))
        const events = needsStream ? await store.read({ stream: taskStream(taskId) }) : []
        if (include.has('comments')) {
          // Curated task-comment events — deliberate notes worth reading as a summary.
          enriched.comments = events.flatMap((e) => {
            if (e.type !== 'task-comment') return []
            const d = e.data as TaskCommentData
            return [{ ts: e.ts, from: d.agent, text: d.text }]
          })
        }
        if (include.has('messages')) {
          // Chat-level reply/send events — full correspondence, higher volume, useful for diagnostics.
          enriched.messages = events.flatMap((e) => {
            if (e.type === 'reply') {
              const d = e.data as ReplyData
              return [{ ts: e.ts, from: d.agent, text: d.text }]
            }
            if (e.type === 'send') {
              const d = e.data as SendData
              return [{ ts: e.ts, from: d.from, to: d.agent, text: d.text }]
            }
            return []
          })
        }
        if (include.has('playbook') && task.playbook) {
          const playbook = playbookProjection.state.playbooks.find((p) => p.id === task.playbook)
          if (playbook) {
            enriched.playbook = { id: playbook.id, name: playbook.name, content: playbook.content }
          }
        }
        return Response.json(enriched)
      })()
    }

    const statusMatch = path.match(/^\/tasks\/(\w+)\/status$/)
    if (statusMatch && req.method === 'PATCH') {
      return (async () => {
        const body = (await req.json()) as UpdateStatusRequest
        if (!body.status) {
          return Response.json({ error: 'missing status' }, { status: 400 })
        }
        const task = boardProjection.state.tasks.find((t) => t.id === statusMatch[1])
        if (!task) return Response.json({ error: 'not found' }, { status: 404 })
        if (!canTransition(task.status, body.status as TaskStatus)) {
          return Response.json({ error: `invalid transition: ${task.status} → ${body.status}` }, { status: 400 })
        }
        await record('task-status', taskStream(task.id), {
          from: task.status,
          to: body.status as TaskStatus,
          actor: body.actor ?? 'api',
        } satisfies TaskStatusData)
        const updated = boardProjection.state.tasks.find((t) => t.id === task.id)
        return Response.json(updated)
      })()
    }

    const revertMatch = path.match(/^\/tasks\/(\w+)\/revert$/)
    if (revertMatch && req.method === 'POST') {
      return (async () => {
        const taskId = revertMatch[1]
        if (!taskId) return Response.json({ error: 'not found' }, { status: 404 })
        const task = boardProjection.state.tasks.find((t) => t.id === taskId)
        if (!task) return Response.json({ error: 'not found' }, { status: 404 })
        const body = (await req.json().catch(() => ({}))) as { actor?: string }

        // Rebuild the task's status stack from its event stream.
        const events = await store.read({ stream: taskStream(taskId) })
        const stack: TaskStatus[] = []
        for (const e of events) {
          if (e.type === 'task-created') stack.push('todo')
          else if (e.type === 'task-status') stack.push((e.data as TaskStatusData).to)
          else if (e.type === 'task-reverted') {
            const target = (e.data as TaskRevertedData).to
            while (stack.length > 0 && stack[stack.length - 1] !== target) stack.pop()
          }
        }

        if (stack.length <= 1) {
          return Response.json({ error: 'nothing to revert — task has no prior status to return to' }, { status: 400 })
        }
        const from = stack[stack.length - 1] as TaskStatus
        const to = stack[stack.length - 2] as TaskStatus
        await record('task-reverted', taskStream(taskId), {
          from,
          to,
          actor: body.actor ?? 'api',
        } satisfies TaskRevertedData)
        const updated = boardProjection.state.tasks.find((t) => t.id === taskId)
        return Response.json({ ...updated, reverted: { from, to } })
      })()
    }

    const taskPatchMatch = path.match(/^\/tasks\/(\w+)$/)
    if (taskPatchMatch && req.method === 'PATCH') {
      return (async () => {
        const body = (await req.json()) as UpdateTaskRequest
        const task = boardProjection.state.tasks.find((t) => t.id === taskPatchMatch[1])
        if (!task) return Response.json({ error: 'not found' }, { status: 404 })
        await record('task-updated', taskStream(task.id), {
          ...(body.agent !== undefined && { agent: body.agent }),
          ...(body.description !== undefined && { description: body.description }),
          actor: body.actor ?? 'api',
        } satisfies TaskUpdatedData)
        const updated = boardProjection.state.tasks.find((t) => t.id === task.id)
        return Response.json(updated)
      })()
    }

    // ── Memorize ────────────────────────────────────────────────
    //
    // Records a `memory` event in MEMORY_STREAM. The librarian — a headless
    // Claude spawned by the consolidate-wiki trigger — reads new memory
    // events via cursor and distills them into the wiki under
    // .jean/context/. See docs/llm-wiki-design.md.

    if (path === '/memorize' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as Partial<MemoryData>
        if (!body.agent || !body.role || !body.text?.trim()) {
          return Response.json({ error: 'memorize requires agent, role, and non-empty text' }, { status: 400 })
        }
        const scope: MemoryScope = body.scope === 'user' ? 'user' : 'dojo'
        const event = await record('memory', MEMORY_STREAM, {
          agent: body.agent,
          role: body.role,
          text: body.text.trim(),
          scope,
          ...(body.taskId && { taskId: body.taskId }),
        } satisfies MemoryData)
        return Response.json({ id: event.id })
      })()
    }

    // ── Message routing ─────────────────────────────────────────

    if (path === '/send' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as SendRequest
        if (!body.to || !body.text) {
          return Response.json({ error: 'missing to or text' }, { status: 400 })
        }
        const delivered = await routeSend({
          from: body.from ?? 'api',
          to: body.to,
          text: body.text,
          taskId: body.taskId,
        })
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
          process.stderr.write(
            `[jean] WARNING: agent-idle for "${agentName}" from stale session ${sessionId} (current: ${entry.sessionId})\n`,
          )
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

        type ToolStats = { count: number; samples: Record<string, unknown>[] }
        const byAgent: Record<string, Record<string, ToolStats>> = {}
        for (const e of permEvents) {
          const d = e.data as PermissionRequestData
          byAgent[d.agent] ??= {}
          // biome-ignore lint/style/noNonNullAssertion: initialized by ??= above
          const agentMap = byAgent[d.agent]!
          agentMap[d.tool] ??= { count: 0, samples: [] }
          // biome-ignore lint/style/noNonNullAssertion: initialized by ??= above
          const entry = agentMap[d.tool]!
          entry.count++
          if (entry.samples.length < 5) entry.samples.push(d.input)
        }

        return Response.json({ permissions: byAgent })
      })()
    }

    // ── Trigger CRUD ────────────────────────────────────────────

    if (path === '/triggers' && req.method === 'POST') {
      return (async () => {
        const body = (await req.json()) as {
          id?: string
          cron?: string
          at?: string
          agent: string
          prompt: string
          actor?: string
          metadata?: Record<string, unknown>
        }
        if (!body.agent || !body.prompt) {
          return Response.json({ error: 'missing agent or prompt' }, { status: 400 })
        }
        if (!body.cron && !body.at) {
          return Response.json({ error: 'must specify cron or at' }, { status: 400 })
        }
        if (body.cron && body.at) {
          return Response.json({ error: 'cron and at are mutually exclusive' }, { status: 400 })
        }
        if (body.cron) {
          try {
            new Cron(body.cron)
          } catch {
            return Response.json({ error: 'invalid cron expression' }, { status: 400 })
          }
        }
        if (body.at) {
          const d = new Date(body.at)
          if (Number.isNaN(d.getTime())) {
            return Response.json({ error: 'invalid datetime for at' }, { status: 400 })
          }
        }

        const id = body.id ?? crypto.randomUUID().slice(0, 8)
        if (triggerProjection.state.triggers.some((t) => t.id === id)) {
          return Response.json({ error: 'trigger ID already exists' }, { status: 409 })
        }

        await record('trigger-created', TRIGGERS_STREAM, {
          id,
          cron: body.cron,
          at: body.at,
          agent: body.agent,
          prompt: body.prompt,
          actor: body.actor ?? 'api',
          metadata: body.metadata,
        } satisfies TriggerCreatedData)

        const trigger = triggerProjection.state.triggers.find((t) => t.id === id)
        return Response.json(trigger, { status: 201 })
      })()
    }

    if (path === '/triggers' && req.method === 'GET') {
      let triggers = triggerProjection.state.triggers
      const status = url.searchParams.get('status')
      if (status) triggers = triggers.filter((t) => t.status === status)
      const agent = url.searchParams.get('agent')
      if (agent) triggers = triggers.filter((t) => t.agent === agent)
      return Response.json({ triggers })
    }

    const triggerId = path.match(/^\/triggers\/([^/]+)$/)?.[1]

    if (triggerId && req.method === 'GET') {
      const trigger = triggerProjection.state.triggers.find((t) => t.id === triggerId)
      if (!trigger) return Response.json({ error: 'not found' }, { status: 404 })
      return Response.json(trigger)
    }

    if (triggerId && req.method === 'PATCH') {
      return (async () => {
        const body = (await req.json()) as Record<string, unknown>
        const trigger = triggerProjection.state.triggers.find((t) => t.id === triggerId)
        if (!trigger) return Response.json({ error: 'not found' }, { status: 404 })
        if ('cron' in body || 'at' in body) {
          return Response.json(
            { error: 'schedule is immutable; delete and recreate the trigger to change cron or at' },
            { status: 400 },
          )
        }
        // Reject unknown fields — no silent drops.
        const unknown = Object.keys(body).filter((k) => !TRIGGER_UPDATE_FIELDS.has(k))
        if (unknown.length > 0) {
          return Response.json({ error: `unknown fields: ${unknown.join(', ')}` }, { status: 400 })
        }
        const update: Omit<TriggerUpdatedData, 'id'> = {}
        if ('agent' in body) {
          if (typeof body.agent !== 'string') {
            return Response.json({ error: 'agent must be a string' }, { status: 400 })
          }
          update.agent = body.agent
        }
        if ('prompt' in body) {
          if (typeof body.prompt !== 'string') {
            return Response.json({ error: 'prompt must be a string' }, { status: 400 })
          }
          update.prompt = body.prompt
        }
        if ('status' in body) {
          if (body.status !== 'active' && body.status !== 'disabled') {
            return Response.json({ error: 'status must be "active" or "disabled"' }, { status: 400 })
          }
          update.status = body.status
        }
        if ('metadata' in body) {
          if (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
            return Response.json({ error: 'metadata must be a JSON object (not array)' }, { status: 400 })
          }
          update.metadata = body.metadata as Record<string, unknown>
        }
        await record('trigger-updated', TRIGGERS_STREAM, {
          id: triggerId,
          ...update,
        } satisfies TriggerUpdatedData)
        return Response.json({ ...trigger, ...update })
      })()
    }

    if (triggerId && req.method === 'DELETE') {
      return (async () => {
        const trigger = triggerProjection.state.triggers.find((t) => t.id === triggerId)
        if (!trigger) return Response.json({ error: 'not found' }, { status: 404 })
        await record('trigger-removed', TRIGGERS_STREAM, {
          id: triggerId,
        } satisfies TriggerRemovedData)
        return Response.json({ ok: true })
      })()
    }

    const triggerFireMatch = path.match(/^\/triggers\/([^/]+)\/fire$/)
    if (triggerFireMatch && req.method === 'POST') {
      return (async () => {
        const trigger = triggerProjection.state.triggers.find((t) => t.id === triggerFireMatch[1])
        if (!trigger) return Response.json({ error: 'not found' }, { status: 404 })
        await fireTrigger(trigger)
        return Response.json({ ok: true, triggerId: trigger.id })
      })()
    }

    // ── Playbook endpoints ──────────────────────────────────────

    if (path === '/playbooks' && req.method === 'GET') {
      const playbooks = playbookProjection.state.playbooks.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        hash: p.hash,
        updatedAt: p.updatedAt,
      }))
      return Response.json({ playbooks })
    }

    const playbookMatch = path.match(/^\/playbooks\/([^/]+)$/)
    if (playbookMatch && req.method === 'GET') {
      const playbook = playbookProjection.state.playbooks.find((p) => p.id === playbookMatch[1])
      if (!playbook) return Response.json({ error: 'not found' }, { status: 404 })
      return Response.json(playbook)
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
        const exists = pendingProjection.state.some((e) => e.id === id)
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
        let toAck = pendingProjection.state.filter((e) => e.id <= body.upToId)
        if (body.agent) {
          toAck = toAck.filter((e) => resolveAgent(e) === body.agent)
        }
        const eventIds = toAck.map((e) => e.id)
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
        if (!includeDiagnostics) events = events.filter((e) => e.type !== 'permission-request')
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
            Connection: 'keep-alive',
          },
        })
      })()
    }

    // ── Info endpoints ──────────────────────────────────────────

    if (path === '/board') {
      return Response.json(boardProjection.state)
    }

    if (path === '/agents') {
      // Liveness is only probed for peers (local agents are "live" by
      // definition — they hold an open WS). Probe in parallel; per-peer
      // results are cached for 5s inside peerLiveness().
      return (async () => {
        const list = await Promise.all(
          [...agents.entries()].map(async ([name, entry]) => {
            const base = { name, role: entry.role, idle: entry.idle, tags: entry.tags }
            if (entry.role !== 'peer') return base
            const peer = peers.get(name)
            return { ...base, liveness: peer ? await peerLiveness(peer) : 'unknown' }
          }),
        )
        return Response.json({ agents: list })
      })()
    }

    // Identity: minimal, used by probes to verify "is this our jean infra?"
    if (path === '/') {
      return Response.json(identity())
    }

    // Full status: identity + live projection state, used by humans / CLI.
    if (path === '/status') {
      const sensei = findSensei()
      return Response.json({
        ...identity(),
        agents: [...agents.entries()].map(([n, e]) => ({ name: n, role: e.role })),
        sensei: sensei ? { connected: true, idle: sensei.idle } : { connected: false },
        pendingEvents: pendingProjection.state.length,
        activeTriggers: triggerProjection.state.triggers.filter((t) => t.status === 'active').length,
        slack: SLACK_APP_TOKEN
          ? { configured: true, connected: slackConnected, channel: SLACK_CHANNEL }
          : { configured: false },
      })
    }

    return new Response('not found', { status: 404 })
  },

  websocket: {
    open(_ws) {},

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

            // Handle existing agent with same name.
            const existing = agents.get(msg.agent)
            if (existing && existing.deliver !== wsDeliver(ws)) {
              const sameSession = !!msg.sessionId && !!existing.sessionId && msg.sessionId === existing.sessionId
              const existingStillLive = existing.isLive?.() ?? false
              // Concurrent duplicate: old WS is still live AND the newcomer has
              // a different sessionId. This is two `jean agent start <name>`
              // processes fighting for the same slot. Without this guard, each
              // kick spawns a reconnect that kicks the other, ping-ponging
              // forever and firing a nudge on every cycle. Keep the incumbent;
              // reject the newcomer and tell its plugin to stop reconnecting.
              if (!sameSession && existingStillLive) {
                wsSend(ws, {
                  type: 'deliver',
                  from: 'infra',
                  text: `ERROR: agent "${msg.agent}" is already connected from another session (${existing.sessionId ?? 'unknown'}). This session will be closed — only one process per agent name. Stop the other 'jean agent start ${msg.agent}' if this one is the intended instance.`,
                })
                wsSend(ws, {
                  type: 'error',
                  code: 'duplicate-session',
                  agent: msg.agent,
                  message: 'Another session is already registered for this agent name.',
                })
                ws.close()
                // Route a one-shot notice to sensei so the human has at least one
                // visible surface to learn about the rejection. Without this,
                // sensei is blind (we deliberately suppressed the register
                // event to avoid the nudge-flood problem) and the newcomer's
                // stderr is easy to miss inside a Claude Code TUI.
                const sensei = findSensei()
                if (sensei && sensei.deliver !== wsDeliver(ws)) {
                  sensei.deliver({
                    type: 'deliver',
                    from: 'infra',
                    text:
                      `Notice: rejected a duplicate \`${msg.agent}\` session attempt. ` +
                      `The existing session (sessionId ${existing.sessionId ?? 'unknown'}) is still connected; ` +
                      `the attempted session (sessionId ${msg.sessionId ?? 'unknown'}) was closed. ` +
                      `If the human may have started \`jean agent start ${msg.agent}\` twice by accident, ` +
                      `let them know — only one process per agent name is allowed, and the duplicate's plugin ` +
                      `has been told to stop reconnecting.`,
                  })
                }
                break
              }
              // Old WS is dead (or same session reconnecting) — replace cleanly.
              if (!sameSession) {
                if (ws.data.agent) ws.data.agent = undefined
                existing.close?.()
              }
              agents.delete(msg.agent)
            }

            // Only one sensei allowed
            if (role === 'sensei') {
              const existingSensei = findSensei()
              if (existingSensei) {
                wsSend(ws, {
                  type: 'deliver',
                  from: 'infra',
                  text: 'ERROR: Another sensei is already connected. Only one sensei per dojo. This connection will be ignored.',
                })
                break
              }
            }

            ws.data.agent = msg.agent
            ws.data.role = msg.role
            // Only `in-progress` counts as busy (see TaskStatus doc in board.ts — `waiting` is paused, not active).
            const hasActiveTask = boardProjection.state.tasks.some(
              (t) => t.agent === msg.agent && t.status === 'in-progress',
            )
            const idle = !hasActiveTask
            const sessionId = msg.sessionId
            agents.set(msg.agent, {
              role,
              idle,
              sessionId,
              tags: msg.tags ?? [],
              deliver: wsDeliver(ws),
              close: () => {
                ws.data.agent = undefined
                ws.close()
              },
              isLive: () => ws.readyState === 1,
            })
            wsSend(ws, { type: 'registered', agent: msg.agent, role })
            void record('register', agentStream(msg.agent), {
              agent: msg.agent,
              role,
              idle,
              sessionId,
            } satisfies RegisterData)

            if (role === 'sensei') {
              setTimeout(() => {
                deliverToAgent(msg.agent, {
                  type: 'deliver',
                  from: 'infra',
                  text: 'You just connected. Check the board and events to get up to date.',
                })
              }, 500)
            }
            // Worker/user register events enter pending via the reducer; the post-record nudge
            // in record() wakes the sensei if idle. No explicit nudge needed here.
            break
          }

          case 'reply': {
            const sender = agents.get(msg.from)
            if (sender?.role === 'sensei') {
              process.stderr.write(
                `[jean] dropping reply from sensei ${msg.from} — sensei must use send with an explicit recipient\n`,
              )
              break
            }
            // Prefer taskId carried on the message (flowed through from deliver); fall back to inference for legacy clients.
            const taskId = msg.taskId ?? inferTaskId(msg.from)
            const stream = taskId ? taskStream(taskId) : agentStream(msg.from)
            void record('reply', stream, { agent: msg.from, text: msg.text } satisfies ReplyData)
            break
          }

          case 'send': {
            // `from` comes from the WS session, never the wire — prevents spoofing.
            const from = ws.data.agent
            if (!from || !msg.to || !msg.text) break
            routeSend({ from, to: msg.to, text: msg.text, taskId: msg.taskId }).catch((err) => {
              process.stderr.write(`[jean] ws send from ${from} → ${msg.to} failed: ${err}\n`)
            })
            break
          }

          case 'task-comment': {
            // `from` comes from the WS session. Comment requires an explicit taskId from the sender.
            const from = ws.data.agent
            if (!from || !msg.taskId || !msg.text) break
            const role = agents.get(from)?.role ?? 'worker'
            void record('task-comment', taskStream(msg.taskId), {
              agent: from,
              role,
              text: msg.text,
            } satisfies TaskCommentData)
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

writeRuntimeFiles()
process.stderr.write(`[jean] listening on port ${PORT} (data: ${DATA_DIR})\n`)

void record('start', SYSTEM_STREAM, { port: PORT } satisfies StartData)
await initSlack()

// Start scheduled trigger jobs from projection state
syncTriggerJobs()

// Reconcile playbooks with files on disk, then watch for changes
await reconcilePlaybooks()
watchPlaybooks()
