/**
 * Routing — where a send goes (contract `contracts/routing.ts`, task D6).
 *
 * ── ONE QUESTION, ASKED ONCE ──
 *
 * "Does this name hold a mailbox?" — and `holdsMailbox` below is the only
 * place it is asked. Everything else about the decision follows from the
 * answer: a mailbox-holder queues, anything else goes to an adapter.
 *
 * The old code asked it twice in two spellings: a CONNECTED target was tested
 * by live role (`entry.role === 'sensei' || 'worker'`), a disconnected one by
 * the persisted dojo set. Ruled at extraction as one question with the live
 * role taking precedence — which is `agents.roleOf`'s own precedence — so both
 * facts arrive resolved and the branch collapses into a single predicate. That
 * collapse is the point: two spellings of one question is how the answers
 * come to differ.
 *
 * Under one-role-many-agents nothing here changes. The test is on the target's
 * OWN resolved role; it never asks whether a role is uniquely held.
 *
 * ── THE TWO ROUTES SHARE ONE PAYLOAD BUILDER ──
 *
 * `basePayload` builds the common fields, and each route adds exactly the one
 * field that distinguishes it: `queued: true` on the queue path, `delivered`
 * on the adapter path. Nothing else may differ, and building them separately
 * is how a field ends up on one route and not the other — the enrichment the
 * conformance suite checks on BOTH routes is precisely that class of bug.
 *
 * ── WHY THE ADAPTER'S RECORD IS A FUNCTION ──
 *
 * `delivered` is not knowable until the transport has been attempted, so the
 * adapter route hands back a builder rather than a record. That is what keeps
 * a failed handover from being recorded as a success: there is no value the
 * shell can append without first saying what happened.
 *
 * And the queue route carries NO notice mechanism at all — not an unused one.
 * An offline dojo agent's mail queuing is the mailbox model working, so there
 * is nothing to warn about, and a notice field sitting there unused would
 * eventually get filled in by someone reading it as an omission.
 *
 * ── ENRICHMENT IS THE RECEIVER'S OWN RECORD ──
 *
 * `senderPeerDescription` comes from this dojo's own peer record, never from
 * the message: a peer cannot rewrite its own description per send. Its
 * PRESENCE is what marks the sender as a peer — the contract carries no
 * separate "is a peer" fact — so the two fields are written together, exactly
 * as the old code wrote them, and an empty description is written as the empty
 * string it is rather than being read as "not a peer".
 *
 * What this file cannot enforce, and what does: the queue-vs-adapter line, the
 * never-notify-on-queue rule and the enrichment source are held by
 * `routing.conformance.test.ts`.
 */

import type { RouteDecision, RoutingContract, RoutingFacts, SendCommand } from '../contracts/routing.ts'
import type { AgentName, AgentRole, SendData } from '../contracts/vocabulary.ts'
import { agentStream, taskStream } from '../contracts/vocabulary.ts'

/** The roles that hold a mailbox. Not "the roles that are agents" — a `user`
 *  and a `peer` are agents in every other sense and hold no mailbox, which is
 *  the whole distinction this module turns on. */
const MAILBOX_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>(['sensei', 'worker'])

/**
 * THE question, and now it can actually be asked. A LIVE session answers it
 * outright: a name connected as a `user` is a user whatever its record once
 * said, because the session is the newer fact. Only when nothing is connected
 * does the record decide, and then it answers the one case it is for — a dojo
 * agent that is simply away, whose mail queues.
 *
 * This module's first version could not express that. `RoutingFacts` gave it a
 * single `resolvedRole` with live and persisted already conflated, so
 * "connected as a user" and "disconnected dojo agent whose record also says
 * user" arrived as the same tuple — and the second one, whose mail should
 * queue, went to an adapter with an undelivered warning. Ruled and fixed in the
 * contract (task 091); `liveRole` is separate now, and the branch below is the
 * ruling rather than a guess at it.
 */
function holdsMailbox(facts: RoutingFacts): boolean {
  return facts.liveRole !== undefined ? MAILBOX_ROLES.has(facts.liveRole) : facts.isDojoAgentEver
}

const streamFor = (to: AgentName, taskId?: string): string =>
  // Truthiness, not `!== undefined`: an empty taskId names no task, and the
  // old router tested it the same way. `task-` with nothing after it would be
  // a stream nobody reads.
  taskId ? taskStream(taskId) : agentStream(to)

/**
 * Everything both routes record. The distinguishing field is added by the
 * caller — see the header on why this is one function.
 */
function basePayload(cmd: SendCommand, facts: RoutingFacts): SendData {
  return {
    agent: cmd.to,
    from: cmd.from,
    text: cmd.text,
    // `?.length` rather than presence: an empty array is no attachments, and
    // recording the empty array would put a field on the event that means
    // nothing.
    ...(cmd.attachments?.length && { attachments: [...cmd.attachments] }),
    // Written together, because the description's presence IS the peer signal.
    ...(facts.senderPeerDescription !== undefined && {
      senderRole: 'peer' as const,
      peerDescription: facts.senderPeerDescription,
    }),
  }
}

export const routing: RoutingContract = {
  streamFor,

  decideSend(cmd: SendCommand, facts: RoutingFacts): RouteDecision {
    const stream = streamFor(cmd.to, cmd.taskId)

    if (holdsMailbox(facts)) {
      return {
        route: 'queue',
        stream,
        data: {
          ...basePayload(cmd, facts),
          // THE ADMISSION FLAG, written here and only here: the write site
          // decides, the fold applies. Its absence is what keeps every
          // adapter-path send — and every historical one — out of pending.
          queued: true,
        },
      }
    }

    return {
      route: 'adapter',
      stream,
      data: (delivered: boolean) => ({
        ...basePayload(cmd, facts),
        // `delivered` and never `queued`: this send was handed to a transport,
        // so nobody holds a pair on it and nothing is waiting to be acked.
        delivered,
      }),
      // THE REASON, NOT THE WHOLE NOTICE. The old split put the wording in the
      // adapter (`notifyUndelivered` composes the warning, the target's name
      // and the what-to-check advice) and gave the domain only the reason.
      // Kept: naming the target here would print it twice once an adapter
      // composes as before, and the presentation belongs where the surface is
      // known (codex pass, task 091).
      //
      // The reason stays vague about WHICH of the two it was, deliberately:
      // from here the dojo cannot tell an unknown name from a known one that is
      // offline, and a message that guessed would send the sender to fix the
      // wrong thing.
      undeliveredNotice: (delivered: boolean) =>
        delivered ? undefined : 'no agent or peer by that name is registered here, or it is offline',
    }
  },
}
