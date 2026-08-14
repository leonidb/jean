/**
 * SCENARIO 9 — PARKED WORK STAYS VISIBLE.
 * LEVEL: core (supervision inputs in, emissions out; `now` is data).
 *
 * CANON (S9, verbatim): "Parked work stays visible. Externally-blocked tasks
 * appear as a daily one-line list with per-item age. They never interrupt and
 * never silently vanish."
 *
 * ── THE MECHANISM CHANGED; THE REQUIREMENT DID NOT (ruled 2026-08-14) ──
 *
 * This file used to test `buildDigest` — a pure board→lines function fired by a
 * built-in `parked-digest` cron trigger at 09:00 daily. Both are deleted, and
 * the deletion is the point. Leonid, verbatim: "Ideally, this one also should
 * not fire if there are no waiting events. It should not fire at all."
 *
 * A scheduled job cannot have that property; it fires and then asks. Measured:
 * `parked-digest` fired three mornings out of three and produced nothing all
 * three times. So the digest is no longer a job at all — parked tasks remind on
 * their blocker's own clock (`external` and anything snoozed: daily), and a
 * reminder event IS the wake. No parked work means no event, means no wake.
 * Self-gating by construction, which is what the trigger had to be told to
 * check and never was.
 *
 * What this file therefore asserts is the REQUIREMENT rather than the old
 * mechanism: everything parked reminds, nothing parked is ever silent, and the
 * daily floor holds however long a task sits. COMPOSING the day's reminders
 * into one readable morning message is the sensei's job now, in its skill —
 * infra emits facts on clocks and holds no opinion about presentation.
 *
 * ── "EXTERNALLY-BLOCKED", RESOLVED ──
 *
 * The old reading excluded `sensei` blocks from the digest so a task would not
 * be both nagged and digested. That tension is gone with the second mechanism:
 * there is ONE clock per task, chosen by its blocker, so nothing is ever
 * covered twice. Every parked task reminds; only the rate differs.
 */

import { describe, expect, test } from 'bun:test'
import type { SupervisedTask } from '../infra/target/supervision.ts'
import { createSupervisor } from '../infra/target/supervision.ts'
import {
  DAILY_REMINDER,
  DAY,
  HOUR,
  MINUTE,
  nags,
  recorder,
  SENSEI,
  SENSEI_REMINDER,
  supervisionView,
  T0,
} from './harness.ts'

function driver() {
  const r = recorder()
  return { r, supervisor: createSupervisor(r.exec) }
}

function parked(
  id: string,
  blockedOn: SupervisedTask['blockedOn'],
  agoMs: number,
  over: Partial<SupervisedTask> = {},
): SupervisedTask {
  return {
    id,
    title: `task ${id}`,
    status: 'waiting',
    agent: 'builder',
    blockedOn,
    lastEventAt: T0 - agoMs,
    ...over,
  }
}

/** Tick daily across `days`, keeping each task's silence growing. */
function runDays(
  supervisor: ReturnType<typeof createSupervisor>,
  tasks: (agoBase: number) => SupervisedTask[],
  days: number,
) {
  for (let d = 0; d <= days; d++) {
    supervisor.tick(supervisionView({ now: T0 + d * DAY, tasks: tasks(DAILY_REMINDER + d * DAY) }))
  }
}

describe('S9 — everything parked is visible', () => {
  test('an externally-blocked task reminds, daily', () => {
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [parked('001', 'external', DAILY_REMINDER)] }))
    expect(nags(r)).toHaveLength(1)
    expect(nags(r)[0]?.data).toMatchObject({ taskId: '001', to: SENSEI })
  })

  test('EVERY blocker is covered — none falls through', () => {
    // The failure this guards is a task parked on a value nobody wired a clock
    // for: it would sit forever, silent, and look exactly like a task nobody
    // parked. Swept over the whole closed set rather than spot-checked.
    const blockers: SupervisedTask['blockedOn'][] = ['sensei', 'human', 'external']
    for (const on of blockers) {
      const { r, supervisor } = driver()
      supervisor.tick(supervisionView({ now: T0, tasks: [parked('001', on, DAILY_REMINDER)] }))
      expect({ on, nags: nags(r).length }).toEqual({ on, nags: 1 })
    }
  })

  test('a legacy park with NO blocker still reminds — the unclassifiable must not vanish', () => {
    // `blockedOn` is required on entry to `waiting` now, so this shape can only
    // arrive from a log written before that. Daily is the floor: a task whose
    // blocker cannot be read is precisely the one that must not go quiet.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [parked('001', undefined, DAILY_REMINDER)] }))
    expect(nags(r)).toHaveLength(1)
  })

  test('NEVER SILENTLY VANISHES — a task parked for a month reminds every day of it', () => {
    // The hard requirement. The ways it breaks are all "it got old": a ladder
    // that stretches, a counter that gives up, a list that truncates.
    const { r, supervisor } = driver()
    runDays(supervisor, (ago) => [parked('001', 'external', ago)], 30)
    expect(nags(r).length).toBeGreaterThanOrEqual(30)
  })

  test('a long list is inconvenient rather than trimmable — twenty parked tasks, twenty reminders', () => {
    // The old shape of this requirement was "no ellipsis in the digest". The
    // per-task mechanism makes it structural: there is no list to truncate.
    const { r, supervisor } = driver()
    const many = Array.from({ length: 20 }, (_, i) => parked(String(i).padStart(3, '0'), 'external', DAILY_REMINDER))
    supervisor.tick(supervisionView({ now: T0, tasks: many }))
    expect(nags(r)).toHaveLength(20)
    expect(new Set(nags(r).map((n) => n.data.taskId)).size).toBe(20)
  })
})

