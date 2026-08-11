/**
 * The notifier — when does an agent get told about its mailbox (013 S1-S3, S6;
 * the transition, task 045 change F).
 *
 * Replaces the idle-gated attention machinery. Everything here is
 * `decide(state, view) → Decision`: no clock, no registry, no projections, no
 * I/O. `now` is data, so "what does this decide at T+5m?" is a number in an
 * array rather than five minutes of wall clock.
 *
 * ── WHAT WENT, AND WHY THE ABSENCE IS THE FEATURE ──
 *
 * THE IDLE GATE. Canon E3, verbatim: "nothing ever asks whether an agent is
 * busy — busy and dead are one case (no ack → keep trying)." The old
 * `decideNudge` gated on `view.idle`, and `AttentionView.idle` existed solely
 * to feed it (042 DEVIATION-1). The field is gone from the view, so the
 * decisions cannot ask, and no runtime check is needed to keep them honest.
 *
 * THE STALL WATCHDOG. It existed for exactly one reason — its own header: a
 * missed Stop hook left the sensei at `idle:false`, suppressing every machine
 * nudge, so the watchdog forced a push that ignored the flag. Delete the gate
 * and the reason is gone: the ladder already pushes unconditionally and never
 * stops. Ruled 2026-08-05: the long-wait survivor is S11's broken-agent
 * escalation, not a second timer — an agent that never acks and never acts is a
 * broken agent, reported to the human on a louder channel. `longWaitMs` left
 * the view with the timer.
 *
 * ── THE TWO REASONS TO PUSH, AND THEY ARE NOT THE SAME REASON ──
 *
 * 1. THRESHOLD (S3). An event at or above the role's minimum priority is pushed
 *    ONCE, to an agent that has not already been shown it. "No retry" means
 *    infra does not re-push what it has already handed over — repetition is
 *    (2)'s job, on (2)'s clock.
 *
 *    ── ANNOUNCEMENT IS BY ANY ROUTE, NOT BY THIS ONE (task 046's audit) ──
 *
 *    A push and a carried inbox line are ONE announcement by two routes, and
 *    either discharges it. This is not a refinement; it is what makes three
 *    canon sentences hold at once, and the transition originally got it wrong:
 *
 *      - S1: an agent making jean calls "learns of new events on its next call
 *        — NO INTERRUPTION". An agent already being told by carriage must not
 *        also be pushed.
 *      - S3: "an event at or above it is pushed once into the agent's input
 *        stream" — so a push exists; "never push, let (2) do it" is not open.
 *      - FOUNDATIONS: "nothing ever asks whether an agent is busy — busy and
 *        dead are one case". So the obvious way to satisfy S1 — don't push to
 *        an active agent — is FORBIDDEN. It is the idle gate (042 DEVIATION-1)
 *        wearing a new name.
 *
 *    Tracking what the agent has been SHOWN is the only rule that satisfies all
 *    three, because it is a fact about the EVENT rather than about the agent's
 *    state — nothing has to ask whether anyone is busy. `announcedThroughId` is
 *    therefore advanced by every carrier, not only by pushes.
 *
 *    The drift entered at test-writing, survived the design pass, a sensei
 *    review and codex, and was found only by a pass organised by SCENARIO PAIR:
 *    no single file contains enough of the canon to see a three-way dependency.
 * 2. QUIET (S2). An agent that has been silent for `nudgeIntervalMs`, MEASURED
 *    FROM ITS LAST ACTIVITY, is told what is waiting. Repeats follow the
 *    backoff ladder. The clock is the agent's silence, not our own last nudge
 *    (042 DEVIATION-2) — which is what makes "an agent already quiet that long
 *    gets it immediately" expressible at all.
 *
 *    ── H2, REPORTED NOT RULED: does notification reset the interval clock? ──
 *
 *    The canon does not say, and this code already answers it — silently, which
 *    is why the answer is written down here rather than left to be rediscovered.
 *    Task 046's audit raised it; the ruling is Leonid's. WHAT THE CODE DOES:
 *
 *      - A notification NEVER resets the interval clock. `quietFor` is
 *        `now - view.lastActivityAt`, and `lastActivityAt` comes from the
 *        registry, which only the AGENT's own traffic touches. So an agent
 *        pushed at T and still silent is still `interval`-overdue at T+1.
 *      - What a push DOES set is `lastNudgeAt`, which gates only the REPEAT arm
 *        (`now - lastNudgeAt >= backoff`). So the first notification is governed
 *        purely by the agent's silence, and repeats by the ladder.
 *      - And an agent that ACTS resets the ladder: `lastActivityAt >
 *        lastNudgeAt` zeroes `nudgeCount`.
 *
 *    Consequence worth stating plainly, because it is the half a ruling might
 *    dislike: for an agent that never acts, the interval decides WHEN the first
 *    notification happens and never again — everything after is the backoff.
 *
 * (2) is the backstop for everything, including every event (1) declined to
 * push. That is what keeps S3's threshold a decision about INTERRUPTING rather
 * than about informing.
 *
 * ── DECIDE → EXECUTE → COMMIT-IFF-LANDED (race guard 4, unchanged) ──
 *
 * A wake the transport refused must not advance the ladder, stamp the ledger,
 * or leave an event claiming the agent was told. So `Decision` stays split:
 * `next` is the transition that happens regardless, `effects[].onLanded` is
 * applied only after a delivery returns true. The shape is the guard — every
 * integration test in the suite runs against a transport that always lands, so
 * a `!landed` check written as a normal branch would never be exercised.
 */

