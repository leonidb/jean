/**
 * Resolution — who each event addresses (spec §4, contract
 * `contracts/resolution.ts`, task D1).
 *
 * ── THE SHAPE: A TABLE, NOT A SWITCH ──
 *
 * Spec §4 is a table and its opening line is a rule about the table itself —
 * "a new kind must declare its resolution before it can be emitted". So the
 * implementation is a table too, typed `Record<KnownKind, Resolver>`, and that
 * type is the rule's enforcement: add a kind to the census in
 * `contracts/vocabulary.ts` without declaring its resolution here and the
 * build fails. A `switch` with a `default` could not do that — it would
 * silently resolve the new kind to whatever the default said, which is the
 * one outcome the spec's sentence exists to prevent.
 *
 * The declared resolutions are deliberately tiny and named after the spec's
 * own rows (`orchestratorOnly`, `taskParties`, `nobody`), so the table below
 * reads as §4's table and can be diffed against it by eye.
 *
 * ── AUTHOR EXCLUSION IS INSIDE `resolve`, NOT BESIDE IT ──
 *
 * Spec §1, verbatim: "Mail is never addressed to its author. Author exclusion
 * is part of every kind's resolution, not a filter applied afterwards." That
 * sentence is about WHERE the exclusion lives, so it is honoured structurally:
 * no declared resolution below excludes anybody, and `resolve` — the only
 * exported way to ask the question — applies the exclusion on the way out. A
 * caller cannot obtain an author-included answer, because there is no surface
 * that returns one. Had the exclusion been a separate exported helper, "not a
 * filter applied afterwards" would be false the moment one caller forgot it.
 *
 * Dedup rides the same pass: when the orchestrator owns a task, `taskParties`
 * names it twice, and one recipient must mean one pair (spec §2 — pending is
 * a SET of (recipient, event) pairs, so a duplicate is not a second pair).
 *
 * ── `roleOf` WAS REMOVED FROM THE CONTEXT (ruled, task 080) ──
 *
 * `ResolutionContext` offered `roleOf`, and no resolution below needed it:
 * §4 addresses replies to the orchestrator whether the speaker is a worker,
 * a human, or a peer, so the branch the field looked like it was for does
 * not exist. The implementation flagged it on task 079 rather than touching
 * the contract; the architect removed it — a shape earns its keep only if a
 * caller uses it as designed.
 *
 * ── LIMITS THIS FILE CANNOT ENFORCE, AND WHAT DOES ──
 *
 * That these answers match §4's table is held by
 * `contracts/resolution.conformance.test.ts`, not by any type here: the store
 * is untyped, so each resolver narrows `event.data` by cast and a wrong cast
 * type-checks. The casts are therefore kept adjacent to the field they read
 * and never widened past it, and every field read is guarded (`typeof x ===
 * 'string'`) rather than trusted — a real log holds events written by older
 * and newer writers than this census.
 */

import type { ResolutionContext, ResolutionContract } from '../contracts/resolution.ts'
import {
  type AgentName,
  type AgentProbeData,
  type KnownKind,
  type ReplyData,
  type SendData,
  type StoredEvent,
  type TaskCommentData,
  type TriggerFiredData,
  taskIdFromStream,
} from '../contracts/vocabulary.ts'

/** One kind's declared resolution: who this event addresses, BEFORE author
 *  exclusion. Never excludes the author itself — see the header. */
type Resolver = (event: StoredEvent, ctx: ResolutionContext) => readonly (AgentName | undefined)[]

/** A name only if it is really there. Guarded because the log is permanent:
 *  an event written without the field must resolve empty, never to
 *  `undefined` cast into a recipient list. */
