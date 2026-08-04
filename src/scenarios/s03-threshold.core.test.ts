/**
 * SCENARIO 3 — THE PUSH THRESHOLD.
 * LEVEL: core (inputs into the listener; `now` is data).
 *
 * CANON (S3, verbatim): "Each role has an infra-configured minimum priority. An
 * event at or above it is pushed **once** into the agent's input stream — seen at
 * the next input read, no retry. Below it, counts update silently. (Config
 * today: worker = 1, sensei = 2.) Scenario 2 is the backstop for everything."
 *
 * STATUS: RED — `createTargetListener` and `thresholdFor` throw.
 *
 * ── "PUSHED ONCE, NO RETRY" AND RACE GUARD 4 ARE NOT IN CONFLICT ──
 *
 * They are about different events, and conflating them is how one of them gets
 * deleted. "No retry" means infra does not re-push an event it has already
 * handed over, hoping this time the agent reads it — repetition is S2's job, on
 * S2's clock. Guard 4 is about a push that NEVER HAPPENED: a transport that
 * refused the frame delivered nothing, so nothing may be recorded as delivered,
 * and the next tick tries again. One is "delivered, don't repeat"; the other is
 * "not delivered, so it doesn't count". Both are asserted below, adjacent, so
 * the distinction survives a reader in a hurry.
 */

import { describe, expect, test } from 'bun:test'
import { createTargetListener } from '../infra/target/attention.ts'
import { thresholdFor } from '../infra/target/priority.ts'
import { deliveries, eventWithId, HOUR, INTERVAL, MINUTE, recorder, T0, targetView } from './harness.ts'

const SENSEI = 'sensei'

function driver(lands = true) {
  const r = recorder(lands)
  return { r, listener: createTargetListener(r.exec) }
}

describe('S3 — at or above the threshold, pushed once', () => {
  test('an event ABOVE the threshold is pushed on arrival', () => {
    const { r, listener } = driver()
    listener.onEvent(
      eventWithId(1),
      targetView({ now: T0, agent: SENSEI, lastActivityAt: T0, threshold: 2, pending: [[1, 3]] }),
    )
    expect(deliveries(r)).toBe(1)
  })

  test('AT the threshold counts as above — "at or above", not "above"', () => {
    // An off-by-one here silently mutes an entire priority band, and the only
    // symptom is slower notification via S2's backstop.
    const { r, listener } = driver()
    listener.onEvent(
      eventWithId(1),
      targetView({ now: T0, agent: SENSEI, lastActivityAt: T0, threshold: 2, pending: [[1, 2]] }),
    )
    expect(deliveries(r)).toBe(1)
  })

  test('ONCE — the clock may run arbitrarily far and the count stays at one', () => {
    // "seen at the next input read, no retry". The push is into the agent's
    // input stream; whether it read it is not infra's question. Repetition is
    // S2's, on S2's clock and only while the agent is QUIET — this agent is not.
    const { r, listener } = driver()
    const world = { agent: SENSEI, lastActivityAt: T0, threshold: 2, pending: [[1, 3] as [number, number]] }
    listener.onEvent(eventWithId(1), targetView({ ...world, now: T0 }))
    expect(deliveries(r)).toBe(1)

    // Active throughout — `lastActivityAt` tracks `now`, so S2 never arms.
    for (let t = T0 + MINUTE; t <= T0 + 6 * HOUR; t += 10 * MINUTE) {
      listener.tick(targetView({ ...world, now: t, lastActivityAt: t }))
    }
    expect(deliveries(r)).toBe(1)
  })
})

