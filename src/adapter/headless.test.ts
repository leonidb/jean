/**
 * The headless runner — the walk against stub processes (task E4-HL).
 *
 * NO REAL CLAUDE IS EVER SPAWNED HERE, and that is a rule rather than a
 * convenience: a suite that shells out to a model is slow, costs money, and
 * fails for reasons that have nothing to do with the code. Every port is
 * injected, so what is exercised is exactly the shell's half — that each
 * effect is performed, that every attempt's record is appended once, that
 * the decision's timeout and model reach the spawner, and that the pipeline's
 * commit happens only when the decision says so.
 *
 * WHAT IT DOES NOT ASSERT: when to retry, which phase follows which, whether
 * a run may commit. Those are the domain's and are green in
 * `headless.conformance.test.ts`.
 */

import { describe, expect, test } from 'bun:test'
import type { AttemptOutcome, HeadlessConfig } from '../domain/contracts/headless.ts'
import type { HeadlessCompletedData } from '../domain/contracts/vocabulary.ts'
import { type HeadlessPorts, runHeadless } from './headless.ts'

const CONFIG: HeadlessConfig = {
  retryBackoffMs: 60_000,
  spawnTimeoutMs: 1_800_000,
  librarianDraftModel: 'haiku',
  librarianReviewModel: 'sonnet',
}

type Trace = {
  records: HeadlessCompletedData[]
  spawns: { role: string; prompt: string; model?: string; timeoutMs: number; phaseTag?: string }[]
  waits: number[]
  did: string[]
}

/** Ports that record everything and answer from a script. */
function stub(script: {
  spawn?: (n: number, tag?: string) => AttemptOutcome
  probe?: (n: number) => { ok: boolean; latencyMs: number; error?: string }
  prepare?: () => { ok: true } | { ok: false; message: string }
  postCheck?: (tag?: string) => boolean | undefined
  commitThrows?: boolean
}): { ports: HeadlessPorts; trace: Trace } {
  const trace: Trace = { records: [], spawns: [], waits: [], did: [] }
  let spawnCount = 0
  let probeCount = 0
  return {
    trace,
    ports: {
      now: () => 1_755_600_000_000,
      log: () => {},
      record: async (data) => {
        trace.records.push(data)
      },
      spawn: async (spec) => {
        spawnCount++
        trace.spawns.push({
          role: spec.role,
          prompt: spec.prompt,
          ...(spec.model !== undefined && { model: spec.model }),
          timeoutMs: spec.timeoutMs,
          ...(spec.phaseTag !== undefined && { phaseTag: spec.phaseTag }),
        })
        trace.did.push('spawn')
        return (
          script.spawn?.(spawnCount, spec.phaseTag) ?? {
            kind: 'ran',
            exitCode: 0,
            durationMs: 1_000,
            timedOut: false,
            stderr: '',
          }
        )
      },
      probe: async () => {
        probeCount++
        trace.did.push('probe')
        return script.probe?.(probeCount) ?? { ok: true, latencyMs: 12 }
      },
      prepare: async () => {
        trace.did.push('prepare')
        return script.prepare?.() ?? { ok: true }
      },
      commit: async () => {
        trace.did.push('commit')
        if (script.commitThrows === true) throw new Error('git said no')
      },
      discardDraft: () => {
        trace.did.push('discard')
      },
      postCheck: (tag) => script.postCheck?.(tag),
      wait: async (ms) => {
        // NOT SLEPT. The backoff is a minute in production; what matters
        // here is that the runner honoured the decision's number.
        trace.waits.push(ms)
      },
    },
  }
}

const nightly = { id: 'nightly-report', kind: 'headless', agent: 'worker', prompt: 'produce the report' }
const pipeline = {
  id: 'consolidate-wiki',
  kind: 'headless',
  agent: 'librarian',
  prompt: 'Run the scheduled wiki-consolidation.',
  retries: 1,
}

