/**
 * The attention core, tested BY EVENTS (refactor stage 3, commit 2 — task 033;
 * shape = task 034 D5, Leonid's test-architecture ruling).
 *
 * Feed an ordered sequence of inputs — events and ticks — into the listener and
 * assert the effects that come out. No server, no sockets, no fake timers:
 * `now` is data, so "what does this decide at T+5m?" is a number in an array
 * rather than five minutes of wall clock.
 *
 * ── WHAT THIS LAYER IS FOR, AND WHAT IT IS NOT ──
 *
 * `race-guards.test.ts` (phase A) drives the real factory over HTTP/WS and
 * proves the WIRED SYSTEM still behaves as it did before the extraction. It
 * stays exactly as it was — converting it would destroy the thing it exists
 * for. This file proves the DECISIONS are right. Different claims; both needed.
 *
 * And one claim only this layer can make: **race guard 4**. Every integration
 * test in the suite runs against a real transport that always lands, so
 * "delivery refused → nothing advances" is untestable up there — that is why
 * guard 4 was the one guard phase A could not cover. Here a refusing transport
 * is `lands = false`.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../../es/index.ts'
import type { AttentionView } from './attention.ts'
import { createAttentionListener } from './attention-listener.ts'

const SENSEI = 'sensei'

/** The slice of the world a view is built from. The adapter reads this off the
 *  registry and the pending projection; here it is just data. */
type World = {
  now: number
  agent: string | null
  idle: boolean
  /** Pending queue as (id, is-this-a-human-waiting) pairs. */
  pending: [id: number, blocking: boolean][]
}

// Named rungs rather than indexed lookups: several assertions below turn on
// WHICH rung applies (the second nudge waits the second rung, not the first —
// a mistake this test caught in its own first draft).
const BLOCK_1 = 120_000
const BLOCK_2 = 300_000
const NUDGE_1 = 60_000
const NUDGE_2 = 120_000
const BLOCKING_BACKOFF = [BLOCK_1, BLOCK_2]
const NUDGE_BACKOFF = [NUDGE_1, NUDGE_2]
const STALL_AFTER = 600_000

function viewOf(w: World): AttentionView {
  return {
    now: w.now,
    agent: w.agent,
    idle: w.idle,
    pendingIds: w.pending.map(([id]) => id),
    blockingPendingIds: w.pending.filter(([, b]) => b).map(([id]) => id),
    // The real builder renders an inbox here. Null exercises the documented
    // fallback text and keeps these assertions about decisions, not wording.
    inbox: null,
    blockingBackoffMs: BLOCKING_BACKOFF,
    nudgeBackoffMs: NUDGE_BACKOFF,
    stallAfterMs: STALL_AFTER,
  }
}

function event(id: number): StoredEvent {
  return { id, stream: 'system', type: 'reply', ts: new Date(0).toISOString(), data: {} }
}

type Harness = ReturnType<typeof harness>

function harness(lands = true) {
  /** Every effect the executor was asked to perform, in order. The whole point
   *  of the assertions below is WHICH of these appear — a refused delivery must
   *  produce `deliver` and nothing else. */
  const trace: string[] = []
  const texts: string[] = []
  let landing = lands
  const listener = createAttentionListener({
    deliver: (to, text) => {
      trace.push(`deliver→${to}`)
      texts.push(text)
      return landing
    },
    markBusy: (agent) => void trace.push(`busy:${agent}`),
    stamp: (via) => void trace.push(`stamp:${via}`),
    emitNudge: (data) => void trace.push(`nudge:${JSON.stringify(data)}`),
  })
  return {
    listener,
    trace,
    texts,
    /** Flip the transport mid-sequence — a socket dying, or reconnecting. */
    setLanding: (v: boolean) => {
      landing = v
    },
    drain: () => trace.splice(0).length,
    /** An event arrives and the projections have already applied it.
     *  `hadBlockingPending` is the adapter's pre-append capture (guard 1). */
    arrive(w: World, id: number, hadBlockingPending = false) {
      listener.onEvent(event(id), viewOf(w), hadBlockingPending)
    },
    tick: (w: World) => listener.tick(viewOf(w)),
    nudge: (w: World) => listener.nudge(viewOf(w)),
    hydrate: (w: World) => listener.hydrate(viewOf(w)),
  }
}

