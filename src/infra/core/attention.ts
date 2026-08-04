/**
 * Attention decisions, as pure functions (refactor stage 3, commit 2 — task
 * 033; shape settled on task 034 D1-D5).
 *
 * Everything here is `decide(state, view) → Decision`. No clock, no registry,
 * no projections, no I/O: `view` is a snapshot the adapter constructs, `now` is
 * data, and the return value DESCRIBES what should happen rather than doing it.
 * That is what makes the whole attention machine testable by feeding it an
 * ordered sequence of inputs and asserting the effects that come out.
 *
 * ── THE LOAD-BEARING CONSTRAINT: DECIDE → EXECUTE → COMMIT-IFF-LANDED ──
 *
 * A wake the transport refused must not advance the episode, stamp the ledger,
 * mark the sensei busy, or leave a `nudge` event claiming the sensei was told.
 * This is race guard 4 — three separate `if (!landed) return` lines in the
 * pre-refactor code, one per push path.
 *
 * So a `Decision` is deliberately split in two:
 *   - `next` — the state transition that happens REGARDLESS. Queue-drain
 *     resets, the stall clock arming. Applied before anything is attempted.
 *   - `effects[].onLanded` — the episode advance, precomputed here but applied
 *     by the listener ONLY after the delivery has actually landed.
 *
 * `decide*` MUST NOT return a state that already assumes delivery. If the
 * episode advance ever migrates into `next`, the guard is gone and the failure
 * is invisible: every integration test in the suite runs against a real
 * transport that always lands, so nothing goes red. That is why the advance is
 * carried as `onLanded` data rather than folded into `next` — the shape itself
 * is the guard.
 *
 * ── STATE SHAPE, AND ONE REFINEMENT OF D4 ──
 *
 * D4 specified `Map<agent, EpisodeState>` with the sensei as the only populated
 * key, and that is what `agents` is. But `pendingSince` is NOT per-agent here,
 * and the reason is concrete: it is the stall clock for the PENDING QUEUE
 * ("when pending last went non-empty, or the last push fired, whichever is
 * later"), the queue is global today, and it is hydrated at boot — when no
 * sensei is connected and there is therefore no agent key to hydrate. Putting
 * it in the map would mean inventing a key that does not exist yet.
 *
 * When phase 5 gives every agent its own mailbox, the queue becomes per-agent
 * and `pendingSince` moves into the per-agent state with it. That is the same
 * reshape, arriving when there is something to key it by.
 *
 * ACCEPTED DELTA (D4, ruled on 2026-08-04): keying episodes by agent name means
 * a sensei that reconnects under a DIFFERENT name starts a fresh episode, where
 * the old file-scope globals were name-agnostic. The reset lands in
 * `blockingWakeCount: 0` — the "unstarted episode" state the blocking tick
 * self-heals — so the cost is at most one extra wake within one tick.
 */

import type { StoredEvent } from '../../es/index.ts'
import { type Inbox, renderInboxWake } from '../inbox.ts'
import type { DeliveredVia, NudgeData } from '../reducers.ts'

/** Per-agent episode bookkeeping. Sensei is the only populated key today. */
export type EpisodeState = {
  /** Wakes fired in the current blocking episode (resets when blocking drains). */
  blockingWakeCount: number
  lastBlockingWakeAt: number
  nudgeCount: number
  lastNudgeAt: number
  /** Highest pending event id this agent has already been told about. */
  maxNudgedPendingId: number
}

export type AttentionState = {
  agents: Map<string, EpisodeState>
  /** Stall clock for the pending queue — see the header for why it is not
   *  per-agent yet. Null while pending is empty. */
  pendingSince: number | null
}

/** What the decisions are allowed to see of the world. Constructed fresh by the
 *  adapter at every decision point — never cached, which is what keeps the
 *  delivered inbox and the recorded `pendingCount` in agreement. */
export type AttentionView = {
  now: number
  /** The agent these decisions are about — the connected sensei, or null when
   *  there is nobody to push to. Also the key into `state.agents`. */
  agent: string | null
  /** The agent's idle flag. Only the machine-nudge path gates on it. */
  idle: boolean
  /** Ids currently in the pending queue, and the blocking (human-waiting)
   *  subset of them. */
  pendingIds: number[]
  blockingPendingIds: number[]
  /** The inbox as of `now`, or null when empty. */
  inbox: Inbox | null
  blockingBackoffMs: number[]
  nudgeBackoffMs: number[]
  stallAfterMs: number
}

