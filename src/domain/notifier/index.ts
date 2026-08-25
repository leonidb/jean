/**
 * The notifier — announcement liveness (spec P8; contract
 * `contracts/notifier.ts`, task D8).
 *
 * ── THE DECISION PROPOSES; THE OUTCOME DISPOSES ──
 *
 * `decide` never advances an episode. It records the announcement it asked for
 * as IN-FLIGHT — with the instant it was decided — and only `applyOutcome`
 * turns that into a discharge. Everything P8 needs falls out of that split:
 *
 *   a REFUSED delivery clears the in-flight WITHOUT discharging, so the agent
 *   is due again at the next eligible tick. It was never told. Advancing on
 *   the attempt rather than the arrival is precisely the failure P8 exists to
 *   prevent — a ladder that goes quiet because the system counted a wake
 *   nobody received.
 *
 *   CARRIAGE discharges the same way an accepted push does, because the agent
 *   did see its inbox — but discharging is not terminating. The episode keeps
 *   its ladder and repeats on schedule while the mail stays unhandled. Told is
 *   not done (P7: seeing is not acking).
 *
 * The split is also forced, and the forcing is worth stating: `applyOutcome`
 * takes no clock. If the discharge instant were not captured at decide time
 * there would be nothing to measure the next rung from, and the ladder would
 * have to invent a time — which is how a cadence quietly stops matching its
 * configuration.
 *
 * ── ONE LADDER, ONE MECHANISM, AND WHAT DECIDES INTERRUPTS ──
 *
 * There is no separate "urgent" path (E6). Priority decides only WHETHER the
 * quiet-clock is waited out: mail from a human announces on arrival; machine
 * mail waits for `nudgeIntervalMs` from the agent's last act. After the first
 * announcement both follow the same `backoffMs` ladder. Nothing anywhere asks
 * whether the agent is busy — busy and unreachable are one case, and the
 * answer to both is "tell it again".
 *
 * ── WHY THE LADDER INDEXES ON DISCHARGES, NOT ON TICKS ──
 *
 * `repeats` counts announcements that actually landed, so the next gap is
 * `backoffMs[min(repeats - 1, last)]`. Counting decisions instead would let a
 * busy tick loop walk the ladder to its cap without the agent hearing
 * anything, and the cap is the one place P8's "never shrinks" and "bounded
 * above" meet: past the end, the last rung repeats forever. It repeats — it
 * does not stop, which is clause 4.
 *
 * ── ACTIVITY RESETS THE EPISODE, NOT JUST THE CLOCK ──
 *
 * `observeEvent` with an actor drops that agent's episode entirely. The agent
 * acted, so whatever it was told before is no longer the thing being repeated
 * — and the next announcement is a FIRST announcement again, governed by the
 * quiet clock from the act rather than by a rung measured from an
 * announcement the agent has since acted past.
 *
 * ── AND SO DOES A NEW OCCUPANT (ruled, task 140) ──
 *
 * An episode belongs to a SESSION, not a name. A `register` event ends it
 * the same way an act does — the whole entry goes — because the process that
 * was told is gone and the one now listening was told nothing. The two
 * resets move the clock in OPPOSITE directions, and neither direction is
 * decided here: after an act the composer's `lastActivityAt` is now, so the
 * first announcement waits the quiet interval; after a register it is
 * absent, so it comes at once. Register is still not activity (H7): it does
 * not earn a quiet interval, it forfeits the inherited one. Without this, a
 * seat mid-ladder that restarts waits its predecessor's rung — up to the
 * ladder's cap — with mail it has never heard of (ruled: a restart must
 * start a new back-off clock).
 *
 * WHY THIS IS EVENT-DRIVEN and not a `dueAt` clause — the rejected
 * alternative, because it looks right: "absent `lastActivityAt` while
 * mid-ladder → immediate". A session that registered on a fresh process and
 * has never acted is legitimately absent AND mid-ladder (told at once, now
 * on its rungs); reading absence as "immediate" there re-fires every tick,
 * which is the 241-announcements-an-hour defect D8 was built to end.
 * Absence of activity says nothing about whether THIS occupant was told.
 * Only the register event carries "new occupant", so the reset lives on the
 * event. The conformance suite pins the guard as well as the rule.
 *
 * ── DECIDE DOES NOT SUPPRESS ON AN IN-FLIGHT, AND THAT IS THE CHOICE ──
 *
 * Calling `decide` twice before reporting an outcome emits a second
 * announcement. Codex raised it as a defect; through a lawful shell the case
 * is unreachable — executor law (a) says the shell reports before the next
 * decide reads state — but the two ways to be wrong here are not symmetric,
 * so it is kept, and RULED into the contract at task 098's round.
 * Suppressing while in-flight means a shell that ever drops an outcome
 * silences that agent's ladder FOREVER, which is P8 clause 4 violated in the
 * exact manner the clause exists to forbid. Not suppressing means a
 * misbehaving shell announces twice: noisy, visible, recoverable. Silence is
 * the failure this module is built to prevent, so the noisy side is where the
 * uncertainty is put. A second decide also overwrites the in-flight instant,
 * which is right — the later announcement is the one the agent might have
 * heard, and the ladder should measure from it.
 *
 * ── PER AGENT, INDEPENDENTLY ──
 *
 * The state is a map keyed by name and every rule reads one entry. An outcome
 * naming an agent the state has never seen is a structural no-op: unassumed
 * input, and there is nothing it could correctly do.
 *
 * What this file cannot enforce, and what does: every P8 clause, the
 * refused-wake rule, the carriage rule and per-agent independence are held by
 * `notifier.conformance.test.ts`.
 */

