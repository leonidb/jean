/**
 * ██ TARGET API ██ STUB GROUP 1 — opaque priority (013 REFERENCE DESIGN,
 * VOCABULARY; 042 A4 — `priority` has 0 references on main).
 *
 * Canon, verbatim: "Priority is an opaque number assigned by infra heuristic
 * (today: external channel → 2, else 1); agents know only that higher outranks
 * lower — no semantics in any agent-facing surface or skill text."
 *
 * ── OPAQUE IS A TESTABLE CLAIM, NOT A STYLE NOTE ──
 *
 * Two halves, and only the first is obvious:
 *   - the VALUE is a number and orders by >. That part is easy.
 *   - NO AGENT-FACING SURFACE NAMES IT. The moment a view emits "urgent" or
 *     "high", agents (and the skills written for them) start reasoning about the
 *     label instead of the order, and the heuristic stops being a dial infra can
 *     turn. `views.projection.test.ts` asserts this over the rendered output of
 *     all three views, which is the only place it can actually be broken.
 *
 * The 2-vs-1 heuristic is a DIAL (013: "Config values … are deliberately NOT
 * requirements"). Tests that pin the specific numbers say so at the assertion.
 */

import type { StoredEvent } from '../../es/index.ts'
import { notImplemented } from './stub.ts'

/** Higher outranks lower. That is the entire contract. */
export type Priority = number

/** What the heuristic is allowed to look at. Deliberately tiny: an event and a
 *  role lookup. Anything more and "infra heuristic" becomes "infra policy
 *  engine", which is not what was designed. */
export type PriorityContext = {
  /** Live-registry role lookup, as everywhere else in the codebase. */
  roleOf: (name: string) => string | undefined
}

/** Infra's heuristic. Total — every event gets a number. */
export function priorityOf(_event: StoredEvent, _ctx: PriorityContext): Priority {
  return notImplemented('priorityOf', 'VOCABULARY (opaque priority)')
}

/**
 * The per-role push threshold (S3). A dial, in one place, so scenario 3's
 * assertions can move it rather than hard-coding infra's current opinion.
 *
 * Config today, per canon: worker = 1, sensei = 2.
 */
export function thresholdFor(_role: string): Priority {
  return notImplemented('thresholdFor', 'S3 (push threshold)')
}
