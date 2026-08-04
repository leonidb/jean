/**
 * The pending fold's ack case, pinned as CHARACTERIZATION for the one-commit
 * transition (task 041 milestone 1, the fold-order pin commit, carried forward and re-aimed by
 * task 044).
 *
 * ── WHAT THESE ARE, AND WHAT THEY ARE NOT ──
 *
 * They are GREEN ON ARRIVAL, by design. Every case here exercises the reducer
 * exactly as it already is, and that is the point: `state.filter(e =>
 * !acked.has(e.id))` is ALREADY idempotent, so unknown ids, duplicate acks,
 * already-cleared ids, repeats inside one ack and the empty ack are all
 * structural no-ops in today's fold. That property is what makes the write-time
 * ack-claim machinery a redundant second layer rather than a load-bearing one —
 * demonstrated here rather than asserted, which is the difference between
 * deleting the claim safely and deleting it hopefully.
 *
 * They are NOT coverage of the transition's new ack behaviour. The three
 * genuinely-new assertions — two ack events in the log for one id, both callers
 * reporting the ids cleared, the FIRST-in-log event carrying the ledger — are
 * RED, and they live in `src/scenarios/ledger-rule.projection.test.ts`. Counting
 * this file as progress on those would be counting a green file as done work.
 *
 * ── WHY IT STAYS IN THE MAIN SUITE AND NOT IN `src/scenarios/` ──
 *
 * The scenario suite is excluded from the merge gate — red is its job. A
 * property that must stay TRUE throughout the transition belongs in the gate
 * that enforces truth. Move these there and a transition that broke the fold's
 * idempotence would not turn the gate red, which is precisely the protection
 * these cases exist to provide.
 *
 * ── WHAT WAS DELETED FROM THE ORIGINAL FILE, AND WHY ──
 *
 * The fold-order pin commit also carried five equivalence cases, a DIVERGENCE case, and a local
 * `autoClearTarget` helper specifying auto-clear as a LOG-ORDER rule. All of it
 * is void: the third amendment (2026-08-04) found auto-clear-on-reply is
 * not in the reference design at all — scenario 5 makes `{id, code}` pairs the
 * ONLY clearing path — so auto-clear dies whole with ack codes rather than being
 * re-specified first. Deleted rather than archived: a spec for a formulation
 * nothing will ever implement has no future reader, and leaving it here invites
 * someone to build against it.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../../es/index.ts'
import { pendingReducer } from '../reducers.ts'

let nextId = 1
function ev(type: string, stream: string, data: Record<string, unknown> = {}): StoredEvent {
  return { id: nextId++, stream, type, ts: '2026-08-04T12:00:00.000Z', data }
}
const ack = (...ids: number[]) => ev('ack', 'system', { eventIds: ids })
const humanSays = (from = 'chat-human') => ev('reply', `agent-${from}`, { agent: from })

/** Fold a log into the pending queue, exactly as the projection does. */
function fold(...log: StoredEvent[]): StoredEvent[] {
  return log.reduce<StoredEvent[]>((s, e) => pendingReducer(s, e) as StoredEvent[], [])
}
const ids = (q: StoredEvent[]) => q.map((e) => e.id)

describe('ack: the fold decides, so the write site does not have to', () => {
  test('a valid ack clears exactly its ids', () => {
    const a = humanSays()
    const b = humanSays('chat-other')
    expect(ids(fold(a, b, ack(a.id)))).toEqual([b.id])
  })

  test('UNKNOWN ids are structural no-ops — no error, no effect', () => {
    // The write-time claim existed to stop these reaching the log. Under fold
    // order they may reach it freely: `state.filter(e => !acked.has(e.id))`
    // cannot be harmed by an id it has never seen.
    const a = humanSays()
    expect(ids(fold(a, ack(9999)))).toEqual([a.id])
    expect(ids(fold(a, ack(9999, a.id)))).toEqual([])
  })

  test('a DUPLICATE ack is a structural no-op — the second changes nothing', () => {
    // THE RACE THE CLAIM MACHINERY GUARDED, now designed away rather than
    // guarded: two acks for the same id both land in the log, and the fold is
    // idempotent, so the second is inert.
    const a = humanSays()
    const once = fold(a, ack(a.id))
    const twice = fold(a, ack(a.id), ack(a.id))
    expect(ids(once)).toEqual([])
    expect(ids(twice)).toEqual([])
  })

  test('an ack for an ALREADY-CLEARED id cannot resurrect or corrupt the queue', () => {
    const a = humanSays()
    const b = humanSays('chat-other')
    expect(ids(fold(a, b, ack(a.id), ack(a.id), ack(9999), ack(a.id, b.id)))).toEqual([])
  })

  test('order within one ack does not matter, and repeats inside it are inert', () => {
    const a = humanSays()
    const b = humanSays('chat-other')
    expect(ids(fold(a, b, ack(b.id, a.id, a.id)))).toEqual([])
  })

  test('an EMPTY ack is inert — it may be appended and decides nothing', () => {
    // Under the claim machinery an empty claim meant "write nothing at all".
    // Under fold order an empty ack is simply a no-op event, which is why the
    // write site no longer needs to know.
    const a = humanSays()
    expect(ids(fold(a, ack()))).toEqual([a.id])
  })
})