import type {
  AgentNotifyFacts,
  AnnounceEffect,
  ConfigRefusal,
  NotifierConfig,
  NotifierContract,
  NotifierDecision,
  NotifierState,
  NotifierView,
  NotifyOutcome,
} from '../contracts/notifier.ts'
import type { AgentName, RegisterData, StoredEvent } from '../contracts/vocabulary.ts'

// ── State ────────────────────────────────────────────────────────

type Episode = {
  /** The ids this agent has been told about in this episode. Used only to
   *  recognise NEW arrivals — a blocking one interrupts the ladder. */
  readonly announced: ReadonlySet<number>
  /** When the last announcement was DISCHARGED. Undefined = the episode has
   *  never landed one, so the next is a FIRST announcement. */
  readonly lastAnnouncedAt: number | undefined
  /** Announcements discharged this episode — the ladder index. */
  readonly repeats: number
  /** Decided, not yet reported. Carries the instant so the outcome can
   *  discharge at the time the announcement was made — see the header. */
  readonly inFlight: { readonly at: number; readonly ids: readonly number[] } | undefined
}

type Episodes = ReadonlyMap<AgentName, Episode>

const FRESH: Episode = { announced: new Set(), lastAnnouncedAt: undefined, repeats: 0, inFlight: undefined }

function episodes(state: NotifierState): Episodes {
  return state as unknown as Episodes
}
function seal(next: Episodes): NotifierState {
  return next as unknown as NotifierState
}

function withEpisode(current: Episodes, agent: AgentName, episode: Episode): Episodes {
  const next = new Map(current)
  next.set(agent, episode)
  return next
}

// ── Configuration ────────────────────────────────────────────────

const validateConfig = (config: NotifierConfig): { ok: true } | { ok: false; refusal: ConfigRefusal } => {
  // A shrinking ladder violates P8 silently and forever — the repeats get
  // faster, the agent gets louder, and nothing ever reports it. Refusing at
  // composition time is the only place this can be caught before it ships.
  if (config.backoffMs.length === 0) return { ok: false, refusal: { kind: 'empty-ladder' } }
  // FINITE, not merely positive. `Infinity` passes every `> 0` test and is the
  // worst value here: an infinite interval never comes due, so it terminates
  // the ladder silently — the P8 violation this validator exists to catch,
  // arriving through the one check a positivity test cannot make (codex pass,
  // task 098). NaN fails `isFinite` too, and would otherwise make every
  // comparison false — including the one guard that withholds an
  // announcement, so it breaks the cadence in the LOUD direction (R13).
  if (!Number.isFinite(config.nudgeIntervalMs) || config.nudgeIntervalMs <= 0) {
    return { ok: false, refusal: { kind: 'non-positive-interval' } }
  }
  for (let i = 0; i < config.backoffMs.length; i++) {
    const rung = config.backoffMs[i] as number
    // A zero or negative rung is an immediate repeat — a spin, not a ladder.
    if (!Number.isFinite(rung) || rung <= 0) return { ok: false, refusal: { kind: 'non-positive-interval' } }
    const previous = config.backoffMs[i - 1]
    if (previous !== undefined && rung < previous) return { ok: false, refusal: { kind: 'shrinking-ladder', at: i } }
  }
  return { ok: true }
}

