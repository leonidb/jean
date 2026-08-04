/**
 * ██ CONDEMNED ██ Pre-append decisions (refactor stage 4 — task 036).
 *
 * Everything in this file is scheduled for DELETION at the protocol build (013).
 * It is here because stage 4 is behaviour-preserving and these decisions had to
 * go somewhere pure; it is here TOGETHER so that deletion is one file rather
 * than an archaeology exercise.
 *
 * ── WHAT "PRE-APPEND" MEANS, AND WHY IT IS A SHIM ──
 *
 * A pre-append decision is legacy semantics: defined at call-entry, against
 * in-memory state, before anything is written. Every one of them exists to
 * close a window that only exists BECAUSE the decision happens before the
 * append. The protocol build redefines these semantics in strict log-order
 * terms, at which point the window is not guarded — it is gone, because there
 * is nothing left before the append to guard. The end state is: the adapter
 * parses, the event appends, the fold assigns meaning.
 *
 * The same retirement already happened to guard 3 (strict log order) and to the
 * `PublishContext` shim carrying guard 1's capture. These two are the rest of
 * the set. Rulings: Leonid, 2026-08-04, recorded on task 035.
 *
 * ── DO NOT POLISH ──
 *
 * These were moved MECHANICALLY. Do not elevate them, do not design around
 * them, do not build on them. If you find yourself wanting to extend one, that
 * is the signal that the protocol formulation below is the thing to build
 * instead. The two-row mutation rule (035) applies while they live: each guard
 * keeps its integration row AND gains a pure row, because a moved guard with
 * one row proves less than it did before the move.
 *
 * ── THE REPLACEMENTS, RECORDED SO THEY DO NOT HAVE TO BE RE-DERIVED ──
 *
 * `claimAckIds` → ack becomes append-unconditionally, fold-decides. The pending
 * reducer's ack case is ALREADY idempotent (`state.filter(e => !acked.has(e.id))`,
 * reducers.ts) — invalid and duplicate ids are structural no-ops in the fold
 * today, which is what makes the write-time claim a redundant second layer. Its
 * only real functions are log hygiene (only effective acks get recorded) and
 * counting claims for the `acknowledged: N` response. Caller feedback derives
 * POST-fold instead: append → synchronous publish → count which of the caller's
 * ids actually left pending. Accurate per call, zero coordination. Every
 * subscriber must then be no-op-safe for acks — an L2 fold test replaces this
 * write-site guard.
 *
 * `decideAutoClear` → "a reply from the sensei to a bridge human auto-clears
 * that human's single blocking event PRECEDING the reply in the log; if two or
 * more precede it, stand down." Same outcome as the entry snapshot: a burst
 * arriving mid-flight lands before the reply in the log, the count is >1, and
 * auto-clear stands down. No snapshot, no await window.
 *
 * Both formulations have the same residual divergence class as guard 1's
 * (entry-time vs log-time, in microsecond windows). That is accepted
 * DELIBERATELY at the protocol build — and the equivalences must be VERIFIED
 * there with fold tests, not assumed. Written down here is not the same as
 * proven there.
 */

/**
 * ██ CONDEMNED ██ GUARD 6 — the ack claim.
 *
 * Two acks for the same id used to produce two ack events, the second carrying
 * `clearedBy` with no `deliveredVia` (the first write already dropped the
 * ledger entry) — so a reader taking the LATEST ack concluded "delivery
 * unknown" for an event that was demonstrably woken. A 20-way interleave
 * produced 20 ack events.
 *
 * THE CALLER OWNS THE WELD. This function is pure and synchronous; the property
 * that makes it a guard is that the caller reserves the claimed ids in the SAME
 * synchronous step, with no await between this call and the reservation. Moving
 * the decision here does not move that obligation — see recordAck, and the
 * structural assertion in core/boundary.test.ts.
 *
 * The input dedupe is not redundant with the caller's: no caller can pass a
 * repeat today, but the reservation is populated AFTER this filter, so a
 * repeated id would slip past it and land twice in the recorded `eventIds`.
 * Local guarantee beats trusting every present and future caller.
 */
export function claimAckIds(
  requested: readonly number[],
  pendingIds: ReadonlySet<number>,
  inFlight: ReadonlySet<number>,
): number[] {
  return [...new Set(requested)].filter((id) => pendingIds.has(id) && !inFlight.has(id))
}

/** What the auto-clear decision needs to know at the moment a send is
 *  initiated. All three are read from live state by the caller, at entry. */
export type AutoClearView = {
  /** Sender's role, falling back to the PERSISTED sensei names — the sensei's
   *  HTTP sends keep working during a WS drop, and auto-clear must not silently
   *  stand down then (review finding). */
  senderRole: string | undefined
  /** Recipient's role, live registry only. */
  targetRole: string | undefined
  /** Ids of pending blocking events from the recipient, as of entry. */
  blockingFromTarget: readonly number[]
}

/**
 * ██ CONDEMNED ██ GUARD 7 (entry half) — which id, if any, this send may
 * auto-clear.
 *
 * The sensei answering a bridge human IS the ack: observation removes a
 * bookkeeping step rather than adding one. THE EXACTLY-ONE RULE: it fires only
 * when exactly ONE pending blocking event exists from that human. A
 * multi-message burst requires an explicit ack, which converts silent loss of
 * question #2 into a visible leftover.
 *
 * THE CALLER OWNS THE WELD, again: this must be evaluated at ENTRY, before any
 * await, so that only an event already visible when the reply was INITIATED can
 * be cleared. Without that, a follow-up or proactive send could ack a brand-new
 * message that arrived mid-flight and was never seen.
 */
export function decideAutoClear(view: AutoClearView): number | null {
  if (view.senderRole !== 'sensei') return null
  if (view.targetRole !== 'user') return null
  return view.blockingFromTarget.length === 1 ? (view.blockingFromTarget[0] as number) : null
}

/**
 * ██ CONDEMNED ██ GUARD 7 (tail half) — is the entry candidate still the sole
 * pending blocking event?
 *
 * Double-check at the tail, and both conditions carry weight: a message that
 * arrived mid-flight turns this into a burst (stand down), and a concurrent
 * manual ack makes it a no-op (the id is gone).
 *
 * KNOWN LIMITATION, unchanged by the move (review, deferred to the
 * delivery-ledger item): bridge delivery is fire-and-forget, so a Telegram or
 * Slack API failure after queueing still counts as delivered and the ack can
 * clear a reminder for a reply the human never received. Bounded — the human
 * re-messages, a fresh blocking event arrives, the wake fires. The proper fix
 * is bridge outcome reporting.
 */
export function confirmAutoClear(candidate: number, blockingFromTarget: readonly number[]): boolean {
  return blockingFromTarget.length === 1 && blockingFromTarget[0] === candidate
}
