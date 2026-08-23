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
import { type AgentRole, type DeliverMsg, type ErrorMsg, isAgentRole, type RegisteredMsg } from '../infra/protocol.ts'
import { findDojoRootFrom, readRuntimeFiles } from '../probe.ts'
import {
  buildInstructions,
  buildTools,
  formatInfraResponse,
  optionalString,
  resolveInboxCall,
  resolveReplyTaskId,
  sendOutcome,
} from './tools.ts'

/**
 * Identity is delivered either by env (set per-launch by `jean agent start`) or,
 * when the channel server is registered globally (one ~/.claude.json entry for all
 * dojos), derived from the session: read `.jean-agent.json` from the worktree and
 * walk up to the dojo root. Env wins per-field; the file fills the gaps — so both
 * the per-launch-env and global-registration setups work from the same code.
 */
function sessionDir(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd()
}

const FILE_META: { name?: string; role?: string; tags: string[] } = (() => {
  const candidates = [process.env.JEAN_AGENT_DIR, resolve(sessionDir(), '.jean')].filter(Boolean) as string[]
  for (const dir of candidates) {
    try {
      const file = resolve(dir, '.jean-agent.json')
      if (existsSync(file)) {
        const d = JSON.parse(readFileSync(file, 'utf8'))
        return { name: d.name, role: d.role, tags: d.tags ?? [] }
      }
    } catch {}
  }
  return { tags: [] }
})()

const AGENT_NAME = process.env.JEAN_AGENT ?? FILE_META.name ?? 'unnamed'
/** Register into a dojo ONLY when this session was deliberately launched as an
 *  agent — signalled by the `JEAN_AGENT` env var, which only `jean agent start`
 *  sets. A `.jean-agent.json` file in the cwd is deliberately NOT sufficient:
 *  the channel is registered machine-wide (user scope), so it loads into EVERY
 *  Claude process — and any stray `claude`/`claude -p` whose cwd happens to be
 *  an agent worktree (an unrelated plugin's summariser, a manual shell, the
 *  desktop app) would otherwise read that file, self-identify as the agent, and
 *  flap duplicate-registration attempts against the real one. Requiring the env
 *  var is the one enforceable signal that distinguishes an intended agent from
 *  ambient context; we don't trust a file sitting in a folder. (FILE_META still
 *  supplies role/tags for a launched agent; `--strict-mcp-config` on a caller's
 *  side helps but can't be relied on — not every `claude -p` author passes it.)
 *  Trade-off: an env-less manual `cd <worktree> && claude … server:jean` launch
 *  no longer auto-registers — set `JEAN_AGENT` or use `jean agent start`. */
const IS_LAUNCHED_AGENT = Boolean(process.env.JEAN_AGENT)
const AGENT_ROLE: AgentRole = ((): AgentRole => {
  const raw = process.env.JEAN_ROLE ?? FILE_META.role ?? 'worker'
  if (isAgentRole(raw)) return raw
  process.stderr.write(`[jean] role "${raw}" is not a known role — falling back to worker\n`)
  return 'worker'
})()

/** Locate dojo root: JEAN_DOJO env (validated against the same `jean.config.json`
 *  marker the walk uses) > walk up from the session dir. The two branches must
 *  agree on what a dojo root is, else a stale JEAN_DOJO pointing at a worktree
 *  (which has a `.jean/` but no `jean.config.json`) would be wrongly accepted. */
function discoverDojoRoot(): string | null {
  if (process.env.JEAN_DOJO && existsSync(resolve(process.env.JEAN_DOJO, '.jean', 'jean.config.json'))) {
    return process.env.JEAN_DOJO
  }
  return findDojoRootFrom(sessionDir())
}

const DOJO_ROOT = discoverDojoRoot()