/** The episode advance + bookkeeping that a push earns ONLY by landing. */
export type OnLanded = {
  /** The agent's episode state after a successful push. Precomputed; applied by
   *  the listener iff the delivery returned true. */
  episode: EpisodeState
  /** Re-arm the stall clock. */
  pendingSince: number
  /** How the delivery ledger should record this push. */
  stampAs: DeliveredVia
  /** The `nudge` event to append. Recorded only on a landed push — an event
   *  claiming the sensei was told, when it wasn't, is worse than silence. */
  nudge: NudgeData
}

export type Effect = {
  kind: 'deliver'
  to: string
  text: string
  onLanded: OnLanded
}

export type Decision = {
  /** Applied unconditionally, before any effect is attempted. */
  next: AttentionState
  /** Attempted in order. At most one per agent — see `tick`. */
  effects: Effect[]
}

export function freshEpisode(): EpisodeState {
  return { blockingWakeCount: 0, lastBlockingWakeAt: 0, nudgeCount: 0, lastNudgeAt: 0, maxNudgedPendingId: 0 }
}

export function initialState(): AttentionState {
  return { agents: new Map(), pendingSince: null }
}

/** Episode for `agent`, defaulting to a fresh one. Reading never mutates the
 *  map: an agent only gets a key once something has actually been decided for
 *  it. */
export function episodeOf(state: AttentionState, agent: string): EpisodeState {
  return state.agents.get(agent) ?? freshEpisode()
}

function withEpisode(state: AttentionState, agent: string, episode: EpisodeState): AttentionState {
  const agents = new Map(state.agents)
  agents.set(agent, episode)
  return { ...state, agents }
}

/** Map over every populated episode. The queue is global today, so the
 *  queue-driven resets apply to every agent that has one. */
function mapEpisodes(state: AttentionState, fn: (e: EpisodeState) => EpisodeState): AttentionState {
  const agents = new Map<string, EpisodeState>()
  for (const [name, episode] of state.agents) agents.set(name, fn(episode))
  return { ...state, agents }
}

const backoffAt = (schedule: number[], count: number): number =>
  schedule[Math.min(count - 1, schedule.length - 1)] as number

const maxId = (ids: number[]): number => ids.reduce((hi, id) => (id > hi ? id : hi), 0)

/** The BLOCKING wake — a human is waiting, so it ignores the idle flag
 *  entirely. Null when there is nobody to deliver to; the piggyback and a
 *  future connect carry the news instead. */
function blockingWake(state: AttentionState, view: AttentionView): Effect | null {
  if (!view.agent) return null
  const episode = episodeOf(state, view.agent)
  return {
    kind: 'deliver',
    to: view.agent,
    text:
      "A human is waiting — delivered regardless of idle state. Handle blocking first; finish your current step, don't start new unrelated work.\n" +
      `${view.inbox ? renderInboxWake(view.inbox) : 'Check the board.'}`,
    onLanded: {
      episode: {
        ...episode,
        lastBlockingWakeAt: view.now,
        blockingWakeCount: episode.blockingWakeCount + 1,
      },
      pendingSince: view.now,
      stampAs: 'wake',
      nudge: { pendingCount: view.pendingIds.length, blocking: true },
    },
  }
}

/**
 * A blocking event just entered pending. A NEW episode (nothing blocking was
 * pending before it was appended) wakes immediately; arrivals during an active
 * episode are coalesced — the existing wake plus climbing piggyback ages cover
 * the burst, and `decideBlockingTick` re-wakes if it stays unhandled.
 *
 * `hadBlockingBefore` is captured by the adapter BEFORE the append, and must
 * stay there: that is race guard 1. It cannot be recomputed here, because by
 * the time this runs the event is already in the queue.
 */
export function decideBlockingArrival(
  state: AttentionState,
  view: AttentionView,
  hadBlockingBefore: boolean,
): Decision {
  if (hadBlockingBefore) return { next: state, effects: [] }
  if (view.agent) {
    // Race guard 3: two near-simultaneous arrivals can BOTH capture
    // hadBlockingBefore=false across the adapter's append. Without this check
    // the second fires a duplicate immediate wake. A very recent blocking wake
    // means the episode is already live and the backoff loop owns any re-wake.
    const episode = episodeOf(state, view.agent)
    if (episode.blockingWakeCount > 0 && view.now - episode.lastBlockingWakeAt < 30_000) {
      return { next: state, effects: [] }
    }
    // Fresh episode — clear any stale backoff state. Unconditional: it is a
    // reset, not an advance, so it does not wait on the delivery landing.
    const next = withEpisode(state, view.agent, { ...episode, blockingWakeCount: 0 })
    const effect = blockingWake(next, view)
    return { next, effects: effect ? [effect] : [] }
  }
  return { next: state, effects: [] }
}

