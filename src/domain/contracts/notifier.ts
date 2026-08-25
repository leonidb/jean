/**
 * The notifier contract — announcement liveness as a decide→effects unit
 * (spec P8, §1 "Announcement"; design §3 §6 §11; canon S1/S2/E6 as the
 * ruled cadence model).
 *
 * ── WHAT ANNOUNCEMENT IS ──
 *
 * The claim "you have mail", tracked per agent, itself history (spec §1).
 * Distinct from delivery of the events: the mailbox holds the mail; the
 * notifier's whole job is P8 —
 *
 *   an agent with unhandled mail is told, and told again until it acts:
 *   the first announcement follows the mail within a bounded interval;
 *   repeat gaps follow a ladder that never shrinks and is bounded above;
 *   any activity by the agent resets the ladder;
 *   the ladder never terminates while mail is unhandled.
 *
 * The bounds are NAMED CONFIGURATION (injected — never numbers in a
 * contract). Nothing asks whether an agent is busy: busy and unreachable
 * are one case. And deliberately NOT promised: that any single announcement
 * becomes a turn — a session can miss any one wake; the obligation is
 * repetition until the agent acts.
 *
 * ── THE CADENCE MODEL (E6, one mechanism) ──
 *
 * One path, one ladder; PRIORITY decides whether an arrival interrupts:
 * mail whose sender is a human (the blocking class, per the mailbox's
 * classification facts) announces IMMEDIATELY on arrival; machine mail
 * waits for the agent's quiet-clock (`nudgeIntervalMs` from its last
 * activity). Repeats follow `backoffMs` while the mailbox stays unhandled.
 * Per-agent, independent: one agent's ladder never advances another's.
 *
 * THE MIRROR (pinned at D8's round, task 098): the interrupt is per NEW
 * arrival — mail the episode has not yet told the agent about. Once told,
 * blocking mail follows the same ladder as everything else. P8's four
 * clauses all guard against going SILENT; this is the same obligation from
 * the other side — never going LOUD: a blocking mailbox held across the
 * tick grid announces at its rungs, not at every tick (D8 measured the
 * defect at 241 announcements per hour against 8 correct).
 *
 * ── DECIDE → EFFECTS, WITH OUTCOMES AS DATA ──
 *
 * `decide(state, view)` is pure: it returns the next state and announce
 * INTENTS. The shell performs each intent and reports what happened through
 * `applyOutcome` — also pure. Feedback must be data because P8's ladder
 * depends on it: a REFUSED delivery must not advance the episode (the
 * agent was never told; advancing would silence the ladder — the exact
 * failure P8 exists to prevent), and CARRIAGE (the agent saw its inbox by
 * fetch or piggyback — the adapter's knowledge) discharges the CURRENT
 * announcement obligation without terminating the ladder: still-unhandled
 * mail re-announces on the backoff schedule. Seeing is not acking (P7);
 * being told is not being done.
 *
 * A DISCHARGE REQUIRES THE IN-FLIGHT IT REPORTS ON (codex, task 098): an
 * outcome arriving with no announcement in flight — a duplicated report, a
 * stray carriage — records its ids as seen (the agent did see them; the
 * interrupt must not re-fire for read mail) but advances neither the rung
 * nor the clock. There is no honest instant to move them to, and the
 * defect this rule was extracted from advanced the ladder on a duplicate:
 * the agent waited 300s where the rung said 120s.
 *
 * RULED (task 098, confirming D8's default): `decide` does NOT suppress
 * while an announcement is in flight. Through a lawful shell the case is
 * unreachable — executor law (a) reports every outcome before the next
 * decide reads state — so this law chooses the FAILURE MODE of an unlawful
 * one, and the two ways to be wrong are not symmetric: suppression means a
 * shell that ever drops an outcome silences that agent's ladder forever
 * (clause 4's exact failure); emission means a misbehaving shell is noisy,
 * visible, recoverable. Silence is the failure this module exists to
 * prevent, so the uncertainty goes on the noisy side. The second decide
 * re-times the in-flight — the later announcement is the one the agent may
 * have heard, and the ladder measures from it.
 *
 * ── THE EXECUTOR IS A UNIT (design §6 bag-or-unit; §11's residue) ──
 *
 * `NotifierExecutor` members are NOT independent, so its contract states
 * the pair-laws a conformance suite holds:
 *   (a) EFFECT ORDER — one decision's effects are performed in the order
 *       listed, completely, before anything else reads notifier state;
 *   (b) STAMP RIDES ITS DELIVER — the delivery evidence recorded for an
 *       announcement is the evidence OF THAT deliver, never batched apart
 *       from it (the dissolved weld-1's residue, stated as law);
 *   (c) NO INTERLEAVING — one decision's effects never interleave with
 *       another decision's reads (the dissolved weld-2's residue: what was
 *       "announcement is synchronous inside record()" by adjacency is this
 *       law by statement).
 * The laws are STATED here; where they are HELD is split honestly (codex
 * pass, 095): (a) is demonstrated now against the fixture's capturing
 * executor (in the fixture's own always-green suite); (b) and (c) are properties of the SHELL's
 * sequencing and are held by the executor conformance suite that ships
 * WITH the executor implementations — an E-side obligation, recorded in
 * the tracker (R11), not silently deferred.
 *
 * What the types cannot enforce, and what does: every P8 clause, the
 * refused-wake rule, the carriage rule, and per-agent independence are held
 * by `notifier.conformance.test.ts`, aimed at the two clusters — episode
 * state is indirectly visible (nothing returns it; it shows only in when
 * announcements happen), and the unassumed inputs (agents with no
 * activity ever, empty mailboxes, unknown agents in outcomes) are pinned.
 */

