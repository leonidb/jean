/**
 * SCENARIO 2 — THE QUIET AGENT. The backstop for everything.
 * LEVEL: core (an ordered sequence of inputs into the listener; `now` is data,
 * so "what does this decide at T+5m?" is arithmetic rather than five minutes).
 *
 * CANON (S2, verbatim): "An agent making no jean-visible calls receives a
 * standalone nudge within the configured interval, **measured from its last
 * activity** — an agent already quiet that long gets it immediately. Invariant:
 * no event waits longer than the interval, ever."
 *
 * RULING (a), Leonid 2026-08-05: the invariant is LOCAL / FIRST-NOTIFICATION.
 * The interval governs how fast an agent first learns of a new event;
 * re-notification for a still-unhandled queue follows the backoff ladder, which
 * SURVIVES. Something watchdog-shaped survives with it as the long-wait
 * backstop — which is why `stall-watchdog.test.ts` came off the whole-file
 * casualty list and adapts instead.
 *
 * STATUS: RED — `createTargetListener` throws.
 *
 * ── THIS FILE CARRIES TWO OF 042's FIVE DEVIATIONS ──
 *
 * DEVIATION-1 (the idle gate still exists, nothing scheduled its removal).
 * Canon E3, verbatim: "nothing ever asks whether an agent is busy — busy and
 * dead are one case (no ack → keep trying)". THE TYPE CHANGE IS THE TEST: a
 * decision that cannot see busyness cannot gate on it, and no runtime assertion
 * can express "the machine no longer asks".
 *
 * DEVIATION-2 (the nudge clock runs from `lastNudgeAt`, not from last activity).
 * Today `AttentionView` carries no last-activity field at all, so "already quiet
 * that long ⇒ immediately" is not merely unimplemented — it is inexpressible.
 * The datum exists in the adapter already; it just never reached a decision.
 */

import { describe, expect, test } from 'bun:test'
import { createTargetListener, type TargetAttentionView } from '../infra/target/attention.ts'
import {
  deliveries,
  eventWithId,
  INTERVAL,
  LONG_WAIT,
  MINUTE,
  RUNG_1,
  RUNG_2,
  recorder,
  T0,
  targetView,
} from './harness.ts'

const AGENT = 'sensei'

/** A listener plus the recorder it writes to. */
function driver(lands = true) {
  const r = recorder(lands)
  return { r, listener: createTargetListener(r.exec) }
}

/** Ids are chosen, not generated: the decision asks whether THIS event is in
 *  THAT mailbox, so the event and the view have to agree. */
const arrival = (id: number) => eventWithId(id)