describe('S3 — below the threshold, counts update silently', () => {
  test('a below-threshold arrival pushes nothing', () => {
    const { r, listener } = driver()
    listener.onEvent(
      eventWithId(1),
      targetView({ now: T0, agent: SENSEI, lastActivityAt: T0, threshold: 2, pending: [[1, 1]] }),
    )
    expect(deliveries(r)).toBe(0)
  })

  test('silently ≠ invisibly — the suppressed event is still counted', () => {
    // "Counts update silently" is a statement about NOTIFICATION, not about
    // membership. An implementation that filtered low-priority events out of the
    // mailbox would satisfy the push assertion above and quietly lose the work.
    //
    // ASSERTED THROUGH THE LISTENER, not by reading the harness's own view back:
    // the first draft did the latter, exercised nothing, and passed on arrival
    // in a suite whose whole job is to be red.
    const { r, listener } = driver()
    const world = {
      agent: SENSEI,
      lastActivityAt: T0,
      threshold: 2,
      pending: [
        [1, 1],
        [2, 3],
      ] as [number, number][],
    }
    listener.onEvent(eventWithId(1), targetView({ ...world, now: T0 }))
    listener.onEvent(eventWithId(2), targetView({ ...world, now: T0 + 1000 }))
    // One push (the high-priority event), but the count it reports includes the
    // suppressed one.
    expect(deliveries(r)).toBe(1)
    expect(r.emitted.at(-1)?.data.pendingCount).toBe(2)
  })

  test('SCENARIO 2 IS THE BACKSTOP — a below-threshold event still gets announced', () => {
    // Canon says so in as many words, and this is what makes the threshold safe:
    // it decides whether to INTERRUPT, never whether to inform. Without this, a
    // low-priority event at a quiet agent could wait forever, which is exactly
    // S2's invariant broken by S3's dial.
    const { r, listener } = driver()
    const quiet = { agent: SENSEI, lastActivityAt: T0, threshold: 2, pending: [[1, 1] as [number, number]] }
    listener.onEvent(eventWithId(1), targetView({ ...quiet, now: T0 }))
    expect(deliveries(r)).toBe(0)

    listener.tick(targetView({ ...quiet, now: T0 + INTERVAL }))
    expect(deliveries(r)).toBe(1)
  })

  test('one above-threshold event in a crowd of low ones pushes exactly once', () => {
    const { r, listener } = driver()
    const world = {
      agent: SENSEI,
      lastActivityAt: T0,
      threshold: 2,
      pending: [
        [1, 1],
        [2, 1],
        [3, 2],
        [4, 1],
      ] as [number, number][],
    }
    for (const id of [1, 2, 3, 4]) listener.onEvent(eventWithId(id), targetView({ ...world, now: T0 }))
    expect(deliveries(r)).toBe(1)
  })
})

describe('S3 — the threshold is a per-role dial', () => {
  test('REQUIREMENT — a worker’s threshold is lower than the sensei’s', () => {
    // The requirement is the ORDER: a worker is interrupted by more than the
    // orchestrator is, because the orchestrator is the one with a queue to
    // triage. The literals are not part of it.
    expect(thresholdFor('worker')).toBeLessThan(thresholdFor('sensei'))
  })

  test('DIAL — today’s config is worker = 1, sensei = 2 (config, not requirement)', () => {
    // 013: "Config values (interval, thresholds, priority heuristic) are
    // deliberately NOT requirements — they're dials." Split out after Codex
    // found the original case claiming exactly that and then asserting the
    // literals anyway. Re-tuning a threshold must break THIS case alone.
    expect(thresholdFor('worker')).toBe(1)
    expect(thresholdFor('sensei')).toBe(2)
  })

  test('the same event pushes to a worker and not to the sensei', () => {
    // The dial's whole purpose, in one comparison: a routine worker-shaped
    // event interrupts a worker and merely counts for the sensei.
    const w = driver()
    const s = driver()
    const pending = [[1, 1] as [number, number]]
    w.listener.onEvent(
      eventWithId(1),
      targetView({ now: T0, agent: 'builder', lastActivityAt: T0, threshold: thresholdFor('worker'), pending }),
    )
    s.listener.onEvent(
      eventWithId(1),
      targetView({ now: T0, agent: SENSEI, lastActivityAt: T0, threshold: thresholdFor('sensei'), pending }),
    )
    expect(deliveries(w.r)).toBe(1)
    expect(deliveries(s.r)).toBe(0)
  })

  test('ONE MECHANISM for sensei and worker — only the dial differs (E6)', () => {
    // Canon E6. Give the two the same threshold and they must behave
    // identically; any divergence would mean a role branch somewhere in the
    // decisions, which is what the foundation forbids.
    const w = driver()
    const s = driver()
    const view = (agent: string) => targetView({ now: T0, agent, lastActivityAt: T0, threshold: 2, pending: [[1, 2]] })
    w.listener.onEvent(eventWithId(1), view('builder'))
    s.listener.onEvent(eventWithId(1), view(SENSEI))
    expect(deliveries(w.r)).toBe(deliveries(s.r))
    expect(deliveries(w.r)).toBe(1)
  })
})

describe('S3 — "no retry" and race guard 4 are different claims', () => {
  test('a LANDED push is not repeated', () => {
    const { r, listener } = driver()
    const world = { agent: SENSEI, lastActivityAt: T0, threshold: 1, pending: [[1, 2] as [number, number]] }
    listener.onEvent(eventWithId(1), targetView({ ...world, now: T0 }))
    listener.onEvent(eventWithId(1), targetView({ ...world, now: T0 + 1000 }))
    expect(deliveries(r)).toBe(1)
  })

  test('a REFUSED push is not a push — nothing is recorded, and the next tick tries again', () => {
    const { r, listener } = driver(false)
    const world = { agent: SENSEI, lastActivityAt: T0, threshold: 1, pending: [[1, 2] as [number, number]] }
    listener.onEvent(eventWithId(1), targetView({ ...world, now: T0 }))
    expect(r.emitted).toHaveLength(0)

    r.setLanding(true)
    listener.tick(targetView({ ...world, now: T0 + 1000 }))
    expect(deliveries(r)).toBe(2)
    expect(r.emitted.length).toBeGreaterThan(0)
  })
})
