/**
 * The mailbox — pairs, membership, views, acknowledgement (spec §2, P1–P7,
 * P10; contract `contracts/mailbox.ts`, task D2).
 *
 * ── THE STATE IS THE OPEN SET, AND NOTHING ELSE ──
 *
 * P4 defines pending as the set of unacknowledged (recipient, event) pairs, so
 * the state IS that set — one entry per event that still has at least one
 * unacked pair:
 *
 *   eventId → { event, recipients, holders }
 *
 * `recipients` is who it was addressed to when it was folded; `holders` is who
 * has not cleared yet, and holders ⊆ recipients always. An entry whose holders
 * fall empty is DROPPED, which is P4 stated as a data structure rather than
 * narrated beside one: "an event leaves pending when its last recipient clears
 * its own pair" is not a rule this code applies, it is the only shape the
 * state can take.
 *
 * Both fields are needed and neither is redundant. Holders alone cannot answer
 * `acknowledgedCount`, because "cleared my pair" and "never had a pair" both
 * read as absence — and the contract wants 1 for the first and 0 for the
 * second. Recipients alone cannot answer membership. See `acknowledgedCount`
 * for the one case this shape genuinely cannot distinguish, and why the
 * alternative is worse.
 *
 * ── WHY IT COPIES, AND WHY THE COPY IS CHEAP ──
 *
 * `fold` and `applyAck` return new states and never touch the old one: the
 * refold test folds an ack onto a state that a decision has already consumed,
 * and both answers must stand. Copying is therefore per-fold — but it is
 * O(pending), not O(log), precisely because fully-cleared events are dropped.
 * A healthy dojo's pending set is small no matter how long its log is, so
 * booting from a 10,000-event log costs 10,000 × (a few pairs) rather than
 * 10,000². A dojo where nothing is ever acked degenerates to O(n²), and there
 * the large state is the honest answer: n pairs really are pending.
 *
 * The alternative — sharing one mutable index across states — was rejected
 * despite being faster: an event-sourced fold whose old states silently change
 * under a caller is the class of defect this whole rewrite exists to remove.
 *
 * ── RECIPIENTS ARE INJECTED; AUTHORSHIP, STILL, IS NOT ──
 *
 * `fold` takes `recipientsOf` (ruled task 083, from D2's first report). This
 * module therefore never imports the resolution implementation and never
 * derives membership itself — the seam P2 forbids has nowhere to open, and
 * the conformance suite can inject a scripted table so its verdicts do not
 * ride on another module's correctness.
 *
 * `groupOf` did NOT get the same treatment, and it needs the same kind of
 * fact. "Is a human waiting" is a question about the event's SENDER, and with
 * the resolution import gone the only way to answer it is `senderOf` below —
 * a second, local reading of authorship that duplicates
 * `resolution.authorOf`. Nothing keeps the two in step: the day a kind moves
 * its author field, mail from a human starts queueing instead of blocking,
 * and no test in either module fails. The ruling closed the membership half
 * of this dependency and left the authorship half open. Reported on task 081;
 * the fix is the same shape as the one that worked — an injected `senderOf`,
 * or a `from` on the classification call.
 *
 * ── ONE MEMBERSHIP FUNCTION (P2) ──
 *
 * `mailboxOf` is the only place membership is decided. `pendingPairs`,
 * `countsFor`, `summaryFor`, `fetchFor` and `select` all call it rather than
 * re-deriving — the seam a second path would need does not exist here. That is
 * structural; the suite additionally checks the rungs agree, and the
 * randomized run is the standing detector.
 *
 * What this file cannot enforce, and what does: that codes are really
 * content-derived, that historical acks fold as described, that a
 * non-recipient is refused, and that the views agree with `mailboxOf` — all
 * held by `mailbox.conformance.test.ts`.
 */

import type {
  AckCode,
  AckDecision,
  AckPair,
  AckRecordData,
  ClearedPair,
  FetchedEvent,
  InboxGroup,
  MailboxContract,
  MailboxCounts,
  MailboxState,
  MailPair,
  RecipientsOf,
  Selection,
  SummaryLine,
} from '../contracts/mailbox.ts'
import type {
  AgentName,
  AgentRole,
  ReplyData,
  SendData,
  StoredEvent,
  TaskCommentData,
} from '../contracts/vocabulary.ts'