/**
 * The backoff loop: while blocking events sit unhandled, re-wake on schedule.
 * Quiet when nothing is blocking (and resets the episode counter then).
 *
 * SELF-HEALING, and this is load-bearing rather than defensive: blocking
 * pending with count === 0 is an UNSTARTED episode — the arrival wake was
 * missed (no sensei connected at arrival, infra restarted with blocking already
 * in pending, or the arrival was masked by an interleaved ack). Firing wake #1
 * here converges every such state within one tick of an agent being available,
 * instead of failing closed until the watchdog.
 */
export function decideBlockingTick(state: AttentionState, view: AttentionView): Decision {
  if (view.blockingPendingIds.length === 0) {
    return { next: mapEpisodes(state, (e) => ({ ...e, blockingWakeCount: 0 })), effects: [] }
  }
  if (!view.agent) return { next: state, effects: [] }
  const episode = episodeOf(state, view.agent)
  if (episode.blockingWakeCount === 0) {
    const effect = blockingWake(state, view)
    return { next: state, effects: effect ? [effect] : [] }
  }
  const delay = backoffAt(view.blockingBackoffMs, episode.blockingWakeCount)
  if (view.now - episode.lastBlockingWakeAt < delay) return { next: state, effects: [] }
  const effect = blockingWake(state, view)
  return { next: state, effects: effect ? [effect] : [] }
}

/** Has an event entered pending since the last nudge? Id-based, not
 *  count-based: an ack plus an arrival between two nudges leaves the count
 *  equal while the content is genuinely new. */
function hasNewContent(episode: EpisodeState, view: AttentionView): boolean {
  return view.pendingIds.some((id) => id > episode.maxNudgedPendingId)
}

function shouldNudge(episode: EpisodeState, view: AttentionView): boolean {
  if (episode.nudgeCount === 0) return true
  if (hasNewContent(episode, view)) return true
  return view.now - episode.lastNudgeAt >= backoffAt(view.nudgeBackoffMs, episode.nudgeCount)
}

/**
 * The machine nudge — idle-gated, with episode backoff.
 *
 * Background (goals dojo event 10077): SIX re-nudges in ~25s on ONE deliberately
 * held event. Every turn-end posts /agent-idle, which called this with zero
 * suppression, so the loop rate WAS the reply rate — the sensei's own answer
 * re-armed the interrupt that produced it. An episode nudges when it has
 * something new to say, not whenever the agent draws breath: first nudge of the
 * episode always; content changed; or the backoff window elapsed.
 */
export function decideNudge(state: AttentionState, view: AttentionView): Decision {
  // THE IDLE GATE IS CHECKED BEFORE ANY EPISODE BOOKKEEPING (race guard 5). A
  // suppressed-because-busy call must not consume the content-changed signal,
  // or an event that arrived mid-turn would never be announced at turn-end.
  if (!view.agent || !view.idle) return { next: state, effects: [] }
  if (view.pendingIds.length === 0) return { next: state, effects: [] }
  const episode = episodeOf(state, view.agent)
  if (!shouldNudge(episode, view)) return { next: state, effects: [] }

  return {
    next: state,
    effects: [
      {
        kind: 'deliver',
        to: view.agent,
        // Full inbox on wakes (docs/attention.md §2): triage needs zero fetches.
        text: view.inbox ? renderInboxWake(view.inbox) : 'Events pending. Check the board.',
        onLanded: {
          episode: {
            ...episode,
            nudgeCount: episode.nudgeCount + 1,
            lastNudgeAt: view.now,
            maxNudgedPendingId: Math.max(episode.maxNudgedPendingId, maxId(view.pendingIds)),
          },
          pendingSince: view.now,
          stampAs: 'wake',
          nudge: { pendingCount: view.pendingIds.length },
        },
      },
    ],
  }
}

/**
 * The stall watchdog. A missed Stop hook leaves the sensei stuck at idle:false,
 * which suppresses every machine nudge: pending grows and the dojo silently
 * stalls. When pending has sat non-empty for `stallAfterMs` with no push, force
 * one that ignores the idle flag.
 */
