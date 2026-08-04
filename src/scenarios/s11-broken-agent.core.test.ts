/**
 * SCENARIO 11 — THE BROKEN AGENT.
 * LEVEL: core (supervision inputs in, pushes out).
 *
 * CANON (S11, verbatim): "An agent that stopped responding entirely — no
 * activity, no task updates, reminders unanswered — is reported to the human
 * within bounded time. Auto-clears on any activity."
 *
 * O3 (039): when there is no bridge, the report goes to the SENSEI's chat. A
 * report nobody can receive is not a report.
 *
 * STATUS: RED — `createSupervisor` throws.
 *
 * ── "BUSY AND DEAD ARE ONE CASE" IS WHAT MAKES THIS DECIDABLE ──
 *
 * Canon E3. Infra cannot tell a wedged agent from a thinking one, and the
 * design's answer is not to try: silence past a bound is reportable regardless
 * of why. That is also what keeps this scenario honest — the report says "this
 * agent has said nothing for four hours", which is TRUE of both cases, rather
 * than "this agent is broken", which infra cannot know.
 *
 * ── AND WHAT MAKES IT SAFE: IT AUTO-CLEARS ──
 *
 * The cost of a false positive is therefore one message to a human, cleared the
 * moment the agent speaks. Asserted below as a restart of the cycle rather than
 * as a latch, because a latched report that never clears would grow into exactly
 * the mute mechanism S8 says does not exist.
 */

import { describe, expect, test } from 'bun:test'
import type { SupervisedAgent } from '../infra/target/supervision.ts'
import { createSupervisor } from '../infra/target/supervision.ts'
import {
  BRIDGE,
  BROKEN_AFTER,
  deliveries,
  HOUR,
  MINUTE,
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

const silentSince = (at: number, name = WORKER, role = 'worker'): SupervisedAgent => ({
  name,
  role,
  lastActivityAt: at,
})

/** Tick across a stretch at ten-minute resolution, with the agent silent since
 *  `since`. Fine enough that a bound cannot be stepped over. */
function run(
  supervisor: ReturnType<typeof createSupervisor>,
  from: number,
  to: number,
  since: number,
  bridge?: string | null,
) {
  for (let t = from; t <= to; t += 10 * MINUTE) {
    supervisor.tick(supervisionView({ now: t, agents: [silentSince(since)], ...(bridge !== undefined && { bridge }) }))
  }
}

describe('S11 — reported to the human within bounded time', () => {
  test('an agent silent past the bound is reported to the human', () => {
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER, T0)
    expect(recipients(r)).toEqual([BRIDGE])
  })

  test('BOUNDED — the report actually arrives rather than waiting for a bigger silence', () => {
    // "Within bounded time" is the requirement, and the way it fails is not a
    // wrong bound but an unbounded one: a ladder that keeps stretching means the
    // report is always still coming.
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER + 10 * MINUTE, T0)
    expect(deliveries(r)).toBeGreaterThan(0)
  })

  test('nothing is reported before the bound', () => {
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER - 20 * MINUTE, T0)
    expect(deliveries(r)).toBe(0)
  })

  test('the report does not repeat on every tick', () => {
    // A broken agent stays broken. Re-reporting every tick would make the
    // human's channel unusable exactly when they need to read it.
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER + 2 * HOUR, T0)
    expect(deliveries(r)).toBe(1)
  })

  test('a live agent is never reported, however long the dojo runs', () => {
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + 3 * BROKEN_AFTER; t += 10 * MINUTE) {
      supervisor.tick(supervisionView({ now: t, agents: [silentSince(t)] }))
    }
    expect(deliveries(r)).toBe(0)
  })
})

describe('S11 — auto-clears on any activity', () => {
  test('after the agent speaks, nothing further is reported', () => {
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER, T0)
    expect(deliveries(r)).toBe(1)

    const spoke = T0 + BROKEN_AFTER + MINUTE
    run(supervisor, spoke, spoke + BROKEN_AFTER - 20 * MINUTE, spoke)
    expect(deliveries(r)).toBe(1)
  })

  test('the CYCLE RESTARTS — an agent that breaks again is reported again', () => {
    // The difference between "cleared" and "latched". A latch would report the
    // first outage and stay silent through every one after it, which is the
    // failure mode of every alert system that has ever been ignored.
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER, T0)
    const spoke = T0 + BROKEN_AFTER + MINUTE
    run(supervisor, spoke, spoke + BROKEN_AFTER, spoke)
    expect(deliveries(r)).toBe(2)
  })
})

describe('O3 — where the report goes when there is no bridge', () => {
  test('no bridge: the report goes to the SENSEI', () => {
    // 039's O3. A report addressed to a human who has no surface is not a
    // report, and silently dropping it would make S11 vacuous on exactly the
    // dojos most likely to be unattended.
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER, T0, null)
    expect(recipients(r)).toEqual([SENSEI])
  })

  test('a bridge, when present, wins — the human is the intended reader', () => {
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER, T0, BRIDGE)
    expect(recipients(r)).toEqual([BRIDGE])
  })

  test('neither bridge nor sensei: nothing is pushed, and nothing crashes', () => {
    // The never-registered dojo (task 040's accepted corner) reaches here too.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + 2 * BROKEN_AFTER; t += 10 * MINUTE) {
      supervisor.tick(supervisionView({ now: t, sensei: null, bridge: null, agents: [silentSince(T0)] }))
    }
    expect(deliveries(r)).toBe(0)
  })
})

describe('S11 — busy and dead are one case (E3)', () => {
  test('the sensei itself is subject to the same rule', () => {
    // Canon E6: one mechanism for sensei and worker. A sensei that has wedged is
    // the most consequential broken agent there is, and it is the one an
    // agent-role branch would exempt.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + BROKEN_AFTER; t += 10 * MINUTE) {
      supervisor.tick(supervisionView({ now: t, agents: [silentSince(T0, SENSEI, 'sensei')] }))
    }
    expect(recipients(r)).toEqual([BRIDGE])
  })

  test('two silent agents produce two reports', () => {
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + BROKEN_AFTER; t += 10 * MINUTE) {
      supervisor.tick(supervisionView({ now: t, agents: [silentSince(T0, 'builder'), silentSince(T0, 'architect')] }))
    }
    expect(deliveries(r)).toBe(2)
  })
})
