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
  LONG_WINDOW,
  MINUTE,
  RUNG_1,
  RUNG_2,
  RUNG_3,
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
    listener.onEvent(
      arrival(1),
      targetView({ now: T0 + MINUTE, agent: AGENT, threshold: 2, lastActivityAt: T0, pending: [[1, 1]] }),
    )
    expect(deliveries(r)).toBe(0)

    // At T0 + INTERVAL the agent has been quiet exactly that long. It learns.
    listener.tick(targetView({ now: T0 + INTERVAL, agent: AGENT, threshold: 2, lastActivityAt: T0, pending: [[1, 1]] }))
    expect(deliveries(r)).toBe(1)
  })

  test('an agent ALREADY quiet that long is notified on the same input — immediately', () => {
    // THE CLAUSE THAT IS INEXPRESSIBLE TODAY. The event arrives at an agent that
    // has been silent for an hour; there is nothing to wait for, so it does not
    // wait. Under a `lastNudgeAt` clock this agent and a freshly-nudged one are
    // indistinguishable, and both wait a full interval.
    const { r, listener } = driver()
    const now = T0 + 60 * MINUTE
    listener.onEvent(arrival(1), targetView({ now, agent: AGENT, threshold: 2, lastActivityAt: T0, pending: [[1, 1]] }))
    expect(deliveries(r)).toBe(1)
  })

  test('an agent that JUST acted is not notified early', () => {
    // The other side of the same clock. Without it, S2 degenerates into
    // "interrupt on every arrival", which is what scenario 1 (the piggyback)
    // exists to avoid.
    const { r, listener } = driver()
    listener.onEvent(
      arrival(1),
      targetView({ now: T0, agent: AGENT, threshold: 2, lastActivityAt: T0, pending: [[1, 1]] }),
    )
    listener.tick(
      targetView({ now: T0 + INTERVAL - 1000, agent: AGENT, threshold: 2, lastActivityAt: T0, pending: [[1, 1]] }),
    )
    expect(deliveries(r)).toBe(0)
  })

  test('ACTIVITY RESETS THE CLOCK — a working agent is never nudged mid-stride', () => {
    const { r, listener } = driver()
    listener.onEvent(
      arrival(1),
      targetView({ now: T0, agent: AGENT, threshold: 2, lastActivityAt: T0, pending: [[1, 1]] }),
    )

    // It acts again at T0 + 4m. The interval now runs from there, so the tick at
    // T0 + 5m — a full interval after the EVENT — must stay quiet.
    const acted = T0 + 4 * MINUTE
    listener.activity(targetView({ now: acted, agent: AGENT, threshold: 2, lastActivityAt: acted, pending: [[1, 1]] }))
    listener.tick(
      targetView({ now: T0 + INTERVAL, agent: AGENT, threshold: 2, lastActivityAt: acted, pending: [[1, 1]] }),
    )
    expect(deliveries(r)).toBe(0)

    listener.tick(
      targetView({ now: acted + INTERVAL, agent: AGENT, threshold: 2, lastActivityAt: acted, pending: [[1, 1]] }),
    )
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
      listener.onEvent(
        arrival(1),
        targetView({ now: arrived, agent: AGENT, threshold: 2, lastActivityAt: T0, pending: [[1, 1]] }),
      )
      // Tick on a grid finer than the interval, THROUGH the deadline.
      //
      // The `+ TICK` bound is not slack: notification happens on ticks, so the
      // honest guarantee is "by the first tick at or after the deadline". The
      // first draft stopped exactly AT the deadline and was unsatisfiable for
      // the arrivals that put the grid out of phase with it — an unreachable
      // green, red for a reason no implementation could ever fix.
      const TICK = 30_000
      for (let t = arrived; t <= T0 + INTERVAL + TICK; t += TICK) {
        listener.tick(targetView({ now: t, agent: AGENT, threshold: 2, lastActivityAt: T0, pending: [[1, 1]] }))
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
    const quiet = { agent: AGENT, threshold: 2, lastActivityAt: T0, pending: [[1, 1] as [number, number]] }

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

  test('NOTIFICATION NEVER STOPS — at the ladder’s cap it settles to the cap RATE', () => {
    // RE-AIMED. The first version of this case was named for a backstop and
    // asserted `deliveries > 3` over two hours — which the ladder alone
    // satisfies about nine times over, so it would have passed whether or not
    // any backstop existed. `longWaitMs` was a dial no test constrained.
    //
    // Ruled 2026-08-05: there IS no separate backstop. With the idle gate gone
    // the ladder pushes unconditionally and never stops, so a second timer had
    // no job; the long-wait survivor is S11's broken-agent escalation, on a
    // louder channel and in its own file. What remains to pin here is the
    // property that made a backstop unnecessary — E2, "the guarantee comes from
    // repetition over an unreliable channel" — and its RATE, which is what an
    // unbounded ladder would quietly break.
    const { r, listener } = driver()
    const quiet = { agent: AGENT, threshold: 2, lastActivityAt: T0, pending: [[1, 1] as [number, number]] }
    const at: number[] = []
    for (let t = T0; t <= T0 + LONG_WINDOW; t += MINUTE) {
      const before = deliveries(r)
      listener.tick(targetView({ ...quiet, now: t }))
      if (deliveries(r) > before) at.push(t)
    }

    // It kept going for the whole window, right to the end.
    expect(at.length).toBeGreaterThan(4)
    expect((at.at(-1) as number) > T0 + LONG_WINDOW - RUNG_3 - MINUTE).toBe(true)

    // ...and once the ladder is at its cap, every subsequent gap IS the cap —
    // never more. An implementation that kept stretching (doubling, or a rung
    // per nudge) passes "it never stops" and still starves the agent.
    const capped = at.slice(3)
    for (let i = 1; i < capped.length; i++) {
      expect((capped[i] as number) - (capped[i - 1] as number)).toBeLessThanOrEqual(RUNG_3 + MINUTE)
    }
  })

  test('a drained mailbox ends the episode: the next arrival is news again', () => {
    const { r, listener } = driver()
    const base = { agent: AGENT, threshold: 2, lastActivityAt: T0 }
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
    const view = targetView({ now: T0, agent: AGENT, threshold: 2, lastActivityAt: T0, pending: [[1, 1]] })
    expect(Object.keys(view)).not.toContain('idle')

    // COMPILE-TIME HALF, which is the one that actually holds: `tsc --noEmit`
    // fails if this stops being an error, so re-introducing the gate cannot pass
    // the typecheck gate quietly.
    // @ts-expect-error — E3: "nothing ever asks whether an agent is busy".
    const withIdle: TargetAttentionView = { ...view, idle: false }
    expect(withIdle.now).toBe(T0)
  })

  // ── THE BEHAVIOURAL HALF OF E3 IS NOT TESTED HERE, ON PURPOSE ──
  //
  // A case titled `an agent mid-turn is notified exactly like an idle one` sat
  // here, and task 046's audit classified it VACUOUS-1 — correctly. It built two
  // drivers, handed them THE SAME VIEW OBJECT, and asserted they agreed. That is
  // a determinism check on `decide`, not a check that busyness is ignored: under
  // the target view "mid-turn" is not representable at all, so there is no
  // second input to compare against and the assertion could not fail for its
  // stated reason.
  //
  // The honest statement is that E3's behavioural half HAS NO BEHAVIOUR LEFT TO
  // CHECK. `AttentionView.idle` is gone; the decisions cannot ask whether an
  // agent is busy because the question is not in their input. The TYPE-GUARD
  // above is therefore not a weaker substitute for a behavioural test — it is
  // the whole of the available evidence, and it is stronger than the vacuous
  // case was: `tsc --noEmit` fails the moment anyone re-adds the field, so the
  // gate cannot come back without breaking a merge gate.
  //
  // Recorded rather than deleted silently, because a suite that quietly loses a
  // case reads as erosion, and because "we cover E3 behaviourally" was a claim
  // this file made and could not support.
})

describe('S2 — the cases that must NOT push', () => {
  test('an empty mailbox is never nudged, however quiet the agent', () => {
    const { r, listener } = driver()
    for (let t = T0; t <= T0 + LONG_WINDOW; t += INTERVAL) {
      listener.tick(targetView({ now: t, agent: AGENT, threshold: 2, lastActivityAt: T0, pending: [] }))
    }
    expect(deliveries(r)).toBe(0)
  })

  test('no live transport, no push — and the notification is not consumed', () => {
    // The queue is truth; notification is best-effort (E1). An agent that was
    // unreachable must be told when it comes back, not counted as informed.
    const { r, listener } = driver()
    const gone = {
      agent: AGENT,
      threshold: 2,
      lastActivityAt: T0,
      deliverable: false,
      pending: [[1, 1] as [number, number]],
    }
    listener.tick(targetView({ ...gone, now: T0 + INTERVAL }))
    expect(deliveries(r)).toBe(0)

    listener.tick(
      targetView({
        agent: AGENT,
        threshold: 2,
        lastActivityAt: T0,
        deliverable: true,
        pending: [[1, 1]],
        now: T0 + INTERVAL + 1000,
      }),
    )
    expect(deliveries(r)).toBe(1)
  })

  test('a REFUSED delivery advances nothing — it retries on the next tick', () => {
    // Race guard 4, which survives the transition unchanged: a wake the
    // transport refused must not be recorded as one. This is the one claim only
    // the core level can make — every integration test in the suite runs against
    // a transport that always lands.
    const { r, listener } = driver(false)
    const quiet = { agent: AGENT, threshold: 2, lastActivityAt: T0, pending: [[1, 1] as [number, number]] }
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
    listener.tick(targetView({ now: T0 + LONG_WINDOW, agent: null, lastActivityAt: T0, pending: [[1, 1]] }))
    expect(deliveries(r)).toBe(0)
  })
})