describe('S2 — first notification, measured from last activity', () => {
  test('an agent quiet for the interval is notified — the clock starts at ACTIVITY', () => {
    const { r, listener } = driver()
    // Active at T0, an event lands one minute later, nothing pushed yet.
    listener.onEvent(arrival(1), targetView({ now: T0 + MINUTE, agent: AGENT, lastActivityAt: T0, pending: [[1, 1]] }))
    expect(deliveries(r)).toBe(0)

    // At T0 + INTERVAL the agent has been quiet exactly that long. It learns.
    listener.tick(targetView({ now: T0 + INTERVAL, agent: AGENT, lastActivityAt: T0, pending: [[1, 1]] }))
    expect(deliveries(r)).toBe(1)
  })

  test('an agent ALREADY quiet that long is notified on the same input — immediately', () => {
    // THE CLAUSE THAT IS INEXPRESSIBLE TODAY. The event arrives at an agent that
    // has been silent for an hour; there is nothing to wait for, so it does not
    // wait. Under a `lastNudgeAt` clock this agent and a freshly-nudged one are
    // indistinguishable, and both wait a full interval.
    const { r, listener } = driver()
    const now = T0 + 60 * MINUTE
    listener.onEvent(arrival(1), targetView({ now, agent: AGENT, lastActivityAt: T0, pending: [[1, 1]] }))
    expect(deliveries(r)).toBe(1)
  })

  test('an agent that JUST acted is not notified early', () => {
    // The other side of the same clock. Without it, S2 degenerates into
    // "interrupt on every arrival", which is what scenario 1 (the piggyback)
    // exists to avoid.
    const { r, listener } = driver()
    listener.onEvent(arrival(1), targetView({ now: T0, agent: AGENT, lastActivityAt: T0, pending: [[1, 1]] }))
    listener.tick(targetView({ now: T0 + INTERVAL - 1000, agent: AGENT, lastActivityAt: T0, pending: [[1, 1]] }))
    expect(deliveries(r)).toBe(0)
  })

  test('ACTIVITY RESETS THE CLOCK — a working agent is never nudged mid-stride', () => {
    const { r, listener } = driver()
    listener.onEvent(arrival(1), targetView({ now: T0, agent: AGENT, lastActivityAt: T0, pending: [[1, 1]] }))

    // It acts again at T0 + 4m. The interval now runs from there, so the tick at
    // T0 + 5m — a full interval after the EVENT — must stay quiet.
    const acted = T0 + 4 * MINUTE
    listener.activity(targetView({ now: acted, agent: AGENT, lastActivityAt: acted, pending: [[1, 1]] }))
    listener.tick(targetView({ now: T0 + INTERVAL, agent: AGENT, lastActivityAt: acted, pending: [[1, 1]] }))
    expect(deliveries(r)).toBe(0)

    listener.tick(targetView({ now: acted + INTERVAL, agent: AGENT, lastActivityAt: acted, pending: [[1, 1]] }))
    expect(deliveries(r)).toBe(1)
  })

  test('NO EVENT WAITS LONGER THAN THE INTERVAL, EVER — swept across arrival times', () => {
    // The invariant stated as a sweep rather than as one case, because the way
    // it breaks is at a boundary: an event that lands just after a tick, or just
    // before one, must still be announced within the interval of the agent's
    // last activity.
    for (const offset of [0, 1, MINUTE, INTERVAL - 1, INTERVAL]) {
      const { r, listener } = driver()
      const arrived = T0 + offset
      listener.onEvent(arrival(1), targetView({ now: arrived, agent: AGENT, lastActivityAt: T0, pending: [[1, 1]] }))
      // Tick on a grid finer than the interval, up to one interval past the
      // agent's last activity.
      for (let t = arrived; t <= T0 + INTERVAL; t += 30_000) {
        listener.tick(targetView({ now: t, agent: AGENT, lastActivityAt: T0, pending: [[1, 1]] }))
      }
      expect(deliveries(r)).toBeGreaterThan(0)
    }
  })
})

describe('S2 — repeats follow the ladder (ruling (a))', () => {
  test('the second notification waits the FIRST rung, the third the SECOND', () => {
    // Named rungs, not indices: the live suite's own first draft got this
    // backwards, and the test caught the test.
    const { r, listener } = driver()
    const quiet = { agent: AGENT, lastActivityAt: T0, pending: [[1, 1] as [number, number]] }

    listener.tick(targetView({ ...quiet, now: T0 + INTERVAL }))
    expect(deliveries(r)).toBe(1)
    const first = T0 + INTERVAL

    listener.tick(targetView({ ...quiet, now: first + RUNG_1 - 1000 }))
    expect(deliveries(r)).toBe(1)
    listener.tick(targetView({ ...quiet, now: first + RUNG_1 }))
    expect(deliveries(r)).toBe(2)
    const second = first + RUNG_1

    listener.tick(targetView({ ...quiet, now: second + RUNG_1 }))
    expect(deliveries(r)).toBe(2) // the FIRST rung no longer applies
    listener.tick(targetView({ ...quiet, now: second + RUNG_2 }))
    expect(deliveries(r)).toBe(3)
  })

  test('the LONG-WAIT BACKSTOP still fires at the ladder’s cap', () => {
    // The surviving watchdog shape. The ladder stretching is the design; the
    // queue going silent forever is not. Ruling (a) kept both.
    const { r, listener } = driver()
    const quiet = { agent: AGENT, lastActivityAt: T0, pending: [[1, 1] as [number, number]] }
    for (let t = T0; t <= T0 + LONG_WAIT * 2; t += 5 * MINUTE) {
      listener.tick(targetView({ ...quiet, now: t }))
    }
    // Far more than the two the ladder alone would produce in the first hour,
    // and — the actual claim — it never stops.
    expect(deliveries(r)).toBeGreaterThan(3)
  })

  test('a drained mailbox ends the episode: the next arrival is news again', () => {
    const { r, listener } = driver()
    const base = { agent: AGENT, lastActivityAt: T0 }
    listener.tick(targetView({ ...base, now: T0 + INTERVAL, pending: [[1, 1]] }))
    expect(deliveries(r)).toBe(1)

    // Acked — the queue is empty.
    listener.onEvent(
      eventWithId(99, 'ack', 'system', { pairs: [] }),
      targetView({ ...base, now: T0 + INTERVAL, pending: [] }),
    )
    r.drain()

    // A new event at an agent still quiet since T0: notified at once, not on
    // the second rung.
    listener.onEvent(arrival(2), targetView({ ...base, now: T0 + 20 * MINUTE, pending: [[2, 1]] }))
    expect(deliveries(r)).toBe(1)
  })
})

