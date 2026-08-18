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
 * ── THE ROLE TEST, extracted and re-expressed (the flagged call) ──
 *
 * The old code special-cased a CONNECTED target by live role
 * (`entry.role === 'sensei' || 'worker'`) and fell back to the persisted
 * dojo set for disconnected names. Ruled at extraction: the intent is
 * DELIBERATE and the spelling was the old model's — both branches answer
 * one question, "does this name hold a mailbox?", with the live session's
 * role taking precedence over the record. That is exactly the agents
 * contract's `roleOf` precedence, so this contract takes the RESOLVED role
 * and the persisted `isDojoAgent` fact as injected values and asks the one
 * question once. Under one-role-many-agents nothing changes: role is a
 * category, and the test is on the target's own resolved role, never on
 * role uniqueness.
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

/** The injected facts, resolved by the shell from the agents contract and
 *  its own connection/peer knowledge. */
export type RoutingFacts = {
  /** The target's role, resolved with live-session precedence
   *  (agents.roleOf(state, to, liveRole)). */
  resolvedRole: AgentRole | undefined
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
