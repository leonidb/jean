/**
 * Headless conformance — the executable form of the headless contract.
 * RED BY ABSENCE until E4-HL lands `src/domain/headless/index.ts` exporting
 * `headless: HeadlessContract`.
 *
 * Aimed per the standing checklist: the attempt counter and phase are
 * indirectly-visible state (nothing returns them but `phaseOf`; they show
 * in WHICH effects each outcome yields), so every law here is a walk; the
 * unassumed inputs are the sentinels, oversized stderr, exit-0-with-failed-
 * post-check, and non-headless triggers; the mirror pair is
 * one-attempt-one-record — never zero, never two — and never more spawns
 * than the budget.
 */

import { describe, expect, test } from 'bun:test'
import { counted } from '../fixture/index.ts'
import type { HeadlessConfig, HeadlessContract, HeadlessTriggerFacts, RunEffect } from './headless.ts'

const IMPL_PATH: string = '../headless/index.ts'
const headless: HeadlessContract = await import(IMPL_PATH)
  .then((m) => (m as { headless: HeadlessContract }).headless)
  .catch((err: unknown) => {
    if (String(err).includes('Cannot find module')) {
      throw new Error(
        'RED BY ABSENCE — src/domain/headless/index.ts does not exist yet. ' +
          'Task E4-HL implements the HeadlessContract; nothing else may (no plausible stubs — design §9).',
      )
    }
    throw err
  })

const T0 = 1_755_600_000_000
const CONFIG: HeadlessConfig = {
  retryBackoffMs: 60_000,
  spawnTimeoutMs: 1_800_000,
  librarianDraftModel: 'haiku',
  librarianReviewModel: 'sonnet',
}

const nightly: HeadlessTriggerFacts = {
  id: 'nightly-report',
  kind: 'headless',
  agent: 'worker',
  prompt: 'produce the report',
}

const pipeline: HeadlessTriggerFacts = {
  id: 'consolidate-wiki',
  kind: 'headless',
  agent: 'librarian',
  prompt: 'Run the scheduled wiki-consolidation.',
  retries: 1,
}

function plan(trigger: HeadlessTriggerFacts) {
  const p = headless.planRun(trigger, T0, CONFIG)
  if (!p.ok) throw new Error(`fixture: planRun refused ${p.refusal.kind}`)
  return p
}

const spawns = (effects: readonly RunEffect[]) => effects.filter((e) => e.kind === 'spawn')

describe('configuration — finite positive bounds, the notifier’s Infinity lesson', () => {
  test('valid passes; zero, negative, Infinity and NaN each refuse naming their field', () => {
    expect(headless.validateConfig(CONFIG)).toEqual({ ok: true })
    const bad = [
      { ...CONFIG, retryBackoffMs: 0 },
      { ...CONFIG, retryBackoffMs: Number.POSITIVE_INFINITY },
      { ...CONFIG, spawnTimeoutMs: -5 },
      { ...CONFIG, spawnTimeoutMs: Number.NaN },
    ]
    let checked = 0
    for (const config of bad) {
      const d = headless.validateConfig(config)
      expect(d.ok).toBe(false)
      if (!d.ok) {
        expect(d.refusal.kind).toBe('non-positive-bound')
        expect(['retryBackoffMs', 'spawnTimeoutMs']).toContain(d.refusal.field) // named, per the contract
      }
      checked++
    }
    counted('config refusals', checked, 4)
  })
})

