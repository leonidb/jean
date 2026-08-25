/**
 * The headless runner — the shell half of the spawn subsystem (task E4-HL).
 *
 * ── THE LOOP IS THE WHOLE FILE ──
 *
 * `planRun` says what to do; the ports do it; the outcome goes back in; the
 * decision says what to do next. Nothing here decides whether to retry, how
 * long to wait, which model a phase uses or whether a run may commit — every
 * one of those is in the effect list it is handed. What this file owns is
 * processes, files and the clock.
 *
 * ── STATE ADVANCES ONLY ON REPORTED OUTCOMES ──
 *
 * The seam this unit was born with (R16). The runner never assumes a spawn
 * worked: it performs the effect, waits for the answer, and hands the answer
 * back. A crash between the two loses the run — which is correct, because a
 * run whose outcome nobody observed is a run nobody can honestly record.
 *
 * ── THE PHASE PROMPT IS THE ADAPTER'S ──
 *
 * `SpawnSpec` carries the trigger's prompt, and for a TAGGED phase the
 * runner substitutes that phase's own instruction text. The prompts are long
 * content strings that live beside the consolidator they instruct; the
 * decision names WHICH phase, which is the part that is a decision. Same
 * split as the announcement's wording. Flagged in handover as an
 * observation about `SpawnSpec.prompt` rather than a liberty taken quietly.
 */

import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  AttemptOutcome,
  HeadlessConfig,
  HeadlessTriggerFacts,
  ProbeOutcome,
} from '../domain/contracts/headless.ts'
import type { HeadlessCompletedData, WikiConsolidatedData } from '../domain/contracts/vocabulary.ts'
import { headless } from '../domain/headless/index.ts'

/**
 * The pipeline phases' own instructions.
 *
 * A tagged phase does not run the trigger's prompt: draft and review each
 * invoke their own skill, and the trigger's text ("Run the scheduled
 * wiki-consolidation.") is the description of the whole job rather than of
 * either half. Extracted verbatim from the old runner — these strings name
 * skills, and a paraphrase would be a different instruction.
 */
const PHASE_PROMPTS: Record<string, string | undefined> = {
  draft: 'Run the consolidate-wiki-draft skill exactly. Phase 1 of 3 — draft only, do not swap, do not advance cursor.',
  review:
    'Run the consolidate-wiki-review skill exactly. Phase 2 of 3 — proofread the staging output from phase 1, do not swap.',
}

/** What the runner needs the world to do. Every one is injectable, which is
 *  what lets the suite drive the whole walk against stub processes — a test
 *  must never spawn a real claude. */
export type HeadlessPorts = {
  now: () => number
  log: (line: string) => void
  /** Append the attempt's record. Exactly one per attempt, never skipped. */
  record: (data: HeadlessCompletedData) => Promise<unknown>
  /** Run the process the decision specified, and report what happened. */
  spawn: (spec: {
    role: string
    prompt: string
    model?: string
    streamSinkPath: string
    timeoutMs: number
    phaseTag?: 'draft' | 'review'
  }) => Promise<AttemptOutcome>
  /** The pre-flight reachability check. */
  probe: () => Promise<ProbeOutcome>
  /** Recover the wiki layout before the pipeline spawns anything. */
  prepare: () => Promise<{ ok: true } | { ok: false; message: string }>
  /** The in-process commit; appends `wiki-consolidated` itself. */
  commit: () => Promise<void>
  /** Sweep the draft's plan so the next run starts clean. */
  discardDraft: () => void
  /** The phase's extra success predicate — draft's plan.json existing. */
  postCheck: (phaseTag: 'draft' | 'review' | undefined) => boolean | undefined
  /** The backoff. Injectable so a suite does not wait sixty seconds. */
  wait: (ms: number) => Promise<void>
}

/**
 * Drive one fired trigger to completion.
 *
 * Returns when the run is done or aborted. The caller does NOT await it in
 * production — a consolidation is half an hour of process time and the
 * firing that started it is one appended event.
 */
