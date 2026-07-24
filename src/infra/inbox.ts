/**
 * Inbox summary — the triage payload of the attention-management design
 * (docs/attention.md, phase 1: summary-in-nudge + piggyback).
 *
 * Builds a per-agent summary of pending events, split into:
 *   - blocking: human-origin (user-role) messages — someone is waiting.
 *     Coalesced per sender: count, LATEST preview, OLDEST age (a 10-message
 *     burst must not look fresh while the human has waited 8 minutes),
 *     media kinds (photo/file/text) so "shelf-photo burst, can batch" is
 *     distinguishable from "question needing an answer now".
 *   - queued: everything machine-shaped, as type-granular counts only
 *     (worker:reply vs worker:idle is the load-bearing distinction; a
 *     trigger's urgency is ~fully determined by which trigger it is, so
 *     trigger firings carry their id). No previews — counts are the cheap 90%.
 *
 * Two render forms (sensei-review gate, docs/attention.md §2):
 *   - renderInboxWake: full JSON — rides on wakes (nudges).
 *   - renderInboxLine: compact ASCII one-liner — piggybacks on tool responses
 *     via the `x-jean-inbox` header (headers must be ASCII), omitted entirely
 *     when the inbox is empty so the empty case costs zero.
 *
 * Pure functions — no server state; callers supply pending events, the clock,
 * and a role-lookup. Phase 1 scope: the sensei's inbox only (workers get
 * queues in phase 5).
 */

import type { StoredEvent } from '../es/index.ts'

export type InboxBlockingEntry = {
  /** Event ids coalesced into this entry (oldest→newest). */
  ids: number[]
  from: string
  /** Age of the OLDEST unhandled message from this sender. */
  waitedMs: number
  /** Number of coalesced messages. */
  count: number
  /** LATEST message's text, truncated. */
  preview: string
  /** Media kinds across the coalesced messages ({photo: 2, text: 1}). Zero entries omitted. */
  kinds: Record<string, number>
}

export type Inbox = {
  blocking: InboxBlockingEntry[]
  queued: { count: number; byType: Record<string, number>; oldestMs: number }
}

const PREVIEW_MAX = 90

type BuildOpts = {
  now: number
  /** Live-registry role lookup. May return undefined for disconnected senders. */
  roleOf: (name: string) => string | undefined
}

function eventAgeMs(e: StoredEvent, now: number): number {
  // Prefer the human's actual send-time when the bridge preserved it.
  const sentAt = (e.data as { sentAt?: unknown }).sentAt
  const at = typeof sentAt === 'number' ? sentAt : Date.parse(e.ts)
  return Math.max(0, now - (Number.isNaN(at) ? now : at))
}

/** Bridge surfaces register as `chat-<id>`; used as a fallback when the sender
 *  isn't currently in the live registry (bridge briefly disconnected). */
function isUserSender(name: string, roleOf: BuildOpts['roleOf']): boolean {
  const role = roleOf(name)
  if (role !== undefined) return role === 'user'
  return name.startsWith('chat-')
}

function messageKind(text: string): 'photo' | 'file' | 'text' {
  if (text.includes('[image]')) return 'photo'
  if (text.includes('[file]') || text.includes('[document]')) return 'file'
  return 'text'
}

/** Machine-event type key — granular enough to triage without previews. */
function queuedType(e: StoredEvent, roleOf: BuildOpts['roleOf']): string {
  const d = e.data as Record<string, unknown>
  switch (e.type) {
    case 'reply': {
      const sender = typeof d.agent === 'string' ? d.agent : 'unknown'
      const role = roleOf(sender) ?? 'worker'
      return `${role}:reply`
    }
    case 'task-comment': {
      const role = typeof d.role === 'string' ? d.role : 'worker'
      return `${role}:comment`
    }
    case 'trigger-fired': {
      const id = typeof d.triggerId === 'string' ? d.triggerId : 'unknown'
      return `trigger:${id}`
    }
    case 'playbook-created':
    case 'playbook-updated':
    case 'playbook-removed':
      return 'playbook'
    default:
      // task-created, register, disconnect, wiki-consolidated, ...
      return e.type
  }
}