describe('S9 — it never interrupts, and it never fires into an empty board', () => {
  test('NOTHING PARKED, NOTHING EMITTED — the property a scheduled job could not have', () => {
    // `parked-digest` fired 3/3 mornings and produced nothing each time. Here
    // the event IS the wake, so an empty board cannot generate one.
    const { r, supervisor } = driver()
    for (let d = 0; d <= 7; d++) {
      supervisor.tick(supervisionView({ now: T0 + d * DAY, tasks: [] }))
    }
    expect(r.emitted).toHaveLength(0)
  })

  test('an in-progress task is not parked and is not reminded about', () => {
    const { r, supervisor } = driver()
    supervisor.tick(
      supervisionView({
        now: T0,
        tasks: [{ ...parked('001', 'external', DAILY_REMINDER), status: 'in-progress' }],
      }),
    )
    expect(nags(r)).toHaveLength(0)
  })

  test('the daily clock does not fire hourly — one reminder a day, not twenty-four', () => {
    const { r, supervisor } = driver()
    for (let h = 0; h <= 24; h++) {
      supervisor.tick(
        supervisionView({ now: T0 + h * HOUR, tasks: [parked('001', 'external', DAILY_REMINDER + h * HOUR)] }),
      )
    }
    expect(nags(r)).toHaveLength(2)
  })
})

describe('S9 — SNOOZE demotes the clock and restores it automatically', () => {
  test('a snoozed task drops from its own cadence to daily', () => {
    // The task is human-blocked, so its clock is hourly; the snooze moves it to
    // the daily one WITHOUT changing what it is waiting on. That is the whole
    // reason `resumeAt` is a modifier and not a blocker: nothing to remember.
    const { r, supervisor } = driver()
    const soon = T0 + 7 * DAY
    supervisor.tick(supervisionView({ now: T0, tasks: [parked('001', 'human', 2 * HOUR, { resumeAt: soon })] }))
    expect(nags(r)).toHaveLength(0) // two hours is past the hourly clock, not the daily one
  })

  test('…but it still reminds DAILY while snoozed — demote, never silence', () => {
    // Leonid: "it's okay to have, if there are any waiting events or snoozed
    // events, send them in a once-a-day message… it's easy to just ignore for a
    // few days. It's not spamming." A snoozed task is one line a day, not zero.
    const { r, supervisor } = driver()
    const far = T0 + 90 * DAY
    runDays(supervisor, (ago) => [parked('001', 'human', ago, { resumeAt: far })], 30)
    expect(nags(r).length).toBeGreaterThanOrEqual(30)
  })

  test('THE RESTORE IS AUTOMATIC — past its date, the task is back on its own clock', () => {
    // No transition, no bookkeeping: the blocker never changed, so once the
    // date is behind `now` the task simply is what it always was.
    const { r, supervisor } = driver()
    const wakeAt = T0 + DAY
    // Before: hourly silence produces nothing, because it is on the daily clock.
    supervisor.tick(supervisionView({ now: T0, tasks: [parked('001', 'human', 2 * HOUR, { resumeAt: wakeAt })] }))
    expect(nags(r)).toHaveLength(0)
    // After: the same two hours of silence is now overdue on the hourly clock.
    supervisor.tick(
      supervisionView({
        now: wakeAt + MINUTE,
        tasks: [parked('001', 'human', 2 * HOUR, { resumeAt: wakeAt })],
      }),
    )
    expect(nags(r)).toHaveLength(1)
  })

  test('a snooze on a SENSEI block demotes it too — the modifier is blocker-agnostic', () => {
    const { r, supervisor } = driver()
    supervisor.tick(
      supervisionView({
        now: T0,
        tasks: [parked('001', 'sensei', SENSEI_REMINDER, { resumeAt: T0 + DAY })],
      }),
    )
    expect(nags(r)).toHaveLength(0)
  })

  test('the reminder text says a snoozed task is snoozed', () => {
    // So the sensei composing the morning picture can tell "waiting on you" from
    // "deferred by you" without re-reading the board.
    const { r, supervisor } = driver()
    supervisor.tick(
      supervisionView({ now: T0, tasks: [parked('001', 'human', DAILY_REMINDER, { resumeAt: T0 + DAY })] }),
    )
    expect(String(nags(r)[0]?.data.text)).toContain('snoozed')
  })
})
