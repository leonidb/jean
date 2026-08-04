/**
 * ██ TARGET API ██ STUB GROUP 7b — the parked-work digest (013 REFERENCE DESIGN
 * S9; 042 DEVIATION-5, which found it had no owning commit at all).
 *
 * Canon, verbatim: "Parked work stays visible. Externally-blocked tasks appear
 * as a daily one-line list with per-item age. They never interrupt and never
 * silently vanish."
 *
 * ── THREE REQUIREMENTS, AND ONLY ONE OF THEM IS ABOUT FORMATTING ──
 *
 * 1. ONE LINE PER PARKED TASK, WITH ITS AGE. The age is what makes the list
 *    actionable: a list without ages reads the same on day 1 and day 30.
 * 2. NEVER INTERRUPTS. It is a scheduled digest, not a push. Mechanism settled
 *    by O1 — calendar-like schedules ride the regular trigger scheduler — which
 *    is why the delivery half is a WIRING test and this half is pure.
 * 3. NEVER SILENTLY VANISHES. The hard one, and the reason this is a real test
 *    rather than a formatting check: a task must not fall off the list because
 *    it got old, because the list got long, or because nothing happened to it.
 *    Truncation with an ellipsis would satisfy "one line each" and violate this.
 *
 * ── ONE INTERPRETATION, FLAGGED RATHER THAN TAKEN SILENTLY ──
 *
 * "Externally-blocked" is not defined against S7's four `blockedOn` values. The
 * natural reading — and the one `isParked` encodes — is the three the dojo
 * cannot act on itself (`human`, `external`, `time`), with `sensei` excluded
 * because the sensei-held nag ladder (S7/S8) already covers it and a task would
 * otherwise be both nagged and digested. **This is an interpretation, not canon,
 * and it is raised on task 044's board comment.** It lives behind this one
 * predicate precisely so that a different ruling is a one-line change and only
 * the case marked as its characterization moves.
 */

import type { TargetBoard, TargetTask } from './blocked.ts'
import { notImplemented } from './stub.ts'

/** Is this task "parked" for digest purposes? THE INTERPRETATION LIVES HERE —
 *  see the header. */
export function isParked(_task: TargetTask): boolean {
  return notImplemented('isParked', 'S9 (parked work stays visible)')
}

/**
 * The digest: one line per parked task, each carrying that task's age.
 *
 * Pure over board state and a clock, so "what does the list say on day 30?" is a
 * number rather than thirty days of wall time.
 */
export function buildDigest(_board: TargetBoard, _now: number): string[] {
  return notImplemented('buildDigest', 'S9 (daily one-line list with per-item age)')
}