/** Build the inbox for the given pending events. Returns null when empty —
 *  the empty case must cost zero everywhere downstream. */
export function buildInbox(events: StoredEvent[], opts: BuildOpts): Inbox | null {
  if (events.length === 0) return null

  const byUser = new Map<string, StoredEvent[]>()
  const machine: StoredEvent[] = []
  for (const e of events) {
    const d = e.data as { agent?: unknown }
    const sender = typeof d.agent === 'string' ? d.agent : undefined
    if (e.type === 'reply' && sender && isUserSender(sender, opts.roleOf)) {
      const list = byUser.get(sender) ?? []
      list.push(e)
      byUser.set(sender, list)
    } else {
      machine.push(e)
    }
  }

  const blocking: InboxBlockingEntry[] = []
  for (const [from, list] of byUser) {
    list.sort((a, b) => a.id - b.id)
    const kinds: Record<string, number> = {}
    for (const e of list) {
      const k = messageKind(String((e.data as { text?: unknown }).text ?? ''))
      kinds[k] = (kinds[k] ?? 0) + 1
    }
    const latest = list[list.length - 1] as StoredEvent
    const oldest = list[0] as StoredEvent
    const latestText = String((latest.data as { text?: unknown }).text ?? '')
    blocking.push({
      ids: list.map((e) => e.id),
      from,
      waitedMs: eventAgeMs(oldest, opts.now),
      count: list.length,
      preview: latestText.length > PREVIEW_MAX ? `${latestText.slice(0, PREVIEW_MAX)}…` : latestText,
      kinds,
    })
  }
  // Longest-waiting human first.
  blocking.sort((a, b) => b.waitedMs - a.waitedMs)

  const byType: Record<string, number> = {}
  let oldestMs = 0
  for (const e of machine) {
    const t = queuedType(e, opts.roleOf)
    byType[t] = (byType[t] ?? 0) + 1
    const age = eventAgeMs(e, opts.now)
    if (age > oldestMs) oldestMs = age
  }

  return { blocking, queued: { count: machine.length, byType, oldestMs } }
}

function fmtAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

/** ASCII-only shortening for header transport ("chat-1000000001" → "chat-1000.."). */
function shortName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '?')
  return ascii.length <= 12 ? ascii : `${ascii.slice(0, 10)}..`
}

/**
 * Compact one-line form for the piggyback (`x-jean-inbox` response header).
 * ASCII-only (HTTP header constraint). Examples:
 *   "1 blocking (chat-1000.., 3m) | 4 queued (oldest 12m)"
 *   "2 blocking (chat-1000.. x3, 8m; cli, 40s) | 1 queued (oldest 2m)"
 *   "3 queued (oldest 5m)"
 */
export function renderInboxLine(inbox: Inbox): string {
  const parts: string[] = []
  if (inbox.blocking.length > 0) {
    const who = inbox.blocking
      .map((b) => `${shortName(b.from)}${b.count > 1 ? ` x${b.count}` : ''}, ${fmtAge(b.waitedMs)}`)
      .join('; ')
    parts.push(`${inbox.blocking.length} blocking (${who})`)
  }
  if (inbox.queued.count > 0) {
    parts.push(`${inbox.queued.count} queued (oldest ${fmtAge(inbox.queued.oldestMs)})`)
  }
  return parts.join(' | ')
}

/**
 * Full form for wakes (nudges). Carries the whole object so triage needs zero
 * follow-up fetches. Phase 1 keeps today's ack semantics — the trailing
 * instruction matches the existing sensei skill contract.
 */
export function renderInboxWake(inbox: Inbox): string {
  return [
    `Events pending — inbox summary (not yet acked):`,
    JSON.stringify(inbox, null, 1),
    // Matches the current ack tool contract exactly (upToId cursor) — per-event
    // ack arrives in phase 3; don't hint at semantics that don't exist yet.
    `Full payloads: GET /events. When done, ack({upToId: <highest id processed>}).`,
  ].join('\n')
}
