/**
 * Headless runs — the decisions behind a process this module never starts
 * (contract: `contracts/headless.ts`; task E4-HL).
 *
 * ── THE WHOLE MODULE IS A WALK, AND THE STATE IS THE POSITION IN IT ──
 *
 * A run is: which phase, which attempt of how many, and what the last probe
 * answered. Nothing else. Every law the contract states falls out of moving
 * that position on reported OUTCOMES — never on intentions, which is the
 * seam this unit was born with (R16): `planRun` says what to do, and the
 * shell says what happened, and only the second one moves anything.
 *
 * ── ONE ATTEMPT, ONE RECORD ──
 *
 * The mirror pair the suite pins is never zero and never two. It holds here
 * by construction rather than by care: every `apply*` that consumes an
 * attempt returns its record in the same step, and the only functions that
 * consume an attempt are the two that receive its outcome. There is no path
 * that advances the counter without producing a record, and none that
 * produces two.
 *
 * ── THE SENTINELS ARE THE LOG'S, NOT THIS MODULE'S ──
 *
 * `-1` spawn failed, `-2` probe failed, `0..n` the process ran. They are
 * extracted from the `headless-completed` events real dojos already hold, so
 * a reader of a year-old log and a reader of tonight's see one vocabulary.
 * The same goes for what rides each: a stderr tail ONLY on a nonzero exit
 * (an exit-0 run's stderr is warnings nobody needs), the parsed session
 * fields verbatim, and `attempt` only when the run HAS more than one — a
 * single-attempt history carries no such field, and inventing one would make
 * every old record look like it was missing something.
 */

import type {
  HeadlessConfig,
  HeadlessContract,
  HeadlessTriggerFacts,
  RunEffect,
  RunPhase,
  RunState,
  SpawnSpec,
} from '../contracts/headless.ts'
import type { AgentRole, HeadlessCompletedData } from '../contracts/vocabulary.ts'

/** The position in the walk. Opaque to everyone but this file. */
type Run = {
  trigger: HeadlessTriggerFacts
  config: HeadlessConfig
  role: AgentRole
  /** `consolidate-wiki` under the librarian — id-keyed, per the contract. */
  pipeline: boolean
  phase: RunPhase
  /** The attempt IN FLIGHT, 1-based, reset at each pipeline phase. */
  attempt: number
  totalAttempts: number
  /** The last probe's answer, carried onto the record of the attempt it
   *  cleared — indirectly-visible state the suite drives through the walk. */
  probeLatencyMs?: number
  /** The sink named for the attempt in flight. Decided when the attempt is
   *  decided, so a killed run still leaves a named trace. */
  sinkPath?: string
}

const seal = (run: Run): RunState => run as unknown as RunState
const open = (state: RunState): Run => state as unknown as Run

const STDERR_TAIL = 2_000

/** The last 2000 characters — the tail is where a failure says what it was. */
const tail = (text: string): string => text.slice(-STDERR_TAIL)

/**
 * The forensic sink for one attempt.
 *
 * Deterministic from the decision's own inputs, so the path exists in the
 * record whether or not the process ever wrote to it — a run killed by a
 * laptop lid still leaves a named place to look.
 */
function sinkFor(role: string, id: string, now: number, tag?: 'draft' | 'review'): string {
  // `:` and `.` are flattened: the first is illegal in paths on some systems
  // and the second would read as an extension boundary.
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  return `.jean/.headless/${role}-${id}${tag === undefined ? '' : `-${tag}`}-${stamp}.jsonl`
}

/** Is this phase's attempt preceded by a probe? Opt-in via retries, and —
 *  in the pipeline — DRAFT ONLY: a passed draft has already proven the
 *  network for the review that follows it. */
const probes = (run: Run): boolean =>
  run.totalAttempts > 1 && (!run.pipeline || run.phase === 'draft' || run.phase === 'preparing')

/** The model for the phase in flight. `trigger.model` overrides BOTH phase
 *  defaults — one knob for experiments. */
function modelFor(run: Run): string | undefined {
  if (run.trigger.model !== undefined) return run.trigger.model
  if (run.phase === 'draft') return run.config.librarianDraftModel
  if (run.phase === 'review') return run.config.librarianReviewModel
  return undefined
}

function specFor(run: Run, now: number): { spec: SpawnSpec; sinkPath: string } {
  const tag = run.phase === 'draft' || run.phase === 'review' ? run.phase : undefined
  const sinkPath = sinkFor(run.role, run.trigger.id, now, tag)
  const model = modelFor(run)
  return {
    sinkPath,
    spec: {
      role: run.role,
      prompt: run.trigger.prompt,
      ...(model !== undefined && { model }),
      streamSinkPath: sinkPath,
      // THE BOUND IS THE DECISION'S. The old path let the spawn port enforce
      // an ambient number nobody declared; carrying it here is what makes
      // "the adapter enforces what the decision names" true.
      timeoutMs: run.config.spawnTimeoutMs,
      ...(tag !== undefined && { phaseTag: tag }),
    },
  }
}

