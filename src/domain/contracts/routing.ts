/**
 * The routing contract — where a send goes (design §3/§4; the old
 * `routeSend` read under §8's extraction discipline; task 087's report
 * carries the calls).
 *
 * ── THE ONE DECISION ──
 *
 * A send is either QUEUED (the target holds a mailbox — the mailbox is
 * truth, delivery is the announcement machinery's job, and being away costs
 * nothing) or handed to an ADAPTER synchronously (peer HTTP hop, bridge
 * surface, a connected non-dojo session). The line between the two is
 * MAILBOX-HOLDING, and mailbox-holders are the dojo agents.
 *
 * ── THE ROLE TEST — corrected at D6's hold (task 092 round) ──
 *
 * The first version of this contract collapsed live and persisted into one
 * `resolvedRole`, and D6's builder proved the conflation loses exactly the
 * information the route needs: a name CONNECTED as user and a DISCONNECTED
 * dojo agent who once registered as user arrived as the identical tuple —
 * yet the first must go to the adapter and the second must QUEUE (a
 * merely-away mailbox-holder was getting its mail handed to a dead adapter
 * and its sender told nothing was delivered). The fix is this module's own
 * §3 law applied to itself — the two sources of fact stay SEPARATE:
 *
 *   liveRole present, mailbox-holding (sensei|worker)  → queue
 *   liveRole present, anything else (user|peer|…)      → adapter — the live
 *                                                        session is where
 *                                                        this name is
 *                                                        reachable NOW
 *   no live session                                    → the RECORD decides:
 *                                                        ever a dojo agent →
 *                                                        queue (being away
 *                                                        costs nothing);
 *                                                        else → adapter
 *
 * Under one-role-many-agents nothing changes: the test is on the target's
 * own facts, never on role uniqueness.
 *
 * ── FACTS vs COMMANDS (ruled here, the law for every module) ──
 *
 * COMMANDS cross the boundary from outside — the domain validates them and
 * refuses typed (the adapter renames, never judges). FACTS are composed by
 * the shell from other domain modules' outputs; they are THE COMPOSER'S
 * GUARANTEE, consumed without defensive re-validation — a consumer
 * second-guessing a fact is a second source of judgement about something
 * the fact's owner already decided. The obligation this places on the
 * adapter (compose facts correctly, from the owning contracts) is recorded
 * in the tracker.
 *
 * ── HONESTY RULES, extracted ──
 *
 * A failed adapter delivery must not look like a successful send — the
 * decision's adapter half says whether to notify the sender, and the queue
 * half NEVER notifies (an offline dojo agent's mail queues; that is the
 * mailbox model working, not a failure). Peer senders are enriched from the
 * receiver's OWN record (`peerDescription` frozen locally — a peer cannot
 * rewrite its description per message). The admission flag (`queued: true`)
 * is written by this decision and only this decision — the write site
 * decides, the fold applies (the established admission-flag law).
 *
 * What the types cannot enforce, and what does: the queue-vs-adapter line,
 * the never-notify-on-queue rule, and the enrichment source are held by
 * `routing.conformance.test.ts`.
 */

import type { AgentName, AgentRole, SendData } from './vocabulary.ts'

export type SendCommand = {
  from: AgentName | 'infra' | 'api'
  to: AgentName
  text: string
  taskId?: string
  attachments?: readonly string[]
}

/** The injected facts, composed by the shell from the agents contract and
 *  its own connection/peer knowledge — the two sources of fact about the
 *  target kept SEPARATE (the conflated `resolvedRole` was this contract's
 *  own defect, caught at D6). */
export type RoutingFacts = {
  /** The role of the target's LIVE session — undefined when no session is
   *  connected under this name right now. */
  liveRole: AgentRole | undefined
  /** Has the target EVER registered as a dojo agent (agents.isDojoAgent)? */
  isDojoAgentEver: boolean
  /** The receiver's own frozen description of the SENDER, when the sender
   *  is a registered peer. */
  senderPeerDescription?: string
}

export type RouteDecision =
  | {
      route: 'queue'
      /** Append as `send` on `stream`; the admission flag is set here. */
      stream: string
      data: SendData
    }
  | {
      route: 'adapter'
      stream: string
      /** Build the record AFTER the transport attempt — `delivered` is only
       *  knowable then. */
      data: (delivered: boolean) => SendData
      /** The sender-notice rule: a message when the attempt failed,
       *  undefined when it landed. */
      undeliveredNotice: (delivered: boolean) => string | undefined
    }

/** `export const routing: RoutingContract` — src/domain/routing/ (D6). */
export type RoutingContract = {
  /** taskId names the task's stream; otherwise the target's agent stream. */
  streamFor: (to: AgentName, taskId?: string) => string
  decideSend: (cmd: SendCommand, facts: RoutingFacts) => RouteDecision
}
