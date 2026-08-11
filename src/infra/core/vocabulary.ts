/**
 * The event vocabulary — `message` + `details`, and the ellipsis contract
 * (013 REFERENCE DESIGN, VOCABULARY block; the transition, task 045 change A).
 *
 * Canon, verbatim: "An event is `message` + optional `details` — details always
 * the complete original content, never a remainder. Derived messages are first
 * line + \" …\"; the ellipsis means there is more, its absence means you've seen
 * everything but the code."
 *
 * ── THE TWO CLAUSES, AND WHY EACH IS EASY TO BREAK ──
 *
 * 1. `details` IS THE COMPLETE ORIGINAL. The obvious implementation is
 *    message = head, details = tail; the canon rules that out by name, because
 *    an agent reading `details` would otherwise have to reassemble the original
 *    from two fields and would never know it had to.
 * 2. THE ELLIPSIS IS A PROMISE IN BOTH DIRECTIONS. Present ⇒ there is more.
 *    ABSENT ⇒ there is nothing more. The second half is the one that costs
 *    something: it forbids truncating by WIDTH, because a line shortened to fit
 *    a terminal and marked with the same glyph would promise content a fetch
 *    cannot deliver.
 *
 * ── WHY MACHINE EVENTS GET A MESSAGE TOO ──
 *
 * Most events carry no `text` at all — `register`, `disconnect`,
 * `trigger-fired`, `wiki-consolidated`. Every one of them reaches a summary
 * line, so a vocabulary that only works for replies is not a vocabulary. They
 * fall back to a single generated line, which by construction carries no marker
 * and no details: there is genuinely nothing more to fetch.
 */

import type { StoredEvent } from '../../es/index.ts'
import { agentFromEvent } from '../reducers.ts'

/** The two-field shape every agent-facing surface renders from. */
export type EventMessage = {
  /** One line. Ends with the ellipsis marker iff `details` holds more. */
  message: string
  /** THE COMPLETE ORIGINAL — never a remainder. Absent when the message is
   *  already the whole of it. */
  details?: string
}

/** The marker. Exported so callers and tests assert against the contract rather
 *  than a hard-coded glyph that could drift on either side. */
export const ELLIPSIS = ' …'

/**
 * The single decision both surfaces below are built on: the first line, and
 * whether anything of SUBSTANCE follows it.
 *
 * SUBSTANCE, not "a newline exists" — `'done\n'` splits into two lines and has
 * nothing more to say. Marking it would promise a second line that is empty,
 * and (the bug this shape fixes, caught by the marker-iff-details case)
 * attaching `details` to it would attach a copy that differs from the message
 * only by a trailing newline.
 *
 * Shared so the marker and `details` can never disagree: they are two readings
 * of one boolean rather than two computations that happen to line up.
 */
function split(original: string): { head: string; more: boolean } {
  const nl = original.indexOf('\n')
  if (nl === -1) return { head: original, more: false }
  return { head: original.slice(0, nl), more: original.slice(nl + 1).trim() !== '' }
}

/** Derive the one-line message from arbitrary original text. Pure and total. */
export function derive(original: string): string {
  const { head, more } = split(original)
  return more ? `${head}${ELLIPSIS}` : head
}

/** A single line for an event that carries no text of its own. Deliberately
 *  boring and deliberately one line — see the header. */
function describeMachineEvent(event: StoredEvent): string {
  const agent = agentFromEvent(event)
  return agent ? `${event.type} — ${agent}` : event.type
}

/** The original content behind an event, whatever shape it arrived in. */
function originalOf(event: StoredEvent): string {
  const text = (event.data as { text?: unknown }).text
  if (typeof text === 'string' && text.trim() !== '') return text
  return describeMachineEvent(event)
}

/** The vocabulary shape for one stored event. */
export function messageOf(event: StoredEvent): EventMessage {
  const original = originalOf(event)
  const { head, more } = split(original)
  // ONE boolean drives both fields, which is what makes "marker present IFF
  // details present" an invariant rather than a coincidence two branches have
  // to maintain.
  return more ? { message: `${head}${ELLIPSIS}`, details: original } : { message: head }
}
