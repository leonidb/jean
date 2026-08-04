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
  /** WHOSE mailbox — survives the owner's disconnects. */
  agent: string | null
  /** Whether there is a live transport. Defaults to "there is an owner", which
   *  is what `agent` meant before the mailbox reshape, so every pre-existing
   *  case below keeps exactly its old meaning. */
  deliverable?: boolean
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
    deliverable: w.deliverable ?? w.agent !== null,
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

describe('mailbox ownership — owner is not deliverable', () => {
  // The two cases the mailbox reshape turns on, both required by the ruling on
  // task 040 Q1. Neither is reachable from the integration suite: both
  // stall-watchdog cases connect the sensei BEFORE the event, and the
  // sensei-absent recovery case uses a human message, which self-heals through
  // the blocking tick rather than the watchdog.

  test('PRESERVED — an arrival while the owner is DISCONNECTED still starts the stall window', () => {
    const h = harness()
    // Owner known (a sensei registered at some point), nobody attached now.
    const offline: World = { now: 0, agent: SENSEI, deliverable: false, idle: false, pending: [[1, false]] }

    h.arrive(offline, 1, false)
    expect(h.trace).toEqual([]) // nothing to push to
    // ...but the clock IS armed. This is the whole point of separating owner
    // from deliverable: pre-reshape the global clock armed here, and keying it
    // on "the connected sensei" would have silently lost that.
    expect(h.listener.state.agents.get(SENSEI)?.pendingSince).toBe(0)

    // A full window later the owner attaches. The watchdog fires IMMEDIATELY,
    // because the window was measured from the ARRIVAL — not restarted from the
    // reconnect.
    h.tick({ ...offline, now: STALL_AFTER, deliverable: true })
    expect(h.trace).toContain('nudge:{"pendingCount":1,"forced":true}')
  })

  test('ACCEPTED CORNER — a never-registered dojo has no owner, so nothing is armed', () => {
    // Sanctioned 2026-08-04 (task 040 Q1, option (c) for this corner alone):
    // with no sensei ever registered there is no name to own the mailbox, and
    // inventing one would be worse than the delay. Pinned so the delta is a
    // decision on the record rather than a surprise later.
    const h = harness()
    h.arrive({ now: 0, agent: null, idle: false, pending: [[1, false]] }, 1, false)
    expect(h.listener.state.agents.size).toBe(0)

    // A full window after that arrival, with an owner now present: silent,
    // because its clock has not started. Pre-reshape this fired.
    h.tick({ now: STALL_AFTER, agent: SENSEI, idle: false, pending: [[1, false]] })
    expect(h.trace).toEqual([])

    // It self-heals on the next arrival — the clock starts then, and the
    // watchdog follows a full window later. Bounded, not lost.
    h.arrive(
      {
        now: STALL_AFTER,
        agent: SENSEI,
        idle: false,
        pending: [
          [1, false],
          [2, false],
        ],
      },
      2,
      false,
    )
    h.drain()
    h.tick({
      now: STALL_AFTER * 2,
      agent: SENSEI,
      idle: false,
      pending: [
        [1, false],
        [2, false],
      ],
    })
    expect(h.trace).toContain('nudge:{"pendingCount":2,"forced":true}')
  })

  test('a non-deliverable mailbox never nudges — `idle` implies `deliverable`', () => {
    // The adapter reports idle:false whenever the mailbox is not deliverable,
    // which is why decideNudge needs no separate check. Pinned here so that
    // coupling is a tested invariant rather than an accident of construction.
    const h = harness()
    h.nudge({ now: 0, agent: SENSEI, deliverable: false, idle: true, pending: [[1, false]] })
    expect(h.trace).toEqual([])
  })
})