const deliveries = (h: Harness) => h.trace.filter((t) => t.startsWith('deliver→')).length

describe('blocking wakes', () => {
  test('a first blocking arrival wakes immediately; a second during the episode is coalesced', () => {
    const h = harness()
    const w: World = { now: 1000, agent: SENSEI, idle: false, pending: [[1, true]] }

    h.arrive(w, 1, false)
    expect(h.trace).toEqual([
      `deliver→${SENSEI}`,
      `busy:${SENSEI}`,
      'stamp:wake',
      'nudge:{"pendingCount":1,"blocking":true}',
    ])
    // Delivered regardless of the idle flag — a human is waiting.
    expect(w.idle).toBe(false)
    h.drain()

    // GUARD 3, in pure form. Both arrivals captured hadBlockingPending=false
    // across the adapter's append (the race phase A drives with a gated store).
    // Without the 30s check the second fires a duplicate immediate wake.
    h.arrive({ ...w, now: 1500, pending: [...w.pending, [2, true]] }, 2, false)
    expect(deliveries(h)).toBe(0)

    // ...and the coalescing is time-bounded: past 30s it is a fresh episode.
    h.arrive({ ...w, now: 1000 + 30_001, pending: [...w.pending, [3, true]] }, 3, false)
    expect(deliveries(h)).toBe(1)
  })

  test('an arrival while blocking was ALREADY pending is coalesced outright', () => {
    const h = harness()
    // hadBlockingPending=true — the wake for the earlier one is already out.
    h.arrive(
      {
        now: 1000,
        agent: SENSEI,
        idle: true,
        pending: [
          [1, true],
          [2, true],
        ],
      },
      2,
      true,
    )
    expect(h.trace).toEqual([])
  })

  test('the backoff ladder re-wakes on schedule and not before', () => {
    const h = harness()
    const w: World = { now: 0, agent: SENSEI, idle: false, pending: [[1, true]] }
    h.arrive(w, 1, false)
    h.drain()

    h.tick({ ...w, now: BLOCK_1 - 1 })
    expect(deliveries(h)).toBe(0)
    h.tick({ ...w, now: BLOCK_1 })
    expect(deliveries(h)).toBe(1)
    h.drain()

    // Second window is the second rung, measured from the LAST wake.
    const t2 = BLOCK_1 + BLOCK_2
    h.tick({ ...w, now: t2 - 1 })
    expect(deliveries(h)).toBe(0)
    h.tick({ ...w, now: t2 })
    expect(deliveries(h)).toBe(1)
  })

  test('an unstarted episode self-heals: blocking pending at count 0 wakes on the next tick', () => {
    const h = harness()
    // Nobody connected when it arrived, so no wake went out and the episode
    // never started. This is also the state a restart lands in.
    h.arrive({ now: 0, agent: null, idle: false, pending: [[1, true]] }, 1, false)
    expect(h.trace).toEqual([])

    h.tick({ now: 5_000, agent: SENSEI, idle: false, pending: [[1, true]] })
    expect(deliveries(h)).toBe(1)
  })

  test('the episode resets when blocking drains, so the next human message wakes at once', () => {
    const h = harness()
    const w: World = { now: 0, agent: SENSEI, idle: false, pending: [[1, true]] }
    h.arrive(w, 1, false)
    h.drain()

    // Ack: the queue drains. Resetting here rather than only on the tick is what
    // stops the next arrival tripping guard 3's stale-episode check.
    h.arrive({ ...w, now: 100, pending: [] }, 99, true)
    h.drain()

    // Well inside the 30s window that would otherwise coalesce it.
    h.arrive({ ...w, now: 200, pending: [[2, true]] }, 2, false)
    expect(deliveries(h)).toBe(1)
  })
})

