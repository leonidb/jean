/**
 * The triggers contract — schedules, validation, firing, catch-up
 * (design §3/§4; old code read under §8's extraction discipline: the
 * server's trigger CRUD validation, the trigger reducer, the fire planner
 * and the catch-up policy; calls recorded in task 087's report).
 *
 * ── THE MODEL ──
 *
 * A trigger schedules a PROMPT for a TARGET: either a repeating `cron` or a
 * one-shot `at` — exactly one, never both, never neither. Two kinds:
 * `agent` (deliver the prompt into a running session — the target is an
 * agent NAME) and `headless` (spawn a one-shot session under a ROLE — the
 * target is a role name, validated against the role list). `model` and
 * `retries` are meaningful for headless only and are REFUSED on agent
 * triggers — a knob that silently does nothing misleads the person who set
 * it (extracted rule, stated in the old code's own words).
 *
 * ── VALIDATION IS TYPED REFUSALS ──
 *
 * Same law as tasks: the adapter renames refusals into status codes, never
 * judges. Unknown update fields are REFUSED, never dropped (the
 * silently-ignored-param defect class, ruled in this dojo). The schedule is
 * IMMUTABLE after creation — delete and recreate to change it.
 *
 * ── AMBIENT FACTS ARE INJECTED ──
 *
 * Cron syntax validity (`isValidCron`) and cron arithmetic
 * (`previousScheduledRun`) are library calls — the adapter's; the contract
 * takes them as injected facts, like every ambient dependency. Trigger IDS
 * come from the caller: the old code minted `crypto.randomUUID()` inline,
 * and nondeterminism belongs to the shell (design §5).
 *
 * ── RULED AT 090 (from D5's report) ──
 *
 * DUPLICATE `trigger-created` for an existing id: FIRST WINS — the same
 * ruling as tasks (086), confirmed for triggers: the old fold appended a
 * second row, a map overwrite silently replaces the original; both are
 * halves of one mistake, and replay never doubles or rewrites. LEGACY
 * created events carrying BOTH schedules: `cron` wins — measured, not
 * argued: at-wins turns a repeating job into one silent fire (status
 * `fired` after its first run, forever), and cron-first is also what the
 * old reducer did. EMPTY-STRING schedule and model fields normalize to
 * ABSENT once, at entry — the old handler tested truthiness throughout,
 * and split readings (exclusivity seeing one schedule, validity seeing
 * two) were the actual hazard.
 *
 * ── FIRING AND THE FOLD ──
 *
 * Firing appends a `trigger-fired` event (resolution already pinned at D1:
 * agent-kind → the target agent; headless → history — the run spawns,
 * there is no session to mail). The fold marks `lastFiredAt`, and a
 * ONE-SHOT trigger becomes status `fired` — terminal: `fired` is not a
 * legal update status (active|disabled only), so reviving a one-shot means
 * recreating it. Deliberate, extracted as-is. The fold tolerates history:
 * a created-event violating the schedule invariant is dropped (the API
 * boundary enforces it; old logs are permanent), and a missing `kind`
 * defaults to `agent` (pre-kind events).
 *
 * ── CATCH-UP (extracted policy, verbatim semantics) ──
 *
 * On startup, a CRON trigger that missed its most recent scheduled fire
 * while infra was down is made up — IF it has fired before. Brand-new
 * triggers never catch up (the user just created them), and
 * `metadata.skipCatchup` opts out. One-shot triggers never catch up (the
 * due plan handles them: an `at` in the past fires now).
 *
 * What the types cannot enforce, and what does: the refusal table, the
 * one-shot terminal rule, the fold's tolerance, and the catch-up policy are
 * held by `triggers.conformance.test.ts`.
 */

import type { AgentRole, StoredEvent, TriggerCreatedData, TriggerFiredData, TriggerKind } from './vocabulary.ts'

export type TriggerStatus = 'active' | 'disabled' | 'fired'

/** Exactly one schedule — encoded, not narrated (codex pass): a D5 reader
 *  of `Trigger` gets the invariant from the type. */
