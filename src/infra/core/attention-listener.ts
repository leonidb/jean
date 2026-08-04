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
  freshEpisode,
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
  /**
   * A mailbox has CHANGED HANDS — the same queue, a differently-named owner.
   *
   * Carries the QUEUE CLOCK across and nothing else. The two halves of an
   * episode answer to different things: `pendingSince` describes the QUEUE
   * ("when did this mailbox last go non-empty"), which a rename does not touch,
   * while the ladder counters describe a named agent's conversation and
   * correctly start fresh (the accepted D4 delta — a renamed sensei pays at
   * most one extra blocking wake within a tick).
   *
   * WHY THIS IS AN EXPLICIT SIGNAL rather than something the listener infers:
   * it cannot be detected from `view.agent` alone. Once worker mailboxes are
   * driven, consecutive calls legitimately alternate between agents, and every
   * alternation would look like a rename. Only the adapter knows the registry
   * changed identity, so the adapter says so.
   *
   * Found by review, not by the suite: without it, a sensei reattaching under a
   * new name while events sat pending left the armed clock stranded on the old
   * key and delayed the stall watchdog by a FULL window (measured: default
   * 10 min, where the pre-reshape global clock fired immediately).
   */
  adoptMailbox: (from: string, to: string) => void
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
      // ── ONE MEASURED DELTA, and it is here ──
      //
      // The committed timestamps come from `view.now`, read BEFORE this
      // delivery. The pre-refactor code read `ports.now()` AFTER it, on each of
      // the three paths. Surfaced by review; the answer is that the position
      // rule (ports.ts) is about AWAIT boundaries, and there is no await in the
      // window — `exec.deliver` bottoms out in `ws.send(JSON.stringify(msg))`,
      // synchronous, and the sensei is always a WS agent (peers register as
      // 'peer', the bridge as 'user').
      //
      // Measured rather than argued: 2000 sends of a full 1.9 KB wake payload
      // over a real socket, worst case 1 ms of wall clock (1.36 ms hi-res, a GC
      // pause). So a committed timestamp can be up to ~1 ms EARLIER than it
      // would have been — never later — against thresholds of 30 s and up. It
      // also collapses what were TWO separate `ports.now()` reads per push into
      // one coherent instant.
      //
      // ONE assignment, since the mailbox reshape moved the stall clock into
      // the episode: `onLanded.episode` is now the whole commit for this
      // mailbox, and it can no longer touch another agent's.
      state = { ...state, agents: new Map(state.agents).set(effect.to, effect.onLanded.episode) }
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
      // Counters at zero, and the stall clock armed from the replayed mailbox's
      // emptiness — the same two facts as before the mailbox reshape, now keyed
      // by owner instead of global.
      //
      // NO KEY IS INVENTED. An empty mailbox map at boot is the correct state:
      // keys appear as agents' events do. So an empty queue leaves the map
      // empty, and a dojo where no sensei has ever registered has no owner to
      // key at all (the accepted corner — see core/attention.ts's header).
      //
      // The lossiness is deliberate and load-bearing: the clock starts at BOOT
      // rather than at the original event's timestamp, and `blockingWakeCount:
      // 0` against a non-empty blocking queue is the "unstarted episode" the
      // backoff tick self-heals within one tick. That is the behaviour
      // attention-recovery.test.ts exists to pin, and it stays unmodified.
      state = initialState()
      if (view.agent && view.pendingIds.length > 0) {
        state = { agents: new Map([[view.agent, { ...freshEpisode(), pendingSince: view.now }]]) }
      }
    },
    adoptMailbox(from, to) {
      if (from === to) return
      const previous = state.agents.get(from)
      if (!previous) return // nothing to carry
      const agents = new Map(state.agents)
      // The old key GOES: the mailbox moved, it was not copied. Leaving it
      // strands a clock nothing can reach and grows the map by one per rename.
      agents.delete(from)
      // The new owner starts a fresh ladder and inherits the queue clock. If it
      // somehow already had an episode — unreachable today, since the sensei
      // mailbox is the only keyed one and a rename deletes the old key — its own
      // state wins and only an unset clock is filled in. Monotone either way:
      // this can add a clock, never overwrite one.
      const arrived = state.agents.get(to)
      agents.set(to, { ...(arrived ?? freshEpisode()), pendingSince: arrived?.pendingSince ?? previous.pendingSince })
      state = { agents }
    },
    get state() {
      return state
    },
  }
}
