/**
 * The attention listener — the stateful shell around the pure decisions in
 * `attention.ts` (refactor stage 3, commit 2 — task 033).
 *
 * It holds `AttentionState`, subscribes to the bus LAST (see core/bus.ts for
 * why last is semantics), and turns decisions into effects through an
 * `Executor` the adapter supplies. It is the ONLY place where the decide →
 * execute → commit-iff-landed sequence is written down.
 *
 * ── WHY GUARD 4 LIVES HERE, ONCE ──
 *
 * Before the extraction, "a refused delivery must not advance anything" was
 * three separate `if (!landed) return` lines — one in each push path
 * (`wakeSenseiBlocking`, `nudgeSenseiIfIdle`, `fireStallWatchdog`). Three copies
 * of a rule is three chances to add a fourth push path that forgets it, which is
 * exactly how the rule got written three times in the first place (review
 * finding [A], reached independently on each path).
 *
 * Here it is structural: `run()` cannot commit anything a delivery did not earn,
 * because the commit data only exists inside `effect.onLanded` and the only code
 * that reads it is below the `if (!landed) continue`. A new push path gets the
 * guard by construction.
 *
 * The mutation harness still proves it PER PATH: one entry per push path, each
 * breaking this single line and running only that path's test, so every path is
 * shown to detect the loss independently.
 */

import type { StoredEvent } from '../../es/index.ts'
import type { DeliveredVia, NudgeData } from '../reducers.ts'
import {
  type AttentionState,
  type AttentionView,
  decideEventApplied,
  decideNudge,
  decideTick,
  initialState,
} from './attention.ts'

/** The adapter side of the four effect kinds the core can emit. Attention only
 *  reaches for two of them (`deliver` and `event`); `schedule` and `spawn` are
 *  the trigger scheduler's, and stay where they are. */
export type Executor = {
  /** Push to a locally-registered agent. Returns whether the transport accepted
   *  it — the answer the entire commit hinges on. */
  deliver: (to: string, text: string) => boolean
  /** Mark the agent busy. Only ever called for a landed push. */
  markBusy: (agent: string) => void
  /** Record how the currently-pending events reached the agent. */
  stamp: (via: DeliveredVia) => void
  /** Append the `nudge` event. Fire-and-forget, like the `void record(...)` it
   *  replaces. */
  emitNudge: (data: NudgeData) => void
}

export type AttentionListener = {
  /** Bus subscriber. `hadBlockingPending` is the adapter's pre-append capture
   *  (race guard 1) — it cannot be recomputed here. */
  onEvent: (event: StoredEvent, view: AttentionView, hadBlockingPending: boolean) => void
  /** Both timer intervals call this and nothing else. */
  tick: (view: AttentionView) => void
  /** The turn-end path (`POST /agent-idle`). */
  nudge: (view: AttentionView) => void
  /** Called ONCE after catch-up, never during it. Reproduces the pre-refactor
   *  boot state: counters at zero, and the stall clock armed from the replayed
   *  queue's emptiness. See core/bus.ts, "REPLAY NEVER PUBLISHES" — the listener
   *  has no replay path at all, which is what stops a restart re-emitting every
   *  historical wake. */
  hydrate: (view: AttentionView) => void
  /** Read-only, for tests and diagnostics. */
  readonly state: AttentionState
}

export function createAttentionListener(exec: Executor): AttentionListener {
  let state = initialState()

  function run(decision: ReturnType<typeof decideTick>): void {
    // The unconditional half — queue-drain resets, the stall clock arming.
    // These are not earned by a delivery, so they land first and stay.
    state = decision.next

    for (const effect of decision.effects) {
      const landed = exec.deliver(effect.to, effect.text)
      // ── RACE GUARD 4 ── Nothing that didn't happen gets recorded. A wake the
      // transport refused (a dead socket whose close handler hasn't run) must
      // not advance the episode, stamp the ledger, mark the agent busy, or
      // leave a `nudge` event claiming it was told. Leaving blockingWakeCount
      // at 0 is precisely the "unstarted episode" state the blocking tick
      // self-heals, so an undelivered wake retries on the next tick rather than
      // after a whole backoff window.
      if (!landed) continue
      state = {
        ...state,
        agents: new Map(state.agents).set(effect.to, effect.onLanded.episode),
        pendingSince: effect.onLanded.pendingSince,
      }
      exec.markBusy(effect.to)
      exec.stamp(effect.onLanded.stampAs)
      exec.emitNudge(effect.onLanded.nudge)
    }
  }

  return {
    onEvent(event, view, hadBlockingPending) {
      run(decideEventApplied(state, view, event, hadBlockingPending))
    },
    tick(view) {
      run(decideTick(state, view))
    },
    nudge(view) {
      run(decideNudge(state, view))
    },
    hydrate(view) {
      // Verbatim reproduction of the three pre-refactor initializations:
      // pendingSince from the replayed queue's emptiness (server.ts:1072), and
      // both counter sets at zero (:861-862, :1109-1112) — i.e. an empty map.
      //
      // The lossiness is deliberate and load-bearing: the stall clock starts at
      // BOOT rather than at the original event's timestamp, and
      // `blockingWakeCount: 0` against a non-empty blocking queue is the
      // "unstarted episode" the backoff tick self-heals within one tick. That
      // is the behaviour attention-recovery.test.ts exists to pin.
      state = { agents: new Map(), pendingSince: view.pendingIds.length > 0 ? view.now : null }
    },
    get state() {
      return state
    },
  }
}