describe('the kill switch (task 131)', () => {
  test('AN ABORTED RUN WRITES NOTHING — the guard that stops a write-after-drain', async () => {
    // WHY IT EXISTS AT ALL. Readiness no longer awaits the boot catch-up, so
    // `stop()` can land while a spawn is live. An orphan that goes on
    // stepping calls `record` into a store the caller has already drained —
    // and `stop` aborts BEFORE it awaits `drain()`, so a record started after
    // the abort is a write nobody is waiting for into a file nobody is
    // holding open.
    //
    // MEASURED as unheld before this walk: deleting the `signal?.aborted`
    // guard from `took()` left the whole adapter suite green. The contract
    // took an `AbortSignal` and nothing honoured it — a signature satisfied
    // in type and not in behaviour.
    // ABORTED *DURING* THE SPAWN, which is the only case that reaches the
    // guard. An already-aborted signal is caught by the step-loop check one
    // level up and never gets here — my first draft did exactly that and
    // passed while the guard was deleted. The real scenario is the contract's
    // own words: "the abort can land while a spawn is awaited", so the step
    // that resolves afterwards is the one that must decline to write.
    const controller = new AbortController()
    const { ports, trace } = stub({
      spawn: () => {
        controller.abort()
        return { kind: 'ran', exitCode: 0, durationMs: 5, timedOut: false, stderr: '' }
      },
    })
    await runHeadless(nightly, CONFIG, ports, controller.signal)
    expect(trace.did, 'the spawn should still have happened — it was in flight').toEqual(['spawn'])
    expect(trace.records, 'a run aborted mid-spawn recorded anyway').toEqual([])
  })

  test('and it stops STEPPING, not just recording — the walk ends where the abort found it', async () => {
    // The other half: a run killed mid-walk must not go on performing
    // effects. A retrying run is the one with steps left after its first
    // spawn, so it is the one that shows the difference.
    const { ports, trace } = stub({
      spawn: () => ({ kind: 'ran', exitCode: 1, durationMs: 5, timedOut: false, stderr: '' }),
    })
    await runHeadless({ ...pipeline, retries: 2 }, CONFIG, ports, AbortSignal.abort())
    expect(trace.did, 'an aborted run took a step').toEqual([])
  })
})

describe('the single-phase run', () => {
  test('one spawn, one record, and the decision’s bound reaches the spawner', async () => {
    const { ports, trace } = stub({})
    await runHeadless(nightly, CONFIG, ports)
    expect(trace.did).toEqual(['spawn'])
    expect(trace.spawns[0]?.timeoutMs).toBe(CONFIG.spawnTimeoutMs)
    expect(trace.spawns[0]?.prompt).toBe('produce the report')
    // ONE ATTEMPT, ONE RECORD — never zero, never two.
    expect(trace.records.length).toBe(1)
    expect(trace.records[0]?.exitCode).toBe(0)
  })

  test('a spawn that never started is reported as such, not as an exit code', async () => {
    const { ports, trace } = stub({ spawn: () => ({ kind: 'spawn-failed', message: 'ENOENT: claude not found' }) })
    await runHeadless(nightly, CONFIG, ports)
    expect(trace.records[0]?.exitCode).toBe(-1)
    expect(trace.records[0]?.stderrTail).toContain('ENOENT')
  })

  test('a retrying run probes, waits the decision’s backoff, and stops at the budget', async () => {
    const { ports, trace } = stub({
      spawn: () => ({ kind: 'ran', exitCode: 1, durationMs: 500, timedOut: false, stderr: 'boom' }),
    })
    await runHeadless({ ...nightly, retries: 1 }, CONFIG, ports)
    expect(trace.did).toEqual(['probe', 'spawn', 'probe', 'spawn'])
    expect(trace.waits).toEqual([CONFIG.retryBackoffMs]) // the number the decision named
    expect(trace.records.length).toBe(2) // one per attempt, and no third spawn
    expect(trace.records.map((r) => r.attempt)).toEqual([1, 2])
  })

  test('a failed probe consumes its attempt and never spawns', async () => {
    const { ports, trace } = stub({ probe: () => ({ ok: false, latencyMs: 900, error: 'dns dead' }) })
    await runHeadless({ ...nightly, retries: 1 }, CONFIG, ports)
    expect(trace.did).toEqual(['probe', 'probe'])
    expect(trace.records.every((r) => r.exitCode === -2)).toBe(true)
    expect(trace.records.every((r) => r.probeFailed === true)).toBe(true)
  })
})

