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
 * ── STATE SHAPE: PER-AGENT MAILBOXES (protocol build commit 1, task 040) ──
 *
 * Everything is keyed by agent, including `pendingSince` — which the previous
 * version of this header promised would move here "when phase 5 gives every
 * agent its own mailbox". This is that commit. Sensei is still the only agent
 * anything fires for; worker keys are structurally reachable and inert.
 *
 * ── OWNER IS NOT DELIVERABLE, AND THE DIFFERENCE IS LOAD-BEARING ──
 *
 * `view.agent` is WHOSE MAILBOX this is. `view.deliverable` is WHETHER THERE IS
 * A LIVE TRANSPORT to push to. The pre-reshape view conflated them (`agent` was
 * `findSensei()?.name ?? null`), which was harmless while the stall clock was
 * global and fatal the moment it became per-agent:
 *
 * Measured on the pre-reshape core — an arrival with NO sensei connected armed
 * the global clock (`pendingSince = 0`) and created ZERO episode keys, so a
 * sensei connecting ten minutes later got the watchdog IMMEDIATELY, its window
 * measured from the arrival. Key that clock on "the connected sensei" and the
 * window has nothing to arm: it would silently restart from the connect.
 *
 * No test in the suite could see that. Both stall-watchdog cases connect the
 * sensei before the event, and the sensei-absent recovery case uses a human
 * message, which self-heals through the blocking tick rather than the watchdog.
 * It is pinned now — see attention.test.ts, "arrival while disconnected".
 *
 * So: state bookkeeping keys on the OWNER (which survives disconnects); pushes
 * gate on DELIVERABLE. The owner is resolved by the adapter as the connected
 * sensei, else the most-recently-registered persisted sensei name.
 *
 * ACCEPTED CORNER (sanctioned 2026-08-04, task 040 Q1): on a dojo where no
 * sensei has EVER registered there is no name to own the mailbox, so `agent` is
 * null and nothing is armed until one registers. Pinned rather than papered
 * over — see attention.test.ts, "never-registered dojo".
 *
 * ── THE SENSEI'S MAILBOX IS THE WHOLE QUEUE ──
 *
 * Ruled on the merits (task 040 Q2): the orchestrator's "everything it needs to
 * know" IS the whole pending queue, so worker mailboxes OVERLAP the sensei's
 * rather than partitioning it. A partition would mean the sensei stops seeing
 * worker-owned events — a different system, and not foreclosed, but not this.
 * The slicing lives in the adapter's view construction; nothing here knows.
 *
 * ACCEPTED DELTA (D4, ruled 2026-08-04): keying episodes by agent name means a
 * sensei that reconnects under a DIFFERENT name starts a fresh episode, where
 * the old file-scope globals were name-agnostic. The reset lands in
 * `blockingWakeCount: 0` — the "unstarted episode" state the blocking tick
 * self-heals — so the cost is at most one extra wake within one tick.
 */

import type { StoredEvent } from '../../es/index.ts'
import { type Inbox, renderInboxWake } from '../inbox.ts'
import type { DeliveredVia, NudgeData } from '../reducers.ts'

/** One agent's mailbox bookkeeping. Sensei is the only populated key today. */
export type EpisodeState = {
  /** Wakes fired in the current blocking episode (resets when blocking drains). */
  blockingWakeCount: number
  lastBlockingWakeAt: number
  nudgeCount: number
  lastNudgeAt: number
  /** Highest pending event id this agent has already been told about. */
  maxNudgedPendingId: number
  /** Stall clock for THIS MAILBOX: when its queue last went non-empty, or when
   *  the last push to it fired, whichever is later. Null while it is empty.
   *  Armed by arrivals regardless of whether the owner is connected — see the
   *  header on owner-vs-deliverable. */
  pendingSince: number | null
}

export type AttentionState = {
  agents: Map<string, EpisodeState>
}

/** What the decisions are allowed to see of the world — ONE agent's mailbox,
 *  constructed fresh by the adapter at every decision point. Never cached,
 *  which is what keeps the delivered inbox and the recorded `pendingCount` in
 *  agreement. */
export type AttentionView = {
  now: number
  /** WHOSE MAILBOX this is, and the key into `state.agents`. Survives the
   *  owner's disconnects. Null only on a dojo where no sensei has ever
   *  registered — see the accepted corner in the header. */
  agent: string | null
  /** WHETHER THERE IS A LIVE TRANSPORT to push to right now. Every push gates
   *  on this; no state bookkeeping does. */
  deliverable: boolean
  /** The owner's idle flag. Only the machine-nudge path gates on it, and the
   *  adapter reports `false` whenever the mailbox is not deliverable — so
   *  `idle` implies `deliverable`, which is why the nudge path needs no
   *  separate check. Pinned in attention.test.ts. */
  idle: boolean
  /** Ids in THIS MAILBOX, and the blocking (human-waiting) subset of them. */
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
  return {
    blockingWakeCount: 0,
    lastBlockingWakeAt: 0,
    nudgeCount: 0,
    lastNudgeAt: 0,
    maxNudgedPendingId: 0,
    pendingSince: null,
  }
}