import type { AgentName, AgentRole, DeliveredVia, StoredEvent } from './vocabulary.ts'

/** Opaque — episodes per agent: what has been announced through, where on
 *  the ladder the agent stands. Indirectly-visible state by design. */
export type NotifierState = { readonly __notifierState: true }

/** The facts one decision consumes — composed by the shell from the
 *  mailbox (membership + classification) and agents (activity) contracts;
 *  facts are the composer's guarantee (R10). */
export type AgentNotifyFacts = {
  name: AgentName
  /** The agent's mailbox, ids in log order — from mailboxOf, nothing else. */
  pendingIds: readonly number[]
  /** Does the mailbox hold blocking mail (a human is waiting)? From the
   *  mailbox's classification over the SAME facts the views use. */
  hasBlocking: boolean
  /** Epoch ms of the agent's last own act IN ITS CURRENT SESSION; absent =
   *  never observed, which reads MAXIMALLY QUIET (a fresh session with
   *  waiting mail is announced at once — the ruled reconnect behaviour).
   *  A NEW SESSION STARTS ABSENT (ruled, task 140): the composer drops the
   *  seat's recorded act on register rather than handing the new session
   *  its predecessor's clock. Registering is not an act (H7), and not
   *  inheriting one is not acting either — an act moves this to NOW, a
   *  register moves it to absent; the two reset in opposite directions. */
  lastActivityAt?: number
}

export type NotifierView = {
  now: number
  agents: readonly AgentNotifyFacts[]
}

/** Named configuration (P8: bounds are configuration, not numbers). The
 *  conformance suite asserts the LAWS over arbitrary valid config — a
 *  ladder that shrinks is invalid input, refused by validateConfig. */
export type NotifierConfig = {
  /** S2's quiet-clock: how long after its last activity an agent with
   *  machine mail is first told. */
  nudgeIntervalMs: number
  /** The repeat ladder — non-empty, NON-SHRINKING (each entry >= the one
   *  before), finite; the last entry repeats forever (bounded above). */
  backoffMs: readonly number[]
}

export type AnnounceEffect = {
  kind: 'announce'
  to: AgentName
  /** Exactly the ids this announcement tells the agent about. */
  ids: readonly number[]
  /** The count-bearing summary line's inputs, not prose — the adapter
   *  renders (core never returns display strings it doesn't have to). */
  pendingCount: number
  hasBlocking: boolean
}

