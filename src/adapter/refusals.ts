/**
 * The rename tables — where a typed domain refusal becomes an HTTP status and
 * a sentence, and the ONLY place in the adapter allowed to name either
 * (design §5's serialize step; task E2).
 *
 * ── WHY THIS IS A TABLE AND NOT A SCATTERING OF `return json(..., 400)` ──
 *
 * The law every E-task carries is "a 400 is a typed refusal RENAMED, never
 * the adapter's own judgement". A handler that writes its own status inline
 * satisfies that law only as long as whoever writes the next handler
 * remembers it. Here the statuses are `Record<Refusal['kind'], number>`,
 * which means a refusal kind added to a contract does not compile until it
 * has a status — the same trick resolution uses for `KnownKind`, and for the
 * same reason: the exhaustiveness is the guarantee, not the contents of any
 * one row.
 *
 * The message switches carry a `never` arm for the other direction: a kind
 * that loses its case is a type error rather than a silent `undefined` in a
 * response body.
 *
 * ── THE `refusal` FIELD IS PART OF THE RENAME ──
 *
 * Every body carries the refusal's own `kind` alongside the prose. The prose
 * is for a human reading a terminal; the kind is for a caller that must
 * branch — and a caller forced to regex an error message is a caller who
 * will break the day the wording improves.
 */

import type { SearchScope } from '../domain/contracts/knowledge.ts'
import type {
  HandoffRefusal,
  RevertDecision,
  SubscribeRefusal,
  TransitionRefusal,
  UnsubscribeRefusal,
} from '../domain/contracts/tasks.ts'
import type { TriggerRefusal } from '../domain/contracts/triggers.ts'

/** What a handler serializes: the status, and the body under it. */
export type Renamed = { status: number; body: { error: string; refusal: string } }

// ── Tasks ────────────────────────────────────────────────────────

/** Revert's refusal has no exported name of its own — taken from the decision
 *  so a change to the contract still reaches this table. */
type RevertRefusal = Extract<RevertDecision, { ok: false }>['refusal']

/** The task-side refusal unions, renamed by one table. They are merged
 *  because the STATUS question is the same question for all of them — and
 *  because `unknown-task` appears in four of them and must not be able to
 *  answer differently depending on which door it came through. */
export type TaskRefusal = TransitionRefusal | HandoffRefusal | SubscribeRefusal | UnsubscribeRefusal | RevertRefusal

/**
 * 404 = the thing named does not exist. 403 = it exists and you may not.
 * 409 = it exists, you may, and its CURRENT STATE says no — a distinction
 * worth keeping, because a caller retrying a 409 after the state moves is
 * behaving correctly and a caller retrying a 400 never is.
 */
const TASK_STATUS: Record<TaskRefusal['kind'], number> = {
  'unknown-task': 404,
  'illegal-transition': 400,
  'actor-forbidden': 403,
  'blocker-required': 400,
  'unparseable-resume': 400,
  'not-waiting': 409,
  'not-a-mailbox-holder': 400,
  'already-subscribed': 409,
  'not-subscribed': 409,
  'nothing-to-revert': 409,
}

function taskMessage(refusal: TaskRefusal): string {
  switch (refusal.kind) {
    case 'unknown-task':
      return 'no such task'
    case 'illegal-transition':
      return `illegal transition: ${refusal.from} → ${refusal.to}`
    case 'actor-forbidden':
      return `${refusal.actorRole} may not drive ${refusal.from} → ${refusal.to}`
    case 'blocker-required':
      return 'parking a task requires blockedOn: "sensei" | "human" | "external"'
    case 'unparseable-resume':
      return `unparseable resumeAt: ${refusal.resumeAt}`
    case 'not-waiting':
      return `the task is ${refusal.status}, not waiting — there is no blocker to hand off`
    case 'not-a-mailbox-holder':
      return `"${refusal.name}" holds no mailbox in this dojo, so it cannot subscribe`
    case 'already-subscribed':
      return 'already subscribed'
    case 'not-subscribed':
      return 'not subscribed'
    case 'nothing-to-revert':
      return 'nothing to revert — the task has no prior status to return to'
    default: {
      const unreached: never = refusal
      return String(unreached)
    }
  }
}

