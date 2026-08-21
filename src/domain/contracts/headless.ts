/**
 * The headless spawn contract — decisions for a process the domain never
 * runs (task 108, row A-HL; R17's subsystem). EXTRACTION territory (§8):
 * the old run path (`runHeadlessTrigger`, `runHeadlessAttempt`,
 * `runLibrarianMultiPhase` in `src/infra/server.ts`) and the REAL
 * `headless-completed` events both dojos' logs hold are the requirements
 * source.
 *
 * ── THE SPLIT ──
 *
 * The DOMAIN decides: what to spawn (role, prompt, model, the forensic
 * stream-sink path, the timeout bound), whether to probe first, when to
 * retry and after how long, when to give up, what each attempt RECORDS,
 * and — for the consolidation pipeline — which phase comes next and when
 * committing is forbidden. The ADAPTER runs: processes (`Bun.spawn`
 * ports), the pre-flight probe, stream capture, timeout enforcement, the
 * wiki-layout recovery, and the commit step. Outcomes come back AS DATA
 * (the notifier's discipline — this unit was born after R16, so it gets
 * the outcome seam from day one: state advances only on reported
 * outcomes, never on intentions).
 *
 * ── ONE ATTEMPT, ONE RECORD — always ──
 *
 * EVERY attempt yields exactly one `headless-completed` record, extracted
 * with the census sentinels real logs hold:
 *   exit 0..n  — the process ran; `stderrTail` (last 2000 chars) only on
 *                nonzero exit; `parsed` session fields carried verbatim;
 *                `streamPath` names the forensic sink.
 *   exit -1    — the spawn itself failed (or the pipeline's prepare step
 *                did): `durationMs: 0`, the message's last 2000 chars.
 *   exit -2    — the pre-flight probe failed: `probeFailed: true`, the
 *                probe latency as the duration AND as `probeLatencyMs`.
 * A ran-record whose attempt was PROBED carries `probeLatencyMs` too (the
 * old path threads the passed probe's latency onto the completion record)
 * — the state remembers the last probe's answer, which is indirect state
 * the suite drives through the walk. `streamPath` rides EVERY ran record,
 * success or failure — the forensic sink exists either way.
 * `attempt` rides the record only when the run has more than one attempt
 * (log fidelity — single-attempt history has no field). A record is never
 * skipped and never doubled — the mirror pair the suite pins.
 *
 * ── RETRY AND PROBE (extracted with their reasons) ──
 *
 * `totalAttempts = retries + 1` (the trigger's own knob; zero keeps the
 * historical single-attempt shape). Between attempts the shell WAITS
 * `retryBackoffMs` — the old 60s constant, promoted to configuration: it
 * exists because post-sleep dark wakes healed within 1–2 minutes. The
 * probe is OPT-IN VIA RETRIES (`retries > 0`) and precedes EVERY attempt
 * it applies to — a failed probe consumes the attempt and records the -2
 * sentinel. The consolidation pipeline probes draft attempts only: a
 * passed draft already validated the network for review.
 *
 * SUCCESS is `exitCode === 0` AND `postCheckPassed !== false` — the post
 * check is the shell's fs knowledge (draft's plan.json existing), reported
 * in the outcome; an exit-0 attempt whose artifact is missing FAILED, and
 * retries.
 *
 * ── THE CONSOLIDATION PIPELINE (id-keyed, deliberately) ──
 *
 * `role === 'librarian' && id === 'consolidate-wiki'` routes through the
 * three-phase pipeline — the old code keys on the id in as many words and
 * lets any other librarian trigger fall through to single-phase; extracted
 * as-is. Phases: PREPARE (shell recovers the wiki layout; failure aborts
 * with a -1 record) → DRAFT (default model from config, post-check
 * required) → REVIEW (default model from config, no probe) → COMMIT (an
 * effect; in-process, deterministic, no retries — the shell runs it and
 * appends `wiki-consolidated`). A draft that exhausts its attempts ABORTS
 * — no review; a review that exhausts its attempts emits DISCARD-DRAFT
 * and never commits ("don't commit on draft alone" — review's index
 * regeneration is load-bearing). `trigger.model` overrides BOTH phase
 * defaults — one knob for experiments.
 *
 * ── WHO OWNS `wiki-consolidated` / the `/context/consolidated` write ──
 *
 * RULED here (the 108 brief asked): NEITHER this module NOR knowledge
 * grows a fold for it. The event is a recorded fact — its shape is the
 * vocabulary's (`WikiConsolidatedData`), its resolution is the table's
 * (MAIL to the orchestrator since task 119, admission-gated — the skill
 * surfaces its anomalies to the human). The write surface is a thin
 * adapter route appending a census shape — E4-HL wires it; a fold with
 * no reader would be shape without a keeper.
 *
 * What the types cannot enforce, and what does: the one-attempt-one-record
 * law, the sentinels, the retry/backoff walk, the probe policy, the
 * success predicate, and the pipeline's abort/no-commit rules are held by
 * `headless.conformance.test.ts` (red by absence until E4-HL lands
 * `src/domain/headless/index.ts` — the implementation rides the E-task
 * because the module is small and the subsystem around it is adapter
 * work; the contract still forbids anything else implementing it).
 */

