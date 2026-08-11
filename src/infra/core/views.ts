/**
 * The three views — counts → summary → fetch (013 VOCABULARY + S4 + S5;
 * the transition, task 045 change E).
 *
 * Canon, verbatim: "Three views: **counts** (numbers by priority) → **summary**
 * (`priority · from · message` per event) → **fetch** (everything + the ack
 * code)."
 *
 * ── THE LADDER IS THE POINT, AND EACH RUNG'S OMISSIONS ARE LOAD-BEARING ──
 *
 * S4: "An agent with many pending events can read the summary view without
 * fetching bodies, then fetch and ack any subset as a group."
 *   - `summary` carries NO details — details would defeat "without fetching
 *     bodies", which is the whole saving.
 *   - `summary` carries NO code — a code on the cheap rung would defeat
 *     read-before-ack (S5) by making the cheap rung sufficient to CLEAR.
 *   - `fetch` carries both, and is the only rung that carries either.
 *
 * ── ONE FILTER, THREE RENDERINGS ──
 *
 * All three are views of ONE list through ONE rule (`mailbox-rules.ts`). They
 * may differ in what they RENDER; they may not differ in what they INCLUDE. A
 * view that quietly admits or drops one event is how counts and summary come to
 * tell different stories about the same queue, with nothing in the rules module
 * to explain it.
 *
 * ── PRIORITY STAYS OPAQUE HERE, WHICH IS WHERE IT COULD STOP BEING ──
 *
 * `counts` is keyed by the NUMBER. No band names, in any rung, ever: the moment
 * a surface says "urgent", agents and the skills written for them reason about
 * the word instead of the order, and infra's heuristic stops being a dial.
 */

import type { StoredEvent } from '../../es/index.ts'
import { type AckCode, codeFor } from './codes.ts'
import { mailboxFor, type RuleContext } from './mailbox-rules.ts'
import { type Priority, priorityOf, senderOf } from './priority.ts'
import { messageOf } from './vocabulary.ts'

/** Numbers by priority. The cheapest rung — no ids, no text, no code. */
export type CountsView = Record<Priority, number>

/** `priority · from · message`, per event. No details, no code — deliberately. */
export type SummaryLine = {
  id: number
  priority: Priority
  from: string
  message: string
}

/** Everything, plus the ack code. */
export type FetchedEvent = {
  id: number
  priority: Priority
  from: string
  message: string
  /** THE COMPLETE ORIGINAL. Absent when `message` is all there is — and its
   *  absence is exactly what the missing ellipsis promised. */
  details?: string
  code: AckCode
}

export type MailboxViews = {
  counts: () => CountsView
  summary: () => SummaryLine[]
  /** Omit `ids` for the whole mailbox. S4's "fetch and ack any subset as a
   *  group" is why this takes a selection: an agent that triaged from the
   *  summary should not have to pull bodies it already decided to leave. */
  fetch: (ids?: readonly number[]) => FetchedEvent[]
}

export type ViewContext = RuleContext

/** Who an event is from, for display — the SENDER, by the same reading the
 *  priority heuristic uses (`senderOf`; architect's F1). The old
 *  `agentFromEvent` read named the ADDRESSEE for send events, so a queued
 *  dispatch rendered as words "from" whoever it was sent TO — a sensei's
 *  outbound answer shown as the human speaking. Falls back to the stream's
 *  own name rather than to a placeholder — "unknown" in a summary column is a
 *  support ticket, and every event in the log came from somewhere. */
function fromOf(event: StoredEvent): string {
  return senderOf(event) ?? event.stream
}

/** The three views of ONE agent's mailbox, built from the one pending list. */
export function viewsFor(pending: readonly StoredEvent[], agent: string, ctx: ViewContext): MailboxViews {
  // Resolved ONCE per call and shared by the three rungs — that is what makes
  // "they differ in rendering only" true by construction rather than by three
  // implementations agreeing. Note this is per CALL, not cached across calls:
  // S6 (fresh counts) requires every view to describe the queue as it is when
  // asked.
  const box = mailboxFor(pending, agent, ctx)
  const line = (event: StoredEvent) => ({
    id: event.id,
    priority: priorityOf(event, ctx),
    from: fromOf(event),
    ...messageOf(event),
  })

  return {
    counts() {
      const counts: CountsView = {}
      for (const event of box) {
        const p = priorityOf(event, ctx)
        counts[p] = (counts[p] ?? 0) + 1
      }
      return counts
    },

    summary() {
      // `details` is dropped HERE, explicitly, rather than never computed —
      // one shared builder keeps the message identical across the two rungs,
      // and an agent comparing a summary line to a fetched body must not find
      // them worded differently.
      return box.map((event) => {
        const { details: _details, ...rest } = line(event)
        return rest
      })
    },

    fetch(ids) {
      const wanted = ids === undefined ? null : new Set(ids)
      return box
        .filter((event) => wanted === null || wanted.has(event.id))
        .map((event) => ({ ...line(event), code: codeFor(event) }))
    },
  }
}