// ── THE GREET: THE ZERO CASE OF THE ANNOUNCEMENT (task 133) ──────
//
// P8 says an agent with unhandled mail is told, and told again until it
// acts. It says nothing about an agent with NO mail — and for most seats
// that silence is correct. For one seat it is a failure to start.
//
// THE CONDITION, and it is measured rather than supposed: a seat whose
// work is SELF-DIRECTED needs a turn in order to start looking, and an
// empty mailbox gives it none. A freshly-connected sensei on a quiet dojo
// receives nothing — no announcement, so no turn, so no skill fires,
// because a skill is instructions for a turn you are already having.
// Confirmed twice, independently: in a harness (empty dojo, attention
// clocks running fast, zero frames in ~200 ticks, against a positive
// control that does see a wake) and in the field (a fresh infra with
// nothing moving; the sensei connected and sat there until a human
// intervened).
//
// SENSEI-ONLY IS A DECISION, NOT A DERIVATION — recorded that way on
// purpose (ruled 2026-08-25: a judgement call — greeting workers was a
// live option). Greeting workers is a coherent design. It
// was considered and rejected; it is not ruled out by anything structural,
// and a reader who reaches for it has not missed an argument.
//
// THE REASON WE CHOSE AGAINST IT: a worker connecting with nothing waiting
// is SUPPOSED to sit idle, and if it should be doing something, saying so
// is the ORCHESTRATOR'S job, not infra's. Greeting workers would put infra
// in the business of telling agents what to do, which is the sensei's
// whole function. That reason is a judgement about where responsibility
// sits — revisit the row if that judgement changes, rather than treating
// it as forced.
//
// A NOTE ON WHY THE FORM MATTERS HERE. This rule was first written as a
// derivation from an asymmetry ("every other seat's connect feeds somebody
// — a worker's register IS the sensei's mail"). That premise was FALSE on
// main: `register` resolves to nobody (see resolution's table, and task
// 139). A rule that reads as forced gets defended; a rule recorded as a
// choice gets revisited. The choice survived its support dying, which is
// exactly the fragility derivation-shaped prose hides.
//
// THE SHAPE, and it is what makes this one mechanism instead of two: the
// greet is minted ONLY when no mail waits. One evaluation, one instant,
// one outcome — so an agent can never receive both a greet and mail, and
// there is nothing to race, time or reconcile. Every earlier attempt at
// this treated the greet as a second thing beside the mail; every problem
// it collected came from that.
//
// AND IT IS ORDINARY MAIL. The greet enters the recipient's mailbox and is
// announced, repeated and cleared by the machinery that carries everything
// else — P7 and P8 unchanged, no second push path. (The old implementation
// was a raw `deliver` with no mailbox entry: the exact defect shape task
// 053 exists to catch, sitting inside the design we were about to restore.)
//
// SELF-LIMITING, and stated here rather than left to emerge because the
// behaviour reads like a bug otherwise: greet, disconnect without acking,
// reconnect — the first greet is STILL PENDING, so mail waits, so nothing
// is minted and the agent is told about the greet it already had. No agent
// can ever hold two. This follows from P7 rather than sitting beside it.
//
// ── A SENSEI'S RESTING MAILBOX IS ONE, NOT ZERO ──
//
// The background invariant this mechanism changes, pinned because things
// lean on it WITHOUT SAYING SO. A freshly-registered sensei holds its
// unacked greet, so any code that assumes an empty orchestrator mailbox at
// rest is now wrong — and will break for a reason unrelated to its own
// subject. Three such walks were found when the greet landed and NOT ONE
// was about emptiness: one asserted authorship, two asserted that a status
// command could parse a shape. Each had encoded `0` incidentally.
//
// That is the hazard: the next reader who writes a fourth will not be
// thinking about greets at all. If a count of the orchestrator's mailbox
// surprises you, this is why — and the fix is to assert the thing the test
// is actually about, never to special-case the greet away.
//
// The state is CORRECT, not a wart to be tidied. Mail sits until acked
// (P7); an orchestrator that has not acked its greet has not started yet,
// which is precisely the fact worth representing. Auto-clearing it would
// make the greet a push wearing mail's clothes — the second push path this
// design exists to avoid.

