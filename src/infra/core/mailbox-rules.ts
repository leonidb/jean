/**
 * The mailbox filter rules, in ONE named module (Leonid's ruling (c),
 * 2026-08-05; the transition, task 045 change C).
 *
 * ── THE RULING, AND WHY IT DISSOLVED THE QUESTION IT ANSWERED ──
 *
 * The open item was binary — is the sensei's mailbox the whole queue (overlap)
 * or only the unowned part (partition)? The answer was neither: "overlap or
 * partition just means the views are projections based on filters over the same
 * list; the answer can be in between … it should be designed flexibly."
 *
 * So: ONE pending list. Each agent's mailbox is a NAMED FILTER over it. The
 * rules live here, together, and they are DIALS — turnable without touching
 * anything structural. No per-agent stored projection, no second reducer.
 *
 * ── CONTRACT vs DIAL ──
 *
 * CONTRACT (and `views.projection.test.ts` asserts it as mechanism): a mailbox
 * is a filter — subset, order-preserving, nothing invented, nothing rewritten —
 * and an event is in it IFF the rule admits it. No view gets a second opinion.
 *
 * DIAL (asserted as characterization): the rules below. Change one and only the
 * cases marked DIAL should move. If a rule change turns a CONTRACT case red,
 * the change was not a dial.
 *
 * ── `data.agent` MEANS FIVE DIFFERENT THINGS, AND THAT IS THE TRAP HERE ──
 *
 * Enumerated against 10,783 real events by the halted phase-5.0 work
 * (an abandoned phase-5 commit): addressee (`send`), sender (`reply`), author (`task-comment`),
 * subject (`register`/`disconnect`/`agent-idle`), target
 * (`trigger-created`/`trigger-fired`), assignee (`task-updated`).
 *
 * `authorOf` below therefore SWITCHES ON TYPE instead of reading `data.agent`
 * and hoping. Reading it blindly costs a real defect, caught while writing this:
 * a `trigger-fired` addressed TO the sensei carries `agent: 'sensei'`, so a
 * naive self-event rule drops every scheduled firing out of the sensei's own
 * mailbox — silently, and exactly for the events it most needs.
 *
 * ── ONE KNOWN IMPRECISION, RECORDED AS A DIAL RATHER THAN FIXED HERE ──
 *
 * The worker rule uses `resolveAgent`, which answers "which agent does this
 * event CONCERN" — conflating sender, subject and assignee. The precise notion
 * is `recipientOf` (phase 5.0, halted at an abandoned phase-5 commit with its corpus findings
 * intact). Until that lands, "addressed slice" means "concerns this agent",
 * which over-delivers rather than under-delivers — the safe direction, and the
 * one 5.0 chose for the same reason.
 *
 * ── PARKED (Leonid, 2026-08-11, recorded with task 050 — DO NOT build yet) ──
 *
 * MEMBERSHIP IS PROBABLY TOO BROAD. Observed the same day the nag defect was
 * ruled on: the sensei's first act of a fresh session was fetching and acking
 * its own two `disconnect` records — the deliberate exception below, working
 * as designed, and still reading as noise an agent must pay codes to clear.
 * The general question is which lifecycle records EARN a mailbox slot versus
 * merely existing in the log. Leonid's words: "not substantial, a specific
 * optimization for later." When it is picked up, start from the enumerated
 * meanings above and the A2 invariant (admitted ⇒ in at least one mailbox) —
 * narrowing membership must not orphan anything that is still in pending.
 */

import type { StoredEvent } from '../../es/index.ts'
import { resolveAgent, type TaskOwner } from './queue.ts'

/** What a rule may look at. As narrow as `PriorityContext`, and for the same
 *  reason: a rule that can reach the world is not a dial any more. */
export type RuleContext = {
  roleOf: (name: string) => string | undefined
  taskOwner: TaskOwner
}

/** One agent's admission rule. Pure predicate over a single event. */
export type MailboxRule = (event: StoredEvent, agent: string, ctx: RuleContext) => boolean

/**
 * Who PRODUCED this event — not who it is about, and not who it is for.
 *
 * Returns undefined when the event has no author in the relevant sense, which
 * includes every case where `data.agent` means something else. Undefined is the
 * safe answer: it can only cause an event to be KEPT.
 */
