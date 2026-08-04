/**
 * SCENARIO 8 — HANDOFF: the nag follows the holder.
 * LEVEL: core (supervision inputs in, pushes out).
 *
 * CANON (S8, verbatim): "When the sensei escalates to the human, `blockedOn`
 * moves and the nagging follows it. No mute mechanism exists or is needed."
 *
 * AMENDMENT (same day): the no-return rule left the infra contract — infra
 * accepts any reassignment and builds no cycle guard. "What survives
 * structurally: nagging always follows the current holder, so even a ping-pong
 * loop is visible and never silences anything — churn-prevention is
 * discretionary, silence-prevention remains guaranteed."
 *
 * The BOARD half — that `blockedOn` moves at all — is
 * `s07-blocked.projection.test.ts`. This is the half that says who then hears
 * about it.
 *
 * STATUS: RED — `createSupervisor` throws.
 */

import { describe, expect, test } from 'bun:test'
import type { SupervisedTask } from '../infra/target/supervision.ts'
import { createSupervisor } from '../infra/target/supervision.ts'
import {
  BRIDGE,
  deliveries,
  HOUR,
  REMINDER_AFTER,
  recipients,
  recorder,
  SENSEI,
  supervisionView,
  T0,
} from './harness.ts'

const WORKER = 'builder'

function driver() {
  const r = recorder()
  return { r, supervisor: createSupervisor(r.exec) }
}

function task(holder: string, blockedOn: SupervisedTask['blockedOn'], agoMs: number): SupervisedTask {
  return {
    id: '044',
    title: 'red suite',
    status: 'waiting',
    agent: WORKER,
    blockedOn,
    holder,
    lastEventAt: T0 - agoMs,
  }
}

describe('S8 — the nag target moves with the blocker', () => {
  test('before the handoff the sensei is nagged; after it, the human is', () => {
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [task(SENSEI, 'sensei', REMINDER_AFTER)] }))
    expect(recipients(r)).toEqual([SENSEI])

    // The sensei escalates. Same task, same silence, different holder.
    supervisor.tick(supervisionView({ now: T0 + HOUR, tasks: [task(BRIDGE, 'human', REMINDER_AFTER + HOUR)] }))
    expect(recipients(r)).toEqual([SENSEI, BRIDGE])
  })

  test('the previous holder stops hearing about it', () => {
    // Otherwise a handoff would add a nag target rather than move one, and every
    // escalation would leave the sensei permanently on the hook for work it has
    // handed on.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + 4 * HOUR; t += REMINDER_AFTER) {
      supervisor.tick(supervisionView({ now: t, tasks: [task(BRIDGE, 'human', REMINDER_AFTER + (t - T0))] }))
    }
    expect(deliveries(r)).toBeGreaterThan(0)
    expect(recipients(r)).not.toContain(SENSEI)
  })

  test('PING-PONG IS VISIBLE, NOT SILENCED — the nag follows every hop', () => {
    // The amendment's structural survivor, asserted. Churn-prevention is
    // discretionary (skill-level); silence-prevention is guaranteed, which means
    // a loop must keep producing nags rather than falling into a hole.
    const { r, supervisor } = driver()
    const hops: [string, SupervisedTask['blockedOn']][] = [
      [SENSEI, 'sensei'],
      [BRIDGE, 'human'],
      [SENSEI, 'sensei'],
      [BRIDGE, 'human'],
    ]
    hops.forEach(([holder, on], i) => {
      supervisor.tick(supervisionView({ now: T0 + i * HOUR, tasks: [task(holder, on, REMINDER_AFTER + i * HOUR)] }))
    })
    expect(recipients(r)).toEqual([SENSEI, BRIDGE, SENSEI, BRIDGE])
  })

  test('NO MUTE — a task that has been handed around many times still nags', () => {
    // "No mute mechanism exists or is needed." The way one appears by accident
    // is a hop counter that decides enough is enough.
    const { r, supervisor } = driver()
    for (let i = 0; i < 12; i++) {
      const holder = i % 2 === 0 ? SENSEI : BRIDGE
      supervisor.tick(
        supervisionView({
          now: T0 + i * HOUR,
          tasks: [task(holder, i % 2 === 0 ? 'sensei' : 'human', REMINDER_AFTER + i * HOUR)],
        }),
      )
    }
    expect(deliveries(r)).toBe(12)
  })

  test('an external or time blocker still has a holder to nag', () => {
    // `external` and `time` are not "nobody" — someone still owns chasing them,
    // and the adapter resolves that to a name. A blocker with no holder is how a
    // task silently leaves the system.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [task(SENSEI, 'external', REMINDER_AFTER)] }))
    supervisor.tick(supervisionView({ now: T0 + HOUR, tasks: [task(SENSEI, 'time', REMINDER_AFTER + HOUR)] }))
    expect(recipients(r)).toEqual([SENSEI, SENSEI])
  })

  test('two tasks with different holders each nag their own', () => {
    const { r, supervisor } = driver()
    supervisor.tick(
      supervisionView({
        now: T0,
        tasks: [
          { ...task(SENSEI, 'sensei', REMINDER_AFTER), id: '001' },
          { ...task(BRIDGE, 'human', REMINDER_AFTER), id: '002' },
        ],
      }),
    )
    expect(recipients(r).sort()).toEqual([BRIDGE, SENSEI].sort())
  })
})
