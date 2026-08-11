/**
 * Opaque priority, and the per-role push threshold (013 REFERENCE DESIGN,
 * VOCABULARY + S3; the transition, task 045 change B).
 *
 * Canon, verbatim: "Priority is an opaque number assigned by infra heuristic
 * (today: external channel → 2, else 1); agents know only that higher outranks
 * lower — no semantics in any agent-facing surface or skill text."
 *
 * ── OPAQUE HAS TWO HALVES, AND ONLY ONE IS ABOUT THIS FILE ──
 *
 * The value is a number and orders by `>`. That part is here. The other half —
 * that no agent-facing surface ever NAMES a band — is enforced where it can
 * actually be broken, in the rendering (`views.ts`), and asserted over the
 * rendered output of all three views. The moment a surface says "urgent",
 * agents and the skills written for them reason about the word instead of the
 * order, and the heuristic stops being something infra can retune.
 *
 * ── WHY THE HEURISTIC LOOKS ONLY AT THE SENDER ──
 *
 * "External channel" is the whole of it: a human on a bridge surface is
 * waiting, and nothing else in the system is. That classification already
 * exists as `isUserSender` and is SHARED rather than re-derived — the blocking
 * path and the inbox learned the hard way (review, 2026-07-24) that a second
 * opinion about who counts as a human produces a wake whose own payload
 * contradicts it.
 */

import type { StoredEvent } from '../../es/index.ts'
import { isUserSender } from '../inbox.ts'
import { agentFromEvent } from '../reducers.ts'

/** Higher outranks lower. That is the entire contract. */
export type Priority = number

/** What the heuristic is allowed to look at. Deliberately tiny: an event and a
 *  role lookup. Anything more and "infra heuristic" becomes "infra policy
 *  engine", which is not what was designed. */
export type PriorityContext = {
  roleOf: (name: string) => string | undefined
}

/** DIAL — today's bands. Config, not requirement (013: "Config values … are
 *  deliberately NOT requirements"). */
const EXTERNAL = 2
const ROUTINE = 1

/**
 * Who PRODUCED this event, for classification and display. The five-meanings
 * trap (mailbox-rules.ts) reaches here too: `data.agent` is the sender on
 * `reply` but the ADDRESSEE on `send`, and an addressee-read prices a message
 * by who it is FOR — a sensei→human send would read as a waiting human. Inert
 * while sends never entered pending; load-bearing since queued sends carry
 * priorities into mailboxes (the unification).
 *
 * EXPORTED because the views' `from` column is the same question (architect's
 * F1, same round): a summary line naming the addressee in the column that
 * says who spoke would show an agent words "from" someone who never said
 * them. One reading, two surfaces — a second opinion here is how the trap
 * bites a sixth time.
 */
export function senderOf(event: StoredEvent): string | undefined {
  if (event.type === 'send') {
    const from = (event.data as { from?: unknown }).from
    return typeof from === 'string' ? from : undefined
  }
  return agentFromEvent(event)
}

/** Infra's heuristic. Total — every event gets a number. */
export function priorityOf(event: StoredEvent, ctx: PriorityContext): Priority {
  const sender = senderOf(event)
  return sender && isUserSender(sender, ctx.roleOf) ? EXTERNAL : ROUTINE
}

/**
 * The per-role push threshold (S3).
 *
 * DIAL. The REQUIREMENT is the order — a worker is interrupted by more than the
 * orchestrator is, because the orchestrator is the one holding a queue to
 * triage and the worker is the one holding the work.
 */
export function thresholdFor(role: string): Priority {
  return role === 'sensei' ? EXTERNAL : ROUTINE
}