// ── When an agent is due ─────────────────────────────────────────

/**
 * The instant this agent's next announcement becomes due, or undefined when
 * there is nothing to announce. One function, so "when do we tell it" has one
 * answer and the two clauses cannot drift apart.
 */
function dueAt(episode: Episode, facts: AgentNotifyFacts, config: NotifierConfig): number | undefined {
  // An empty mailbox announces nothing, ever. Not "later" — nothing.
  if (facts.pendingIds.length === 0) return undefined

  const unannounced = facts.pendingIds.some((id) => !episode.announced.has(id))

  // PRIORITY INTERRUPTS, and only on something NEW. A human is waiting, so the
  // quiet clock and the ladder both yield — but only for mail this episode has
  // not already told the agent about, or a blocking mailbox would re-announce
  // on every tick forever.
  if (facts.hasBlocking && unannounced) return Number.NEGATIVE_INFINITY

  if (episode.lastAnnouncedAt === undefined) {
    // FIRST ANNOUNCEMENT: the quiet clock, measured from the agent's own last
    // act. No activity ever observed reads MAXIMALLY QUIET — a fresh session
    // with waiting mail is told at once, which is the ruled reconnect
    // behaviour and the reason this is `-Infinity` rather than `now`.
    const since = facts.lastActivityAt ?? Number.NEGATIVE_INFINITY
    return since + config.nudgeIntervalMs
  }

  // REPEAT: the ladder, indexed by discharges. Past the end the last rung
  // repeats — bounded above, and never terminating (clauses 2 and 4 are the
  // same line of code).
  const rung = config.backoffMs[Math.min(episode.repeats - 1, config.backoffMs.length - 1)] as number
  return episode.lastAnnouncedAt + rung
}

// ── The contract ─────────────────────────────────────────────────

