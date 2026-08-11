/**
 * The parked-work digest (013 S9; 042 DEVIATION-5, which found this scenario
 * had no owning commit at all; the transition, change I).
 *
 * Canon, verbatim: "Parked work stays visible. Externally-blocked tasks appear
 * as a daily one-line list with per-item age. They never interrupt and never
 * silently vanish."
 *
 * ── THREE REQUIREMENTS, AND ONLY ONE IS ABOUT FORMATTING ──
 *
 * 1. ONE LINE PER PARKED TASK, WITH ITS AGE. The age is what makes the list
 *    actionable — without it, the list reads identically on day 1 and day 30.
 * 2. NEVER INTERRUPTS. It is a scheduled digest, not a push, so it rides the
 *    regular trigger scheduler (O1) and this module has no idea it exists.
 * 3. NEVER SILENTLY VANISHES. The hard one, and the reason this is a real test
 *    rather than a formatting check: a task must not fall off because it got
 *    old, because the list got long, or because nothing happened to it.
 *    Truncating with an ellipsis would satisfy "one line each" and violate the
 *    point of the whole scenario.
 *
 * ── THE MEMBERSHIP RULE, RULED (H3, 2026-08-11) ──
 *
 * The amended canon sentence, verbatim: "Parked = any task whose blockedOn is
 * human or external. A time-parked task carries its resume date; it stays out
 * of the digest until that date and surfaces in it from then on — the date is
 * the wake, a trigger is optional precision. Sensei-held tasks are the
 * sensei's own queue and are not parked."
 *
 * The flagged interpretation this replaces read `time` as unconditionally
 * parked; Leonid cut it — a daily line about a September task until September
 * is spam, scheduled work is decided once. What earns the silence is the DATE
 * ON THE TASK: overdue-by-its-own-record is the discovery path if the resume
 * never happens (the digest cycle itself is the wake), so a time-park that
 * recorded NO date has no wake at all and stays visible — never-silently-
 * vanishes outranks the spam concern, in exactly one direction.
 */

import type { Board, Task } from './board.ts'

/** Is this task "parked" for digest purposes, as of `now`? THE RULE LIVES
 *  HERE — `now` entered the signature with H3, because time-park membership
 *  is date-dependent. */
export function isParked(task: Task, now: number): boolean {
  if (task.status !== 'waiting') return false
  if (task.blockedOn === 'human' || task.blockedOn === 'external') return true
  if (task.blockedOn !== 'time') return false
  // The date is the wake. Absent or unparseable ⇒ no wake exists ⇒ visible
  // now — the safe direction (a hidden task with a broken date is the silent
  // vanish; a visible one costs a line).
  if (!task.resumeAt) return true
  const at = Date.parse(task.resumeAt)
  return Number.isNaN(at) ? true : now >= at
}

/** Compact age. Same shape as the inbox's, deliberately — two age formats in
 *  one system is one more than anybody can hold. */
function fmtAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

/** How long the CURRENT holder has had it. Falls back to `updatedAt` for tasks
 *  parked before `blockedSince` existed — a missing timestamp must not drop a
 *  task off the list, which is requirement 3. */
function parkedForMs(task: Task, now: number): number {
  const since = Date.parse(task.blockedSince ?? task.updatedAt)
  return Math.max(0, now - (Number.isNaN(since) ? now : since))
}

/**
 * The digest: one line per parked task, each carrying that task's age.
 *
 * Pure over board state and a clock, so "what does this say on day 30?" is a
 * number rather than thirty days of waiting. Longest-waiting first — the only
 * ordering that makes a scan-from-the-top list useful, and stable day over day
 * because every age grows at the same rate.
 *
 * NO LIMIT, NO TRUNCATION, NO "and N more". Requirement 3 is exactly the rule
 * that a long list is inconvenient rather than trimmable.
 */
export function buildDigest(board: Board, now: number): string[] {
  return board.tasks
    .filter((task) => isParked(task, now))
    .map((task) => ({ task, age: parkedForMs(task, now) }))
    .sort((a, b) => b.age - a.age)
    .map(({ task, age }) => `${task.id} · ${task.title} · ${task.blockedOn} · ${fmtAge(age)}`)
}