import type { StoredEvent } from '../../es/index.ts'
import type { DeliveredVia } from '../reducers.ts'
import type { Priority } from './priority.ts'

/** One event in a mailbox, as a decision sees it. */
export type PendingEntry = {
  id: number
  priority: Priority
  from: string
}

/**
 * ONE agent's mailbox, as of `now`. Constructed fresh at every decision point —
 * that is S6 (fresh counts), and it is the one property here that was already
 * true before the transition and had to survive it.
 *
 * NOTE WHAT IS NOT HERE: `idle`, and `longWaitMs`. See the header.
 */
export type NotifyView = {
  now: number
  /** WHOSE mailbox. Survives the owner's disconnects (task 040's owner /
   *  deliverable split, which the transition keeps unchanged). */
  agent: string | null
  /** Whether there is a live transport to push to right now. */
  deliverable: boolean
  /** When this agent was last seen doing anything jean-visible. Canon E5:
   *  messaging-system events only — no commits, no file mtimes. */
  lastActivityAt: number
  /** This role's minimum priority for a push (S3). A dial. */
  threshold: Priority
  /** The mailbox: one list, filtered (see mailbox-rules.ts). */
  pending: PendingEntry[]
  /** DIALS. */
  nudgeIntervalMs: number
  nudgeBackoffMs: number[]
}

/** Per-agent bookkeeping. Nothing global — a mailbox is one agent's. */
export type Episode = {
  /** Nudges landed in the current quiet spell. Reset when the agent acts or the
   *  mailbox drains. */
  nudgeCount: number
  lastNudgeAt: number
  /** Highest event id this agent has been TOLD about. Advanced only by a landed
   *  push, which is what makes "pushed once, no retry" and race guard 4 the
   *  same mechanism rather than two. */
  announcedThroughId: number
}

export type NotifyState = { agents: Map<string, Episode> }

export type OnLanded = {
  episode: Episode
  stampAs: DeliveredVia
  pendingCount: number
  /**
   * EXACTLY the events this push carried, by id.
   *
   * Carried explicitly rather than left to the adapter, because the adapter's
   * convenient default was "everything currently pending" — which is only ever
   * right by coincidence. A push carries ONE AGENT'S MAILBOX; the moment a
   * second agent has one, "everything pending" stamps the other agent's events
   * as delivered to this one, and first-delivery-wins makes that permanent.
   * The decision already knows the answer, so it says it.
   */
  ids: number[]
}

export type Effect = { kind: 'deliver'; to: string; text: string; onLanded: OnLanded }

export type Decision = { next: NotifyState; effects: Effect[] }