/** Begin the attempt in flight: probe first if this phase probes, else
 *  spawn. The one place that decides which of the two starts an attempt. */
function beginAttempt(run: Run, now: number): { run: Run; effects: RunEffect[] } {
  if (probes(run)) return { run, effects: [{ kind: 'probe' }] }
  const { spec, sinkPath } = specFor(run, now)
  return {
    run: { ...run, sinkPath },
    effects: [{ kind: 'spawn', spec, attempt: run.attempt, totalAttempts: run.totalAttempts }],
  }
}

/** `attempt` rides a record only when the run HAS more than one — log
 *  fidelity: single-attempt history has no such field. */
const numbered = (run: Run): { attempt?: number } => (run.totalAttempts > 1 ? { attempt: run.attempt } : {})

const base = (run: Run): Pick<HeadlessCompletedData, 'triggerId' | 'role'> => ({
  triggerId: run.trigger.id,
  role: run.role,
})

/**
 * A failure has consumed its attempt: wait and go again, or stop.
 *
 * The one place the budget is spent, so "never more spawns than the budget"
 * is a property of this function rather than a rule spread over the callers.
 * A dying REVIEW is the exception the pipeline cares about: it sweeps the
 * draft rather than leaving a half-consolidated wiki for the next run to
 * commit on its own — "don't commit on draft alone".
 */
function afterFailure(run: Run, now: number): { run: Run; effects: RunEffect[] } {
  if (run.attempt < run.totalAttempts) {
    const next = { ...run, attempt: run.attempt + 1 }
    const started = beginAttempt(next, now)
    return { run: started.run, effects: [{ kind: 'wait', ms: run.config.retryBackoffMs }, ...started.effects] }
  }
  const aborted: Run = { ...run, phase: 'aborted' }
  return run.phase === 'review' ? { run: aborted, effects: [{ kind: 'discard-draft' }] } : { run: aborted, effects: [] }
}

