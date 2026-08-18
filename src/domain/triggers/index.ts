/**
 * Triggers — schedules, validation, firing, catch-up (contract
 * `contracts/triggers.ts`, task D5).
 *
 * ── REFUSAL ORDER IS EXTRACTED, NOT INVENTED ──
 *
 * `decideCreate` checks in the old handler's order, and the order is part of
 * the behaviour rather than an accident of how it was written: identity and
 * shape first (agent/prompt, then the schedule), then the schedule's own
 * validity, then the kind, then the kind-gated knobs, and the duplicate id
 * last. Two places where it is load-bearing:
 *
 *   ROLE BEFORE RETRIES. A headless trigger with a misspelled role AND an
 *   out-of-range retries count is refused for the ROLE. The role is what the
 *   caller got wrong about what they are building; the retries number is a
 *   detail of a thing that cannot exist yet. Reversing them sends someone to
 *   fix a number on a trigger whose target does not exist.
 *
 *   DUPLICATE ID LAST. A caller reusing an id has usually also changed
 *   something else, and hearing "that id is taken" while a field is also
 *   malformed would mean two round trips.
 *
 * ── THE KIND GATES, AND WHY THEY REFUSE RATHER THAN IGNORE ──
 *
 * `model` and `retries` do something only for headless runs. An agent trigger
 * messages a running session: there is no model to choose and no attempt
 * cycle to retry. Accepting them there would leave a knob that reads as
 * configured and does nothing — the silently-ignored-parameter class this
 * dojo has ruled on twice. Same reason unknown UPDATE fields are refused by
 * name rather than dropped.
 *
 * `retries: 0` on an agent trigger is allowed, extracted as-is: zero retries
 * is the absence of the feature, so there is nothing being silently ignored.
 *
 * ── ONE-SHOT TERMINALITY ──
 *
 * A fired `at` trigger becomes status `fired`, and `fired` is not a settable
 * status — `decideUpdate` accepts `active|disabled` only. Reviving a one-shot
 * means creating a new one, deliberately: the alternative is a trigger whose
 * "it already ran" fact can be edited away, and then the log no longer says
 * what happened.
 *
 * ── WHAT THE FOLD TOLERATES, AND WHY IT MUST ──
 *
 * A `trigger-created` carrying no schedule is DROPPED rather than stored
 * half-built: the API boundary is what enforces exactly-one-schedule, logs
 * are permanent, and a trigger with no schedule can never fire, so keeping it
 * would put an unfireable row on every listing forever. A missing `kind`
 * defaults to `agent` — that field postdates the kind, and every event older
 * than it was an agent trigger. When a historical event carries BOTH
 * schedules, `cron` wins, matching the old fold: it is the repeating one, so
 * the wrong guess is recoverable on the next run rather than silently never.
 *
 * ── CATCH-UP: STATUS IS THE CALLER'S GATE, NOT THIS FUNCTION'S ──
 *
 * `shouldCatchUp` answers only "did this cron trigger miss its most recent
 * scheduled run", exactly as the extracted helper did. The old startup loop
 * filtered `status !== 'active'` before calling it, and that split is kept —
 * but it means an adapter that forgets the filter will catch up DISABLED
 * triggers. Flagged for E3 on task 089; the conformance suite does not pin
 * it either way.
 *
 * What this file cannot enforce, and what does: the refusal table and its
 * order, one-shot terminality, the fold's tolerance and the catch-up policy
 * are held by `triggers.conformance.test.ts`.
 */

import type {
  CreateDecision,
  CreateTriggerCommand,
  RemoveDecision,
  Trigger,
  TriggerSchedule,
  TriggersContract,
  TriggersState,
  UpdateDecision,
  UpdateTriggerCommand,
} from '../contracts/triggers.ts'
import type {
  AgentRole,
  StoredEvent,
  TriggerCreatedData,
  TriggerFiredData,
  TriggerKind,
  TriggerRemovedData,
  TriggerUpdatedData,
} from '../contracts/vocabulary.ts'

// ── State ────────────────────────────────────────────────────────

/** Keyed by id; insertion order is creation order, which is what `all`
 *  reports. Ids are identities here — `decideCreate` refuses a duplicate — so
 *  a map is the shape, not an optimisation. */
type Registry = ReadonlyMap<string, Trigger>

function registry(state: TriggersState): Registry {
  return state as unknown as Registry
}
function seal(next: Registry): TriggersState {
  return next as unknown as TriggersState
}