describe('machine nudges', () => {
  test('idle-gated: nothing while busy, one nudge at turn-end', () => {
    const h = harness()
    const busy: World = { now: 0, agent: SENSEI, idle: false, pending: [[1, false]] }
    h.arrive(busy, 1, false)
    expect(h.trace).toEqual([])

    h.nudge({ ...busy, idle: true, now: 500 })
    expect(h.trace).toEqual([`deliver→${SENSEI}`, `busy:${SENSEI}`, 'stamp:wake', 'nudge:{"pendingCount":1}'])
  })

  test('GUARD 5 — a suppressed-because-busy call does not consume the content-changed signal', () => {
    const h = harness()
    const w: World = { now: 0, agent: SENSEI, idle: true, pending: [[1, false]] }
    h.nudge(w) // nudge #1 lands
    h.drain()

    // An event arrives mid-turn, while the sensei is busy. If the episode
    // bookkeeping ran before the idle gate, this would mark id 2 as
    // already-announced and the turn-end nudge below would never fire.
    h.arrive(
      {
        ...w,
        now: 100,
        idle: false,
        pending: [
          [1, false],
          [2, false],
        ],
      },
      2,
      false,
    )
    expect(deliveries(h)).toBe(0)

    // Turn-end, still far inside the backoff window: only the content-changed
    // signal can produce this.
    h.nudge({
      ...w,
      now: 200,
      pending: [
        [1, false],
        [2, false],
      ],
    })
    expect(deliveries(h)).toBe(1)
  })

  test('content-changed is decided by ID, not by count', () => {
    const h = harness()
    const w: World = { now: 0, agent: SENSEI, idle: true, pending: [[1, false]] }
    h.nudge(w)
    h.drain()

    // One acked, one arrived: the count is unchanged, the content is not.
    h.nudge({ ...w, now: 100, pending: [[2, false]] })
    expect(deliveries(h)).toBe(1)
    h.drain()

    // Nothing new and inside the window — silence, on purpose.
    h.nudge({ ...w, now: 200, pending: [[2, false]] })
    expect(deliveries(h)).toBe(0)
    // The window elapsing is worth exactly one reminder. Note the rung: two
    // nudges have fired, so the wait is the SECOND entry of the ladder measured
    // from the second nudge — not the first. (I got this wrong on the first
    // pass and the test caught the test.)
    h.nudge({ ...w, now: 100 + NUDGE_2 - 1, pending: [[2, false]] })
    expect(deliveries(h)).toBe(0)
    h.nudge({ ...w, now: 100 + NUDGE_2, pending: [[2, false]] })
    expect(deliveries(h)).toBe(1)
  })

  test('a drained queue ends the episode — the next arrival nudges immediately', () => {
    const h = harness()
    const w: World = { now: 0, agent: SENSEI, idle: true, pending: [[1, false]] }
    h.nudge(w)
    h.drain()

    h.arrive({ ...w, now: 10, pending: [] }, 50, false) // drain
    // A fresh queue is genuinely new news: no backoff, even though the window
    // has not elapsed and the new id is lower than nothing in particular.
    h.nudge({ ...w, now: 20, pending: [[2, false]] })
    expect(deliveries(h)).toBe(1)
  })

  test('an empty queue never nudges', () => {
    const h = harness()
    h.nudge({ now: 0, agent: SENSEI, idle: true, pending: [] })
    expect(h.trace).toEqual([])
  })
})

describe('stall watchdog', () => {
  test('fires once the window elapses, ignoring the idle flag, and re-arms', () => {
    const h = harness()
    const w: World = { now: 0, agent: SENSEI, idle: false, pending: [[1, false]] }
    h.arrive(w, 1, false) // arms the clock at now=0
    h.drain()

    h.tick({ ...w, now: STALL_AFTER - 1 })
    expect(deliveries(h)).toBe(0)

    h.tick({ ...w, now: STALL_AFTER })
    expect(h.trace).toEqual([
      `deliver→${SENSEI}`,
      `busy:${SENSEI}`,
      'stamp:heartbeat',
      'nudge:{"pendingCount":1,"forced":true}',
    ])
    expect(h.texts.at(-1)).toContain('Watchdog: events pending for over 10 min')
    h.drain()

    // Re-armed for a full window: one reminder per window, not a flood.
    h.tick({ ...w, now: STALL_AFTER + 1 })
    expect(deliveries(h)).toBe(0)
    h.tick({ ...w, now: 2 * STALL_AFTER })
    expect(deliveries(h)).toBe(1)
  })

  test('stands down while ANY blocking event is pending', () => {
    const h = harness()
    const w: World = { now: 0, agent: SENSEI, idle: false, pending: [[1, false]] }
    h.arrive(w, 1, false)
    h.drain()

    // A human arrives. The blocking path owns delivery from here; the two
    // clocks would otherwise double-fire seconds apart at the backoff cap.
    const withBlocking: World = {
      ...w,
      now: STALL_AFTER,
      pending: [
        [1, false],
        [2, true],
      ],
    }
    h.arrive(withBlocking, 2, false)
    h.drain()

    h.tick({ ...withBlocking, now: STALL_AFTER * 2 })
    // The blocking backoff owns this wake; the `blocking: true` tag proves which
    // path fired, and there is no `forced` watchdog nudge alongside it.
    expect(h.trace.filter((t) => t.startsWith('nudge:'))).toEqual(['nudge:{"pendingCount":2,"blocking":true}'])
  })
})

