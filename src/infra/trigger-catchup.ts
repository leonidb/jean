/**
 * Catch-up decision for cron triggers on infra startup.
 *
 * If the machine was off (or infra wasn't running) when a scheduled fire
 * was due, we want to make up that run on the next startup. This helper
 * decides whether a single cron trigger qualifies based on its last-fired
 * timestamp versus the most recent scheduled time per its cron expression.
 *
 * Brand-new triggers (never fired) are intentionally NOT caught up — the
 * user just created them; they can wait for the next scheduled time.
 *
 * Pure function — separated from server.ts so tests can import it without
 * triggering the server's top-level `Bun.serve()` side effects.
 */

import { Cron } from 'croner'
import type { Trigger } from './reducers.ts'

export function shouldCatchUp(trigger: Trigger, now: Date = new Date()): boolean {
  if (!trigger.cron) return false
  if (!trigger.lastFiredAt) return false
  const meta = trigger.metadata as Record<string, unknown> | undefined
  if (meta?.skipCatchup) return false

  const cronJob = new Cron(trigger.cron)
  // croner's `previousRun()` takes no args; use `previousRuns(1, ref)` for
  // the most recent fire time as of a given reference date — testable.
  const [previousRun] = cronJob.previousRuns(1, now)
  if (!previousRun) return false

  return new Date(trigger.lastFiredAt) < previousRun
}