describe('planRun — the gate and the first move', () => {
  test('a non-headless trigger refuses typed — absent kind means agent (older logs), refused the same', () => {
    let checked = 0
    for (const kind of ['agent', undefined]) {
      const p = headless.planRun({ ...nightly, kind }, T0, CONFIG)
      expect(p.ok).toBe(false)
      if (!p.ok) expect(p.refusal).toEqual({ kind: 'not-headless', id: 'nightly-report' })
      checked++
    }
    counted('non-headless refusals', checked, 2)
  })

  test('retries 0 (the historical default): ONE spawn, NO probe, everything decided — role, prompt, timeout, a named sink', () => {
    const p = plan(nightly)
    expect(p.effects.length).toBe(1)
    const spawn = p.effects[0]
    expect(spawn?.kind).toBe('spawn')
    if (spawn?.kind !== 'spawn') throw new Error('unreachable')
    expect(spawn.attempt).toBe(1)
    expect(spawn.totalAttempts).toBe(1)
    expect(spawn.spec.role).toBe('worker')
    expect(spawn.spec.prompt).toBe('produce the report')
    expect(spawn.spec.timeoutMs).toBe(CONFIG.spawnTimeoutMs) // the bound is configuration, not adapter lore
    expect(spawn.spec.phaseTag).toBeUndefined()
    // The forensic sink: role, id and a timestamp with [:.] flattened —
    // a killed run still leaves a named trace.
    expect(spawn.spec.streamSinkPath).toMatch(/^\.jean\/\.headless\/worker-nightly-report-[0-9TZ-]+\.jsonl$/)
    expect(headless.phaseOf(p.state)).toBe('single')
  })

  test('retries > 0: the probe comes FIRST, and precedes every attempt it applies to', () => {
    const p = plan({ ...nightly, retries: 2 })
    expect(p.effects.map((e) => e.kind)).toEqual(['probe'])
    const probed = headless.applyProbe(p.state, { ok: true, latencyMs: 40 }, T0)
    expect(probed.record).toBeUndefined() // a passed probe records nothing
    expect(probed.effects.map((e) => e.kind)).toEqual(['spawn'])
    expect(spawns(probed.effects)[0]?.totalAttempts).toBe(3)
  })
})

describe('the retry walk — one attempt, one record, never more spawns than the budget', () => {
  test('failure records (stderr tail capped at 2000, attempt numbered), waits the backoff, probes again; exhaustion aborts', () => {
    const p = plan({ ...nightly, retries: 1 })
    let step = headless.applyProbe(p.state, { ok: true, latencyMs: 10 }, T0)
    // Attempt 1 fails loudly with an oversized stderr.
    step = headless.applyAttempt(
      step.next,
      { kind: 'ran', exitCode: 1, durationMs: 5_000, timedOut: false, stderr: 'x'.repeat(3_000) },
      T0 + 60_000,
    )
    expect(step.record?.exitCode).toBe(1)
    expect(step.record?.stderrTail?.length).toBe(2_000) // the last 2000, exactly
    expect(step.record?.attempt).toBe(1) // numbered — the run has two attempts
    expect(step.record?.timedOut).toBe(false)
    expect(step.record?.probeLatencyMs).toBe(10) // the passed probe rides its attempt's record (codex pass)
    expect(typeof step.record?.streamPath).toBe('string') // the sink exists on failures too
    expect(step.effects.map((e) => e.kind)).toEqual(['wait', 'probe']) // backoff, then the NEXT attempt's probe
    expect(step.effects[0]).toEqual({ kind: 'wait', ms: CONFIG.retryBackoffMs })
    // Attempt 2: probe ok, spawn, fail again — exhausted.
    step = headless.applyProbe(step.next, { ok: true, latencyMs: 12 }, T0 + 120_000)
    expect(spawns(step.effects)[0]?.attempt).toBe(2)
    step = headless.applyAttempt(
      step.next,
      { kind: 'ran', exitCode: 1, durationMs: 4_000, timedOut: true, stderr: 'died' },
      T0 + 180_000,
    )
    expect(step.record?.attempt).toBe(2)
    expect(step.record?.timedOut).toBe(true)
    expect(step.record?.probeLatencyMs).toBe(12) // the SECOND probe's answer, not the first's
    expect(step.effects).toEqual([]) // THE MIRROR: no third spawn, ever
    expect(headless.phaseOf(step.next)).toBe('aborted')
  })

  test('a FAILED probe consumes the attempt: the -2 sentinel with the latency as duration, then retry or abort', () => {
    const p = plan({ ...nightly, retries: 1 })
    let step = headless.applyProbe(p.state, { ok: false, latencyMs: 950, error: 'dns dead' }, T0)
    expect(step.record?.exitCode).toBe(-2)
    expect(step.record?.probeFailed).toBe(true)
    expect(step.record?.durationMs).toBe(950)
    expect(step.record?.probeLatencyMs).toBe(950) // both fields, per the old record shape
    expect(step.record?.stderrTail).toContain('dns dead')
    expect(step.record?.streamPath).toBeUndefined() // nothing spawned, nothing to trace
    expect(step.effects.map((e) => e.kind)).toEqual(['wait', 'probe'])
    step = headless.applyProbe(step.next, { ok: false, latencyMs: 990, error: 'still dead' }, T0 + 60_000)
    expect(step.record?.attempt).toBe(2)
    expect(step.effects).toEqual([])
    expect(headless.phaseOf(step.next)).toBe('aborted')
  })

  test('the -1 sentinel: a spawn that never ran records duration 0 and the message tail', () => {
    const p = plan(nightly)
    const step = headless.applyAttempt(p.state, { kind: 'spawn-failed', message: 'ENOENT: claude not found' }, T0)
    expect(step.record?.exitCode).toBe(-1)
    expect(step.record?.durationMs).toBe(0)
    expect(step.record?.stderrTail).toContain('ENOENT')
    expect(step.record?.attempt).toBeUndefined() // single-attempt runs carry no attempt field (log fidelity)
    expect(headless.phaseOf(step.next)).toBe('aborted')
  })

  test('SUCCESS is exit 0 AND the post check not false: an exit-0 attempt with a missing artifact FAILED, and retries', () => {
    const p = plan({ ...nightly, retries: 1 })
    let step = headless.applyProbe(p.state, { ok: true, latencyMs: 8 }, T0)
    step = headless.applyAttempt(
      step.next,
      { kind: 'ran', exitCode: 0, durationMs: 9_000, timedOut: false, stderr: '', postCheckPassed: false },
      T0 + 60_000,
    )
    expect(step.record?.exitCode).toBe(0) // the record says what happened…
    expect(step.effects.map((e) => e.kind)).toEqual(['wait', 'probe']) // …the decision says it was not success
    expect(headless.phaseOf(step.next)).not.toBe('done')
  })

  test('a clean success records verbatim parsed fields, no stderr tail, the stream path — and ends the run', () => {
    const p = plan(nightly)
    const step = headless.applyAttempt(
      p.state,
      {
        kind: 'ran',
        exitCode: 0,
        durationMs: 435_471,
        timedOut: false,
        stderr: 'warnings that do not matter',
        parsed: { sessionId: 'sess-1', costUsd: 1.78, totalTokens: 921_000, model: 'haiku' },
      },
      T0 + 500_000,
    )
    expect(step.record?.stderrTail).toBeUndefined() // exit 0 carries no tail
    expect(step.record?.sessionId).toBe('sess-1')
    expect(step.record?.costUsd).toBe(1.78)
    expect(step.record?.totalTokens).toBe(921_000)
    expect(step.record?.model).toBe('haiku')
    expect(typeof step.record?.streamPath).toBe('string')
    expect(step.effects).toEqual([])
    expect(headless.phaseOf(step.next)).toBe('done')
  })
})

