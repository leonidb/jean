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

import type { AgentName, DeliveredVia, StoredEvent } from './vocabulary.ts'

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
  /** Epoch ms of the agent's last own act; absent = never observed, which
   *  reads MAXIMALLY QUIET (a fresh session with waiting mail is announced
   *  at once — the ruled reconnect behaviour). */
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
   *  the shell passes the acting agent, or none for machine writes. */
  observeEvent: (state: NotifierState, event: StoredEvent, actor: AgentName | undefined) => NotifierState
}
