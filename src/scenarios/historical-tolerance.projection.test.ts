/**
 * HISTORICAL TOLERANCE — the ack shapes already in every dojo's log must keep
 * folding, forever.
 * LEVEL: projection (a log in → pending out; pure).
 *
 * Task 044 deliverable 4, from 043's at-risk flag. This is the SEVENTEENTH file
 * — 043's layout named sixteen, and the tolerance test was called out
 * separately; it is its own file rather than a case inside `s05` so that it
 * cannot be deleted along with the scenario whose migration it protects.
 *
 * ── THE FLAG'S PREMISE WAS WRONG, AND THE CORRECTION MATTERS ──
 *
 * 043 flagged `src/cli/peek.test.ts:93` — a fixture built as `ack` with
 * `{upToId: 3}` — and reasoned: "Historical logs will contain `upToId` ack
 * events forever — the reader must remain tolerant."
 *
 * MEASURED, 2026-08-05, across every dojo on this machine (eight
 * `.jean/history.jsonl` files, 5,537 `ack` events in total):
 *   - ack events carrying `upToId`:            **0**
 *   - ack events NOT carrying `eventIds`:      **0**
 *
 * `upToId` was only ever a REQUEST-BODY form. `recordAck` has always expanded it
 * to the ids it actually cleared and recorded `{eventIds: [...]}`, so the shape
 * never reached an event. The peek fixture is a test artifact, and peek is
 * doubly unaffected: it filters events by TYPE (`SIGNIFICANT_EVENT_TYPES`
 * excludes `ack`) and never reads ack data at all.
 *
 * ── SO WHAT IS ACTUALLY AT RISK ──
 *
 * The real forever-shape is `{eventIds: number[]}`, and the real hazard is a
 * transition that teaches the fold `{id, code}` pairs and nothing else. Replay
 * any dojo's log through that fold and all 5,537 historical acks stop clearing —
 * every long-answered event comes back into pending on the next restart. That is
 * the failure this file exists to prevent, and it is a much sharper one than the
 * flag described.
 *
 * The `upToId`-shaped case survives below anyway, downgraded to what it is: a
 * defensive check that an unrecognized ack shape is INERT rather than fatal.
 * Cheap, and a hand-written or third-party event is not impossible.
 *
 * STATUS: RED — `targetPendingReducer` throws.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../es/index.ts'
import { pendingReducer } from '../infra/reducers.ts'
import { targetPendingReducer } from '../infra/target/codes.ts'
import { ev, humanSays, workerSays } from './harness.ts'

const HUMAN = 'chat-human'

const targetFold = (log: readonly StoredEvent[]) => log.reduce<StoredEvent[]>((s, e) => targetPendingReducer(s, e), [])
const liveFold = (log: readonly StoredEvent[]) =>
  log.reduce<StoredEvent[]>((s, e) => pendingReducer(s, e) as StoredEvent[], [])
const ids = (q: readonly StoredEvent[]) => q.map((e) => e.id)

describe('the shape that is actually in history: {eventIds}', () => {
  test('a historical eventIds ack still clears its ids under the target fold', () => {
    // 5,537 events across eight dojos depend on this single assertion.
    const a = humanSays(HUMAN, 'answered months ago')
    const b = workerSays('builder', 'also handled')
    const log = [a, b, ev('ack', 'system', { eventIds: [a.id, b.id] })]
    expect(ids(targetFold(log))).toEqual([])
  })

  test('the target fold agrees with the live fold on a realistic historical log', () => {
    // The strongest form of "tolerant": replaying real history must produce the
    // same pending queue it produces today. Anything else is a silent
    // resurrection, and it surfaces on a restart rather than at deploy.
    const events: StoredEvent[] = []
    for (let i = 0; i < 6; i++) events.push(workerSays('builder', `step ${i}`))
    const human = humanSays(HUMAN, 'question')
    events.push(human)
    const acked = events.slice(0, 4).map((e) => e.id)
    events.push(ev('ack', 'system', { eventIds: acked }))
    events.push(ev('ack', 'system', { eventIds: [human.id] }))
    const trailing = workerSays('builder', 'and one more, unacked')
    events.push(trailing)

    expect(ids(targetFold(events))).toEqual(ids(liveFold(events)))
    expect(ids(targetFold(events))).toEqual(ids(liveFold(events)).slice())
    expect(ids(targetFold(events))).toContain(trailing.id)
  })

  test('the auto-clear era’s acks still clear after auto-clear is deleted', () => {
    // `auto: 'reply'` acks are in every dojo's log. Auto-clear the MECHANISM
    // dies (S5: `{id, code}` is the only clearing path); the EVENTS it wrote do
    // not, and a fold that rejects them on account of an unfamiliar field
    // resurrects every human message the sensei ever answered.
    const q = humanSays(HUMAN, 'ping')
    const log = [q, ev('ack', 'system', { eventIds: [q.id], auto: 'reply' })]
    expect(ids(targetFold(log))).toEqual([])
  })

  test('a ledger-carrying ack still clears — the extra field is not a gate', () => {
    const q = humanSays(HUMAN)
    const log = [
      q,
      ev('ack', 'system', {
        eventIds: [q.id],
        ledger: { [String(q.id)]: { deliveredVia: 'wake', clearedBy: 'ack' } },
      }),
    ]
    expect(ids(targetFold(log))).toEqual([])
  })
})

describe('mixed logs — history and the new form in one stream', () => {
  test('a log that switches from eventIds to {id, code} pairs mid-stream folds correctly', () => {
    // What every dojo's log becomes the moment the transition deploys: old acks
    // below the cut, new acks above it, one continuous replay across both.
    const old1 = workerSays('builder', 'before the transition')
    const old2 = humanSays(HUMAN, 'also before')
    const fresh = workerSays('builder', 'after the transition')
    const log = [
      old1,
      old2,
      ev('ack', 'system', { eventIds: [old1.id, old2.id] }),
      fresh,
      ev('ack', 'system', { pairs: [{ id: fresh.id, code: 'whatever-the-code-is' }] }),
    ]
    expect(ids(targetFold(log))).toEqual([])
  })

  test('an ack carrying BOTH forms clears the union rather than picking a winner', () => {
    // Not expected to occur, but the fold must be total. Preferring one form and
    // silently discarding the other would leave events pending with no trace of
    // why — the worst failure shape for something replayed at every boot.
    const a = workerSays('builder', 'a')
    const b = workerSays('builder', 'b')
    const log = [a, b, ev('ack', 'system', { eventIds: [a.id], pairs: [{ id: b.id, code: 'c' }] })]
    expect(ids(targetFold(log))).toEqual([])
  })
})

describe('unrecognized shapes are inert, never fatal', () => {
  test('an ack with only {upToId} clears nothing and does not throw', () => {
    // ZERO of these exist in real history (see the header). Kept as a defensive
    // check, and pinned as CLEARS NOTHING rather than as drain-all: `upToId` is
    // deleted, so honouring it would be reviving the very form S5 removes.
    const a = workerSays('builder', 'one')
    const b = workerSays('builder', 'two')
    const log = [a, b, ev('ack', 'system', { upToId: b.id })]
    expect(ids(targetFold(log))).toEqual([a.id, b.id])
    // And today's fold already behaves this way — `new Set(undefined)` is empty,
    // so nothing is filtered. The target must not regress into interpreting it.
    expect(ids(liveFold(log))).toEqual([a.id, b.id])
  })

  test('an ack with no recognizable clearing form is inert', () => {
    const a = workerSays('builder', 'survives')
    for (const data of [{}, { eventIds: [] }, { pairs: [] }, { eventIds: null }, { note: 'hand-written' }]) {
      expect(ids(targetFold([a, ev('ack', 'system', data as Record<string, unknown>)]))).toEqual([a.id])
    }
  })

  test('an unknown EVENT TYPE from a future or foreign writer is ignored', () => {
    // Logs outlive schemas. A type the fold has never seen must pass through
    // without touching the queue, which is what makes replay safe across
    // versions in either direction.
    const a = workerSays('builder', 'survives')
    const log = [a, ev('quantum-entangled', 'system', { whatever: true })]
    expect(ids(targetFold(log))).toEqual([a.id])
  })
})