/**
 * Frozen on the way in: `all` and `triggerOf` hand back the state's own
 * objects, so without this a caller could edit one and change the registry
 * through a read (the hazard codex found in tasks, task 084). Spreading a
 * frozen object is unaffected, which is all any legitimate caller does.
 *
 * `metadata` is COPIED before freezing, and that order is deliberate in both
 * halves. Freezing the caller's own object instead would reach back out of
 * this module and immobilise a value somebody else still owns; not freezing it
 * at all would leave `triggerOf(id).metadata.x = 1` as a live write into the
 * registry, which is the hazard this function exists for (codex pass,
 * task 089). One level deep — a nested bag inside metadata is still shared,
 * and saying so is better than implying a depth this does not have.
 */
function store(current: Registry, trigger: Trigger): Registry {
  const next = new Map(current)
  const safe =
    trigger.metadata === undefined ? trigger : { ...trigger, metadata: Object.freeze({ ...trigger.metadata }) }
  next.set(trigger.id, Object.freeze(safe))
  return next
}

// ── Shared reading ───────────────────────────────────────────────

const KINDS: ReadonlySet<string> = new Set<TriggerKind>(['agent', 'headless'])

/** Retries bounds, extracted: an integer in 0..10. Ten is not a magic number
 *  worth changing here — it is what the old handler accepted, and every log
 *  written under it holds values inside it. */
const MAX_RETRIES = 10

/**
 * The schedule half, or undefined when there is none. `cron` wins if a
 * historical event carries both — see the header.
 */
function scheduleOf(d: { cron?: unknown; at?: unknown }): TriggerSchedule | undefined {
  if (typeof d.cron === 'string' && d.cron.length > 0) return { cron: d.cron }
  if (typeof d.at === 'string' && d.at.length > 0) return { at: d.at }
  return undefined
}

/** A one-shot is a trigger scheduled by instant rather than by expression.
 *  Asked in one place so "one-shot" means one thing. */
function isOneShot(trigger: Trigger): boolean {
  return trigger.at !== undefined && trigger.cron === undefined
}

// ── Creation ─────────────────────────────────────────────────────

const decideCreate = (
  state: TriggersState,
  cmd: CreateTriggerCommand,
  facts: { isValidCron: (expr: string) => boolean; validRoles: readonly AgentRole[] },
): CreateDecision => {
  if (!cmd.agent || !cmd.prompt) return { ok: false, refusal: { kind: 'missing-agent-or-prompt' } }

  // EMPTY IS ABSENT, once, at the top. The old handler tested these by
  // truthiness throughout, so `cron: ''` was a trigger with no cron rather
  // than a trigger with a malformed one — and normalising here rather than at
  // each use is what stops the two readings drifting apart: without it the
  // exclusivity check could see one schedule while the validity check saw
  // two, and an empty string could reach the log as a field nothing reads
  // (codex pass, task 089).
  const cron = cmd.cron ? cmd.cron : undefined
  const at = cmd.at ? cmd.at : undefined
  const model = cmd.model ? cmd.model : undefined

  // Exactly one schedule. Both refusals are named separately because the
  // fixes differ: one caller forgot to say when, the other said it twice.
  if (cron === undefined && at === undefined) return { ok: false, refusal: { kind: 'no-schedule' } }
  if (cron !== undefined && at !== undefined) return { ok: false, refusal: { kind: 'both-schedules' } }

  // Cron VALIDITY is an injected fact — it is a library's opinion, and this
  // module does not own a cron parser.
  if (cron !== undefined && !facts.isValidCron(cron)) return { ok: false, refusal: { kind: 'invalid-cron' } }
  if (at !== undefined && Number.isNaN(Date.parse(at))) {
    return { ok: false, refusal: { kind: 'invalid-at', at } }
  }

  const kind: TriggerKind = cmd.kind ?? 'agent'
  if (!KINDS.has(kind)) return { ok: false, refusal: { kind: 'invalid-kind', got: String(cmd.kind) } }

  if (kind === 'headless') {
    // For a headless trigger `agent` names a ROLE, not an agent. Validated at
    // creation so a misspelling fails now rather than on first fire, hours
    // later, in a spawn nobody is watching.
    if (!(facts.validRoles as readonly string[]).includes(cmd.agent)) {
      return { ok: false, refusal: { kind: 'invalid-role-for-headless', got: cmd.agent, valid: facts.validRoles } }
    }
  } else if (model !== undefined) {
    return { ok: false, refusal: { kind: 'model-on-agent-trigger' } }
  }

  if (cmd.retries !== undefined) {
    if (!Number.isInteger(cmd.retries) || cmd.retries < 0 || cmd.retries > MAX_RETRIES) {
      return { ok: false, refusal: { kind: 'invalid-retries', got: cmd.retries } }
    }
    // `> 0` deliberately: zero retries is the absence of the feature, so it
    // configures nothing and misleads nobody.
    if (kind !== 'headless' && cmd.retries > 0) return { ok: false, refusal: { kind: 'retries-on-agent-trigger' } }
  }

  if (registry(state).has(cmd.id)) return { ok: false, refusal: { kind: 'duplicate-id', id: cmd.id } }

  return {
    ok: true,
    data: {
      id: cmd.id,
      ...(cron !== undefined && { cron }),
      ...(at !== undefined && { at }),
      agent: cmd.agent,
      prompt: cmd.prompt,
      // The RESOLVED kind, not the given one: the default belongs in the log,
      // so a later reader never has to know what the default was when this
      // was written.
      kind,
      ...(model !== undefined && { model }),
      ...(cmd.retries !== undefined && cmd.retries > 0 && { retries: cmd.retries }),
      actor: cmd.actor,
      ...(cmd.metadata !== undefined && { metadata: cmd.metadata }),
    },
  }
}

