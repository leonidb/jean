/**
 * jean peek — read another dojo's state from disk.
 *
 * Works on stopped dojos (reads .jean/history.jsonl directly, no HTTP). Rides
 * on the EventStore abstraction so a future JSONL→SQLite swap doesn't break
 * callers. Supports a per-caller delta cursor so repeat peeks return only
 * what's new.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createStore, jsonlBackend, type StoredEvent } from '../es/index.ts'
import type { Board, Task } from '../infra/board.ts'
import { agentFromEvent, boardReducer, migrateBoard } from '../infra/reducers.ts'

// ── Types ─────────────────────────────────────────────────────────

export type PeekResult = {
  target: { path: string; identity: string | null }
  board: Board
  events: StoredEvent[] // filtered, ordered by id ascending
  cursor: { lastEventId: number; eventsSince?: number }
  agents: string[] // union of discoverable agent names (registry + event history)
}

export type PeekOpts = {
  sinceId?: number // lower bound on event id; return events with id > sinceId
  lastN?: number // cap recent events to last N (default 20); ignored if sinceId set
}

type CursorFile = {
  cursors: Record<string, { lastEventId: number; lastPeekAt: string }>
}

// Events worth surfacing in the default output. Mirrors `jean task log`'s
// filter — administrative noise (ack, register/disconnect, nudge) is excluded.
const SIGNIFICANT_EVENT_TYPES = new Set([
  'task-created',
  'task-status',
  'task-reverted',
  'task-updated',
  'task-comment',
  'send',
  'reply',
  'agent-idle',
  'trigger-fired',
  'permission-request',
  // H4 (2026-08-11): a worker going down/stuck/recovered, and the S11 human
  // report, are exactly what a human peeking at a dojo wants to see.
  'worker-status',
  'agent-unresponsive',
])

// ── Core read ─────────────────────────────────────────────────────

/**
 * Load the target dojo's events + project the board. No HTTP, no assumption
 * that infra is running.
 */
export async function peekDojo(targetPath: string, opts: PeekOpts = {}): Promise<PeekResult> {
  const realTarget = realpathSync(targetPath)
  const jeanDir = resolve(realTarget, '.jean')
  if (!existsSync(jeanDir)) {
    throw new Error(`Not a Jean dojo: ${realTarget} (no .jean/ directory)`)
  }

  const historyPath = resolve(jeanDir, 'history.jsonl')
  const store = createStore(jsonlBackend(historyPath))
  const all = await store.read()
  const lastEventId = all.at(-1)?.id ?? 0

  // Project the full board from all events. Reducers are cheap and pure; for
  // dojos with 10k+ events we could load board.snapshot.json and catch up,
  // but that's premature — measure before optimizing.
  const board = migrateBoard(all.reduce(boardReducer, { tasks: [] } as Board))

  // Event window: if sinceId set, strictly events past it; otherwise tail.
  let windowed: StoredEvent[]
  if (opts.sinceId !== undefined) {
    windowed = all.filter((e) => e.id > (opts.sinceId ?? 0))
  } else {
    const limit = opts.lastN ?? 20
    windowed = all.slice(-Math.max(limit * 3, 60)) // oversample so the filter below can still return ~limit
  }
  const filtered = windowed.filter((e) => SIGNIFICANT_EVENT_TYPES.has(e.type))
  const events = opts.sinceId !== undefined ? filtered : filtered.slice(-(opts.lastN ?? 20))

  // Identity from jean.config.json if present; falls back to basename.
  let identity: string | null = null
  try {
    const cfg = JSON.parse(readFileSync(resolve(jeanDir, 'jean.config.json'), 'utf8'))
    identity = typeof cfg.identity === 'string' ? cfg.identity : null
  } catch {}

  // Agent names: union of board.agent + agentFromEvent (canonical). Messaging
  // events (send, reply) additionally carry sender/receiver as from/to —
  // agentFromEvent only covers data.agent, so merge those in for send/reply.
  const agentSet = new Set<string>()
  for (const t of board.tasks) if (t.agent) agentSet.add(t.agent)
  for (const e of all) {
    const canonical = agentFromEvent(e)
    if (canonical) agentSet.add(canonical)
    if (e.type === 'send' || e.type === 'reply' || e.type === 'task-comment') {
      const d = (e.data ?? {}) as Record<string, unknown>
      if (typeof d.from === 'string' && d.from.length > 0) agentSet.add(d.from)
      if (typeof d.to === 'string' && d.to.length > 0) agentSet.add(d.to)
    }
  }

  return {
    target: { path: realTarget, identity },
    board,
    events,
    cursor: {
      lastEventId,
      eventsSince: opts.sinceId !== undefined ? all.filter((e) => e.id > opts.sinceId!).length : undefined,
    },
    agents: [...agentSet].sort(),
  }
}

// ── Cursor persistence ────────────────────────────────────────────