describe('the consolidation pipeline', () => {
  test('prepare → draft → review → commit, with each phase’s own model and prompt', async () => {
    const { ports, trace } = stub({ postCheck: (tag) => (tag === 'draft' ? true : undefined) })
    await runHeadless(pipeline, CONFIG, ports)
    expect(trace.did).toEqual(['prepare', 'probe', 'spawn', 'spawn', 'commit'])
    expect(trace.spawns[0]).toMatchObject({ phaseTag: 'draft', model: 'haiku', role: 'librarian' })
    expect(trace.spawns[1]).toMatchObject({ phaseTag: 'review', model: 'sonnet' })
    // THE PHASE PROMPT IS THE ADAPTER'S: a tagged phase runs its own skill,
    // not the trigger's description of the whole job.
    expect(trace.spawns[0]?.prompt).toContain('consolidate-wiki-draft')
    expect(trace.spawns[1]?.prompt).toContain('consolidate-wiki-review')
    expect(trace.spawns[0]?.prompt).not.toBe(pipeline.prompt)
    expect(trace.records.length).toBe(2) // one per attempt; commit is not an attempt
  })

  test('the draft’s POST CHECK is the shell’s fs answer, and an exit-0 draft without it fails', async () => {
    // The artifact is missing, so the draft did not succeed however cleanly
    // the process exited — and review must not run on a plan that is not
    // there.
    const { ports, trace } = stub({ postCheck: (tag) => (tag === 'draft' ? false : undefined) })
    await runHeadless(pipeline, CONFIG, ports)
    expect(trace.did).toEqual(['prepare', 'probe', 'spawn', 'probe', 'spawn'])
    expect(trace.did).not.toContain('commit')
    expect(trace.records.length).toBe(2)
  })

  test('a review that dies discards the draft and NEVER commits', async () => {
    const { ports, trace } = stub({
      postCheck: (tag) => (tag === 'draft' ? true : undefined),
      spawn: (_n, tag) =>
        tag === 'review'
          ? { kind: 'ran', exitCode: 1, durationMs: 400, timedOut: false, stderr: 'review died' }
          : { kind: 'ran', exitCode: 0, durationMs: 400, timedOut: false, stderr: '' },
    })
    await runHeadless(pipeline, CONFIG, ports)
    expect(trace.did).toEqual(['prepare', 'probe', 'spawn', 'spawn', 'spawn', 'discard'])
    expect(trace.did).not.toContain('commit')
  })

  test('a prepare that fails records the sentinel and spawns nothing', async () => {
    const { ports, trace } = stub({ prepare: () => ({ ok: false, message: 'staging corrupt' }) })
    await runHeadless(pipeline, CONFIG, ports)
    expect(trace.did).toEqual(['prepare'])
    expect(trace.records[0]?.exitCode).toBe(-1)
    expect(trace.records[0]?.stderrTail).toContain('staging corrupt')
  })

  test('a commit that throws is LOUD and does not take the run down', async () => {
    const lines: string[] = []
    const { ports, trace } = stub({ postCheck: (tag) => (tag === 'draft' ? true : undefined), commitThrows: true })
    await runHeadless(pipeline, CONFIG, { ...ports, log: (line) => lines.push(line) })
    expect(trace.did).toContain('commit')
    // There is no attempt left to record it against — the decision has
    // already finished — so the log is where the next morning looks.
    expect(lines.join('')).toContain('commit failed')
  })
})

describe('the gate', () => {
  test('an AGENT trigger runs nothing at all — its prompt reaches its target through the mailbox', async () => {
    const { ports, trace } = stub({})
    await runHeadless({ ...nightly, kind: 'agent' }, CONFIG, ports)
    expect(trace.did).toEqual([])
    expect(trace.records).toEqual([])
  })
})
