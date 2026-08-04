/**
 * SCENARIO 7 (the NAG half) — a parked task nags the SENSEI, not the worker.
 * LEVEL: core (supervision inputs in, pushes out; `now` is data).
 *
 * CANON (S7, verbatim): "A worker that completes its task or hits a question
 * puts the task into waiting-on-sensei — same state, different message — and the
 * **sensei** is nagged, not the worker."
 *
 * The DATA half — `blockedOn` and the transition permissions — is
 * `s07-blocked.projection.test.ts`.
 *
 * STATUS: RED — `createSupervisor` throws.
 *
 * ── THE INVERSION IS THE SCENARIO ──
 *
 * Nagging whoever holds the task is what any reasonable default does, and it is
 * the measured failure: a worker that has said everything it has to say cannot
 * be un-stuck by being asked again, so the reminder lands on the one party who
 * cannot act on it while the party who can hears nothing. Every case below is
 * some form of "the push went to the right agent", because that is the entire
 * requirement.
 */

import { describe, expect, test } from 'bun:test'
import type { SupervisedTask } from '../infra/target/supervision.ts'
import { createSupervisor } from '../infra/target/supervision.ts'
import {
  deliveries,
  HOUR,
  MINUTE,
  REMINDER_AFTER,
  recipients,
  recorder,
  SENSEI,
  supervisionView,
  T0,
} from './harness.ts'

const WORKER = 'builder'

function driver(lands = true) {
  const r = recorder(lands)
  return { r, supervisor: createSupervisor(r.exec) }
}

/** A task the worker parked on the sensei, last touched `agoMs` ago. */
function parkedTask(agoMs: number, over: Partial<SupervisedTask> = {}): SupervisedTask {
  return {
    id: '044',
    title: 'red suite',
    status: 'waiting',
    agent: WORKER,
    blockedOn: 'sensei',
    holder: SENSEI,
    lastEventAt: T0 - agoMs,
    ...over,
  }
}

describe('S7 — the nag goes to the holder, and the holder is the sensei', () => {
  test('a task parked on the sensei nags the SENSEI', () => {
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [parkedTask(REMINDER_AFTER)] }))
    expect(recipients(r)).toEqual([SENSEI])
  })

  test('the worker who parked it is NEVER pushed', () => {
    // The inversion, asserted as an absence. A push to the worker here is not a
    // duplicate — it is the failure, and it looks like diligence.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + 6 * HOUR; t += REMINDER_AFTER) {
      supervisor.tick(supervisionView({ now: t, tasks: [parkedTask(REMINDER_AFTER + (t - T0))] }))
    }
    expect(deliveries(r)).toBeGreaterThan(0)
    expect(recipients(r)).not.toContain(WORKER)
  })

  test('a task nobody parked nags nobody', () => {
    const { r, supervisor } = driver()
    const active: SupervisedTask = {
      id: '044',
      title: 'red suite',
      status: 'in-progress',
      agent: WORKER,
      holder: undefined,
      lastEventAt: T0 - MINUTE,
    }
    supervisor.tick(supervisionView({ now: T0, tasks: [active] }))
    expect(deliveries(r)).toBe(0)
  })

  test('a freshly parked task is not nagged instantly', () => {
    // Parking is itself an act, and the sensei was told by the act. The ladder
    // exists for what happens when that lands on a sensei that never acts on it.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [parkedTask(MINUTE)] }))
    expect(deliveries(r)).toBe(0)
  })

  test('the nag REPEATS while the task stays parked — repetition is the guarantee', () => {
    // Canon E2: "the guarantee comes from repetition over an unreliable channel,
    // not from any single delivery path being sound." One nag and silence would
    // make the whole scenario depend on a single push landing.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + 4 * HOUR; t += 15 * MINUTE) {
      supervisor.tick(supervisionView({ now: t, tasks: [parkedTask(REMINDER_AFTER + (t - T0))] }))
    }
    expect(deliveries(r)).toBeGreaterThan(2)
    expect(new Set(recipients(r))).toEqual(new Set([SENSEI]))
  })

  test('activity on the task stops the nagging', () => {
    // The task moved, so there is nothing to nag about. Without this, a task
    // being actively worked would keep generating reminders.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [parkedTask(REMINDER_AFTER)] }))
    const after = deliveries(r)
    supervisor.tick(supervisionView({ now: T0 + MINUTE, tasks: [parkedTask(0)] }))
    expect(deliveries(r)).toBe(after)
  })
})

describe('S7 — a refused nag is not a nag', () => {
  test('landed:false advances nothing and the next tick tries again', () => {
    // Race guard 4, at the supervision level. The failure it prevents: a nag
    // written off as delivered to a sensei whose socket had already died, with
    // the ladder advanced so the retry waits a full window.
    const { r, supervisor } = driver(false)
    supervisor.tick(supervisionView({ now: T0, tasks: [parkedTask(REMINDER_AFTER)] }))
    expect(deliveries(r)).toBe(1)
    expect(r.emitted).toHaveLength(0)

    r.setLanding(true)
    supervisor.tick(supervisionView({ now: T0 + MINUTE, tasks: [parkedTask(REMINDER_AFTER + MINUTE)] }))
    expect(deliveries(r)).toBe(2)
    expect(r.emitted.length).toBeGreaterThan(0)
  })

  test('an unreachable holder is not nagged, and the clock is not spent', () => {
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, deliverable: [], tasks: [parkedTask(REMINDER_AFTER)] }))
    expect(deliveries(r)).toBe(0)

    supervisor.tick(
      supervisionView({ now: T0 + MINUTE, deliverable: [SENSEI], tasks: [parkedTask(REMINDER_AFTER + MINUTE)] }),
    )
    expect(recipients(r)).toEqual([SENSEI])
  })
})