function named(value: unknown): readonly (AgentName | undefined)[] {
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

/** History — the empty case of the one rule (spec §1). Not a second category:
 *  the same function shape as every other row, returning nobody. */
const nobody: Resolver = () => []

/** THE ADMISSION GATE (contract, task 102): the five kinds that became mail
 *  mid-history resolve only when their record carries `queued: true` — the
 *  vocabulary's admission flag. Without it the record is bookkeeping-era
 *  history (or a synchronous `delivered` handover) and must not mint pairs
 *  on replay. Part of the declared resolution, not a check beside it (P2). */
function queuedOnly(resolver: Resolver): Resolver {
  return (event, ctx) => ((event.data as { queued?: unknown } | undefined)?.queued === true ? resolver(event, ctx) : [])
}

/** Every §4 row that reads "orchestrator". Empty when the dojo has none on
 *  record — never a fallback: a mailbox nobody owns is exactly the orphan
 *  class P4 abolishes, so between-boot events are history, not misaddressed
 *  mail. */
const orchestratorOnly: Resolver = (_event, ctx) => named(ctx.orchestrator)

/**
 * The task row: "everyone involved with the task, minus the author" —
 * "involved" IS the subscriber set (A-SUB), and the minus is `resolve`'s,
 * not this function's.
 *
 * The task id comes from the STREAM rather than the payload, because the
 * stream is the one place every kind in this family carries it; `data` names
 * it inconsistently across the census. A non-task stream, an unknown task,
 * or one nobody subscribes to resolves EMPTY.
 */
const taskParties: Resolver = (event, ctx) => {
  const taskId = taskIdFromStream(event.stream)
  // THE SUBSCRIBER SET IS "EVERYONE INVOLVED", now that there is a set to ask.
  // This used to read `[taskOwner, orchestrator]` — the participant list
  // hard-coded, which could not answer the case that matters: a third agent
  // pulled into a task receives nothing, because the resolver did not know it
  // was involved. §4's task row always said "everyone involved with the task";
  // A-SUB gave that phrase a referent, and the row now consults it instead of
  // re-deriving a guess at it.
  //
  // An unknown task, or one nobody subscribes to, resolves EMPTY — which is
  // what makes an orchestrator-created unassigned task history, exactly as
  // before: nobody is involved, so the event is a fact rather than mail.
  return taskId === undefined ? [] : ctx.subscribersOf(taskId)
}

/** §4: "Trigger firing targeting X → X". The contract narrows it — agent
 *  triggers mail their target; headless runs spawn a process, so there is no
 *  mailbox to address and the firing is history. Absent `kind` means an agent
 *  trigger: that field postdates the kind, and older firings are all agent
 *  ones. */
const triggerFired: Resolver = (event) => {
  const data = event.data as TriggerFiredData
  return data?.kind === 'headless' ? [] : named(data?.agent)
}

/**
 * SPEC §4'S TABLE, EXECUTABLE. Row order follows the contract's listing so the
 * two can be read side by side. Exhaustive over `KnownKind` by type — that is
 * the load-bearing part, not the contents of any one row.
 */
const RESOLUTIONS: Record<KnownKind, Resolver> = {
  // Messages. `send` is admission-gated: only a queued send is mail.
  send: queuedOnly((event) => named((event.data as SendData)?.agent)),
  reply: orchestratorOnly,

  // The task family — one row in §4, one resolver here
  'task-created': taskParties,
  'task-status': taskParties,
  'task-blocked': taskParties,
  'task-reverted': taskParties,
  'task-updated': taskParties,
  'task-comment': taskParties,

  // The subscriber pair (A-SUB): routing-rule changes, not mail — the effect
  // shows in future routing. Declared with the kinds, per §4's law. Addressing
  // them to the subscriber set instead would put a "you were subscribed" pair
  // in every mailbox on every change, which is noise nobody acts on.
  'task-subscribed': nobody,
  'task-unsubscribed': nobody,

  // Supervision and liveness — all admission-gated except `disconnect`
  // (which never grew a flag: it was always mail to the orchestrator).
  'task-reminder': queuedOnly(orchestratorOnly),
  'agent-probe': queuedOnly((event) => named((event.data as AgentProbeData)?.agent)),
  'agent-down': queuedOnly(orchestratorOnly),
  'worker-status': queuedOnly(orchestratorOnly),
  disconnect: orchestratorOnly,
  'trigger-fired': triggerFired,

  // History — nobody must act on these
  ack: nobody,
  nudge: nobody,
  'agent-idle': nobody,
  memory: nobody,
  register: nobody,
  start: nobody,
  'permission-request': nobody,
  'wiki-consolidated': nobody,
  'trigger-created': nobody,
  'trigger-updated': nobody,
  'trigger-removed': nobody,
  'playbook-created': nobody,
  'playbook-updated': nobody,
  'playbook-removed': nobody,
  'headless-completed': nobody,
}

/** Keyed by plain string so an unknown kind is a miss rather than a prototype
 *  hit (`'constructor'` is a legal event type in a permanent log). */
const BY_KIND: ReadonlyMap<string, Resolver> = new Map(Object.entries(RESOLUTIONS))

/**
 * Who PRODUCED this event — not who it is about, and not who it is for.
 *
 * The distinction is the whole reason this is a per-kind function rather than
 * a read of `data.agent`: across the census that field means addressee
 * (`send`), speaker (`reply`, `task-comment`), subject (`register`,
 * `disconnect`, `agent-probe`, `worker-status`), and target (`trigger-fired`).
 * Reading it blindly would exclude a probe's subject from its own probe —
 * the one event whose entire purpose is to reach that agent.
 *
 * Undefined is the safe answer and the default: it can only cause an event to
 * be KEPT in a mailbox. Infra's own emissions have no author (contract), so
 * every supervision and bookkeeping kind falls through to it.
 */
const authorOf = (event: StoredEvent): AgentName | undefined => {
  const data = (event.data ?? {}) as Record<string, unknown>
  switch (event.type) {
    // The speaker.
    case 'reply':
    case 'task-comment':
    case 'memory': {
      const agent = (data as Partial<ReplyData & TaskCommentData>).agent
      return typeof agent === 'string' ? agent : undefined
    }

    // `send` carries its author in `from`, because `agent` is the addressee.
    // 'infra' and 'api' are the machine senders the shape admits: they name no
    // agent, so they author nothing (contract — "machine-produced events have
    // no author"). Returning them would be harmless today and wrong the day a
    // dojo registers an agent by either name.
    case 'send': {
      const from = data.from
      return typeof from === 'string' && from !== 'infra' && from !== 'api' ? from : undefined
    }

    // The agent that performed the transition. `data.agent` on `task-updated`
    // is an ASSIGNEE, not an author, which is why this arm reads `actor` only.
    case 'task-created':
    case 'task-status':
    case 'task-blocked':
    case 'task-reverted':
    case 'task-updated':
    case 'trigger-created': {
      const actor = data.actor
      return typeof actor === 'string' ? actor : undefined
    }

    default:
      return undefined
  }
}

export const resolution: ResolutionContract = {
  /**
   * The declared resolution for the kind, minus the author, deduped — and
   * empty for any kind this census does not know. Unknown kinds resolve empty
   * rather than throwing: logs are permanent, so this fold will one day read
   * events written by a newer system, and a fold that throws on an unfamiliar
   * shape takes the whole dojo down to report a message it merely cannot
   * address.
   */
  resolve(event: StoredEvent, ctx: ResolutionContext): readonly AgentName[] {
    const declared = BY_KIND.get(event.type)
    if (declared === undefined) return []
    const author = authorOf(event)
    const recipients: AgentName[] = []
    for (const name of declared(event, ctx)) {
      if (name === undefined || name === author) continue
      if (recipients.includes(name)) continue
      recipients.push(name)
    }
    return recipients
  },

  authorOf,
}