// ── Update ───────────────────────────────────────────────────────

/** What an update may set. Everything else is refused BY NAME — a dropped
 *  field is a caller believing they changed something. */
const UPDATABLE: ReadonlySet<string> = new Set(['agent', 'prompt', 'status', 'metadata'])
/** Known, and still refused: the schedule is immutable after creation. Named
 *  apart from the unknowns so the refusal says *why* rather than "no such
 *  field" about a field that plainly exists. */
const SCHEDULE_FIELDS: ReadonlySet<string> = new Set(['cron', 'at'])
const SETTABLE_STATUS: ReadonlySet<string> = new Set(['active', 'disabled'])

const decideUpdate = (state: TriggersState, cmd: UpdateTriggerCommand): UpdateDecision => {
  if (!registry(state).has(cmd.id)) return { ok: false, refusal: { kind: 'unknown-trigger', id: cmd.id } }

  const names = Object.keys(cmd.fields)
  if (names.some((n) => SCHEDULE_FIELDS.has(n))) return { ok: false, refusal: { kind: 'schedule-immutable' } }
  const unknown = names.filter((n) => !UPDATABLE.has(n))
  if (unknown.length > 0) return { ok: false, refusal: { kind: 'unknown-fields', fields: unknown } }

  // PRESENCE IS `in`, NOT `!== undefined`, and the field order is the old
  // handler's: agent, prompt, status, metadata. Both details matter.
  // `{ agent: undefined }` is a caller who MEANT to set agent and sent
  // nothing usable — refused, where a `!== undefined` test would silently
  // treat it as "not updating agent" and report success for a no-op.
  const { agent, prompt, status, metadata } = cmd.fields

  // TYPES CHECKED, NOT COERCED. `String(value)` here would write
  // "[object Object]" into the log as somebody's prompt and report success —
  // the log is permanent, so a coercion is a lie that outlives the request.
  if ('agent' in cmd.fields && typeof agent !== 'string') {
    return { ok: false, refusal: { kind: 'missing-agent-or-prompt' } }
  }
  if ('prompt' in cmd.fields && typeof prompt !== 'string') {
    return { ok: false, refusal: { kind: 'missing-agent-or-prompt' } }
  }
  // `fired` is deliberately absent from the settable set — one-shot
  // terminality is a fact about what happened, not a flag.
  if ('status' in cmd.fields && (typeof status !== 'string' || !SETTABLE_STATUS.has(status))) {
    return { ok: false, refusal: { kind: 'invalid-status', got: status } }
  }
  // An array is an object to `typeof`, and metadata is a bag of named things.
  if ('metadata' in cmd.fields && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
    return { ok: false, refusal: { kind: 'invalid-metadata' } }
  }

  return {
    ok: true,
    data: {
      id: cmd.id,
      ...('agent' in cmd.fields && { agent: agent as string }),
      ...('prompt' in cmd.fields && { prompt: prompt as string }),
      ...('status' in cmd.fields && { status: status as 'active' | 'disabled' }),
      ...('metadata' in cmd.fields && { metadata: metadata as Record<string, unknown> }),
    },
  }
}

const decideRemove = (state: TriggersState, id: string): RemoveDecision =>
  registry(state).has(id) ? { ok: true, data: { id } } : { ok: false, refusal: { kind: 'unknown-trigger', id } }

// ── The fold ─────────────────────────────────────────────────────