export type TriggerSchedule = { cron: string; at?: never } | { at: string; cron?: never }

export type Trigger = TriggerSchedule & {
  id: string
  agent: string
  prompt: string
  kind: TriggerKind
  model?: string
  retries?: number
  status: TriggerStatus
  actor: string
  createdAt: string
  lastFiredAt?: string
  metadata?: Record<string, unknown>
}

/** Opaque — constructed by `initial()`, evolved by `fold`. */
export type TriggersState = { readonly __triggersState: true }

export type TriggerRefusal =
  | { kind: 'missing-agent-or-prompt' }
  | { kind: 'no-schedule' }
  | { kind: 'both-schedules' }
  | { kind: 'invalid-cron' }
  | { kind: 'invalid-at'; at: string }
  | { kind: 'invalid-kind'; got: string }
  | { kind: 'model-on-agent-trigger' }
  | { kind: 'retries-on-agent-trigger' }
  | { kind: 'invalid-retries'; got: unknown }
  | { kind: 'invalid-role-for-headless'; got: string; valid: readonly string[] }
  | { kind: 'duplicate-id'; id: string }
  | { kind: 'unknown-trigger'; id: string }
  | { kind: 'schedule-immutable' }
  | { kind: 'unknown-fields'; fields: readonly string[] }
  | { kind: 'invalid-status'; got: unknown }
  | { kind: 'invalid-metadata' }

export type CreateTriggerCommand = {
  /** Caller-supplied (the shell mints randomness; the CLI may pass one). */
  id: string
  cron?: string
  at?: string
  agent: string
  prompt: string
  kind?: TriggerKind
  model?: string
  retries?: number
  actor: string
  metadata?: Record<string, unknown>
}

export type UpdateTriggerCommand = {
  id: string
  /** Raw field map, deliberately — unknown-field REFUSAL is this decision's
   *  job, so the adapter must not pre-filter (that would be the silent
   *  drop). */
  fields: Record<string, unknown>
}

export type CreateDecision = { ok: true; data: TriggerCreatedData } | { ok: false; refusal: TriggerRefusal }
export type UpdateDecision =
  | {
      ok: true
      data: {
        id: string
        agent?: string
        prompt?: string
        status?: 'active' | 'disabled'
        metadata?: Record<string, unknown>
      }
    }
  | { ok: false; refusal: TriggerRefusal }
export type RemoveDecision = { ok: true; data: { id: string } } | { ok: false; refusal: TriggerRefusal }

/** `export const triggers: TriggersContract` — src/domain/triggers/ (D5). */
export type TriggersContract = {
  initial: () => TriggersState
  fold: (state: TriggersState, event: StoredEvent) => TriggersState

  all: (state: TriggersState) => readonly Trigger[]
  triggerOf: (state: TriggersState, id: string) => Trigger | undefined

  decideCreate: (
    state: TriggersState,
    cmd: CreateTriggerCommand,
    facts: { isValidCron: (expr: string) => boolean; validRoles: readonly AgentRole[] },
  ) => CreateDecision
  decideUpdate: (state: TriggersState, cmd: UpdateTriggerCommand) => UpdateDecision
  decideRemove: (state: TriggersState, id: string) => RemoveDecision

  /** The data of the `trigger-fired` event a firing appends. */
  fireData: (trigger: Trigger) => TriggerFiredData

  /** One-shot triggers whose `at` has passed and that have not fired —
   *  fire now. Cron scheduling itself is the shell's job (a job table);
   *  this is the domain's half: which `at`s are due. */
  dueOneShots: (state: TriggersState, now: number) => readonly Trigger[]

  /** The startup catch-up policy for ONE cron trigger. `previousScheduledRun`
   *  is the injected cron arithmetic: the most recent scheduled instant at
   *  or before `now`, undefined when none. */
  shouldCatchUp: (
    trigger: Trigger,
    now: number,
    previousScheduledRun: (cron: string, now: number) => number | undefined,
  ) => boolean
}