describe('the consolidation pipeline — id-keyed, prepare → draft → review → commit', () => {
  test('only consolidate-wiki routes through the pipeline; any other librarian trigger is single-phase', () => {
    const other = plan({ ...pipeline, id: 'other-librarian-job' })
    expect(other.effects.map((e) => e.kind)).toEqual(['probe']) // retries 1 → probe, straight to single-phase
    expect(headless.phaseOf(other.state)).toBe('single')
    const p = plan(pipeline)
    expect(p.effects.map((e) => e.kind)).toEqual(['prepare'])
    expect(headless.phaseOf(p.state)).toBe('preparing')
  })

  test('prepare failure aborts with the -1 record; nothing ever spawns', () => {
    const p = plan(pipeline)
    const step = headless.applyPrepare(p.state, { ok: false, message: 'staging corrupt' }, T0)
    expect(step.record?.exitCode).toBe(-1)
    expect(step.record?.stderrTail).toContain('staging corrupt')
    // The full recordHeadlessFailure shape (codex pass): zero duration, not
    // timed out, and NO attempt field — the old recover-failure path never
    // numbered one.
    expect(step.record?.durationMs).toBe(0)
    expect(step.record?.timedOut).toBe(false)
    expect(step.record?.attempt).toBeUndefined()
    expect(step.effects).toEqual([])
    expect(headless.phaseOf(step.next)).toBe('aborted')
  })

  test('the happy path: draft (default model, post-checked, probed) → review (default model, NO probe) → commit', () => {
    const p = plan(pipeline)
    let step = headless.applyPrepare(p.state, { ok: true }, T0)
    expect(step.effects.map((e) => e.kind)).toEqual(['probe']) // retries 1 → draft attempts are probed
    step = headless.applyProbe(step.next, { ok: true, latencyMs: 20 }, T0)
    const draft = spawns(step.effects)[0]
    expect(draft?.spec.phaseTag).toBe('draft')
    expect(draft?.spec.model).toBe('haiku') // the config default
    expect(draft?.spec.role).toBe('librarian')
    expect(draft?.spec.streamSinkPath).toContain('-draft-')
    step = headless.applyAttempt(
      step.next,
      { kind: 'ran', exitCode: 0, durationMs: 100_000, timedOut: false, stderr: '', postCheckPassed: true },
      T0 + 100_000,
    )
    // Straight to review — no probe (draft already validated the network).
    const review = spawns(step.effects)[0]
    expect(step.effects.map((e) => e.kind)).toEqual(['spawn'])
    expect(review?.spec.phaseTag).toBe('review')
    expect(review?.spec.model).toBe('sonnet')
    expect(headless.phaseOf(step.next)).toBe('review')
    step = headless.applyAttempt(
      step.next,
      { kind: 'ran', exitCode: 0, durationMs: 200_000, timedOut: false, stderr: '' },
      T0 + 300_000,
    )
    expect(step.effects.map((e) => e.kind)).toEqual(['commit'])
    expect(headless.phaseOf(step.next)).toBe('done')
  })

  test('trigger.model overrides BOTH phase defaults — one knob', () => {
    const p = plan({ ...pipeline, model: 'opus' })
    let step = headless.applyPrepare(p.state, { ok: true }, T0)
    step = headless.applyProbe(step.next, { ok: true, latencyMs: 5 }, T0)
    expect(spawns(step.effects)[0]?.spec.model).toBe('opus')
    step = headless.applyAttempt(
      step.next,
      { kind: 'ran', exitCode: 0, durationMs: 1_000, timedOut: false, stderr: '', postCheckPassed: true },
      T0 + 60_000,
    )
    expect(spawns(step.effects)[0]?.spec.model).toBe('opus')
  })

  test('a review that exhausts its attempts DISCARDS THE DRAFT and never commits — review is load-bearing', () => {
    const p = plan(pipeline) // retries 1 → two attempts per phase
    let step = headless.applyPrepare(p.state, { ok: true }, T0)
    step = headless.applyProbe(step.next, { ok: true, latencyMs: 5 }, T0)
    step = headless.applyAttempt(
      step.next,
      { kind: 'ran', exitCode: 0, durationMs: 1_000, timedOut: false, stderr: '', postCheckPassed: true },
      T0 + 60_000,
    )
    const collected: string[] = []
    // Review fails both attempts.
    step = headless.applyAttempt(
      step.next,
      { kind: 'ran', exitCode: 1, durationMs: 500, timedOut: false, stderr: 'review died' },
      T0 + 120_000,
    )
    collected.push(...step.effects.map((e) => e.kind))
    expect(step.effects.map((e) => e.kind)).toEqual(['wait', 'spawn']) // review retries are NOT probed
    step = headless.applyAttempt(
      step.next,
      { kind: 'ran', exitCode: 1, durationMs: 500, timedOut: false, stderr: 'review died again' },
      T0 + 240_000,
    )
    collected.push(...step.effects.map((e) => e.kind))
    expect(step.effects.map((e) => e.kind)).toEqual(['discard-draft'])
    expect(headless.phaseOf(step.next)).toBe('aborted')
    expect(collected).not.toContain('commit') // don't commit on draft alone — ever
  })

  test('a draft that exhausts its attempts ABORTS — no review, no commit, no discard needed', () => {
    const p = plan(pipeline)
    let step = headless.applyPrepare(p.state, { ok: true }, T0)
    step = headless.applyProbe(step.next, { ok: true, latencyMs: 5 }, T0)
    step = headless.applyAttempt(
      step.next,
      { kind: 'ran', exitCode: 1, durationMs: 500, timedOut: false, stderr: 'draft died' },
      T0 + 60_000,
    )
    expect(step.effects.map((e) => e.kind)).toEqual(['wait', 'probe'])
    step = headless.applyProbe(step.next, { ok: true, latencyMs: 5 }, T0 + 120_000)
    step = headless.applyAttempt(
      step.next,
      { kind: 'ran', exitCode: 0, durationMs: 500, timedOut: false, stderr: '', postCheckPassed: false },
      T0 + 180_000,
    )
    expect(step.effects).toEqual([]) // exhausted: exit 0 with a failed post check is still a failure
    expect(headless.phaseOf(step.next)).toBe('aborted')
  })
})
