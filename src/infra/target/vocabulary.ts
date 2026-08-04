/**
 * ██ TARGET API ██ STUB GROUP 4 — the event vocabulary (013 REFERENCE DESIGN,
 * VOCABULARY block; unblocked by Leonid's ruling (b), 2026-08-05: IN SCOPE).
 *
 * Canon, verbatim: "An event is `message` + optional `details` — details always
 * the complete original content, never a remainder. Derived messages are first
 * line + \" …\"; the ellipsis means there is more, its absence means you've seen
 * everything but the code."
 *
 * ── THE TWO CLAUSES THAT ARE EASY TO GET WRONG, STATED APART ──
 *
 * 1. `details` IS THE COMPLETE ORIGINAL, NOT THE TAIL. The obvious
 *    implementation — message = head, details = what's left — is the one the
 *    canon rules out by name. An agent reading `details` must never have to
 *    reassemble it from two fields.
 * 2. THE ELLIPSIS IS A PROMISE IN BOTH DIRECTIONS. Present ⇒ there is more.
 *    ABSENT ⇒ there is nothing more (except the ack code). A message truncated
 *    without the marker is the failure this contract exists to forbid, because
 *    it silently converts "the agent has read everything" into a wrong belief.
 *
 * ── WHY THIS IS ITS OWN GROUP RATHER THAN PART OF THE VIEWS ──
 *
 * 042's AMBIGUITY-1: the vocabulary had no owning commit, and the views were
 * specced as consumers of a shape nobody had declared. Declared here, so a view
 * cannot ship without it.
 */

import type { StoredEvent } from '../../es/index.ts'
import { notImplemented } from './stub.ts'

/** The two-field shape every agent-facing surface renders from. */
export type EventMessage = {
  /** One line. Ends with the ellipsis marker iff `details` holds more. */
  message: string
  /** THE COMPLETE ORIGINAL — never a remainder. Absent when the message is
   *  already the whole of it. */
  details?: string
}

/** The marker, exported so tests assert against the contract rather than
 *  against a hard-coded space-and-dots that could drift. */
export const ELLIPSIS = ' …'

/**
 * Derive the one-line message from arbitrary original text.
 *
 * Pure and total: no event, no clock, no registry. First line plus the marker
 * when anything follows it; the text itself when nothing does.
 */
export function derive(_original: string): string {
  return notImplemented('derive', 'VOCABULARY (ellipsis contract)')
}

/** The vocabulary shape for one stored event: what an agent sees, and the
 *  complete original behind it. */
export function messageOf(_event: StoredEvent): EventMessage {
  return notImplemented('messageOf', 'VOCABULARY (message + details)')
}