import type { AgentRole, HeadlessCompletedData } from './vocabulary.ts'

/** Named configuration — every bound injected (P8's discipline), validated
 *  like the notifier's (the Infinity lesson: finite, positive). */
export type HeadlessConfig = {
  /** Between failed attempts — the old 60s dark-wake constant. */
  retryBackoffMs: number
  /** The bound the SPAWNER enforces; carried on every spawn spec.
   *  DELIBERATE DIVERGENCE (task 108, flagged): the old path never decided
   *  a timeout — the spawn port enforced one ambiently (`timedOut` is real
   *  in every log). Promoting the bound to configuration is the standing
   *  bounds-are-configuration discipline; the adapter enforces what the
   *  decision names, instead of a number nobody declared. */
  spawnTimeoutMs: number
  /** The pipeline's phase defaults; `trigger.model` overrides both. */
  librarianDraftModel: string
  librarianReviewModel: string
}

export type HeadlessConfigRefusal = { kind: 'non-positive-bound'; field: string }

/** The fired trigger's facts, composed from the triggers module (R10). */
export type HeadlessTriggerFacts = {
  id: string
  kind?: string
  /** For a headless trigger this names a ROLE (validated at creation). */
  agent: string
  prompt: string
  model?: string
  retries?: number
}

/** What the adapter's spawn port consumes — everything decided, nothing
 *  ambient. */
export type SpawnSpec = {
  role: AgentRole
  prompt: string
  model?: string
  /** `.jean/.headless/<role>-<id>[-<tag>]-<iso>.jsonl` — deterministic
   *  from the decision's inputs, so a killed run still leaves a named
   *  trace. */
  streamSinkPath: string
  timeoutMs: number
  phaseTag?: 'draft' | 'review'
}

export type RunEffect =
  | { kind: 'probe' }
  | { kind: 'spawn'; spec: SpawnSpec; attempt: number; totalAttempts: number }
  /** The shell sleeps this long before performing the NEXT effect in the
   *  same list (executor law (a): one decision's effects, in order). */
  | { kind: 'wait'; ms: number }
  /** Pipeline only: recover the wiki layout before anything spawns. */
  | { kind: 'prepare' }
  /** Pipeline only: the in-process commit (deterministic, no retries);
   *  the shell appends `wiki-consolidated` as part of performing it. */
  | { kind: 'commit' }
  /** Pipeline only: review exhausted its attempts — sweep the draft's
   *  plan so the next run starts clean. Never followed by commit. */
  | { kind: 'discard-draft' }

export type ProbeOutcome = { ok: boolean; latencyMs: number; error?: string }

export type AttemptOutcome =
  | {
      kind: 'ran'
      exitCode: number
      durationMs: number
      timedOut: boolean
      stderr: string
      parsed?: { sessionId?: string; costUsd?: number; totalTokens?: number; model?: string }
      /** The phase's extra success predicate (fs knowledge, shell-evaluated).
       *  Absent = no post check for this phase. */
      postCheckPassed?: boolean
    }
  | { kind: 'spawn-failed'; message: string }

export type PrepareOutcome = { ok: true } | { ok: false; message: string }

/** Where a run stands — the view assertions read; the state is otherwise
 *  opaque (attempt counters and phase are indirectly-visible by design). */
export type RunPhase = 'preparing' | 'single' | 'draft' | 'review' | 'committing' | 'done' | 'aborted'

export type RunState = { readonly __headlessRunState: true }

export type RunStep = {
  next: RunState
  /** The attempt's record, when this step produced one — append exactly
   *  this, once, to the triggers stream. */
  record?: HeadlessCompletedData
  effects: readonly RunEffect[]
}

export type PlanRefusal = { kind: 'not-headless'; id: string }

/** `export const headless: HeadlessContract` — src/domain/headless/
 *  (task E4-HL, and nowhere else). */
export type HeadlessContract = {
  validateConfig: (config: HeadlessConfig) => { ok: true } | { ok: false; refusal: HeadlessConfigRefusal }

  /** Start a run for a FIRED trigger. Refuses non-headless kinds typed —
   *  the one gate this module keeps for itself; role validity is the
   *  creation gate's (composed facts, R10). `now` stamps the first
   *  forensic sink path. */
  planRun: (
    trigger: HeadlessTriggerFacts,
    now: number,
    config: HeadlessConfig,
  ) => { ok: true; state: RunState; effects: readonly RunEffect[] } | { ok: false; refusal: PlanRefusal }

  /** The pipeline's prepare outcome. Failure records the -1 sentinel and
   *  aborts the run. */
  applyPrepare: (state: RunState, outcome: PrepareOutcome, now: number) => RunStep

  /** A probe outcome. Failure consumes the attempt (the -2 record) and
   *  retries or aborts per the budget; success spawns. */
  applyProbe: (state: RunState, outcome: ProbeOutcome, now: number) => RunStep

  /** An attempt outcome — ALWAYS yields the attempt's record, then
   *  decides: success advances (next phase, commit, or done); failure
   *  waits and retries, or aborts (with discard-draft when a review
   *  dies). `now` stamps the next attempt's sink path. */
  applyAttempt: (state: RunState, outcome: AttemptOutcome, now: number) => RunStep

  phaseOf: (state: RunState) => RunPhase
}