/**
 * Resolve the infra port for THIS agent's dojo. No fallbacks — same strictness
 * as the CLI (see src/cli/jean.ts discoverInfraUrl). If the dojo can't be
 * located or its infra isn't running, return null. Connecting blindly to a
 * default 8700 caused phantom cross-dojo registrations: an agent for a stopped
 * dojo would connect to whichever dojo happened to own 8700 and register as
 * a sensei/worker there, leaving a ghost in that dojo's agents map.
 */
function discoverPort(): number | null {
  if (!DOJO_ROOT) return null
  const { port } = readRuntimeFiles(resolve(DOJO_ROOT, '.jean'))
  return port
}

function discoverInfraWsUrl(): string | null {
  const port = discoverPort()
  return port === null ? null : `ws://127.0.0.1:${port}/ws`
}

function discoverInfraHttpBase(): string | null {
  const port = discoverPort()
  return port === null ? null : `http://127.0.0.1:${port}`
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

// Tags come from the same .jean-agent.json read as name/role (see FILE_META).
const AGENT_TAGS: string[] = FILE_META.tags

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

type ToolResponse = {
  content: { type: 'text'; text: string }[]
  isError?: true
}

/** Error response for an outbound message that couldn't be delivered because the
 *  infra socket is down. The channel auto-reconnects (see scheduleReconnect), so
 *  a retry shortly may succeed; if it persists the agent must be reconnected.
 *  This is what stops a disconnected agent from being told "Sent" when nothing
 *  left the process. */
function undelivered(kind: string): ToolResponse {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${kind} NOT delivered — the channel is not connected to infra (it may be reconnecting). Nothing was sent. Retry in a few seconds; if it keeps failing, this agent needs to be reconnected.`,
      },
    ],
    isError: true,
  }
}

// ── Inbox piggyback (attention phase 1) ──
// The infra attaches a compact inbox line as an `x-jean-inbox` response header
// on sensei requests (identified by the `x-jean-agent` request header). We
// append it to the tool result so an actively-working sensei learns of pending
// work as a side effect of ANY infra call — no Stop hook, no extra fetch.
// Empty inbox = no header = nothing appended (the empty case costs zero).

const IS_SENSEI = AGENT_ROLE === 'sensei'

/** HTTP headers are Latin-1-only — a raw non-ASCII agent name would make
 *  `fetch` THROW on every call (verified in Bun), killing all HTTP tools for
 *  that agent. Percent-encode; infra decodes. */
const HEADER_AGENT_NAME = encodeURIComponent(AGENT_NAME)

/** Identify EVERY agent's HTTP call, not just the sensei's (attention phase 4):
 *  infra infers liveness from observed traffic, and a
 *  worker's infra reads are otherwise invisible between WS frames. The piggyback
 *  itself stays sensei-only — infra decides that by role, not by this header. */
const AGENT_HEADERS = { 'x-jean-agent': HEADER_AGENT_NAME } as const

// Note: the line is appended to error results too — deliberate ("cannot not
// know" beats a slightly cleaner failure message).
function appendInboxLine(text: string, line: string | null): string {
  if (!line) return text
  return `${text}\n\n[inbox] ${line} — not acked; review when you finish the current step.`
}

/** For the WS-path `comment` tool whose transport carries no response: one
 *  cheap localhost GET after a successful send. Best-effort with a hard
 *  timeout — a slow/wedged infra must not stall the tool call over
 *  nonessential piggyback data; any failure just means no line this call.
 *  (`reply` doesn't use this: it's a worker-only tool and the piggyback is
 *  sensei-only in phase 1.) */
async function fetchInboxLine(): Promise<string | null> {
  if (!IS_SENSEI) return null
  const base = discoverInfraHttpBase()
  if (base === null) return null
  try {
    const res = await fetch(`${base}/inbox`, {
      headers: { 'x-jean-agent': HEADER_AGENT_NAME },
      signal: AbortSignal.timeout(1_500),
    })
    if (!res.ok) return null
    return ((await res.json()) as { line?: string | null }).line ?? null
  } catch {
    return null
  }
}

async function callInfraTool(toolName: string, method: string, path: string, body?: unknown): Promise<ToolResponse> {
  const base = discoverInfraHttpBase()
  if (base === null) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${toolName}: infra not running for this dojo (${DOJO_ROOT ?? '<unknown>'}).`,
        },
      ],
      isError: true,
    }
  }
  try {
    const init: RequestInit = { method, headers: { ...AGENT_HEADERS } }
    if (body !== undefined && method !== 'GET') {
      // Models sometimes pass body as a JSON-encoded string despite the
      // schema description saying object — JSON.stringify would then
      // produce a quoted string-of-a-string and the server reads
      // body fields as undefined. Unpack first.
      let payload = body
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload)
        } catch {
          /* keep as string if not valid JSON */
        }
      }
      init.body = JSON.stringify(payload)
      init.headers = { ...init.headers, 'content-type': 'application/json' }
    }
    const res = await fetch(`${base}${path}`, init)
    const { text, isError } = formatInfraResponse(res.status, res.statusText, await res.text())
    return {
      content: [{ type: 'text' as const, text: appendInboxLine(text, res.headers.get('x-jean-inbox')) }],
      ...(isError && { isError: true }),
    }
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `${toolName}: request failed — ${err}` }],
      isError: true,
    }
  }
}

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

    if (!sendToInfra({ type: 'reply', from: AGENT_NAME, text: text.trim(), ...(taskId && { taskId }) })) {
      return undelivered('Reply')
    }

    // No piggyback here: `reply` is a worker-only tool (tools.ts buildTools)
    // and the inbox is sensei-only in phase 1 — the fetch would always no-op.
    return {
      content: [{ type: 'text' as const, text: `Sent to orchestrator${taskId ? ` (task ${taskId})` : ''}.` }],
    }
  }

  if (req.params.name === 'comment') {
    const taskId = optionalString(args, 'taskId')
    const text = optionalString(args, 'text')
    if (!taskId || !text) {
      return {
        content: [{ type: 'text' as const, text: 'comment requires non-empty `taskId` and `text`.' }],
        isError: true,
      }
    }
    if (!sendToInfra({ type: 'task-comment', from: AGENT_NAME, taskId, text })) {
      return undelivered('Comment')
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: appendInboxLine(`Comment recorded on task ${taskId}.`, await fetchInboxLine()),
        },
      ],
    }
  }

  if (req.params.name === 'send') {
    const to = optionalString(args, 'to')
    const text = optionalString(args, 'text')
    const taskId = optionalString(args, 'taskId')
    const attachments = Array.isArray(args.attachments)
      ? (args.attachments.filter((a) => typeof a === 'string' && a.length > 0) as string[])
      : undefined
    if (!to || !text) {
      return {
        content: [{ type: 'text' as const, text: 'send requires non-empty `to` and `text`.' }],
        isError: true,
      }
    }
    // Send over HTTP (not the fire-and-forget WS) so we get the infra's
    // `delivered` result back and can FAIL when the target doesn't exist — a
    // hallucinated address must not read as a successful send.
    const base = discoverInfraHttpBase()
    if (base === null) return undelivered('Message')
    let outcome = { ok: false, queued: false }
    let inboxLine: string | null = null
    try {
      const res = await fetch(`${base}/send`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...AGENT_HEADERS,
        },
        body: JSON.stringify({
          from: AGENT_NAME,
          to,
          text,
          ...(taskId && { taskId }),
          ...(attachments?.length && { attachments }),
        }),
      })
      inboxLine = res.headers.get('x-jean-inbox')
      outcome = sendOutcome((await res.json()) as { delivered?: boolean; queued?: boolean })
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `send failed — request to infra errored: ${err}` }],
        isError: true,
      }
    }
    if (!outcome.ok) {
      return {
        content: [
          {
            type: 'text' as const,
            // NAMES BOTH POSSIBILITIES ON PURPOSE, and stays that way: the
            // routing contract refuses to guess which, because from there the
            // dojo genuinely cannot tell an unknown name from a known one that
            // is offline. Task 129 asked whether this could be sharpened here —
            // it cannot, and passing the server's own notice through instead
            // would swap one vague sentence for the same vague sentence while
            // losing the guidance below.
            text: `NOT delivered to "${to}" — no agent or peer by that name is registered in this dojo (or it's offline). Nothing was sent. Check the name against \`GET /agents\` / \`jean peer list\` — "${to}" may be an address that doesn't exist.`,
          },
        ],
        isError: true,
      }
    }
    const attachNote = attachments?.length ? ` with ${attachments.length} attachment(s)` : ''
    // A queued send is a SUCCESS with a different tense: it sits in the
    // recipient's mailbox and their notifier announces it (on reconnect if
    // they are offline). Saying "sent" for both would be fine; naming the
    // queue keeps the agent's model of offline recipients honest.
    const verb = outcome.queued ? `Queued to ${to}'s mailbox` : `Sent to ${to}`
    return {
      content: [
        {
          type: 'text' as const,
          text: appendInboxLine(`${verb}${taskId ? ` (task ${taskId})` : ''}${attachNote}.`, inboxLine),
        },
      ],
    }
  }

  if (req.params.name === 'memorize') {
    const text = optionalString(args, 'text')
    if (!text) {
      return {
        content: [{ type: 'text' as const, text: 'memorize requires non-empty `text`.' }],
        isError: true,
      }
    }
    const scope = args.scope === 'user' ? 'user' : 'dojo'
    const taskId = optionalString(args, 'taskId')
    return callInfraTool('memorize', 'POST', '/context/memorize', {
      agent: AGENT_NAME,
      role: AGENT_ROLE,
      text,
      scope,
      ...(taskId && { taskId }),
    })
  }

  if (req.params.name === 'inbox') {
    // The read ladder as one operation (task 057): pure mapping onto the
    // existing HTTP surface — the resolved GET carries this agent's identity
    // header, so it is an addressed read of its OWN mailbox, exactly as the
    // hand-built `infra` call was. Validation (selectors ride view:'fetch'
    // only, one per call) lives in resolveInboxCall where it is unit-tested.
    const resolved = resolveInboxCall(args)
    if ('error' in resolved) {
      return { content: [{ type: 'text' as const, text: resolved.error }], isError: true }
    }
    return callInfraTool('inbox', 'GET', resolved.path)
  }

  if (req.params.name === 'ack') {
    // ONE FORM (013 S5): `{id, code}` pairs. `upToId` (drain-all) and the bare
    // `ids` form are both gone, and the reason is the same for both — an id is
    // knowable from a cheap summary line, a code is not, so only the pair form
    // can mean "I read this". Nothing else clears an event any more.
    const raw = args.pairs
    const pairs = Array.isArray(raw)
      ? raw
          .map((p) => p as { id?: unknown; code?: unknown })
          .filter((p) => Number.isInteger(Number(p?.id)) && Number(p?.id) > 0 && typeof p?.code === 'string')
          .map((p) => ({ id: Number(p.id), code: String(p.code) }))
      : []
    if (pairs.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'ack requires `pairs: [{id, code}, ...]`. Codes come from GET /events — fetch first, then ack what you read.',
          },
        ],
        isError: true,
      }
    }
    return callInfraTool('ack', 'POST', '/events/ack', { pairs })
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
    return callInfraTool('infra', method, path, args.body)
  }

  return {
    content: [{ type: 'text' as const, text: `Unknown tool: ${req.params.name}` }],
    isError: true,
  }
})