export function freshEpisode(): Episode {
  return { nudgeCount: 0, lastNudgeAt: 0, announcedThroughId: 0 }
}

export function initialState(): NotifyState {
  return { agents: new Map() }
}

export function episodeOf(state: NotifyState, agent: string): Episode {
  return state.agents.get(agent) ?? freshEpisode()
}

function withEpisode(state: NotifyState, agent: string, episode: Episode): NotifyState {
  const agents = new Map(state.agents)
  agents.set(agent, episode)
  return { agents }
}

const backoffAt = (schedule: number[], count: number): number =>
  schedule[Math.min(Math.max(count, 1) - 1, schedule.length - 1)] as number

const maxId = (entries: PendingEntry[]): number => entries.reduce((hi, e) => (e.id > hi ? e.id : hi), 0)

/**
 * The core decision. One push at most, and the two reasons are tried in order:
 * something new that outranks the threshold, else the quiet clock.
 */
export function decide(state: NotifyState, view: NotifyView): Decision {
  if (!view.agent) return { next: state, effects: [] }
  const agent = view.agent

  // A drained mailbox ends the spell: the next arrival on an empty queue is
  // genuinely new news and must not inherit a deep ladder rung.
  if (view.pending.length === 0) {
    return { next: withEpisode(state, agent, freshEpisode()), effects: [] }
  }

  let episode = episodeOf(state, agent)

  // THE AGENT ACTED SINCE OUR LAST NUDGE, so the spell is over and the ladder
  // starts again. DERIVED rather than requiring the adapter to call `activity`,
  // because S2's clock is `lastActivityAt` and a ladder that disagreed with it
  // would make "measured from its last activity" true of the first notification
  // and false of every repeat.
  if (episode.nudgeCount > 0 && view.lastActivityAt > episode.lastNudgeAt) {
    episode = { ...episode, nudgeCount: 0, lastNudgeAt: 0 }
  }
  const next = withEpisode(state, agent, episode)

  // Nowhere to push. State still advanced above — the mailbox is the truth and
  // notification is best-effort (E1), so an unreachable agent is not "informed".
  if (!view.deliverable) return { next, effects: [] }

  const unannounced = view.pending.filter((e) => e.priority >= view.threshold && e.id > episode.announcedThroughId)
  const quietFor = view.now - view.lastActivityAt
  const quietDue =
    quietFor >= view.nudgeIntervalMs &&
    (episode.nudgeCount === 0 || view.now - episode.lastNudgeAt >= backoffAt(view.nudgeBackoffMs, episode.nudgeCount))

  if (unannounced.length === 0 && !quietDue) return { next, effects: [] }

  return {
    next,
    effects: [
      {
        kind: 'deliver',
        to: agent,
        text: 'pending',
        onLanded: {
          episode: {
            nudgeCount: episode.nudgeCount + 1,
            lastNudgeAt: view.now,
            // EVERYTHING IN THE MAILBOX has now been announced, whichever
            // reason fired: a push carries the whole mailbox, so an event left
            // out of `unannounced` was still in the payload.
            announcedThroughId: Math.max(episode.announcedThroughId, maxId(view.pending)),
          },
          stampAs: 'wake',
          // S6: the queue AS OF EMISSION. Read from the view the decision was
          // handed, never from a stored snapshot — the falling leg (a queue that
          // shrank) is where a cached count is wrong, and it is exactly when the
          // agent is deciding whether it is done.
          pendingCount: view.pending.length,
          // The same snapshot, itemised. Same source, same instant, so the
          // ledger cannot disagree with the count about what was in the payload.
          ids: view.pending.map((e) => e.id),
        },
      },
    ],
  }
}

/** The adapter side. Two effects, per the four-effects ruling. There is no
 *  `markBusy`: nothing asks whether an agent is busy any more. */
export type NotifyExecutor = {
  /** Push. Returns whether the transport accepted it — the answer every commit
   *  hinges on. */
  deliver: (to: string, text: string) => boolean
  /** Append an event. `pendingCount` is the one pinned field (S6). */
  emit: (type: string, data: Record<string, unknown> & { pendingCount?: number }) => void
  /** Record how the events a push CARRIED reached the agent — by id, never "all
   *  pending". See `OnLanded.ids`. */
  stamp: (via: DeliveredVia, ids: number[]) => void
}