// ── State ────────────────────────────────────────────────────────

/** One event with at least one unacked pair. `holders ⊆ recipients`, and
 *  `holders` is never empty — an entry that would empty is removed instead. */
type OpenEvent = {
  readonly event: StoredEvent
  readonly recipients: ReadonlySet<AgentName>
  readonly holders: ReadonlySet<AgentName>
}

/** The opaque state, in the open. Keyed by event id; insertion order is log
 *  order, which is why the views can rely on it without sorting. */
type Open = ReadonlyMap<number, OpenEvent>

/** The contract's `MailboxState` is a nominal shell; this is what it is. The
 *  cast is confined to these two helpers so no other line has to think about
 *  it. */
function open(state: MailboxState): Open {
  return state as unknown as Open
}
function seal(next: Open): MailboxState {
  return next as unknown as MailboxState
}

// ── Codes ────────────────────────────────────────────────────────

/**
 * Structural stringify with SORTED KEYS. Two structurally equal events must
 * produce one code regardless of the order their fields were built in — a
 * record round-tripped through JSON and rebuilt by an adapter is the same
 * event, and a code that disagreed would refuse a caller that had genuinely
 * read the payload.
 */
function stable(value: unknown): string {
  if (value === undefined) return 'u'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'u'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
}

/** FNV-1a, 32-bit, with the basis as a parameter so one pass can be run twice
 *  under different bases. `>>> 0` after every step keeps it unsigned; without
 *  it the multiply drifts into the sign bit and two contents collide far
 *  sooner than the width suggests. */