/** The facts one registration decision consumes. `pendingIds` comes from
 *  `mailboxOf` — the ONE membership function (P2) — so "empty" here means
 *  exactly what it means everywhere else. */
export type RegistrationFact = {
  name: AgentName
  role: AgentRole
  /** The registering agent's mailbox, ids in log order. */
  pendingIds: readonly number[]
}

/** Mint a greet as ordinary mail for this recipient. The adapter records it;
 *  the announcement machinery then carries it like anything else. The core
 *  returns no prose — the text is the adapter's to render, as with
 *  `AnnounceEffect`. */
export type GreetEffect = {
  kind: 'greet'
  to: AgentName
}

export type NotifierDecision = {
  next: NotifierState
  effects: readonly AnnounceEffect[]
}

/** What the shell reports back, as data. */
export type NotifyOutcome =
  | {
      kind: 'announced'
      agent: AgentName
      ids: readonly number[]
      /** Did the transport accept the push? Refused = the agent was never
       *  told; the episode must not advance (P8). */
      accepted: boolean
    }
  | {
      /** The agent saw its inbox by its own act (fetch, piggyback). The
       *  current announcement obligation is discharged; the ladder
       *  continues while mail is unhandled. */
      kind: 'carried'
      agent: AgentName
      ids: readonly number[]
      via: DeliveredVia
    }

/**
 * The executor UNIT — see the header's pair-laws (a)–(c). `emit` appends a
 * history event (the nudge record); `stamp` records delivery evidence for
 * the ids an accepted announce told the agent about.
 */
export type NotifierExecutor = {
  deliver: (to: AgentName, text: string) => boolean
  stamp: (via: DeliveredVia, ids: readonly number[]) => void
  emit: (type: string, data: unknown) => void
}

export type ConfigRefusal =
  | { kind: 'empty-ladder' }
  | { kind: 'shrinking-ladder'; at: number }
  | { kind: 'non-positive-interval' }

/** `export const notifier: NotifierContract` — src/domain/notifier/ (D8). */
export type NotifierContract = {
  initial: () => NotifierState

  /** Invalid configuration refuses loudly at composition time — a shrinking
   *  ladder would violate P8 silently forever. */
  validateConfig: (config: NotifierConfig) => { ok: true } | { ok: false; refusal: ConfigRefusal }

  /** Pure. Called on arrival and on the tick — same function (E6: one
   *  mechanism; the trigger is the view's `now`, not the call site). */
  decide: (state: NotifierState, view: NotifierView, config: NotifierConfig) => NotifierDecision

  /** Pure. The shell reports each performed effect's outcome, and carriage
   *  it observed, BEFORE the next decide reads state (executor law (a)). */
  applyOutcome: (state: NotifierState, outcome: NotifyOutcome) => NotifierState

  /** An event arrived / an agent acted — the activity reset (P8 clause 3)
   *  and the new-arrival trigger, from the log the shell already appends.
   *  Activity is the agent's OWN act per the agents contract's definition;
   *  the shell passes the acting agent, or none for machine writes.
   *
   *  AN EPISODE BELONGS TO A SESSION, NOT A NAME (ruled, task 140). It ends
   *  when the occupant acts — OR when a `register` event seats a new one:
   *  the process that was told is gone, and the one listening was told
   *  nothing, so the whole episode (ladder position and what was announced)
   *  goes, read from the event itself. The direction the clock then moves
   *  is the composer's fact, not this module's: `lastActivityAt` is now
   *  after an act (told after the quiet interval) and absent after a
   *  register (told at once). Register is not activity (H7): it earns no
   *  quiet interval, it forfeits the inherited one. A register for a name
   *  with no episode is a no-op; a register for one agent never touches
   *  another's. */
  observeEvent: (state: NotifierState, event: StoredEvent, actor: AgentName | undefined) => NotifierState

  /** Pure. A seat has registered. Mints a greet ONLY for a self-directed
   *  seat whose mailbox is empty; returns none otherwise. See the greet
   *  section above for why the empty-mailbox test is the whole mechanism
   *  rather than a guard on it. */
  greetOnRegistration: (fact: RegistrationFact) => GreetEffect | undefined
}