export type Notifier = {
  /** An event has just been applied to the projections. */
  onEvent: (event: StoredEvent, view: NotifyView) => void
  /** A timer tick. Both intervals call this and nothing else. */
  tick: (view: NotifyView) => void
  /**
   * One decision per mailbox, over EVERY driveable agent's view — the
   * delivery-unification entry point (ruled 2026-08-11: "the mailbox is for
   * everyone … notifications work the same for any agent"). The adapter used
   * to build one view (the sensei's) and drive `tick`/`onEvent` with it, which
   * left `thresholdFor('worker')` deciding nothing in production; now it
   * builds a view per dojo agent and hands them all here. Pure fan-out over
   * the same `run` — an agent's decision neither sees nor depends on the
   * others', which is what keeps this a loop and not a policy.
   */
  sweep: (views: NotifyView[]) => void
  /** The agent did something jean-visible. Replaces the old turn-end entry
   *  point, and the rename is the design change: that one asked "are you idle
   *  yet?", this one reports activity. It never gates a push on busyness. */
  activity: (view: NotifyView) => void
  /**
   * A CARRIER handed this agent its mailbox — the piggyback line on a response
   * it asked for, or a fetch it made. Discharges announcement for everything
   * shown, exactly as a landed push does, so the agent is not told twice and
   * S1's "no interruption" costs no busy check (see the header).
   *
   * Takes the ids SHOWN rather than a view: a carrier knows precisely what it
   * put on the wire, and re-deriving it here would reintroduce the gap between
   * what was announced and what was carried.
   */
  carried: (agent: string, ids: number[]) => void
  /** Called ONCE after catch-up, never during it — with every driveable
   *  agent's view, since boot state is per-mailbox like everything else. */
  hydrate: (views: NotifyView[]) => void
  readonly state: NotifyState
}

export function createNotifier(
  exec: NotifyExecutor,
  render: (view: NotifyView) => string = () => 'Events pending.',
): Notifier {
  let state = initialState()

  function run(view: NotifyView): void {
    const decision = decide(state, view)
    state = decision.next
    for (const effect of decision.effects) {
      const landed = exec.deliver(effect.to, render(view))
      // ── RACE GUARD 4 ── Nothing that didn't happen gets recorded. A push the
      // transport refused (a dead socket whose close handler hasn't run) must
      // not advance the ladder, mark anything announced, stamp the ledger, or
      // leave an event claiming the agent was told. Leaving
      // `announcedThroughId` where it was is precisely what makes the next tick
      // retry immediately rather than after a ladder rung.
      if (!landed) continue
      state = { agents: new Map(state.agents).set(effect.to, effect.onLanded.episode) }
      exec.stamp(effect.onLanded.stampAs, effect.onLanded.ids)
      exec.emit('nudge', { pendingCount: effect.onLanded.pendingCount })
    }
  }

  return {
    onEvent: (_event, view) => run(view),
    tick: (view) => run(view),
    sweep: (views) => {
      for (const view of views) run(view)
    },
    activity: (view) => run(view),
    carried(agent, ids) {
      if (ids.length === 0) return
      const episode = episodeOf(state, agent)
      const high = ids.reduce((hi, id) => (id > hi ? id : hi), 0)
      // ONLY FORWARD. A carrier that showed an older slice than a previous one
      // (a filtered read, a subset fetch) must not un-announce anything.
      if (high <= episode.announcedThroughId) return
      state = withEpisode(state, agent, { ...episode, announcedThroughId: high })
    },
    hydrate(views) {
      // Counters at zero. An empty mailbox map at boot is the correct state:
      // keys appear as agents' events do, and inventing one for an agent
      // nothing has happened to would give it a ladder position it never earned.
      state = initialState()
      for (const view of views) {
        if (view.agent && view.pending.length > 0) state = withEpisode(state, view.agent, freshEpisode())
      }
    },
    get state() {
      return state
    },
  }
}