describe('adoptMailbox — a mailbox changing hands', () => {
  // Review finding (codex, 2026-08-04), fixed inside this commit. Without
  // adoption, a sensei reattaching under a NEW name while events sat pending
  // left the armed clock stranded on the old key: the pre-reshape global clock
  // fired the watchdog immediately on connect, the reshaped one waited a FULL
  // FURTHER window. Measured at 10 min on the defaults.
  //
  // The rule the three cases below pin: the QUEUE clock crosses, the LADDER
  // does not. `pendingSince` describes the queue, which a rename cannot touch;
  // the counters describe a named agent's conversation, and reset — the D4
  // delta, still accepted at its stated cost.

  test('THE REPRO — a rename mid-stall no longer delays the watchdog', () => {
    const h = harness()
    // `alice` owns the mailbox, nobody attached. An event lands and arms it.
    h.arrive({ now: 0, agent: 'alice', deliverable: false, idle: false, pending: [[1, false]] }, 1, false)
    expect(h.listener.state.agents.get('alice')?.pendingSince).toBe(0)

    // A sensei reattaches under a different name, a full window later.
    h.listener.adoptMailbox('alice', 'bob')

    // The watchdog fires AT ONCE, because the window was measured from the
    // arrival. Pre-fix this produced nothing and waited another full window.
    h.tick({ now: STALL_AFTER, agent: 'bob', deliverable: true, idle: false, pending: [[1, false]] })
    expect(h.trace).toContain('nudge:{"pendingCount":1,"forced":true}')
  })

  test('the queue clock CROSSES and the old key is released', () => {
    const h = harness()
    h.arrive({ now: 7_000, agent: 'alice', deliverable: false, idle: false, pending: [[1, false]] }, 1, false)
    h.listener.adoptMailbox('alice', 'bob')

    expect(h.listener.state.agents.get('bob')?.pendingSince).toBe(7_000)
    // Moved, not copied: a stranded clock is unreachable state, and one per
    // rename is a slow leak.
    expect(h.listener.state.agents.has('alice')).toBe(false)
  })

  test('the LADDER does not cross — the renamed owner starts fresh', () => {
    const h = harness()
    const w: World = { now: 0, agent: 'alice', idle: false, pending: [[1, true]] }
    h.arrive(w, 1, false) // a blocking wake lands: alice's ladder is now at 1
    h.drain()
    expect(h.listener.state.agents.get('alice')?.blockingWakeCount).toBe(1)

    h.listener.adoptMailbox('alice', 'bob')
    const bob = h.listener.state.agents.get('bob')
    expect(bob?.blockingWakeCount).toBe(0)
    expect(bob?.lastBlockingWakeAt).toBe(0)
    expect(bob?.nudgeCount).toBe(0)
    expect(bob?.maxNudgedPendingId).toBe(0)
    // ...and the clock the landed wake armed still came along.
    expect(bob?.pendingSince).toBe(0)

    // The behavioural consequence, which is the D4 delta at exactly its stated
    // cost: one extra blocking wake on the next tick rather than waiting out
    // the rung. Not a missed wake, and not a stalled backstop.
    h.tick({ ...w, now: BLOCK_1 - 1, agent: 'bob' })
    expect(deliveries(h)).toBe(1)
  })

  test('adopting from an owner with no episode is a no-op', () => {
    const h = harness()
    h.listener.adoptMailbox('nobody', 'bob')
    expect(h.listener.state.agents.size).toBe(0)
    // Self-adoption cannot destroy state either.
    h.arrive({ now: 5, agent: 'bob', idle: false, pending: [[1, false]] }, 1, false)
    h.listener.adoptMailbox('bob', 'bob')
    expect(h.listener.state.agents.get('bob')?.pendingSince).toBe(5)
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
    // STATE-INTERNAL UPDATE (mailbox reshape): the clock is the OWNER's now, so
    // hydrate creates exactly one key rather than leaving the map empty with a
    // global clock beside it. The behaviour asserted below is unchanged.
    expect([...h.listener.state.agents.keys()]).toEqual([SENSEI])
    expect(h.listener.state.agents.get(SENSEI)?.pendingSince).toBe(5_000)

    h.tick({ ...w, now: 6_000 })
    expect(deliveries(h)).toBe(1)
  })

  test('ACCEPTED DELTA — a sensei reconnecting under a DIFFERENT name starts a fresh episode', () => {
    // Keying episodes by agent name is the D4 reshape (ruled 2026-08-04). The
    // pre-refactor globals were name-agnostic, so this is a real behaviour
    // change: accepted, and therefore pinned rather than left to drift.
    //
    // Why it is benign, asserted rather than asserted-about: the reset lands in
    // `blockingWakeCount: 0`, which is the "unstarted episode" state the
    // blocking tick self-heals — so the cost is at most one extra wake on the
    // next tick, never a missed one.
    const h = harness()
    const w: World = { now: 0, agent: 'sensei-a', idle: false, pending: [[1, true]] }
    h.arrive(w, 1, false)
    h.drain()

    // Same episode, same name: coalesced by the backoff ladder.
    h.tick({ ...w, now: BLOCK_1 - 1 })
    expect(deliveries(h)).toBe(0)

    // Renamed. The new key has no episode, so the ladder restarts — one extra
    // wake, immediately, instead of waiting out the rung.
    h.tick({ ...w, now: BLOCK_1 - 1, agent: 'sensei-b' })
    expect(deliveries(h)).toBe(1)
    h.drain()

    // And it is ONE extra, not a loop: the new key's episode is now live and
    // the ladder applies to it exactly as it did to the old one.
    h.tick({ ...w, now: BLOCK_1, agent: 'sensei-b' })
    expect(deliveries(h)).toBe(0)

    // The old name's episode is untouched — nothing was migrated or lost.
    expect(h.listener.state.agents.get('sensei-a')?.blockingWakeCount).toBe(1)
    expect(h.listener.state.agents.get('sensei-b')?.blockingWakeCount).toBe(1)
  })

  test('an empty queue at boot leaves the stall clock disarmed', () => {
    const h = harness()
    h.hydrate({ now: 5_000, agent: SENSEI, idle: false, pending: [] })
    // STATE-INTERNAL UPDATE: an empty mailbox invents NO key — "keys appear as
    // agents' events do" — where the pre-reshape shape carried a null global.
    expect(h.listener.state.agents.size).toBe(0)

    // Nothing pending and no clock: a tick far in the future is silent.
    h.tick({ now: 5_000 + STALL_AFTER * 10, agent: SENSEI, idle: false, pending: [] })
    expect(h.trace).toEqual([])
  })
})