const fold = (state: TriggersState, event: StoredEvent): TriggersState => {
  const current = registry(state)
  const data = (event.data ?? {}) as Record<string, unknown>

  switch (event.type) {
    case 'trigger-created': {
      const d = data as unknown as TriggerCreatedData
      const schedule = scheduleOf(d)
      // No schedule, no trigger — see the header on why this is dropped
      // rather than stored.
      if (schedule === undefined || typeof d.id !== 'string') return state
      // FIRST WINS, as the tasks fold was ruled for the identical question
      // (task 086): a second created-event for an id already held is a replay,
      // not a new trigger. The old array-backed reducer APPENDED, giving one
      // id two rows; overwriting would avoid that but silently replace the
      // original's `createdAt` and fields, which is the other half of the same
      // mistake. The contract does not rule this for triggers — reported on
      // task 089, implemented consistently with the module that was ruled.
      if (current.has(d.id)) return state
      const trigger = {
        ...schedule,
        id: d.id,
        agent: d.agent,
        prompt: d.prompt,
        kind: d.kind ?? 'agent',
        ...(d.model !== undefined && { model: d.model }),
        ...(d.retries !== undefined && d.retries > 0 && { retries: d.retries }),
        status: 'active',
        // `createdBy` is what this field was called before it was `actor`, and
        // 'unknown' is what the old fold used when a log held neither. Both
        // kept: a trigger whose author cannot be named is still a trigger, and
        // `Trigger.actor` is not optional, so dropping the fallback would put
        // `undefined` where the type promises a string (codex pass, task 089).
        actor: d.actor ?? ((d as unknown as Record<string, unknown>).createdBy as string | undefined) ?? 'unknown',
        createdAt: event.ts,
        ...(d.metadata !== undefined && { metadata: d.metadata }),
      } as Trigger
      return seal(store(current, trigger))
    }

    case 'trigger-updated': {
      const d = data as unknown as TriggerUpdatedData
      const existing = current.get(d.id)
      if (existing === undefined) return state
      return seal(
        store(current, {
          ...existing,
          ...(d.agent !== undefined && { agent: d.agent }),
          ...(d.prompt !== undefined && { prompt: d.prompt }),
          ...(d.status !== undefined && { status: d.status }),
          ...(d.metadata !== undefined && { metadata: d.metadata }),
        }),
      )
    }

    case 'trigger-removed': {
      const d = data as unknown as TriggerRemovedData
      if (!current.has(d.id)) return state
      const next = new Map(current)
      next.delete(d.id)
      return seal(next)
    }

    case 'trigger-fired': {
      const d = data as unknown as TriggerFiredData
      const existing = current.get(d.triggerId)
      if (existing === undefined) return state
      return seal(
        store(current, {
          ...existing,
          lastFiredAt: event.ts,
          // TERMINAL, and only for one-shots: a cron trigger fires forever.
          ...(isOneShot(existing) && { status: 'fired' as const }),
        }),
      )
    }

    default:
      return state
  }
}

export const triggers: TriggersContract = {
  initial: () => seal(new Map()),
  fold,

  all: (state) => [...registry(state).values()],
  triggerOf: (state, id) => registry(state).get(id),

  decideCreate,
  decideUpdate,
  decideRemove,

  fireData: (trigger) => ({
    triggerId: trigger.id,
    agent: trigger.agent,
    prompt: trigger.prompt,
    kind: trigger.kind,
  }),

  dueOneShots: (state, now) => {
    const due: Trigger[] = []
    for (const trigger of registry(state).values()) {
      if (!isOneShot(trigger) || trigger.status !== 'active') continue
      const at = Date.parse(trigger.at as string)
      // `<=`: an instant that has arrived is due. A malformed `at` that
      // survived into the log parses as NaN, and NaN fails this comparison,
      // so it simply never fires — silent, but the alternative is a trigger
      // that fires every tick forever.
      if (!Number.isNaN(at) && at <= now) due.push(trigger)
    }
    return due
  },

  shouldCatchUp: (trigger, now, previousScheduledRun) => {
    // One-shots are the due plan's business: an `at` in the past fires now,
    // which is the same outcome catch-up would produce, without needing a
    // second mechanism to agree with the first.
    if (trigger.cron === undefined) return false
    // Never fired means brand new — the user just created it, and firing on
    // startup for a schedule it has never met would surprise them.
    if (trigger.lastFiredAt === undefined) return false
    if ((trigger.metadata as Record<string, unknown> | undefined)?.skipCatchup) return false
    const previous = previousScheduledRun(trigger.cron, now)
    if (previous === undefined) return false
    // Missed IFF the last fire predates the most recent scheduled instant.
    return Date.parse(trigger.lastFiredAt) < previous
  },
}
