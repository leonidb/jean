/**
 * The mailbox contract — pairs, membership, views, acknowledgement
 * (spec §2, P1–P7, P10; design §3, §11).
 *
 * ── THE MODEL ──
 *
 * Pending is the set of unacknowledged **(recipient, event) pairs** — a
 * definition, not a status flag (P4). An event with no recipients never
 * enters pending; an event leaves pending when its last recipient clears its
 * own pair. A mailbox is one agent's pairs (§1). Every acknowledgement is
 * per-pair: **no agent's acknowledgement can consume another agent's mail**
 * (§2). Authorization falls out of the model rather than sitting beside it:
 * a caller clears a pair only if THE CALLER'S OWN pair exists — a
 * non-recipient has no pair to clear, so a leaked code confers nothing (P5).
 *
 * ── ONE MEMBERSHIP FUNCTION (P2) ──
 *
 * `mailboxOf` is the only membership function. Views, selectors, counts and
 * observer reads are all derived from it — the contract deliberately gives a
 * second path no seam to exist in. This is structural; the conformance suite
 * additionally checks agreement behaviourally, and the fixture's randomized
 * runs are the standing detector for a parallel path added later.
 *
 * ── THE FOLD, and history (P3, data compatibility) ──
 *
 * `fold` consumes the log one event at a time. Resolution is decided at
 * creation (spec §1), so the caller supplies the ResolutionContext CURRENT AS
 * OF THAT EVENT — folding a historical log means threading the context that
 * log prefix implies, not today's.
 *
 * Ack events fold by their own record — tolerant of history, permanently:
 *   - a HISTORICAL ack (`{eventIds}`, no `caller`) clears EVERY pair of the
 *     named events. That is the old shared-flag semantics, preserved for
 *     replay: refusing it would resurrect months of cleared mail at boot.
 *   - an ATTRIBUTED ack folds from `caller` + **`cleared`** — what the
 *     decision actually cleared — NEVER from `pairs`, which is the verbatim
 *     presented input and includes misses (wrong codes, already-cleared).
 *     Replaying `pairs` would clear at replay what did not clear live.
 *
 * ── ACKNOWLEDGEMENT IS A DECISION (design §11) ──
 *
 * `applyAck` returns a Decision: the next state, the cleared pairs, and the
 * DATA OF THE SINGLE ACK EVENT the shell appends. The record carries
 * attribution (P6: the clearing record names the clearer, per pair) and the
 * delivery evidence for each cleared pair, supplied by the shell as a plain
 * value at decision time. One append; nothing is consulted mid-write; there
 * is no order to preserve — the old ledger weld has no counterpart here.
 * Evidence is the adapter's operational knowledge ("what did I hand over,
 * how") and enters the log only inside this record; `deliveredVia === undefined`
 * means unknown, never "not delivered".
 *
 * ── CODES (P5, §1) ──
 *
 * An ack code is a deterministic function of the event's FULL content —
 * envelope and data — so possession proves the holder fetched the payload:
 * nothing derivable from a summary line (id, sender, first words) may
 * suffice. Stable across restarts and replays. Codes are issued by the fetch
 * view only; the cheap rungs never carry them (P7: an id is knowable from a
 * summary, a code is not).
 *
 * ── VIEWS (P7, P10) ──
 *
 * Three rungs over ONE mailbox: counts → summary → fetch; only fetch carries
 * payloads and codes. All reads are pure functions of (state, arguments) —
 * they mutate nothing (P7: progress is only by acknowledgement) and cache
 * nothing (P10: every answer is derived from the state passed in; a second
 * source for "what is mine" is the 059 class). `groupOf` is the ONE
 * classification both the summary and the from/type selectors share, so the
 * key an agent reads off a summary is the key selection accepts.
 *
 * What the types cannot enforce, and what does: that codes really are
 * content-derived, that historical acks fold as described, that authorization
 * refuses a non-recipient, and that the views agree with `mailboxOf` — all
 * held by `mailbox.conformance.test.ts`; the randomized replay runs hold the
 * rest.
 */

import type { ResolutionContext } from './resolution.ts'
import type { AgentName, AgentRole, DeliveredVia, StoredEvent } from './vocabulary.ts'

// ── Pairs and state ──────────────────────────────────────────────

/** §2's unit: one recipient's claim on one event. */
export type MailPair = { recipient: AgentName; eventId: number }

/** Opaque — constructed by `initial()`, evolved by `fold`, read through the
 *  contract's functions only. Its internals are the implementation's. */
export type MailboxState = { readonly __mailboxState: true }

// ── Codes ────────────────────────────────────────────────────────

export type AckCode = string

/** One requested clearing: the event and the code proving it was fetched. */
export type AckPair = { id: number; code: AckCode }

// ── The ack decision ─────────────────────────────────────────────

export type ClearedPair = {
  eventId: number
  /** How the event reached the caller, from the shell's evidence. Absent =
   *  unknown — never "not delivered". */
  deliveredVia?: DeliveredVia
}

/**
 * The data of the single `ack` event the shell appends for this decision.
 * Extends the historical shape additively (vocabulary `AckData`): old folds
 * read `eventIds` and still clear correctly during a fallback window; new
 * folds read `caller` + `pairs` and clear per-pair.
 */
