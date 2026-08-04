/**
 * The queue queries, tested BY EVENTS (refactor stage 4 — task 036).
 *
 * The queue these functions answer questions about is built by FOLDING REAL
 * EVENTS through the real `pendingReducer`, not by hand-assembling an array.
 * That is the difference between testing the queries and testing my idea of
 * what the projection contains — an ack that the reducer handles differently
 * than I assume would go unnoticed by the second kind of test.
 *
 * No server, no sockets, no clock: `now` is an argument.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../../es/index.ts'
import { pendingReducer } from '../reducers.ts'
import {
  blockingPendingFrom,
  hasBlockingPending,
  inboxFor,
  isBlockingEvent,
  pendingByAgent,
  pendingEvents,
  type RoleOf,
  resolveAgent,
  type TaskOwner,
} from './queue.ts'

let nextId = 1
function ev(
  type: string,
  stream: string,
  data: Record<string, unknown> = {},
  ts = '2026-08-04T12:00:00.000Z',
): StoredEvent {
  return { id: nextId++, stream, type, ts, data }
}

/** Fold events into a pending queue exactly as the projection does. */
function queueOf(...events: StoredEvent[]): StoredEvent[] {
  return events.reduce<StoredEvent[]>((state, e) => pendingReducer(state, e) as StoredEvent[], [])
}

/** Nobody owns anything unless a test says so. */
const noTasks: TaskOwner = () => undefined

const roles: Record<string, string> = { human: 'user', sensei: 'sensei', w1: 'worker' }
const roleOf: RoleOf = (n) => roles[n] as ReturnType<RoleOf>

describe('resolveAgent', () => {
  test('prefers the agent stated on the event', () => {
    expect(resolveAgent(ev('reply', 'agent-w1', { agent: 'w1' }), noTasks)).toBe('w1')
  })

  test('falls back to the task owner, and to its QUEUE when unassigned', () => {
    const owner: TaskOwner = (id) => (id === '007' ? { agent: 'w1', queue: 'builder' } : { queue: 'builder' })
    expect(resolveAgent(ev('task-created', 'task-007'), owner)).toBe('w1')
    expect(resolveAgent(ev('task-created', 'task-008'), owner)).toBe('builder')
  })

  test('resolves to nobody when the stream names no task and the event no agent', () => {
    expect(resolveAgent(ev('task-created', 'system'), noTasks)).toBeUndefined()
    // A task stream the board has never heard of — a real state after a
    // history edit, and it must not throw or invent an owner.
    expect(resolveAgent(ev('task-created', 'task-999'), noTasks)).toBeUndefined()
  })
})

describe('pendingEvents / pendingByAgent', () => {
  test('the whole queue is returned as a COPY — callers cannot mutate the projection', () => {
    const queue = queueOf(ev('reply', 'agent-w1', { agent: 'w1' }))
    const out = pendingEvents(queue, noTasks)
    out.push(ev('reply', 'agent-w2', { agent: 'w2' }))
    expect(queue).toHaveLength(1)
  })

  test('filtering by agent uses the same resolution as the counts', () => {
    const owner: TaskOwner = () => ({ queue: 'builder' })
    const queue = queueOf(
      ev('reply', 'agent-w1', { agent: 'w1' }),
      ev('reply', 'agent-w1', { agent: 'w1' }),
      ev('task-created', 'task-007'), // resolves to the queue, 'builder'
    )
    expect(pendingEvents(queue, owner, 'w1')).toHaveLength(2)
    expect(pendingEvents(queue, owner, 'builder')).toHaveLength(1)
    expect(pendingEvents(queue, owner, 'nobody')).toHaveLength(0)
    expect(pendingByAgent(queue, owner)).toEqual({ w1: 2, builder: 1 })
  })

  test('events that resolve to nobody are counted for nobody', () => {
    const queue = queueOf(ev('reply', 'agent-w1', { agent: 'w1' }), ev('task-created', 'task-404'))
    // Deliberate: an unowned queue entry is a real state, and inventing an
    // owner for it would hide exactly the case worth seeing.
    expect(pendingByAgent(queue, noTasks)).toEqual({ w1: 1 })
    expect(queue).toHaveLength(2)
  })

  test('a drained queue answers empty rather than throwing', () => {
    const reply = ev('reply', 'agent-w1', { agent: 'w1' })
    const queue = queueOf(reply, ev('ack', 'system', { eventIds: [reply.id] }))
    expect(queue).toEqual([])
    expect(pendingEvents(queue, noTasks)).toEqual([])
    expect(pendingByAgent(queue, noTasks)).toEqual({})
  })
})

