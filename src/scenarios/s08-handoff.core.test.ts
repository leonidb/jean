/**
 * SCENARIO 8 — HANDOFF: the nag follows the blocker.
 * LEVEL: core (supervision inputs in, emissions out; there are no pushes at
 * all any more).
 *
 * CANON (S8, verbatim): "When the sensei escalates to the human, `blockedOn`
 * moves and the nagging follows it. No mute mechanism exists or is needed."
 *
 * AMENDMENT (2026-08-11): the no-return rule left the infra contract — infra
 * accepts any reassignment and builds no cycle guard. "What survives
 * structurally: nagging always follows the current holder, so even a ping-pong
 * loop is visible and never silences anything — churn-prevention is
 * discretionary, silence-prevention remains guaranteed."
 *
 * The BOARD half — that `blockedOn` moves at all — is
 * `s07-blocked.projection.test.ts`. This is the half that says what then
 * changes about the reminding.
 *
 * ── WHAT "FOLLOWS IT" MEANS NOW (ruled 2026-08-14) ──
 *
 * It used to mean the RECIPIENT moved: escalate to the human and the nag was
 * pushed to the human's bridge surface. That is deleted. Leonid, verbatim: "a
 * reminder to the human was always, from the start, meant to remind Sensei, not
 * the human… there shouldn't be automatic messages to the human from infra."
 *
 * So the recipient is ALWAYS the sensei, and what the blocker moves is the
 * CADENCE:
 *
 *   sensei    → short  (transitory: resolve it or escalate it)
 *   human     → hourly (immediate, expecting the human to be available)
 *   external  → daily  (a picture, not a prompt)
 *
 * The scenario's guarantee is untouched by that: parked work still never goes
 * quiet, and an escalation still visibly changes what happens. What changed is
 * that the sensei — not infra — decides whether a given hour's reminder is
 * worth putting in front of a person. The measured reason: 88 reminders in 48
 * hours, all for one task, every 30 minutes round the clock, every one pushed
 * to a phone, against zero curated messages from the sensei in the same window.
 */

import { describe, expect, test } from 'bun:test'
import type { SupervisedTask } from '../infra/target/supervision.ts'
import { createSupervisor } from '../infra/target/supervision.ts'
import {
  DAILY_REMINDER,
  deliveries,
  HOUR,
  HUMAN_REMINDER,
  nags,
  nagTargets,
  recorder,
  SENSEI,
  SENSEI_REMINDER,
  supervisionView,
  T0,
} from './harness.ts'

const WORKER = 'builder'

function driver() {
  const r = recorder()
  return { r, supervisor: createSupervisor(r.exec) }
}

function task(blockedOn: SupervisedTask['blockedOn'], agoMs: number): SupervisedTask {
  return {
    id: '044',
    title: 'red suite',
    status: 'waiting',
    agent: WORKER,
    blockedOn,
    lastEventAt: T0 - agoMs,
  }
}

describe('S8 — the blocker moves, and the CADENCE moves with it', () => {
  test('a sensei block reminds on the short clock; a human block does not, yet', () => {
    // The same silence, the same task, two blockers — and only the one whose
    // clock has elapsed produces anything. That IS the handoff, observable.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [task('sensei', SENSEI_REMINDER)] }))
    expect(nagTargets(r)).toEqual([SENSEI])

    const { r: r2, supervisor: s2 } = driver()
    s2.tick(supervisionView({ now: T0, tasks: [task('human', SENSEI_REMINDER)] }))
    expect(nags(r2)).toHaveLength(0)
  })

  test('…and the human block reminds once its own hour has passed', () => {
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [task('human', HUMAN_REMINDER)] }))
    expect(nagTargets(r)).toEqual([SENSEI])
  })

  test('an EXTERNAL block is daily — an hour of silence is not enough', () => {
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [task('external', HUMAN_REMINDER)] }))
    expect(nags(r)).toHaveLength(0)
    supervisor.tick(supervisionView({ now: T0 + HOUR, tasks: [task('external', DAILY_REMINDER)] }))
    expect(nagTargets(r)).toEqual([SENSEI])
  })

  test('THE RECIPIENT NEVER MOVES — every blocker reminds the sensei', () => {
    // The inversion S7 established, extended: it is not merely that the worker
    // is never nagged, it is that there is exactly one recipient in the system.
    const { r, supervisor } = driver()
    const blockers: SupervisedTask['blockedOn'][] = ['sensei', 'human', 'external']
    blockers.forEach((on, i) => {
      supervisor.tick(supervisionView({ now: T0 + i * DAILY_REMINDER, tasks: [task(on, DAILY_REMINDER)] }))
    })
    expect(nagTargets(r)).toEqual([SENSEI, SENSEI, SENSEI])
    expect(nagTargets(r)).not.toContain(WORKER)
  })

  test('PING-PONG IS VISIBLE, NOT SILENCED — every hop still reminds', () => {
    // The amendment's structural survivor. Churn-prevention is discretionary
    // (skill-level); silence-prevention is guaranteed, so a loop must keep
    // producing reminders rather than falling into a hole.
    const { r, supervisor } = driver()
    const hops: SupervisedTask['blockedOn'][] = ['sensei', 'human', 'sensei', 'human']
    hops.forEach((on, i) => {
      supervisor.tick(supervisionView({ now: T0 + i * DAILY_REMINDER, tasks: [task(on, DAILY_REMINDER)] }))
    })
    expect(nags(r)).toHaveLength(4)
  })

  test('NO MUTE — a task handed around many times still reminds', () => {
    // "No mute mechanism exists or is needed." The way one appears by accident
    // is a hop counter that decides enough is enough.
    const { r, supervisor } = driver()
    for (let i = 0; i < 12; i++) {
      supervisor.tick(
        supervisionView({
          now: T0 + i * DAILY_REMINDER,
          tasks: [task(i % 2 === 0 ? 'sensei' : 'human', DAILY_REMINDER)],
        }),
      )
    }
    expect(nags(r)).toHaveLength(12)
  })

  test('two tasks on different blockers each remind on their own clock', () => {
    const { r, supervisor } = driver()
    supervisor.tick(
      supervisionView({
        now: T0,
        tasks: [
          { ...task('sensei', SENSEI_REMINDER), id: '001' },
          { ...task('human', SENSEI_REMINDER), id: '002' },
        ],
      }),
    )
    // Only the short clock has elapsed, so only one reminds — per task, with no
    // grouping machinery anywhere (ruled 2026-08-14).
    expect(nags(r)).toHaveLength(1)
    expect(nags(r)[0]?.data.taskId).toBe('001')
  })
})

describe('S8 — INFRA NEVER MESSAGES THE HUMAN', () => {
  test('a human-blocked task produces an EVENT for the sensei and no push at all', () => {
    // The whole of what changed, in one case. The human still finds out —
    // through the sensei, which is the party that can judge whether this
    // particular hour is worth interrupting them for.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [task('human', HUMAN_REMINDER)] }))
    expect(nags(r)).toHaveLength(1)
    expect(nags(r)[0]?.data).toMatchObject({ to: SENSEI, queued: true })
    expect(deliveries(r)).toBe(0)
  })

  test('a dojo with no sensei has nobody to remind, and does not invent one', () => {
    // Previously this fell back to the bridge, which is how a machine ended up
    // with a direct line to a person by default.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, sensei: null, tasks: [task('human', DAILY_REMINDER)] }))
    expect(nags(r)).toHaveLength(0)
    expect(deliveries(r)).toBe(0)
  })
})