export const notifier: NotifierContract = {
  initial: () => seal(new Map()),

  validateConfig,

  decide(state: NotifierState, view: NotifierView, config: NotifierConfig): NotifierDecision {
    let next = episodes(state)
    const effects: AnnounceEffect[] = []

    for (const facts of view.agents) {
      const episode = next.get(facts.name) ?? FRESH
      const due = dueAt(episode, facts, config)
      if (due === undefined || view.now < due) continue

      effects.push({
        kind: 'announce',
        to: facts.name,
        // The whole mailbox, not just the new part: an announcement says what
        // is waiting, and a count that omitted already-told mail would
        // understate the queue the agent has to work through.
        ids: [...facts.pendingIds],
        pendingCount: facts.pendingIds.length,
        hasBlocking: facts.hasBlocking,
      })
      // IN FLIGHT, NOT DISCHARGED. Nothing about the ladder moves here.
      next = withEpisode(next, facts.name, { ...episode, inFlight: { at: view.now, ids: [...facts.pendingIds] } })
    }

    return { next: seal(next), effects }
  },

  applyOutcome(state: NotifierState, outcome: NotifyOutcome): NotifierState {
    const current = episodes(state)
    const episode = current.get(outcome.agent)
    // An agent the state has never seen: a structural no-op. There is no
    // episode to advance and nothing that could be correctly guessed.
    if (episode === undefined) return state

    if (outcome.kind === 'announced' && !outcome.accepted) {
      // REFUSED. Clear the in-flight and change NOTHING else: no discharge, no
      // rung, no announced ids. The agent was never told, so as far as P8 is
      // concerned the announcement did not happen.
      return seal(withEpisode(current, outcome.agent, { ...episode, inFlight: undefined }))
    }

    // ACCEPTED or CARRIED — the agent has been told, one way or the other.
    const announced = new Set(episode.announced)
    for (const id of outcome.ids) announced.add(id)

    // THE IN-FLIGHT IS WHAT MAKES THIS A DISCHARGE. Without one there is no
    // announcement being reported on: the outcome is a duplicate, or carriage
    // the agent performed with nothing pending. Recording the ids is right in
    // both cases — the agent did see them, and the priority interrupt must not
    // re-fire for mail it has read — but ADVANCING is not: an earlier version
    // incremented `repeats` regardless, so a duplicated report skipped a rung
    // and the agent waited 300s where P8's ladder said 120s (codex pass, task
    // 098). There is also no honest instant to move the clock to; `applyOutcome`
    // has no clock, which is precisely why the in-flight carries one.
    if (episode.inFlight === undefined) {
      return seal(withEpisode(current, outcome.agent, { ...episode, announced }))
    }

    // Discharge at the instant the announcement was DECIDED — the only time
    // either path has.
    return seal(
      withEpisode(current, outcome.agent, {
        announced,
        lastAnnouncedAt: episode.inFlight.at,
        repeats: episode.repeats + 1,
        inFlight: undefined,
      }),
    )
  },

  observeEvent(state: NotifierState, event: StoredEvent, actor: AgentName | undefined): NotifierState {
    // AN EPISODE ENDS TWO WAYS: the occupant acts, or a new occupant takes
    // the seat. Only the agent's OWN act is the first — machine writes about
    // an agent are not the agent acting (the agents contract's activity
    // definition, and the reason this takes the actor rather than reading
    // the event). The second is the `register` event itself (ruled, task
    // 140), read through the vocabulary's own shape: it names the seat, and
    // it is the ONLY fact that says "new occupant" — see the header for why
    // absence of activity cannot stand in for it.
    const ended = actor ?? newOccupantOf(event)
    if (ended === undefined) return state
    const current = episodes(state)
    if (!current.has(ended)) return state
    // THE WHOLE EPISODE GOES, not just the clock — in both cases, and for the
    // same reason: whatever was told before was told to someone who is no
    // longer the one listening. The agent acted past it, or the process that
    // heard it is gone. The next announcement is a FIRST announcement again;
    // WHEN it comes is the agents-side fact's to say (the quiet clock from an
    // act; at once for a session that has none). Dropping the entry rather
    // than resetting its fields is the same thing said in one line, and
    // leaves no field to forget.
    const next = new Map(current)
    next.delete(ended)
    return seal(next)
  },

  greetOnRegistration(fact) {
    // THE EMPTY MAILBOX IS THE WHOLE MECHANISM, not a guard on one. A greet
    // is minted only in the mail's absence, so the two outcomes are one
    // evaluation with two arms rather than two things that could both fire —
    // and everything that used to be handled falls out instead: an agent can
    // never receive both, there is nothing to race, nothing to time, and no
    // second push path to reconcile. It is also what makes the greet
    // self-limiting: an unacked greet IS mail, so a reconnect sees a
    // non-empty mailbox and mints nothing. No agent can ever hold two.
    if (fact.pendingIds.length > 0) return undefined
    // SENSEI-ONLY IS A DECISION, NOT A DERIVATION (ruled 2026-08-25: a
    // judgement call — greeting workers was a live option). Greeting workers
    // is coherent and was rejected, not ruled out. THE REASON: a worker
    // connecting with nothing waiting is supposed to sit idle, and saying
    // otherwise is the orchestrator's job rather than infra's.
    //
    // The earlier wording here argued from "a worker's register event is the
    // sensei's mail". That is FALSE on main — `register` resolves to nobody
    // (task 139) — and it was inherited from a comment describing code the
    // teardown deleted. The decision survived its support dying; the prose
    // now records the choice rather than a proof.
    if (fact.role !== 'sensei') return undefined
    // NO PROSE. The text is the adapter's to render, exactly as with an
    // announce effect — the core does not return display strings it does
    // not have to.
    return { kind: 'greet', to: fact.name }
  },
}

/** The seat a `register` event fills, or nothing for any other event — and
 *  nothing for a register too malformed to name one, which the agents fold
 *  also folds to nothing. */
function newOccupantOf(event: StoredEvent): AgentName | undefined {
  if (event.type !== 'register') return undefined
  const name = (event.data as Partial<RegisterData> | undefined)?.agent
  return typeof name === 'string' && name.length > 0 ? name : undefined
}
