/**
 * SCENARIO 6 — FRESH COUNTS.
 * LEVEL: core (inputs into the listener; `now` is data).
 *
 * CANON (S6, verbatim): "Every nudge reflects the queue as it is at emission —
 * never a stored snapshot, regardless of what triggered it."
 *
 * STATUS: RED — `createTargetListener` throws. The PROPERTY, though, already
 * holds on main (042 verdict: CONFORMS — `AttentionView` is "constructed fresh
 * by the adapter at every decision point — never cached", pinned by a phase-A
 * test and mutation-proven). So this file's job is not to introduce the property
 * but to make sure the transition does not lose it while rewriting everything
 * around it.
 *
 * ── WHY THE FALLING LEG IS THE WHOLE TEST ──
 *
 * A cached snapshot is invisible while the queue grows: 1 → 2 with a stale
 * snapshot still reports something plausible and merely lags. It becomes wrong
 * on the way DOWN, when the agent has just cleared events and is told there are
 * more waiting than there are — which is precisely when it decides whether to
 * stop. Hence 1 → 2 → 1, with the assertion on the 1.
 *
 * `race-guards.test.ts`'s scenario 6 drives the same claim through the WIRED
 * system and must stay green through the transition (043's casualty list names
 * it explicitly among the tests that do NOT change). This is the same claim at
 * the level where the decision is actually made.
 */

import { describe, expect, test } from 'bun:test'
import { createTargetListener } from '../infra/target/attention.ts'
import { eventWithId, INTERVAL, MINUTE, recorder, T0, targetView } from './harness.ts'

const SENSEI = 'sensei'

function driver() {
  const r = recorder()
  return { r, listener: createTargetListener(r.exec) }
}

/** Every count a push has claimed, in order. */
const counts = (emitted: { data: Record<string, unknown> }[]) =>
  emitted.map((e) => e.data.pendingCount).filter((n) => typeof n === 'number')

const pairs = (...ids: number[]) => ids.map((id) => [id, 2] as [number, number])

describe('S6 — every push reports the queue at emission', () => {
  test('1 → 2 → 1: the FALLING leg is where a cached snapshot is wrong', () => {
    const { r, listener } = driver()
    const world = (now: number, ids: number[]) =>
      targetView({ now, agent: SENSEI, lastActivityAt: T0, pending: pairs(...ids) })

    listener.onEvent(eventWithId(1), world(T0, [1]))
    listener.onEvent(eventWithId(2), world(T0 + 1000, [1, 2]))
    // The agent handled #1. One remains.
    listener.onEvent(eventWithId(3, 'ack', 'system', { pairs: [] }), world(T0 + 2000, [2]))
    listener.tick(world(T0 + INTERVAL, [2]))

    expect(counts(r.emitted).at(-1)).toBe(1)
    // And nothing along the way ever over-reported.
    expect(counts(r.emitted).every((n) => (n as number) <= 2)).toBe(true)
  })

  test('a tick-triggered push reports the queue AT THE TICK, not at arrival', () => {
    // "Regardless of what triggered it." The arrival path has the queue in hand;
    // the tick path is the one that has to go and look, and is therefore the one
    // that grows a cache.
    const { r, listener } = driver()
    listener.onEvent(eventWithId(1), targetView({ now: T0, agent: SENSEI, lastActivityAt: T0, pending: pairs(1) }))
    r.emitted.length = 0

    listener.tick(targetView({ now: T0 + INTERVAL, agent: SENSEI, lastActivityAt: T0, pending: pairs(1, 2, 3) }))
    expect(counts(r.emitted).at(-1)).toBe(3)
  })

  test('the arrival path and the tick path agree on the same queue', () => {
    const a = driver()
    const b = driver()
    const queue = pairs(1, 2, 3, 4)
    a.listener.onEvent(eventWithId(4), targetView({ now: T0, agent: SENSEI, lastActivityAt: T0, pending: queue }))
    b.listener.tick(targetView({ now: T0 + INTERVAL, agent: SENSEI, lastActivityAt: T0, pending: queue }))
    expect(counts(a.r.emitted).at(-1)).toBe(counts(b.r.emitted).at(-1))
    expect(counts(a.r.emitted).at(-1)).toBe(4)
  })

  test('a long-running episode never re-reports an older count', () => {
    // The failure a snapshot taken at episode start produces: every repeat in
    // the episode carries the number from when it began. Ticking across several
    // ladder rungs while the queue shrinks catches it.
    const { r, listener } = driver()
    let ids = [1, 2, 3, 4, 5]
    for (let t = T0 + INTERVAL; t <= T0 + 90 * MINUTE; t += 5 * MINUTE) {
      listener.tick(targetView({ now: t, agent: SENSEI, lastActivityAt: T0, pending: pairs(...ids) }))
      if (ids.length > 1) ids = ids.slice(1)
    }
    const reported = counts(r.emitted) as number[]
    expect(reported.length).toBeGreaterThan(1)
    // Monotonically non-increasing, because the queue only shrank.
    for (let i = 1; i < reported.length; i++) {
      expect(reported[i] as number).toBeLessThanOrEqual(reported[i - 1] as number)
    }
    expect(reported.at(-1)).toBe(1)
  })

  test('an emptied queue produces no push claiming anything is waiting', () => {
    const { r, listener } = driver()
    listener.onEvent(eventWithId(1), targetView({ now: T0, agent: SENSEI, lastActivityAt: T0, pending: pairs(1) }))
    r.emitted.length = 0
    listener.onEvent(
      eventWithId(2, 'ack', 'system', { pairs: [] }),
      targetView({ now: T0 + 1000, agent: SENSEI, lastActivityAt: T0, pending: [] }),
    )
    listener.tick(targetView({ now: T0 + INTERVAL, agent: SENSEI, lastActivityAt: T0, pending: [] }))
    expect(counts(r.emitted)).toEqual([])
  })
})
