/**
 * The trigger scheduler's decision half (refactor stage 3, commit 2 — task
 * 033; spec = task 029's 09:49 amendment: croner is MECHANISM and stays in the
 * adapter, the overdue rule is a DECISION and belongs here).
 *
 * Pure: given the active triggers, what is already scheduled, and the clock,
 * say what should be fired now, scheduled, and cancelled. Nothing here knows
 * croner exists.
 */

import type { Trigger } from '../reducers.ts'

export type TriggerPlan = {
  /** One-off triggers whose time has already passed — fire immediately instead
   *  of scheduling a job for a moment in the past. */
  fireNow: Trigger[]
  /** Active triggers with no job yet. */
  schedule: Trigger[]
  /** Job ids whose trigger is no longer active. */
  unschedule: string[]
}

/**
 * @param triggers   every trigger the projection knows about, active or not
 * @param scheduled  ids that currently have a job
 * @param now        epoch ms
 */
export function planTriggers(triggers: readonly Trigger[], scheduled: Iterable<string>, now: number): TriggerPlan {
  const plan: TriggerPlan = { fireNow: [], schedule: [], unschedule: [] }
  const has = new Set(scheduled)
  const active = new Set<string>()

  for (const trigger of triggers) {
    if (trigger.status !== 'active') continue
    active.add(trigger.id)
    if (has.has(trigger.id)) continue
    // THE OVERDUE RULE. A one-off whose moment has passed fires now: croner
    // given a past date would simply never run, silently swallowing the
    // trigger — which is what startup catch-up exists to prevent.
    if (trigger.at && new Date(trigger.at).getTime() <= now) plan.fireNow.push(trigger)
    else plan.schedule.push(trigger)
  }

  for (const id of has) {
    if (!active.has(id)) plan.unschedule.push(id)
  }
  return plan
}