export function initialState(): AttentionState {
  return { agents: new Map() }
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

/** Apply `fn` to ONE mailbox's episode. Replaces the pre-reshape `mapEpisodes`,
 *  which walked every key because the queue was global: a queue-driven reset is
 *  now scoped to the mailbox that drained, which is the mailbox the view
 *  describes. Identical while the sensei is the only populated key. */
function updateEpisode(state: AttentionState, agent: string, fn: (e: EpisodeState) => EpisodeState): AttentionState {
  return withEpisode(state, agent, fn(episodeOf(state, agent)))
}

const backoffAt = (schedule: number[], count: number): number =>
  schedule[Math.min(count - 1, schedule.length - 1)] as number

const maxId = (ids: number[]): number => ids.reduce((hi, id) => (id > hi ? id : hi), 0)

/** The BLOCKING wake — a human is waiting, so it ignores the idle flag
 *  entirely. Null when there is nobody to deliver to; the piggyback and a
 *  future connect carry the news instead. */
function blockingWake(state: AttentionState, view: AttentionView): Effect | null {
  if (!view.agent || !view.deliverable) return null
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
        // Re-arms this mailbox's stall clock — a landed push counts as activity.
        pendingSince: view.now,
      },
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
    if (!view.agent) return { next: state, effects: [] }
    return { next: updateEpisode(state, view.agent, (e) => ({ ...e, blockingWakeCount: 0 })), effects: [] }
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
  //
  // `deliverable` is checked EXPLICITLY rather than leaning on the adapter's
  // `idle ⇒ deliverable` construction. The coupling holds today, but a view
  // built by hand could violate it, and the failure would be a push at a
  // mailbox with no transport. Cheap to state, so stated.
  if (!view.agent || !view.deliverable || !view.idle) return { next: state, effects: [] }
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
            pendingSince: view.now,
          },
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
  if (!view.agent) return { next: state, effects: [] } // no mailbox, no clock
  const pendingSince = episodeOf(state, view.agent).pendingSince
  if (pendingSince === null) return { next: state, effects: [] }
  if (view.now - pendingSince < view.stallAfterMs) return { next: state, effects: [] }
  // While ANY blocking event is pending, the blocking path owns delivery and
  // the watchdog stands down — its re-wakes ARE the delivery attempts, and at
  // the backoff cap the two clocks run at identical periods and would
  // double-fire seconds apart.
  //
  // The condition is "blocking is pending", NOT "a blocking episode has fired":
  // since guard 4 stopped failed deliveries from advancing blockingWakeCount,
  // an unstarted episode sits at count 0, which a `count > 0` guard would miss.
  if (view.blockingPendingIds.length > 0) return { next: state, effects: [] }
  // Nobody to wake — the clock stays armed for when one connects. This is the
  // line the owner/deliverable split preserves: pre-reshape it read `!view.agent`
  // and meant "no sensei connected"; the mailbox now outlives the connection.
  if (!view.deliverable) return { next: state, effects: [] }

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
          // The watchdog advances no counters — it only re-arms the window, so
          // a wedged owner gets one reminder per window rather than a flood.
          episode: { ...episodeOf(state, view.agent), pendingSince: view.now },
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
  // No mailbox owner yet (a dojo where no sensei has ever registered) — nothing
  // to key any of this on. The accepted corner; see the header.
  if (!view.agent) return { next: state, effects: [] }
  const agent = view.agent

  // Stall clock: starts when this mailbox becomes non-empty, clears when it
  // drains. A drained mailbox also ends its machine-nudge episode — the next
  // arrival on an empty queue is genuinely new news and nudges immediately.
  //
  // NOTE the arming is NOT gated on `deliverable`: an arrival during an owner's
  // outage still starts the clock, so the watchdog measures from the arrival
  // rather than from the reconnect. That is the pre-reshape behaviour the
  // owner/deliverable split exists to preserve.
  let next: AttentionState = updateEpisode(state, agent, (e) =>
    view.pendingIds.length === 0
      ? { ...e, nudgeCount: 0, lastNudgeAt: 0, maxNudgedPendingId: 0, pendingSince: null }
      : { ...e, pendingSince: e.pendingSince ?? view.now },
  )

  // The blocking episode ends the moment blocking drains, here rather than only
  // on the tick, so a new human message right after a drain gets its immediate
  // wake instead of tripping guard 3's stale-episode check.
  if (view.blockingPendingIds.length === 0) {
    next = updateEpisode(next, agent, (e) => ({ ...e, blockingWakeCount: 0 }))
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