function fnv1a(input: string, basis: number): number {
  let hash = basis
  for (let i = 0; i < input.length; i++) {
    hash = (hash ^ input.charCodeAt(i)) >>> 0
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

// ── Sender, group, preview ───────────────────────────────────────

/** The fields a payload's first line can come from, in the order a reader
 *  would want them. `text` covers the message and supervision kinds, `title`
 *  a created task, `description` an updated one, `prompt` a trigger firing. */
const PREVIEW_FIELDS = ['text', 'title', 'description', 'prompt'] as const

/** First line of the payload, capped. Enough to triage; a code needs the full
 *  content, so no preview can shorten the path to one (P5/P7). */
function previewOf(event: StoredEvent): string {
  const data = (event.data ?? {}) as Record<string, unknown>
  for (const field of PREVIEW_FIELDS) {
    const value = data[field]
    if (typeof value !== 'string' || value.length === 0) continue
    const firstLine = value.split('\n', 1)[0] ?? ''
    return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
  }
  return ''
}

/**
 * WHO SPOKE — the classification's input, and a duplicate by necessity.
 *
 * This answers the same question as `resolution.authorOf`, and it exists only
 * because `groupOf` has no injected source for it (see the header). It is
 * kept deliberately NARROW — the kinds where an agent composed something a
 * reader can be blocked on — rather than mirroring `authorOf` arm for arm: a
 * partial duplicate that admits what it does not cover is easier to reconcile
 * than a full one that silently drifts.
 *
 * `data.agent` cannot be read blindly. Across the census it is the addressee
 * on `send`, the speaker on `reply` and `task-comment`, and the subject on
 * the lifecycle kinds — so a `send` addressed TO a human would classify as
 * blocking if this read `agent`, and every dispatch to a human would jump the
 * queue.
 */
function senderOf(event: StoredEvent): AgentName | undefined {
  const data = (event.data ?? {}) as Partial<ReplyData & TaskCommentData & SendData> & { actor?: unknown }
  switch (event.type) {
    case 'reply':
    case 'task-comment':
    case 'memory':
      return typeof data.agent === 'string' ? data.agent : undefined
    // `from`, not `agent`: `agent` is who this is FOR.
    case 'send': {
      const from = data.from
      return typeof from === 'string' && from !== 'infra' && from !== 'api' ? from : undefined
    }
    case 'task-created':
    case 'task-status':
    case 'task-blocked':
    case 'task-reverted':
    case 'task-updated':
    // `trigger-created` resolves to nobody today, so this arm is unreachable
    // through the real resolver — and it is here anyway, because it is the
    // arm `resolution.authorOf` has. THE DRIFT THIS FILE'S HEADER WARNS ABOUT
    // WAS ALREADY REAL AT BIRTH: codex found the two readings disagreeing on
    // this exact kind on the day the duplicate was written. Kept in step by
    // hand until the dependency is closed properly (task 081).
    case 'trigger-created':
      return typeof data.actor === 'string' ? data.actor : undefined
    default:
      // Infra's own emissions — probes, reminders, down reports. Nobody spoke,
      // so nobody is waiting, so they queue. Undefined is the safe answer: it
      // can only send an event to the queued group, never jump it ahead.
      return undefined
  }
}

// ── Membership and clearing helpers ──────────────────────────────

/** Remove one holder from one event; drop the entry when its last holder
 *  goes. Returns the map unchanged when there was nothing to remove, so
 *  callers can fold a batch without special-casing misses. */
function withoutHolder(current: Open, eventId: number, holder: AgentName): Open {
  const entry = current.get(eventId)
  if (entry === undefined || !entry.holders.has(holder)) return current
  const next = new Map(current)
  const holders = new Set(entry.holders)
  holders.delete(holder)
  if (holders.size === 0) next.delete(eventId)
  else next.set(eventId, { ...entry, holders })
  return next
}

/** Remove an event outright — every holder at once. The historical ack's
 *  semantics, and the reason it is a separate helper: nothing else in this
 *  module may clear more than one agent's pair (§2). */
function withoutEvent(current: Open, eventId: number): Open {
  if (!current.has(eventId)) return current
  const next = new Map(current)
  next.delete(eventId)
  return next
}

/** Fold one ack event by its own record — the whole of the contract's replay
 *  tolerance, in one place.
 *
 * ATTRIBUTED records replay from `caller` + `cleared`, never from `pairs`:
 * `pairs` is what the caller PRESENTED, misses included, so replaying it
 * would clear at boot what did not clear live — an agent's unread mail
 * vanishing on restart because it once presented a wrong code for it.
 *
 * HISTORICAL records (`eventIds`, no caller) clear every pair of the named
 * events. That is the old shared-flag behaviour, and it is preserved
 * deliberately and permanently: those records are already in every dojo's
 * log, and refusing them would resurrect months of long-cleared mail on the
 * first boot after the switch.
 */
function foldAck(current: Open, event: StoredEvent): Open {
  const data = (event.data ?? {}) as { caller?: unknown; cleared?: unknown; eventIds?: unknown }

  // ATTRIBUTION DECIDES WHICH PATH, AND IT DECIDES FIRST. A record that names
  // a caller is an attributed one even when its `cleared` list is missing or
  // malformed — such a record clears NOTHING. Letting it fall through to the
  // historical branch below (it also carries `eventIds`) would clear every
  // holder's pair on those events: the shared-flag defect arriving by a second
  // road, through a damaged record rather than through the code. The contract
  // is precise that historical means `eventIds` with NO caller, and this is
  // that sentence enforced (codex pass, task 081).
  if (typeof data.caller === 'string') {
    if (!Array.isArray(data.cleared)) return current
    let next = current
    for (const entry of data.cleared as readonly { eventId?: unknown }[]) {
      if (typeof entry?.eventId === 'number') next = withoutHolder(next, entry.eventId, data.caller)
    }
    return next
  }

  if (Array.isArray(data.eventIds)) {
    let next = current
    for (const id of data.eventIds as readonly unknown[]) {
      if (typeof id === 'number') next = withoutEvent(next, id)
    }
    return next
  }

  return current
}

// ── The contract ─────────────────────────────────────────────────

const codeFor = (event: StoredEvent): AckCode => {
  // The FULL content — envelope and data. Nothing derivable from a summary
  // line may suffice (P5), so id, ts, type, stream and data all participate,
  // and the conformance suite moves each one independently to prove it.
  const content = stable({ id: event.id, ts: event.ts, type: event.type, stream: event.stream, data: event.data })
  // Two passes under different bases, concatenated: one 32-bit hash is short
  // enough that a busy dojo would eventually see a collision, and a collision
  // here means a code minted for one event opening another.
  const lo = fnv1a(content, 0x811c9dc5).toString(36)
  const hi = fnv1a(content, 0x01000193).toString(36)
  return `${lo}${hi}`
}

const mailboxOf = (state: MailboxState, agent: AgentName): readonly StoredEvent[] => {
  const events: StoredEvent[] = []
  for (const entry of open(state).values()) {
    if (entry.holders.has(agent)) events.push(entry.event)
  }
  // Log order. Insertion order already gives it, and the sort states the
  // guarantee rather than relying on a Map's iteration order to keep meaning
  // it after some future edit.
  return events.sort((a, b) => a.id - b.id)
}

const groupOf = (event: StoredEvent, roleOf: (name: AgentName) => AgentRole | undefined): InboxGroup => {
  // Blocking means a HUMAN is waiting — a fact about the SENDER's role, not
  // about the kind. `send` is the case that proves it: the same kind queues
  // or blocks depending only on who wrote it.
  const from = senderOf(event)
  if (from !== undefined && roleOf(from) === 'user') return { kind: 'blocking', from }
  return { kind: 'queued', type: event.type }
}

const fetchFor = (state: MailboxState, agent: AgentName): readonly FetchedEvent[] =>
  mailboxOf(state, agent).map((event) => ({ event, code: codeFor(event) }))

export const mailbox: MailboxContract = {
  initial: () => seal(new Map()),

  fold(state: MailboxState, event: StoredEvent, recipientsOf: RecipientsOf): MailboxState {
    const current = open(state)
    if (event.type === 'ack') return seal(foldAck(current, event))

    // THE INJECTED RESOLVER IS THE ONLY SOURCE. No kind is special-cased here,
    // and mail-shaped kinds get no shortcut: a `send` whose resolver answers
    // nobody enters nothing, exactly like a `nudge`. That is what keeps this
    // from becoming a second membership path (P2).
    const recipients = recipientsOf(event)
    // History — an event resolving to nobody never enters pending (P4). This
    // is the empty case of the one rule, not a branch for a second category.
    if (recipients.length === 0) return state

    const next = new Map(current)
    // A Set also collapses a resolver that repeats a recipient: one recipient
    // is one pair, whatever it was handed (spec §2).
    const holders = new Set<AgentName>(recipients)
    next.set(event.id, { event, recipients: holders, holders })
    return seal(next)
  },

  mailboxOf,

  pendingPairs(state: MailboxState): readonly MailPair[] {
    const pairs: MailPair[] = []
    for (const [eventId, entry] of open(state)) {
      for (const recipient of entry.holders) pairs.push({ recipient, eventId })
    }
    return pairs
  },

  codeFor,

  groupOf,

  countsFor(state, agent, roleOf): MailboxCounts {
    let blocking = 0
    let queued = 0
    for (const event of mailboxOf(state, agent)) {
      if (groupOf(event, roleOf).kind === 'blocking') blocking++
      else queued++
    }
    return { blocking, queued, total: blocking + queued }
  },

  summaryFor(state, agent, roleOf, now): readonly SummaryLine[] {
    return mailboxOf(state, agent).map((event) => ({
      id: event.id,
      group: groupOf(event, roleOf),
      // The same reading `groupOf` used, so a line's `from` and its group can
      // never disagree about who spoke.
      from: senderOf(event),
      preview: previewOf(event),
      // Clamped at zero: a log written by a clock ahead of this one would
      // otherwise report a negative age, and "arrived in the future" is not
      // a triage signal anybody can use.
      ageMs: Math.max(0, now - Date.parse(event.ts)),
    }))
  },

  fetchFor,

  select(state, agent, selector, roleOf): Selection {
    // Selection happens INSIDE the reader's mailbox: everything below narrows
    // `fetchFor`, so an id belonging to somebody else is a miss and never a
    // disclosure. The union's variants are read in the contract's stated
    // order, which is what makes a malformed multi-key object deterministic
    // rather than dependent on key order.
    const mine = fetchFor(state, agent)

    if ('ids' in selector) {
      const wanted = new Set(selector.ids)
      const events = mine.filter((f) => wanted.has(f.event.id))
      const found = new Set(events.map((f) => f.event.id))
      // `missing` is present even when empty: "all found" and "silently
      // dropped" must not be the same response.
      return { events, missing: selector.ids.filter((id) => !found.has(id)) }
    }

    if ('from' in selector) {
      return {
        events: mine.filter((f) => {
          const group = groupOf(f.event, roleOf)
          return group.kind === 'blocking' && group.from === selector.from
        }),
      }
    }

    return {
      events: mine.filter((f) => {
        const group = groupOf(f.event, roleOf)
        return group.kind === 'queued' && group.type === selector.type
      }),
    }
  },

  applyAck(state, caller, pairs, deliveredVia): AckDecision {
    let next = open(state)
    const cleared: ClearedPair[] = []

    for (const { id, code } of pairs) {
      const entry = next.get(id)
      // Three ways to clear nothing, none of them an error (fail-soft, P5):
      // no such open event, the caller holds no pair on it, or the code does
      // not match. AUTHORIZATION IS THE SECOND ONE, and it is the model
      // rather than a check bolted beside it — a non-recipient has no pair,
      // so a leaked code opens nothing. The register's row 3 cannot be
      // written here.
      if (entry === undefined || !entry.holders.has(caller)) continue
      if (codeFor(entry.event) !== code) continue

      const via = deliveredVia(id)
      // The key is OMITTED when evidence is absent rather than set to
      // undefined: `deliveredVia === undefined` means unknown, and a record
      // that spells the unknown out invites a reader to treat it as
      // "not delivered".
      cleared.push(via === undefined ? { eventId: id } : { eventId: id, deliveredVia: via })
      next = withoutHolder(next, id, caller)
    }

    const record: AckRecordData = {
      // The historical field first, so an OLD fold reading a NEW record still
      // clears correctly during the fallback window.
      eventIds: cleared.map((c) => c.eventId),
      caller,
      // Verbatim, copied rather than aliased — audit data must not change
      // afterwards because the caller reused its array.
      pairs: pairs.map((p): AckPair => ({ id: p.id, code: p.code })),
      // Its own array AND its own entries. `AckRecordData.cleared` is mutably
      // typed, so a caller editing the record must not change what the
      // decision reported it did. A spread alone copies only the array — the
      // `ClearedPair` objects stayed shared, so `record.cleared[0].eventId =
      // …` still reached `decision.cleared[0]`, which is exactly the
      // independence the comment claimed and did not have (codex pass,
      // task 081, second round).
      cleared: cleared.map((c): ClearedPair => ({ ...c })),
    }

    return { next: seal(next), cleared, record }
  },

  acknowledgedCount(stateAfter, caller, requestedIds): number {
    const current = open(stateAfter)
    let count = 0
    for (const id of requestedIds) {
      const entry = current.get(id)
      // Still open and still the caller's — not cleared.
      if (entry?.holders.has(caller)) continue
      // Still open, and the caller was never a recipient — nothing of the
      // caller's was ever there to clear, so this is not success.
      if (entry !== undefined && !entry.recipients.has(caller)) continue
      // Otherwise: the caller's pair is gone. Either it cleared it, or a
      // racing acker of the same pair did — a distinction the contract says
      // nobody needs.
      //
      // THE ONE CASE THIS SHAPE CANNOT SEE: an id whose event has fully
      // cleared (or never existed) reads as acknowledged even for an agent
      // that never held it, because the entry is gone and with it the
      // recipient list. Keeping cleared events forever would fix it and would
      // make the state grow with the LOG rather than with pending — trading a
      // wrong answer nobody asks for against unbounded memory. Recorded for
      // the architect on task 081 rather than decided here.
      count++
    }
    return count
  },
}