function cursorPath(callerDojo: string): string {
  return resolve(callerDojo, '.jean', 'peek-cursors.json')
}

function readCursorFile(callerDojo: string): CursorFile {
  try {
    return JSON.parse(readFileSync(cursorPath(callerDojo), 'utf8')) as CursorFile
  } catch {
    return { cursors: {} }
  }
}

export function readCursor(callerDojo: string, targetRealpath: string): number | undefined {
  return readCursorFile(callerDojo).cursors[targetRealpath]?.lastEventId
}

export function writeCursor(callerDojo: string, targetRealpath: string, lastEventId: number): void {
  const file = readCursorFile(callerDojo)
  file.cursors[targetRealpath] = { lastEventId, lastPeekAt: new Date().toISOString() }
  const p = cursorPath(callerDojo)
  mkdirSync(resolve(callerDojo, '.jean'), { recursive: true })
  writeFileSync(p, `${JSON.stringify(file, null, 2)}\n`)
}

// ── Formatters ────────────────────────────────────────────────────

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

export function formatPeekJson(result: PeekResult): string {
  return JSON.stringify(result, null, 2)
}

export function formatPeekPretty(result: PeekResult): string {
  const lines: string[] = []
  const name = result.target.identity ?? result.target.path.split('/').pop()
  lines.push(`${BOLD}${name}${RESET} ${DIM}${result.target.path}${RESET}`)

  // Board summary
  const byStatus = new Map<string, Task[]>()
  for (const t of result.board.tasks) {
    const arr = byStatus.get(t.status) ?? []
    arr.push(t)
    byStatus.set(t.status, arr)
  }
  const statusOrder = ['in-progress', 'waiting', 'assigned', 'todo', 'done', 'cancelled']
  const summary = statusOrder
    .filter((s) => byStatus.has(s))
    .map((s) => `${byStatus.get(s)!.length} ${s}`)
    .join(', ')
  lines.push('')
  lines.push(`${BOLD}Board${RESET} — ${summary || 'empty'}`)
  for (const status of ['in-progress', 'waiting', 'todo', 'assigned']) {
    for (const t of byStatus.get(status) ?? []) {
      const agent = t.agent ? ` ${DIM}(${t.agent})${RESET}` : ''
      lines.push(`  ${DIM}${status}${RESET} ${t.id} ${t.title}${agent}`)
    }
  }

  // Agents
  if (result.agents.length > 0) {
    lines.push('')
    lines.push(`${BOLD}Agents${RESET} ${result.agents.join(', ')}`)
  }

  // Recent events
  lines.push('')
  const header =
    result.cursor.eventsSince !== undefined
      ? `${BOLD}Events since last peek${RESET} (${result.cursor.eventsSince} new)`
      : `${BOLD}Recent events${RESET} (last ${result.events.length})`
  lines.push(header)
  if (result.events.length === 0) {
    lines.push(`  ${DIM}(none)${RESET}`)
  } else {
    for (const e of result.events) {
      lines.push(`  ${formatEventLine(e)}`)
    }
  }

  lines.push('')
  lines.push(`${DIM}cursor: lastEventId=${result.cursor.lastEventId}${RESET}`)
  return lines.join('\n')
}

function formatEventLine(e: StoredEvent): string {
  const t = e.ts.slice(11, 19)
  const d = (e.data ?? {}) as Record<string, unknown>
  const agent = typeof d.agent === 'string' ? d.agent : undefined
  const text = typeof d.text === 'string' ? truncate(d.text as string, 80) : undefined

  switch (e.type) {
    case 'task-created':
      return `${DIM}${t}${RESET} task-created ${e.stream.slice(5)} ${truncate(String(d.title ?? ''), 60)}`
    case 'task-status':
      return `${DIM}${t}${RESET} task-status ${e.stream.slice(5)} ${d.from} → ${d.to}`
    case 'task-reverted':
      return `${DIM}${t}${RESET} task-reverted ${e.stream.slice(5)} → ${d.to}`
    case 'task-comment':
      return `${DIM}${t}${RESET} comment ${e.stream.slice(5)} ${agent ?? ''} ${text ?? ''}`
    case 'send':
      return `${DIM}${t}${RESET} send ${d.from} → ${d.to} ${text ?? ''}`
    case 'reply':
      return `${DIM}${t}${RESET} reply ${agent ?? ''} ${text ?? ''}`
    case 'agent-idle':
      return `${DIM}${t}${RESET} idle ${agent ?? ''}`
    case 'trigger-fired':
      return `${DIM}${t}${RESET} trigger-fired ${d.id ?? ''}`
    case 'permission-request':
      return `${DIM}${t}${RESET} permission ${agent ?? ''} ${d.tool ?? ''}`
    default:
      return `${DIM}${t}${RESET} ${e.type} ${agent ?? ''}`
  }
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}
