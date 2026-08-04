/**
 * ██ TARGET API ██ STUB GROUP 2 — ack codes (013 REFERENCE DESIGN S5;
 * 039 O2; 041's ledger reading rule).
 *
 * Canon, verbatim (S5): "The ack code exists only in a fetch response. Acking is
 * explicit `{id, code}` pairs — THE ONLY CLEARING PATH. Nothing like `upToId`
 * exists."
 *
 * ── WHAT THE CODE IS FOR ──
 *
 * Read-before-ack. A code an agent could compute, guess, or carry over from a
 * summary line would let it clear an event it never fetched, which is the one
 * thing this mechanism exists to prevent — E4, "progress is defined only by
 * ack", is worth nothing if an ack can be issued without reading.
 *
 * ── O2: CODES SURVIVE RESTART, AND THE SURFACE IS MECHANISM-NEUTRAL ──
 *
 * 039 left the mechanism open: durable (stored) or content-derived (a function
 * of the event). `codeFor` is written so BOTH satisfy it, and the scenario test
 * asserts the property both share — fold the same history twice from scratch and
 * the codes are identical. That test is not vacuous under either mechanism: it
 * is exactly what a counter- or random-based implementation fails.
 *
 * ── WHAT DIES HERE, AND WHAT MUST NOT ──
 *
 * `upToId` and auto-clear-on-reply die with this group (041's third amendment:
 * S5 makes `{id, code}` the only clearing path). What must NOT die is the fold's
 * tolerance for the ack events already in history — 5,537 of them across eight
 * dojos, every one shaped `{eventIds: number[]}`. See
 * `src/scenarios/historical-tolerance.projection.test.ts`.
 */

import type { StoredEvent } from '../../es/index.ts'
import { notImplemented } from './stub.ts'

/** Opaque to agents. Its only property is that it must have been READ. */
export type AckCode = string

/** The only clearing form. There is no other, and there is deliberately no
 *  `upToId` sibling — `s05-ack-codes.projection.test.ts` asserts that at the
 *  type level as well as at runtime. */
export type AckPair = { id: number; code: AckCode }

/**
 * The authoritative code for one event.
 *
 * Stable across restarts and replays — that is O2, and it is the whole reason
 * this is a function of the event rather than of a session.
 */
export function codeFor(_event: StoredEvent): AckCode {
  return notImplemented('codeFor', 'S5 (read-before-ack) / O2 (codes survive restart)')
}

/** Codes for the events a fetch is about to return. The ONLY place codes are
 *  handed out (S5: "exists only in a fetch response"). */
export function issueCodes(_events: readonly StoredEvent[]): Map<number, AckCode> {
  return notImplemented('issueCodes', 'S5 (read-before-ack)')
}

/**
 * The fold: apply `{id, code}` pairs to a pending queue.
 *
 * Every failure mode is a structural no-op, not an error — an unknown id, a
 * wrong code, a duplicate pair, an empty list. That is the fold-decides ruling
 * (041) carried into the code world: the write site appends, the fold assigns
 * meaning, and nothing upstream has to coordinate.
 */
export function applyAck(_pending: readonly StoredEvent[], _pairs: readonly AckPair[]): StoredEvent[] {
  return notImplemented('applyAck', 'S5 ({id, code} is the only clearing path)')
}

/**
 * The `ack` event's data under the target design.
 *
 * ── THE ABSENCES ARE THE SPECIFICATION ──
 *
 * There is no `upToId` (S5: "Nothing like `upToId` exists"), and no `auto`
 * (S5: `{id, code}` is THE ONLY clearing path — infra never generates a clear on
 * an agent's behalf, which is what retires auto-clear-on-reply). Both absences
 * are asserted at the TYPE level in `s05-ack-codes.projection.test.ts`, because
 * that is where they can be checked before anything runs.
 *
 * `ledger` survives unchanged, and so does its reading rule: THE AUTHORITATIVE
 * ACK FOR AN ID IS THE FIRST IN LOG ORDER (ruling 3, task 041 — the event whose
 * fold actually cleared the id; later duplicates are structural no-ops, and a
 * reader asking a no-op about a transition it did not cause gets "unknown" for
 * an event that was demonstrably delivered).
 */
export type TargetAckData = {
  pairs: AckPair[]
  ledger?: Record<string, { deliveredVia?: string; clearedBy: 'ack' }>
}

/**
 * The pending fold under the target design.
 *
 * MUST REMAIN TOLERANT OF HISTORY. Every dojo's log already contains
 * `{eventIds: number[]}` acks — 5,537 of them across the eight dojos on this
 * machine, measured 2026-08-05. A fold that understands only `pairs` resurrects
 * every one of those long-cleared events on the next replay. See
 * `src/scenarios/historical-tolerance.projection.test.ts`.
 */
export function targetPendingReducer(_pending: readonly StoredEvent[], _event: StoredEvent): StoredEvent[] {
  return notImplemented('targetPendingReducer', 'S5 + historical tolerance')
}

/**
 * What an ack call reports back: how many of the REQUESTED ids are now cleared.
 *
 * Leonid's second correction (2026-08-04), verbatim: "Ack is idempotent, you
 * should just know the message is acked." So this reads POST-fold state and
 * gives every caller the SAME answer — two racing ackers of one id both get
 * success. Whether yours or the racing one did the clearing is a distinction
 * nobody needs, and pursuing it is what had previously required a claim
 * machinery, and then a hook on `record()`. Both died with the requirement.
 */
export function acknowledgedCount(_requested: readonly number[], _pendingAfter: readonly StoredEvent[]): number {
  return notImplemented('acknowledgedCount', 'idempotent ack responses (Leonid, 2026-08-04)')
}

/**
 * THE READING RULE (ruling 3, task 041 — STANDS through every amendment).
 *
 * How did event `id` reach its agent, read FROM THE LOG ALONE? The authoritative
 * ack is the FIRST in log order — the one whose fold actually cleared the id.
 * Later acks for the same id are structural no-ops, and a no-op's ledger entry
 * says only what a no-op can know.
 */
export function deliveredViaFor(_log: readonly StoredEvent[], _id: number): string | undefined {
  return notImplemented('deliveredViaFor', 'ledger reading rule — first ack in log order is authoritative')
}