export function decideStallTick(state: AttentionState, view: AttentionView): Decision {
  if (state.pendingSince === null) return { next: state, effects: [] }
  if (view.now - state.pendingSince < view.stallAfterMs) return { next: state, effects: [] }
  // While ANY blocking event is pending, the blocking path owns delivery and
  // the watchdog stands down — its re-wakes ARE the delivery attempts, and at
  // the backoff cap the two clocks run at identical periods and would
  // double-fire seconds apart.
  //
  // The condition is "blocking is pending", NOT "a blocking episode has fired":
  // since guard 4 stopped failed deliveries from advancing blockingWakeCount,
  // an unstarted episode sits at count 0, which a `count > 0` guard would miss.
  if (view.blockingPendingIds.length > 0) return { next: state, effects: [] }
  if (!view.agent) return { next: state, effects: [] } // clock stays armed for when one connects

  const minutes = Math.max(1, Math.round(view.stallAfterMs / 60_000))
  return {
    next: state,
    effects: [
      {
        kind: 'deliver',
        to: view.agent,
        text:
          `Watchdog: events pending for over ${minutes} min. (Sent regardless of your idle state — your Stop hook may have misfired.)\n` +
          `${view.inbox ? renderInboxWake(view.inbox) : 'Check the board.'}`,
        onLanded: {
          episode: episodeOf(state, view.agent),
          pendingSince: view.now,
          stampAs: 'heartbeat',
          nudge: { pendingCount: view.pendingIds.length, forced: true },
        },
      },
    ],
  }
}

/**
 * An event has just been applied to the projections. Reproduces the tail of
 * `record()`: the queue-driven resets, then the arrival dispatch.
 *
 * `hadBlockingBefore` must be captured by the adapter before the append (race
 * guard 1); see `decideBlockingArrival`.
 */
export function decideEventApplied(
  state: AttentionState,
  view: AttentionView,
  event: StoredEvent,
  hadBlockingBefore: boolean,
): Decision {
  // Stall clock: starts when pending becomes non-empty, clears when drained. A
  // drained queue also ends the machine-nudge episode — the next arrival on an
  // empty queue is genuinely new news and nudges immediately.
  let next: AttentionState =
    view.pendingIds.length === 0
      ? {
          ...mapEpisodes(state, (e) => ({ ...e, nudgeCount: 0, lastNudgeAt: 0, maxNudgedPendingId: 0 })),
          pendingSince: null,
        }
      : { ...state, pendingSince: state.pendingSince ?? view.now }

  // The blocking episode ends the moment blocking drains, here rather than only
  // on the tick, so a new human message right after a drain gets its immediate
  // wake instead of tripping guard 3's stale-episode check.
  if (view.blockingPendingIds.length === 0) {
    next = mapEpisodes(next, (e) => ({ ...e, blockingWakeCount: 0 }))
  }

  // Did THIS event enter pending? Checked directly by id (race guard 2) — a
  // length-compare across the adapter's append is maskable by an interleaved
  // ack shrinking the queue, which would silently skip the dispatch.
  if (!view.pendingIds.includes(event.id)) return { next, effects: [] }

  // A human waiting wakes regardless of the idle flag; machine events keep the
  // idle-gated nudge. `blockingPendingIds` is the queue's blocking subset, so
  // membership here is exactly "this event is a human waiting".
  const arrival = view.blockingPendingIds.includes(event.id)
    ? decideBlockingArrival(next, view, hadBlockingBefore)
    : decideNudge(next, view)
  return arrival
}

/**
 * One timer tick. BOTH intervals call this and nothing else — the acceptance
 * check for the extraction is that a timer callback no longer branches on
 * state.
 *
 * Blocking first, then stall, matching the order the two `setInterval`s were
 * registered in. They are mutually exclusive in practice (the watchdog stands
 * down while blocking is pending), so at most one effect comes out.
 *
 * NOTE, the one timing delta of the merge: the stall check now also runs on the
 * blocking interval's faster grid. It can only fire SOONER after its threshold,
 * never before it — the `now - pendingSince >= stallAfterMs` test is unchanged
 * — so the window is exact and only the latency after it shrinks.
 */
export function decideTick(state: AttentionState, view: AttentionView): Decision {
  const blocking = decideBlockingTick(state, view)
  // Not an optimisation, and not defensive-dead either: two effects for the
  // same agent in one decision would carry two `onLanded.episode` values both
  // computed from the SAME pre-tick state, so committing the second would undo
  // the first. The exclusion is real (the watchdog stands down while blocking
  // is pending, and the blocking path only pushes while it is), and this makes
  // it structural instead of relying on it.
  if (blocking.effects.length > 0) return blocking
  return decideStallTick(blocking.next, view)
}