function authorOf(event: StoredEvent): string | undefined {
  const d = event.data as { agent?: unknown; from?: unknown }
  switch (event.type) {
    case 'reply':
    case 'task-comment':
    case 'memory':
      return typeof d.agent === 'string' ? d.agent : undefined
    case 'send':
      return typeof d.from === 'string' ? d.from : undefined
    // The agent's OWN LIFECYCLE. `data.agent` is the subject here rather than
    // an author in the strict sense, but for mailbox purposes the distinction
    // does not exist: an agent has no use for the news that it connected —
    // nor for its own status notice (H4's `worker-status`, which exists so the
    // SENSEI acts). Everyone ELSE does, which is why these stay in the
    // sensei's mailbox. `worker-status` can never orphan on this rule: its
    // subject is only ever a worker (the supervisor watches role 'worker'
    // exclusively), so the sensei's universal mailbox always claims it — the
    // same jointly-held shape as the sensei-reply case in
    // `mailbox-rules.test.ts`.
    case 'register':
    case 'agent-idle':
    case 'worker-status':
      return typeof d.agent === 'string' ? d.agent : undefined

    // `agent-unresponsive` is NOT in that list — it follows `disconnect`'s
    // precedent below, and for `disconnect`'s reason. S11 watches the sensei
    // too ("the sensei itself is subject to the same rule", E6), so a report
    // ABOUT the sensei exists — and the sensei's mailbox is the only universal
    // one, so treating the report as the subject's self-event would orphan it:
    // in pending, in nobody's mailbox, unclearable forever (the A2 class,
    // caught by this file's own invariant test before it shipped). And the
    // disconnect argument holds on the merits: by the time the subject can
    // read the report, it is a RECOVERED session learning it was reported
    // broken while it was gone. That is news.
    case 'agent-unresponsive':
      return undefined

    // `disconnect` IS NOT IN THAT LIST, and the exception is load-bearing.
    //
    // THE DEFECT IT FIXES (found by reading the pending reducer against this
    // rule, task 045; no test in either suite could see it). The sensei's
    // mailbox is the only universal one, so an event the SENSEI authored that
    // still enters pending is in NOBODY's mailbox — and an event in nobody's
    // mailbox can never be fetched, so it can never be acked, so it sits in the
    // queue forever inflating every count. The pending reducer already drops the
    // sensei's own `task-comment` and `register` for exactly this reason. It
    // KEEPS `disconnect`, deliberately and with its reason written down: "when
    // the sensei reconnects it sees the disconnect in pending." Treating that as
    // a self-event orphaned one event per sensei restart, permanently.
    //
    // And the reducer is right on the merits: "an agent has no use for the news
    // that it connected" is true of `register` and `agent-idle`, which arrive
    // while it is running. A `disconnect` is different in kind — by the time
    // anything can read it, the session that produced it is gone, so the reader
    // is a new session learning that it was restarted. That is news.
    //
    // THE GENERAL INVARIANT behind this, raised for ruling rather than built
    // here: every event admitted to pending must be in at least one agent's
    // mailbox. `mailbox-rules.test.ts` pins the instance; nothing yet pins the
    // rule, and the next event type added to the reducer can break it again.
    case 'disconnect':
      return undefined
    default:
      // `trigger-fired`, `task-*`, … — `data.agent` here is a target or an
      // assignee, and neither is an author. Undefined is the safe answer: it
      // can only cause an event to be KEPT.
      return undefined
  }
}

/**
 * The rule for one agent, resolved by its role.
 *
 * A FUNCTION rather than a `Record<role, rule>` so that "no role registered
 * yet" has an answer instead of an undefined lookup — the never-registered
 * dojo is a real state (task 040's accepted corner) and it reaches here too.
 */
export function ruleFor(agent: string, ctx: RuleContext): MailboxRule {
  // ONE RULE, TWO DIALS: "does this concern me" AND "did I not produce it".
  //
  // The second half is uniform across roles, and it is uniform because the
  // reason is: a mailbox is what an agent has to ACT on, and its own utterances
  // are not that. Leonid's example was the sensei ("no need for the sensei to
  // see a message he himself sent to a worker as his own event"); applying it
  // only to the sensei would have been a role branch in a system whose canon
  // says one mechanism for sensei and worker (E6).
  const concernsMe: (event: StoredEvent, self: string) => boolean =
    // DIAL — the orchestrator's mailbox is the whole list.
    ctx.roleOf(agent) === 'sensei'
      ? () => true
      : // DIAL — a worker's is the slice that concerns it. See the header on
        // `recipientOf` for what "concerns" will eventually mean more precisely.
        (event, self) => resolveAgent(event, ctx.taskOwner) === self
  return (event, self) => concernsMe(event, self) && authorOf(event) !== self
}

/** The mailbox: the one list, filtered. Order-preserving by construction —
 *  `Array.filter` is the whole implementation, and that is the point. */
export function mailboxFor(pending: readonly StoredEvent[], agent: string, ctx: RuleContext): StoredEvent[] {
  const rule = ruleFor(agent, ctx)
  return pending.filter((e) => rule(e, agent, ctx))
}