export function renameTaskRefusal(refusal: TaskRefusal): Renamed {
  return { status: TASK_STATUS[refusal.kind], body: { error: taskMessage(refusal), refusal: refusal.kind } }
}

// ── Triggers ─────────────────────────────────────────────────────

const TRIGGER_STATUS: Record<TriggerRefusal['kind'], number> = {
  'missing-agent-or-prompt': 400,
  'no-schedule': 400,
  'both-schedules': 400,
  'invalid-cron': 400,
  'invalid-at': 400,
  'invalid-kind': 400,
  'model-on-agent-trigger': 400,
  'retries-on-agent-trigger': 400,
  'invalid-retries': 400,
  'invalid-role-for-headless': 400,
  // The one that is NOT a malformed request: the id is well-formed and taken.
  'duplicate-id': 409,
  'unknown-trigger': 404,
  'schedule-immutable': 400,
  'unknown-fields': 400,
  'invalid-status': 400,
  'invalid-metadata': 400,
}

function triggerMessage(refusal: TriggerRefusal): string {
  switch (refusal.kind) {
    case 'missing-agent-or-prompt':
      return 'a trigger needs both an agent and a prompt'
    case 'no-schedule':
      return 'must specify cron or at'
    case 'both-schedules':
      return 'cron and at are mutually exclusive'
    case 'invalid-cron':
      return 'invalid cron expression'
    case 'invalid-at':
      return `invalid datetime for at: ${refusal.at}`
    case 'invalid-kind':
      return `invalid kind "${refusal.got}", must be 'agent' or 'headless'`
    case 'model-on-agent-trigger':
      return "model is only valid for headless triggers; set kind: 'headless' or remove model"
    case 'retries-on-agent-trigger':
      return "retries is only valid for headless triggers; set kind: 'headless' or remove retries"
    case 'invalid-retries':
      return `retries must be an integer between 0 and 10; got ${JSON.stringify(refusal.got)}`
    case 'invalid-role-for-headless':
      return `headless trigger requires 'agent' to be a valid role; got "${refusal.got}". Valid: ${refusal.valid.join(', ')}`
    case 'duplicate-id':
      return `trigger id already exists: ${refusal.id}`
    case 'unknown-trigger':
      return `no such trigger: ${refusal.id}`
    case 'schedule-immutable':
      return 'schedule is immutable; delete and recreate the trigger to change cron or at'
    case 'unknown-fields':
      return `unknown fields: ${refusal.fields.join(', ')}`
    case 'invalid-status':
      return `status must be "active" or "disabled"; got ${JSON.stringify(refusal.got)}`
    case 'invalid-metadata':
      return 'metadata must be a JSON object (not an array)'
    default: {
      const unreached: never = refusal
      return String(unreached)
    }
  }
}

export function renameTriggerRefusal(refusal: TriggerRefusal): Renamed {
  return { status: TRIGGER_STATUS[refusal.kind], body: { error: triggerMessage(refusal), refusal: refusal.kind } }
}

// ── Knowledge ────────────────────────────────────────────────────

export function renameMemoryRefusal(refusal: { kind: 'missing-fields' }): Renamed {
  return {
    status: 400,
    body: { error: 'memorize requires agent, role, and non-empty text', refusal: refusal.kind },
  }
}

/** The scope refusal carries no `kind` — it is a list of what WOULD have been
 *  valid, which is the more useful thing to hand back, so the rename names the
 *  kind itself and passes the list through. */
export function renameScopeRefusal(valid: readonly SearchScope[], got: string): Renamed & { validScopes: string[] } {
  return {
    status: 400,
    body: { error: `invalid scope "${got}"`, refusal: 'invalid-scope' },
    validScopes: [...valid],
  }
}

/**
 * A duplicate document id is the ADAPTER'S OWN bug — it built the corpus, and
 * two docs sharing an id means its own namespacing failed. 500, and loud: the
 * alternative (drop one and search the rest) would make `empty` mean
 * "definitively not in the dojo's memory" while a whole document was missing,
 * which is the one lie the knowledge contract forbids.
 */
export function renameCorpusRefusal(refusal: { kind: 'duplicate-doc-id'; id: string }): Renamed {
  return {
    status: 500,
    body: { error: `the search corpus contains two documents with id "${refusal.id}"`, refusal: refusal.kind },
  }
}
