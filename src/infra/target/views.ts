/**
 * ██ TARGET API ██ STUB GROUP 3b — the three views (013 REFERENCE DESIGN,
 * VOCABULARY + S4 + S5).
 *
 * Canon, verbatim: "Three views: **counts** (numbers by priority) → **summary**
 * (`priority · from · message` per event) → **fetch** (everything + the ack
 * code)."
 *
 * ── THE LADDER IS THE POINT ──
 *
 * S4: "An agent with many pending events can read the summary view without
 * fetching bodies, then fetch and ack any subset as a group." Each rung costs
 * more and tells more, and an agent should be able to triage at the cheapest one
 * that answers its question. Two consequences the tests pin:
 *   - `summary` carries NO details and NO code. Details would defeat "without
 *     fetching bodies"; a code would defeat read-before-ack (S5) by making the
 *     cheap view sufficient to clear.
 *   - `fetch` carries everything AND the code — it is the only rung that does.
 *
 * ── AND THE PART THAT IS NOT ABOUT COST ──
 *
 * All three are views of ONE list through ONE filter (see mailbox-rules.ts).
 * They may differ in what they RENDER; they may not differ in what they
 * INCLUDE. A view that quietly admits or drops an event the rule disagrees with
 * is the failure that makes counts and summary tell different stories about the
 * same queue.
 */

import type { StoredEvent } from '../../es/index.ts'
import type { AckCode } from './codes.ts'
import type { RuleContext } from './mailbox-rules.ts'
import type { Priority } from './priority.ts'
import { notImplemented } from './stub.ts'

/** Numbers by priority. The cheapest rung — no ids, no text, no code. */
export type CountsView = Record<Priority, number>

/** `priority · from · message`, per event. No details, no code — deliberately. */
export type SummaryLine = {
  id: number
  priority: Priority
  from: string
  message: string
}

/** Everything, plus the ack code. The only rung that carries either. */
export type FetchedEvent = {
  id: number
  priority: Priority
  from: string
  message: string
  /** THE COMPLETE ORIGINAL (see vocabulary.ts). Absent when `message` is all
   *  there is — and its absence is exactly what the missing ellipsis promised. */
  details?: string
  code: AckCode
}

export type MailboxViews = {
  counts: () => CountsView
  summary: () => SummaryLine[]
  /** Omit `ids` for the whole mailbox. S4's "fetch and ack any subset as a
   *  group" is why this takes a selection at all — an agent that triaged from
   *  the summary should not have to pull bodies it already decided to leave. */
  fetch: (ids?: readonly number[]) => FetchedEvent[]
}

export type ViewContext = RuleContext

/** The three views of ONE agent's mailbox, built from the one pending list. */
export function viewsFor(_pending: readonly StoredEvent[], _agent: string, _ctx: ViewContext): MailboxViews {
  return notImplemented('viewsFor', 'S4 (triage) / three views')
}
