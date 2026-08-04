/**
 * Questions about the pending queue, as pure functions (refactor stage 4 —
 * task 036; spec = task 035's delta comment).
 *
 * Every one of these was a closure over `pendingProjection` and
 * `boardProjection` inside the factory, which meant none of them could be asked
 * a question without standing up a server. They take the queue as an argument
 * now, and the two lookups they need — "who owns this task?" and "what role is
 * this name?" — arrive as functions.
 *
 * ── WHY THESE ARE CALLED, NOT SUBSCRIBED (035's rule) ──
 *
 * A subscriber reacts to an event that already happened; a called function
 * answers a question before one does. These are reads. The topology is finished
 * — stage 3 landed the bus and nothing new joins it.
 *
 * ── inboxFor, AND THE ONE PIECE OF FORWARD SHAPE HERE ──
 *
 * `senseiInboxNow()` became `inboxFor(..., {agent})`. The pending queue is the
 * sensei's queue today, so the sensei's inbox is the whole of it and `agent` is
 * left undefined at every call site. The parameter exists because per-agent
 * inboxes are the settled phase-5 target and this is the query surface they
 * arrive through — NOT because anything reads it yet. It is a signature, not
 * storage: `pendingByAgent` stays a count over the one queue and must not grow
 * into per-agent state here (034's closure: the mailbox reshape is protocol-era).
 */

import type { StoredEvent } from '../../es/index.ts'
import { buildInbox, type Inbox, isUserSender } from '../inbox.ts'
import { agentFromEvent, taskIdFromStream } from '../reducers.ts'

/** "Who owns this task?" — the board lookup, without the board. */
export type TaskOwner = (taskId: string) => { agent?: string; queue?: string } | undefined

/** "What role does this name have?" — the live registry plus the persisted
 *  user/sensei sets, without either. MUST match the inbox's own lookup: a
 *  divergence means a wake whose payload contradicts it. */
export type RoleOf = Parameters<typeof isUserSender>[1]

/** Which agent an event concerns: stated on the event, or inherited from the
 *  task its stream belongs to. */
export function resolveAgent(event: StoredEvent, taskOwner: TaskOwner): string | undefined {
  const agent = agentFromEvent(event)
  if (agent) return agent
  const taskId = taskIdFromStream(event.stream)
  if (taskId) {
    const task = taskOwner(taskId)
    return task?.agent ?? task?.queue
  }
  return undefined
}

/** The queue, whole or filtered to one agent. Copies rather than aliasing the
 *  projection's array, as the closure version did. */
export function pendingEvents(pending: readonly StoredEvent[], taskOwner: TaskOwner, agent?: string): StoredEvent[] {
  if (!agent) return [...pending]
  return pending.filter((e) => resolveAgent(e, taskOwner) === agent)
}

/** How many pending events each agent has. Events that resolve to nobody are
 *  counted for nobody — deliberate, not an oversight: a queue entry with no
 *  owner is a real state and inventing one would hide it. */
export function pendingByAgent(pending: readonly StoredEvent[], taskOwner: TaskOwner): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const e of pending) {
    const agent = resolveAgent(e, taskOwner)
    if (agent) counts[agent] = (counts[agent] ?? 0) + 1
  }
  return counts
}

/**
 * Is this event a human waiting?
 *
 * The classification the whole blocking path turns on, and it MUST agree with
 * the inbox's — hence the shared `isUserSender` (including its `chat-` prefix
 * fallback) rather than a second opinion. A divergence produces a wake whose
 * own payload contradicts it (review finding, 2026-07-24).
 */
export function isBlockingEvent(event: StoredEvent, roleOf: RoleOf): boolean {
  if (event.type !== 'reply') return false
  const sender = (event.data as { agent?: unknown }).agent
  if (typeof sender !== 'string') return false
  return isUserSender(sender, roleOf)
}

/** Guard 1's input: is anyone waiting? Read immediately before an append, and
 *  again as the attention view's `blockingPendingIds`. */
export function hasBlockingPending(pending: readonly StoredEvent[], roleOf: RoleOf): boolean {
  return pending.some((e) => isBlockingEvent(e, roleOf))
}

/** Ids of pending blocking events from ONE sender. Guard 7 asks this twice —
 *  once at entry and once at the tail — and compares the answers, so it lives
 *  here rather than being spelled out at both call sites. */
export function blockingPendingFrom(pending: readonly StoredEvent[], roleOf: RoleOf, sender: string): number[] {
  return pending
    .filter((e) => isBlockingEvent(e, roleOf) && (e.data as { agent?: unknown }).agent === sender)
    .map((e) => e.id)
}

/** The inbox as of `now`. `buildInbox` was already pure; this is the query
 *  surface around it — pull, per the inbox-is-core-state ruling. */
export function inboxFor(
  pending: readonly StoredEvent[],
  taskOwner: TaskOwner,
  opts: { now: number; roleOf: RoleOf; agent?: string },
): Inbox | null {
  return buildInbox(pendingEvents(pending, taskOwner, opts.agent), { now: opts.now, roleOf: opts.roleOf })
}