describe('RACE GUARD 4 — a refused delivery advances nothing', () => {
  // The guard phase A cannot reach: it drives a real socket, which always
  // accepts. Each push path is proven separately, because each one had its own
  // `if (!landed) return` before the extraction folded them into one.

  test('blocking wake: nothing is committed, and the next tick retries', () => {
    const h = harness(false)
    const w: World = { now: 0, agent: SENSEI, idle: false, pending: [[1, true]] }

    h.arrive(w, 1, false)
    // The attempt happened and NOTHING else did — no busy, no stamp, and above
    // all no `nudge` event claiming the sensei was told.
    expect(h.trace).toEqual([`deliver→${SENSEI}`])
    h.drain()

    // Because the episode never advanced, the count is still 0 — the
    // "unstarted episode" state — so the retry comes on the very next tick
    // rather than after a whole backoff window.
    h.setLanding(true)
    h.tick({ ...w, now: 1_000 })
    expect(h.trace).toEqual([
      `deliver→${SENSEI}`,
      `busy:${SENSEI}`,
      'stamp:wake',
      'nudge:{"pendingCount":1,"blocking":true}',
    ])
  })

  test('machine nudge: the episode is not consumed, so turn-end re-announces', () => {
    const h = harness(false)
    const w: World = { now: 0, agent: SENSEI, idle: true, pending: [[1, false]] }

    h.nudge(w)
    expect(h.trace).toEqual([`deliver→${SENSEI}`])
    h.drain()

    // Advancing nudgeCount on a refused push would suppress re-announcement for
    // a whole backoff window. Nothing new has arrived and no time has passed —
    // only an unconsumed episode can produce this second attempt.
    h.setLanding(true)
    h.nudge({ ...w, now: 1 })
    expect(deliveries(h)).toBe(1)
    expect(h.trace).toContain('nudge:{"pendingCount":1}')
  })

  test('stall watchdog: the window is not re-armed, so it retries next tick', () => {
    const h = harness(false)
    const w: World = { now: 0, agent: SENSEI, idle: false, pending: [[1, false]] }
    h.arrive(w, 1, false)
    h.drain()

    h.tick({ ...w, now: STALL_AFTER })
    expect(h.trace).toEqual([`deliver→${SENSEI}`])
    h.drain()

    // Re-arming on a refused push silences the backstop for another full
    // period — precisely the stall class the watchdog exists to break.
    h.setLanding(true)
    h.tick({ ...w, now: STALL_AFTER + 1 })
    expect(deliveries(h)).toBe(1)
    expect(h.trace).toContain('nudge:{"pendingCount":1,"forced":true}')
  })
})

describe('hydrate', () => {
  test('reproduces the pre-refactor boot state: counters zeroed, stall clock armed from the queue', () => {
    const h = harness()
    const w: World = { now: 5_000, agent: SENSEI, idle: false, pending: [[1, true]] }

    // A restart with blocking already in pending. The counters start at zero —
    // deliberately lossy: the stall clock starts at BOOT, not at the original
    // event's timestamp, and blockingWakeCount 0 against a non-empty blocking
    // queue is the unstarted episode the tick self-heals.
    h.hydrate(w)
    expect(h.listener.state.agents.size).toBe(0)
    expect(h.listener.state.pendingSince).toBe(5_000)

    h.tick({ ...w, now: 6_000 })
    expect(deliveries(h)).toBe(1)
  })

  test('an empty queue at boot leaves the stall clock disarmed', () => {
    const h = harness()
    h.hydrate({ now: 5_000, agent: null, idle: false, pending: [] })
    expect(h.listener.state.pendingSince).toBeNull()

    // Nothing pending and no clock: a tick far in the future is silent.
    h.tick({ now: 5_000 + STALL_AFTER * 10, agent: SENSEI, idle: false, pending: [] })
    expect(h.trace).toEqual([])
  })
})