export const headless: HeadlessContract = {
  validateConfig(config) {
    // FINITE AND POSITIVE — the notifier's Infinity lesson, applied: an
    // infinite backoff never comes due and a zero timeout kills every run
    // instantly, and both are silent for as long as nobody looks.
    for (const field of ['retryBackoffMs', 'spawnTimeoutMs'] as const) {
      const value = config[field]
      if (!Number.isFinite(value) || value <= 0) return { ok: false, refusal: { kind: 'non-positive-bound', field } }
    }
    return { ok: true }
  },

  planRun(trigger, now, config) {
    // THE ONE GATE THIS MODULE KEEPS. Absent `kind` means an agent trigger —
    // that field postdates the kind, so older firings are all agent ones —
    // and is refused the same way.
    if (trigger.kind !== 'headless') return { ok: false, refusal: { kind: 'not-headless', id: trigger.id } }

    const role = trigger.agent as AgentRole
    const totalAttempts = (trigger.retries ?? 0) + 1
    // ID-KEYED, deliberately: the old code names `consolidate-wiki` in as
    // many words and lets any other librarian trigger fall through to a
    // single phase. Extracted as-is rather than generalised into a rule
    // nobody has a second instance of.
    const pipeline = role === 'librarian' && trigger.id === 'consolidate-wiki'

    const run: Run = {
      trigger,
      config,
      role,
      pipeline,
      phase: pipeline ? 'preparing' : 'single',
      attempt: 1,
      totalAttempts,
    }
    // The pipeline recovers its wiki layout before anything spawns; a
    // single-phase run starts its first attempt immediately.
    if (pipeline) return { ok: true, state: seal(run), effects: [{ kind: 'prepare' }] }
    const started = beginAttempt(run, now)
    return { ok: true, state: seal(started.run), effects: started.effects }
  },

  applyPrepare(state, outcome, now) {
    const run = open(state)
    if (!outcome.ok) {
      // The -1 sentinel, in the recover-failure shape: zero duration, not
      // timed out, and NO attempt number — the old path never numbered one
      // here, because nothing had been attempted yet.
      return {
        next: seal({ ...run, phase: 'aborted' }),
        record: {
          ...base(run),
          exitCode: -1,
          durationMs: 0,
          timedOut: false,
          stderrTail: tail(outcome.message),
        },
        effects: [],
      }
    }
    const drafting: Run = { ...run, phase: 'draft', attempt: 1 }
    const started = beginAttempt(drafting, now)
    return { next: seal(started.run), effects: started.effects }
  },

  applyProbe(state, outcome, now) {
    const run = open(state)
    if (outcome.ok) {
      // A PASSED PROBE RECORDS NOTHING — it is not an attempt, it is the
      // permission to make one. Its latency rides the record of the attempt
      // it cleared, which is where a later reader would look for it.
      const cleared: Run = { ...run, probeLatencyMs: outcome.latencyMs }
      const { spec, sinkPath } = specFor(cleared, now)
      return {
        next: seal({ ...cleared, sinkPath }),
        effects: [{ kind: 'spawn', spec, attempt: run.attempt, totalAttempts: run.totalAttempts }],
      }
    }
    // A FAILED PROBE CONSUMES THE ATTEMPT. There is no network to spawn
    // into, so spending the attempt is the honest accounting — and the
    // record says so with its own sentinel rather than a fabricated exit.
    const record: HeadlessCompletedData = {
      ...base(run),
      exitCode: -2,
      durationMs: outcome.latencyMs,
      timedOut: false,
      probeFailed: true,
      probeLatencyMs: outcome.latencyMs,
      stderrTail: tail(`probe failed: ${outcome.error ?? 'unknown'}`),
      ...numbered(run),
    }
    // No `streamPath`: nothing spawned, so there is no trace to name.
    const after = afterFailure({ ...run, probeLatencyMs: outcome.latencyMs }, now)
    return { next: seal(after.run), record, effects: after.effects }
  },

  applyAttempt(state, outcome, now) {
    const run = open(state)

    if (outcome.kind === 'spawn-failed') {
      const record: HeadlessCompletedData = {
        ...base(run),
        exitCode: -1,
        durationMs: 0,
        timedOut: false,
        stderrTail: tail(outcome.message),
        ...numbered(run),
      }
      // RETRIED LIKE ANY OTHER FAILURE — the old loop treats a spawn that
      // never started as `succeeded: false` and goes round again. A missing
      // binary will not heal in sixty seconds, but a machine mid-update or a
      // transient fork failure might, and the budget is the caller's to set.
      const after = afterFailure(run, now)
      return { next: seal(after.run), record, effects: after.effects }
    }

    // SUCCESS IS BOTH HALVES: the process said zero AND the artifact the
    // phase promised is there. An exit-0 draft with no plan.json FAILED —
    // the old path's post-check, and the reason review can trust its input.
    const succeeded = outcome.exitCode === 0 && outcome.postCheckPassed !== false

    const record: HeadlessCompletedData = {
      ...base(run),
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      timedOut: outcome.timedOut,
      // ONLY ON A NONZERO EXIT. A successful run's stderr is warnings, and
      // two thousand characters of them on every nightly record is noise
      // that makes the real tails harder to find.
      ...(outcome.exitCode !== 0 && { stderrTail: tail(outcome.stderr) }),
      ...(outcome.parsed?.sessionId !== undefined && { sessionId: outcome.parsed.sessionId }),
      ...(outcome.parsed?.costUsd !== undefined && { costUsd: outcome.parsed.costUsd }),
      ...(outcome.parsed?.totalTokens !== undefined && { totalTokens: outcome.parsed.totalTokens }),
      ...(outcome.parsed?.model !== undefined && { model: outcome.parsed.model }),
      // The sink rides EVERY ran record, success or failure — it exists
      // either way, and a failure is when someone actually reads it.
      ...(run.sinkPath !== undefined && { streamPath: run.sinkPath }),
      ...(run.probeLatencyMs !== undefined && probes(run) && { probeLatencyMs: run.probeLatencyMs }),
      ...numbered(run),
    }

    if (!succeeded) {
      const after = afterFailure(run, now)
      return { next: seal(after.run), record, effects: after.effects }
    }

    // A DRAFT hands straight to review — no probe, because the draft that
    // just succeeded proved the network for it.
    if (run.phase === 'draft') {
      const reviewing: Run = { ...run, phase: 'review', attempt: 1, probeLatencyMs: undefined }
      const { spec, sinkPath } = specFor(reviewing, now)
      return {
        next: seal({ ...reviewing, sinkPath }),
        record,
        effects: [{ kind: 'spawn', spec, attempt: 1, totalAttempts: run.totalAttempts }],
      }
    }
    // A REVIEW that passed is what makes committing safe.
    if (run.phase === 'review') {
      return { next: seal({ ...run, phase: 'done' }), record, effects: [{ kind: 'commit' }] }
    }
    return { next: seal({ ...run, phase: 'done' }), record, effects: [] }
  },

  phaseOf: (state) => open(state).phase,
}