describe('DEVIATION-1 — nothing asks whether the agent is busy', () => {
  test('TYPE-GUARD — the target view HAS NO `idle` FIELD; the type change is the test', () => {
    const view = targetView({ now: T0, agent: AGENT, lastActivityAt: T0, pending: [[1, 1]] })
    expect(Object.keys(view)).not.toContain('idle')

    // COMPILE-TIME HALF, which is the one that actually holds: `tsc --noEmit`
    // fails if this stops being an error, so re-introducing the gate cannot pass
    // the typecheck gate quietly.
    // @ts-expect-error — E3: "nothing ever asks whether an agent is busy".
    const withIdle: TargetAttentionView = { ...view, idle: false }
    expect(withIdle.now).toBe(T0)
  })

  test('an agent mid-turn is notified exactly like an idle one', () => {
    // The behavioural half. Today this is the difference between a nudge and
    // silence; under the canon the two situations are indistinguishable by
    // construction, so the same inputs must produce the same push.
    const a = driver()
    const b = driver()
    const view = targetView({ now: T0 + INTERVAL, agent: AGENT, lastActivityAt: T0, pending: [[1, 1]] })
    a.listener.tick(view)
    b.listener.tick(view)
    expect(deliveries(a.r)).toBe(deliveries(b.r))
    expect(deliveries(a.r)).toBe(1)
  })
})

describe('S2 — the cases that must NOT push', () => {
  test('an empty mailbox is never nudged, however quiet the agent', () => {
    const { r, listener } = driver()
    for (let t = T0; t <= T0 + LONG_WAIT; t += INTERVAL) {
      listener.tick(targetView({ now: t, agent: AGENT, lastActivityAt: T0, pending: [] }))
    }
    expect(deliveries(r)).toBe(0)
  })

  test('no live transport, no push — and the notification is not consumed', () => {
    // The queue is truth; notification is best-effort (E1). An agent that was
    // unreachable must be told when it comes back, not counted as informed.
    const { r, listener } = driver()
    const gone = { agent: AGENT, lastActivityAt: T0, deliverable: false, pending: [[1, 1] as [number, number]] }
    listener.tick(targetView({ ...gone, now: T0 + INTERVAL }))
    expect(deliveries(r)).toBe(0)

    listener.tick(
      targetView({ agent: AGENT, lastActivityAt: T0, deliverable: true, pending: [[1, 1]], now: T0 + INTERVAL + 1000 }),
    )
    expect(deliveries(r)).toBe(1)
  })

  test('a REFUSED delivery advances nothing — it retries on the next tick', () => {
    // Race guard 4, which survives the transition unchanged: a wake the
    // transport refused must not be recorded as one. This is the one claim only
    // the core level can make — every integration test in the suite runs against
    // a transport that always lands.
    const { r, listener } = driver(false)
    const quiet = { agent: AGENT, lastActivityAt: T0, pending: [[1, 1] as [number, number]] }
    listener.tick(targetView({ ...quiet, now: T0 + INTERVAL }))
    expect(deliveries(r)).toBe(1) // attempted
    expect(r.emitted).toHaveLength(0) // but nothing claims the agent was told

    r.setLanding(true)
    listener.tick(targetView({ ...quiet, now: T0 + INTERVAL + 1000 }))
    expect(deliveries(r)).toBe(2) // retried at once, not a ladder rung later
    expect(r.emitted.length).toBeGreaterThan(0)
  })

  test('a dojo with no mailbox owner decides nothing', () => {
    const { r, listener } = driver()
    listener.tick(targetView({ now: T0 + LONG_WAIT, agent: null, lastActivityAt: T0, pending: [[1, 1]] }))
    expect(deliveries(r)).toBe(0)
  })
})