export type AckRecordData = {
  /** The cleared events' ids — the historical field, kept so the OLD fold
   *  can read a NEW record (shrinks the switch's one-way door). */
  eventIds: number[]
  /** P6: the agent whose pairs were cleared — the clearing record names the
   *  clearer. */
  caller: AgentName
  /** What the caller presented, verbatim — including pairs that cleared
   *  nothing (wrong code, already cleared), so the record is auditable.
   *  AUDIT DATA ONLY: the fold never reads this field. */
  pairs: AckPair[]
  /** What actually cleared, with delivery evidence embedded per pair. THIS
   *  is what the fold replays (with `caller`) — the state change itself. */
  cleared: ClearedPair[]
}

export type AckDecision = {
  next: MailboxState
  /** The caller's pairs this decision cleared — every entry names the caller
   *  implicitly; no other agent's pair can appear here (§2). */
  cleared: readonly ClearedPair[]
  /** Append exactly this, once. Empty `cleared` still returns a record —
   *  whether to append a no-op ack is the adapter's call, stated there. */
  record: AckRecordData
}

// ── Views ────────────────────────────────────────────────────────

/** The one classification the summary and the from/type selectors share.
 *  Blocking = a human is waiting (sender resolves to role 'user'); grouped by
 *  sender. Everything else queues, grouped by type. */
export type InboxGroup = { kind: 'blocking'; from: AgentName } | { kind: 'queued'; type: string }

export type MailboxCounts = {
  blocking: number
  queued: number
  total: number
}

export type SummaryLine = {
  id: number
  group: InboxGroup
  from: AgentName | undefined
  /** First line of the payload — enough to triage, not enough to derive a
   *  code from. */
  preview: string
  ageMs: number
}

/** Fetch is the only rung carrying payloads and codes (P5/P7). */
export type FetchedEvent = { event: StoredEvent; code: AckCode }

/** Exactly one selector. The union names the three forms; structural typing
 *  cannot forbid an object carrying extra keys, so the at-most-one rule is
 *  the ADAPTER's grammar guarantee — implementations may assume exactly one
 *  variant and read them in the order ids, from, type if handed a malformed
 *  value. Selection happens INSIDE the reader's mailbox: an id outside it is
 *  a miss, never a disclosure. */
export type Selector = { ids: readonly number[] } | { from: AgentName } | { type: string }

export type Selection = {
  events: readonly FetchedEvent[]
  /** Always present on an ids selection, even when empty — "all found" and
   *  "silently dropped" must not be the same response. Absent otherwise. */
  missing?: readonly number[]
}

// ── The contract ─────────────────────────────────────────────────

/** One implementation object: `export const mailbox: MailboxContract`
 *  (src/domain/mailbox/ and nowhere else — task D2). */
export type MailboxContract = {
  initial: () => MailboxState

  /** Fold one event. `ctx` is the resolution context current AS OF this
   *  event. Unknown kinds are history; ack events fold by their own record
   *  (historical: all pairs of the ids; attributed: the caller's pairs). */
  fold: (state: MailboxState, event: StoredEvent, ctx: ResolutionContext) => MailboxState

  /** THE membership function (P2). One agent's pending events, log order. */
  mailboxOf: (state: MailboxState, agent: AgentName) => readonly StoredEvent[]

  /** Every unacknowledged pair — the observer read; P4's definition made
   *  visible. Must equal the union of every agent's mailbox exactly. */
  pendingPairs: (state: MailboxState) => readonly MailPair[]

  /** Deterministic over the event's full content; stable across restarts. */
  codeFor: (event: StoredEvent) => AckCode

  /** The shared classification (summary grouping AND selector keys). */
  groupOf: (event: StoredEvent, roleOf: (name: AgentName) => AgentRole | undefined) => InboxGroup

  countsFor: (
    state: MailboxState,
    agent: AgentName,
    roleOf: (name: AgentName) => AgentRole | undefined,
  ) => MailboxCounts

  summaryFor: (
    state: MailboxState,
    agent: AgentName,
    roleOf: (name: AgentName) => AgentRole | undefined,
    now: number,
  ) => readonly SummaryLine[]

  /** The whole mailbox with codes; `select` narrows by one selector. */
  fetchFor: (state: MailboxState, agent: AgentName) => readonly FetchedEvent[]

  select: (
    state: MailboxState,
    agent: AgentName,
    selector: Selector,
    roleOf: (name: AgentName) => AgentRole | undefined,
  ) => Selection

  /**
   * The clearing decision (P5, P6, §2). A pair clears iff the caller's own
   * pair exists AND the code matches the event — fail-soft per pair: a wrong
   * code, an unknown id, an already-cleared or never-held pair clears
   * nothing and is not an error. `deliveredVia` is the shell's evidence,
   * consulted only to embed marks into the record.
   */
  applyAck: (
    state: MailboxState,
    caller: AgentName,
    pairs: readonly AckPair[],
    deliveredVia: (eventId: number) => DeliveredVia | undefined,
  ) => AckDecision

  /** Idempotent answer: of the requested ids, how many have the CALLER's
   *  pair cleared in `stateAfter`. Two racing ackers of one pair both read
   *  success — which one did the clearing is a distinction nobody needs. */
  acknowledgedCount: (stateAfter: MailboxState, caller: AgentName, requestedIds: readonly number[]) => number
}