export async function runHeadless(
  trigger: HeadlessTriggerFacts,
  config: HeadlessConfig,
  ports: HeadlessPorts,
  /** THE BOOT CATCH-UP'S KILL SWITCH (task 131). Carried only by the run
   *  `stop` may find in flight — readiness no longer waits for the catch-up,
   *  so a stop can land mid-run, and an orphan that keeps stepping calls
   *  `record` into a store the caller has already drained. Absent on an
   *  ordinary cron firing, which `stop` has no claim on. */
  signal?: AbortSignal,
): Promise<void> {
  const planned = headless.planRun(trigger, ports.now(), config)
  if (!planned.ok) {
    // Not this runner's trigger. The firing is still recorded — the caller
    // appended it — and an agent-kind trigger reaches its target through the
    // ordinary mail path.
    return
  }

  let state = planned.state
  let effects = [...planned.effects]

  const took = async (record: HeadlessCompletedData | undefined): Promise<void> => {
    // KILLED MEANS SILENT. The abort can land while a spawn is awaited, and
    // the step that resolves after it must not write — the store its
    // `record` reaches has been drained by the `stop` that aborted us. That
    // is the write-after-drain class, and it is the reason the handle exists
    // at all rather than the run simply being abandoned.
    if (signal?.aborted === true) return
    if (record !== undefined) await ports.record(record)
  }

  // A HARD CEILING on the walk. Every step either consumes an attempt or
  // performs a terminal effect, so a real run terminates long before this —
  // but a decision that ever returned its own effect list unchanged would
  // otherwise spin forever inside a process nobody is watching.
  for (let steps = 0; steps < 64 && effects.length > 0; steps++) {
    // AND THE WALK STOPS AT THE NEXT STEP BOUNDARY. It does not kill a live
    // subprocess — that is the spawn port's `timeoutMs` — it stops this run
    // from taking another step on behalf of an instance that is gone.
    if (signal?.aborted === true) return
    const [head, ...rest] = effects
    if (head === undefined) break

    if (head.kind === 'wait') {
      await ports.wait(head.ms)
      effects = rest
      continue
    }

    if (head.kind === 'prepare') {
      const outcome = await ports.prepare()
      const step = headless.applyPrepare(state, outcome, ports.now())
      await took(step.record)
      state = step.next
      effects = [...step.effects]
      continue
    }

    if (head.kind === 'probe') {
      const outcome = await ports.probe()
      const step = headless.applyProbe(state, outcome, ports.now())
      await took(step.record)
      state = step.next
      effects = [...step.effects]
      continue
    }

    if (head.kind === 'spawn') {
      const outcome = await ports.spawn({
        ...head.spec,
        // The phase's own instructions, substituted by tag — see the header.
        prompt: PHASE_PROMPTS[head.spec.phaseTag ?? 'none'] ?? head.spec.prompt,
      })
      const withCheck: AttemptOutcome =
        outcome.kind === 'ran'
          ? (() => {
              const passed = ports.postCheck(head.spec.phaseTag)
              return passed === undefined ? outcome : { ...outcome, postCheckPassed: passed }
            })()
          : outcome
      const step = headless.applyAttempt(state, withCheck, ports.now())
      await took(step.record)
      state = step.next
      effects = [...step.effects]
      continue
    }

    if (head.kind === 'commit') {
      try {
        await ports.commit()
      } catch (err) {
        // A COMMIT THAT FAILED IS NOT A RUN THAT SUCCEEDED, but there is no
        // attempt left to record it against — the decision has already
        // finished. Loud in the log, which is where the next morning looks.
        ports.log(`[jean:new] headless ${trigger.id} commit failed: ${String(err)}\n`)
      }
      effects = rest
      continue
    }

    // discard-draft
    ports.discardDraft()
    effects = rest
  }
}

/** The consolidator's own files — the paths the pipeline's steps act on. */
export const consolidatorPaths = (dataDir: string) => ({
  planPath: resolve(dataDir, '.consolidator', 'plan.json'),
})

export type { WikiConsolidatedData }

/** Sweep the draft's plan. `force` because the normal case is that a review
 *  died before one existed. */
export function discardDraftPlan(dataDir: string): void {
  rmSync(consolidatorPaths(dataDir).planPath, { force: true })
}