// ── Infrastructure WebSocket connection ────────────────────────────

let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
/** Set when infra sends a fatal ErrorMsg (e.g. duplicate-session). Stops the
 *  reconnect loop so a rejected plugin doesn't hammer the server forever. */
let fatalClose = false
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

/** Returns true if the message was put on the wire, false if it was dropped
 *  because the infra socket isn't open. Callers that need the agent to know
 *  whether its message actually went out (reply/comment/send) MUST check this —
 *  otherwise a disconnected agent gets a false "sent" while the message is
 *  silently dropped, and the orchestrator never hears from it. */
function sendToInfra(msg: object): boolean {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
    return true
  }
  process.stderr.write(`[jean] not connected to infra, message dropped\n`)
  return false
}

function connectToInfra() {
  // Not deliberately launched as an agent (no JEAN_AGENT env) → stay fully idle:
  // never connect, never retry. Load-bearing guard for machine-wide registration:
  // the channel loads into EVERY Claude process, so without this any stray
  // `claude`/`claude -p` whose cwd is an agent worktree (an unrelated plugin's
  // summariser, the desktop app, a manual shell) would read the worktree's
  // `.jean-agent.json`, self-identify as that agent, and flap duplicate-register
  // attempts against the real one. Only `jean agent start`-launched agents (which
  // set JEAN_AGENT) proceed. A file in the folder is not enough — see IS_LAUNCHED_AGENT.
  if (!IS_LAUNCHED_AGENT) {
    process.stderr.write('[jean] not a launched agent (no JEAN_AGENT) — channel idle, not connecting.\n')
    return
  }
  try {
    const url = discoverInfraWsUrl()
    if (url === null) {
      if (!DOJO_ROOT) {
        // Named agent, but no dojo resolved (stale config). Nothing to wait
        // for — stay idle rather than spin the 2s reconnect loop forever.
        process.stderr.write('[jean] no dojo for this session — channel idle, not connecting.\n')
        return
      }
      // Dojo found but its infra isn't up yet. Don't fall back to a default
      // port — that's how phantom cross-dojo registrations happen. Stay alive
      // and retry; this is transient (infra will come up).
      process.stderr.write(
        `[jean] no infra port for dojo ${DOJO_ROOT} — not connecting. Will retry; start infra with 'jean infra start'.\n`,
      )
      scheduleReconnect()
      return
    }
    ws = new WebSocket(url)

    ws.addEventListener('open', () => {
      process.stderr.write(`[jean] connected to infra at ${url} as "${AGENT_NAME}" session=${SESSION_ID}\n`)
      sendToInfra({ type: 'register', agent: AGENT_NAME, role: AGENT_ROLE, sessionId: SESSION_ID, tags: AGENT_TAGS })
    })

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as DeliverMsg | RegisteredMsg | ErrorMsg

        switch (msg.type) {
          case 'registered':
            process.stderr.write(`[jean] registered as "${msg.agent}"\n`)
            writeSessionFile()
            break

          case 'deliver':
            if (msg.taskId) lastDeliverTaskId = msg.taskId
            deliver(msg.from, msg.text, msg.taskId ? { taskId: msg.taskId } : {})
            break

          case 'error':
            // Infra rejected this connection for a reason the plugin can't
            // recover from (currently: another session holds this name).
            // Stop reconnecting so we don't flap — the human must resolve it.
            process.stderr.write(`[jean] fatal: ${msg.code} — ${msg.message}\n`)
            fatalClose = true
            break
        }
      } catch {
        // Ignore malformed messages
      }
    })

    ws.addEventListener('close', () => {
      if (fatalClose) {
        process.stderr.write(`[jean] connection closed (fatal); not reconnecting.\n`)
        return
      }
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

// Detect parent death: when Claude exits, stdin closes (SDK doesn't handle
// this — see PR #1613).
process.stdin.on('end', () => {
  process.stderr.write(`[jean] stdin closed (parent died), shutting down\n`)
  ws?.close()
  process.exit(0)
})

process.stderr.write(`[jean] channel plugin started for agent "${AGENT_NAME}"\n`)