describe('blocking classification', () => {
  test('only a REPLY from a user-role sender is blocking', () => {
    expect(isBlockingEvent(ev('reply', 'agent-human', { agent: 'human' }), roleOf)).toBe(true)
    // A worker reply is machine traffic: idle-gated nudge, not a wake.
    expect(isBlockingEvent(ev('reply', 'agent-w1', { agent: 'w1' }), roleOf)).toBe(false)
    // Type matters as much as sender — a human-created task is not someone waiting.
    expect(isBlockingEvent(ev('task-created', 'task-1', { agent: 'human' }), roleOf)).toBe(false)
  })

  test('a malformed or absent sender is not blocking, and does not throw', () => {
    expect(isBlockingEvent(ev('reply', 'agent-x', {}), roleOf)).toBe(false)
    expect(isBlockingEvent(ev('reply', 'agent-x', { agent: 42 }), roleOf)).toBe(false)
  })

  test('an UNKNOWN sender named chat-* is blocking — the registry-prefix fallback', () => {
    // The case that matters after a bridge reconnect or an infra restart: the
    // name is not in the registry, and demoting a waiting human to machine
    // traffic is the one class that must never be missed.
    expect(isBlockingEvent(ev('reply', 'agent-chat-42', { agent: 'chat-42' }), roleOf)).toBe(true)
    expect(isBlockingEvent(ev('reply', 'agent-stranger', { agent: 'stranger' }), roleOf)).toBe(false)
  })

  test('hasBlockingPending is guard 1s input: true iff someone is waiting', () => {
    expect(hasBlockingPending(queueOf(ev('reply', 'agent-w1', { agent: 'w1' })), roleOf)).toBe(false)
    expect(hasBlockingPending(queueOf(ev('reply', 'agent-human', { agent: 'human' })), roleOf)).toBe(true)

    // ...and it goes false again the moment the human's event is acked, which
    // is what ends the blocking episode.
    const q = ev('reply', 'agent-human', { agent: 'human' })
    expect(hasBlockingPending(queueOf(q, ev('ack', 'system', { eventIds: [q.id] })), roleOf)).toBe(false)
  })

  test('blockingPendingFrom returns ids for ONE sender, in queue order', () => {
    const a1 = ev('reply', 'agent-human', { agent: 'human' })
    const other = ev('reply', 'agent-chat-9', { agent: 'chat-9' })
    const a2 = ev('reply', 'agent-human', { agent: 'human' })
    const queue = queueOf(a1, other, a2, ev('reply', 'agent-w1', { agent: 'w1' }))
    expect(blockingPendingFrom(queue, roleOf, 'human')).toEqual([a1.id, a2.id])
    expect(blockingPendingFrom(queue, roleOf, 'chat-9')).toEqual([other.id])
    expect(blockingPendingFrom(queue, roleOf, 'w1')).toEqual([])
  })
})

describe('inboxFor', () => {
  const NOW = Date.UTC(2026, 7, 4, 12, 5, 0)

  test('splits the folded queue into blocking senders and machine counts', () => {
    const queue = queueOf(
      ev('reply', 'agent-human', { agent: 'human', text: 'where are we?' }, new Date(NOW - 60_000).toISOString()),
      ev('reply', 'agent-w1', { agent: 'w1', text: 'done' }),
    )
    const inbox = inboxFor(queue, noTasks, { now: NOW, roleOf })
    expect(inbox?.blocking).toHaveLength(1)
    expect(inbox?.blocking[0]?.from).toBe('human')
    expect(inbox?.blocking[0]?.preview).toBe('where are we?')
    // Age is measured from the OLDEST unhandled message, against the `now` we
    // passed — no wall clock anywhere in this file.
    expect(inbox?.blocking[0]?.waitedMs).toBe(60_000)
    // The worker's reply lands in `queued` as a type-granular count, not a
    // preview — counts are the cheap 90% for machine traffic.
    expect(inbox?.queued.count).toBe(1)
    expect(inbox?.queued.byType).toEqual({ 'worker:reply': 1 })
  })

  test('an empty queue has NO inbox — null, not an empty object', () => {
    // Load-bearing downstream: the piggyback header and the wake text both
    // branch on null, and the empty case is meant to cost zero.
    expect(inboxFor([], noTasks, { now: NOW, roleOf })).toBeNull()
  })
})
