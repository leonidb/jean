/**
 * ██ TARGET API ██ STUB GROUP 3a — the mailbox filter rules, in ONE named
 * module (Leonid's ruling (c), 2026-08-05).
 *
 * ── THE RULING, AND WHY IT DISSOLVED THE QUESTION IT ANSWERED ──
 *
 * The open item was binary: is the sensei's mailbox the WHOLE queue (overlap) or
 * only the unowned part (partition)? 040 had ruled overlap on the merits; 042
 * flagged that ruling as an un-ratified sensei interpretation. Leonid's answer
 * was neither option: *"overlap or partition just means the views are
 * projections based on filters over the same list; the answer can be in between
 * … it should be designed flexibly."*
 *
 * So the architecture is: ONE pending list. Each agent's mailbox is a NAMED
 * FILTER over it. The rules live here, together, and they are DIALS — turnable
 * without touching anything structural. There is no per-agent stored projection
 * and no second reducer; a mailbox is a question you ask the one list.
 *
 * ── WHAT IS CONTRACT AND WHAT IS DIAL, STATED SO TESTS CAN SPLIT THEM ──
 *
 * CONTRACT (asserted as mechanism in `views.projection.test.ts`):
 *   - every view is a FILTER of the one list: subset, order-preserving, nothing
 *     invented, nothing rewritten;
 *   - an event is in an agent's mailbox IFF that agent's rule admits it —
 *     no second condition hiding in the view layer.
 *
 * DIAL (asserted as CHARACTERIZATION, marked as such at the assertion):
 *   - the initial rule-set = today's semantics. Sensei: everything minus its own
 *     self-events. Worker: the slice addressed to it.
 * Changing a dial must change only the characterization cases. If it breaks a
 * contract case, the change was not a dial.
 */

import type { StoredEvent } from '../../es/index.ts'
import { notImplemented } from './stub.ts'

/** What a rule may look at. As narrow as `PriorityContext`, and for the same
 *  reason: a rule that can reach the world is not a dial any more. */
export type RuleContext = {
  roleOf: (name: string) => string | undefined
  /** "Who owns this task?" — the board lookup, as in core/queue.ts. */
  taskOwner: (taskId: string) => { agent?: string; queue?: string } | undefined
}

/** One agent's admission rule. Pure predicate over a single event. */
export type MailboxRule = (event: StoredEvent, agent: string, ctx: RuleContext) => boolean

/**
 * The rule for one agent, resolved by its role.
 *
 * A FUNCTION rather than a `Record<role, rule>` so that "no role registered yet"
 * has an answer instead of an undefined lookup — the never-registered dojo is a
 * real state (task 040's accepted corner) and it reaches here too.
 */
export function ruleFor(_agent: string, _ctx: RuleContext): MailboxRule {
  return notImplemented('ruleFor', 'mailbox filter rules (Leonid ruling (c))')
}

/** The mailbox: the one list, filtered. Order-preserving by construction —
 *  that is the property `views.projection.test.ts` pins as CONTRACT. */
export function mailboxFor(_pending: readonly StoredEvent[], _agent: string, _ctx: RuleContext): StoredEvent[] {
  return notImplemented('mailboxFor', 'mailbox = one list + per-agent filter')
}
