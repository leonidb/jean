/**
 * SCENARIO 10 — DONE-BUT-UNMARKED: two reminders, then escalate.
 * LEVEL: core (supervision inputs in, pushes out).
 *
 * CANON (S10 + the same-day amendment, verbatim): "A worker silent on an
 * in-progress task gets one reminder; unanswered twice, the sensei is told."
 * Amended arithmetic: "TWO reminders, then escalate. Reads: reminder → silent
 * window → second reminder → silent window → sensei told. The worker gets a
 * second chance before its silence becomes the sensei's problem."
 *
 * TARGET, named in canon: "The 8-and-10 stuck in-progress tasks measured on live
 * boards 2026-07-30 are this scenario's target."
 *
 * STATUS: RED — `createSupervisor` throws.
 *
 * ── THIS IS THE ONE PLACE THE WORKER IS NAGGED, AND IT IS NOT S7 ──
 *
 * S7 is about a task the worker has FINISHED WITH — parked, holder elsewhere, and
 * nagging the worker there is the failure. S10 is about a task the worker STILL
 * HOLDS and has gone quiet on, where the worker is exactly the right party to
 * ask. Getting these the wrong way round produces a system that pesters the
 * powerless and never asks the one agent that could answer.
 */

import { describe, expect, test } from 'bun:test'
import type { SupervisedTask } from '../infra/target/supervision.ts'
import { createSupervisor } from '../infra/target/supervision.ts'
import { deliveries, MINUTE, REMINDER_AFTER, recipients, recorder, SENSEI, supervisionView, T0 } from './harness.ts'

const WORKER = 'builder'

function driver() {
  const r = recorder()
  return { r, supervisor: createSupervisor(r.exec) }
}

/** A task the worker still holds, last touched at `lastEventAt`. */
function held(lastEventAt: number): SupervisedTask {
  return {
    id: '044',
    title: 'red suite',
    status: 'in-progress',
    agent: WORKER,
    holder: WORKER,
    lastEventAt,
  }
}

/** Tick the supervisor across a silent stretch, one tick per minute — fine
 *  enough that a window boundary cannot be stepped over. */
function runSilent(supervisor: ReturnType<typeof createSupervisor>, from: number, to: number, lastEventAt: number) {
  for (let t = from; t <= to; t += MINUTE) {
    supervisor.tick(supervisionView({ now: t, tasks: [held(lastEventAt)] }))
  }
}

describe('S10 — the ladder: reminder, reminder, escalate', () => {
  test('the first silent window produces exactly ONE reminder, to the worker', () => {
    const { r, supervisor } = driver()
    runSilent(supervisor, T0, T0 + REMINDER_AFTER, T0)
    expect(recipients(r)).toEqual([WORKER])
  })

  test('a second silent window produces the SECOND reminder — still to the worker', () => {
    // The amendment's second chance. Escalating after one window would make the
    // sensei's inbox the first stop for every slow worker.
    const { r, supervisor } = driver()
    runSilent(supervisor, T0, T0 + 2 * REMINDER_AFTER, T0)
    expect(recipients(r)).toEqual([WORKER, WORKER])
  })

  test('a THIRD silent window escalates — the sensei is told', () => {
    const { r, supervisor } = driver()
    runSilent(supervisor, T0, T0 + 3 * REMINDER_AFTER, T0)
    expect(recipients(r)).toEqual([WORKER, WORKER, SENSEI])
  })

  test('after escalation the worker is not asked a third time', () => {
    // "Its silence becomes the sensei's problem." Continuing to remind the
    // worker after handing the problem on would leave the ownership ambiguous
    // in exactly the situation the escalation exists to disambiguate.
    const { r, supervisor } = driver()
    runSilent(supervisor, T0, T0 + 6 * REMINDER_AFTER, T0)

    // THE PREMISE IS ASSERTED FIRST. Codex's finding: without this line,
    // `indexOf(SENSEI)` returns -1 when no escalation ever happened,
    // `slice(-1)` yields the last element, and an implementation that NEVER
    // escalates passes a test named "after escalation".
    const who = recipients(r)
    expect(who).toContain(SENSEI)
    expect(who.slice(who.indexOf(SENSEI))).not.toContain(WORKER)
  })

  test('nothing at all happens inside the first window', () => {
    const { r, supervisor } = driver()
    runSilent(supervisor, T0, T0 + REMINDER_AFTER - MINUTE, T0)
    expect(deliveries(r)).toBe(0)
  })

  test('one reminder per window, not one per tick', () => {
    // The failure this catches is the loudest one possible: a supervisor that
    // fires on every tick past the threshold turns a silent worker into a flood.
    const { r, supervisor } = driver()
    runSilent(supervisor, T0, T0 + 2 * REMINDER_AFTER - MINUTE, T0)
    expect(deliveries(r)).toBe(1)
  })
})

describe('S10 — any activity resets the ladder', () => {
  test('a reply from the worker clears the count — the next silence starts at reminder one', () => {
    const { r, supervisor } = driver()
    runSilent(supervisor, T0, T0 + REMINDER_AFTER, T0)
    expect(recipients(r)).toEqual([WORKER])

    // The worker speaks. Everything below is measured from there.
    const spoke = T0 + REMINDER_AFTER + MINUTE
    supervisor.tick(supervisionView({ now: spoke, tasks: [held(spoke)] }))
    runSilent(supervisor, spoke, spoke + REMINDER_AFTER, spoke)
    expect(recipients(r)).toEqual([WORKER, WORKER])

    // ...and the SECOND of those is a first reminder, not a second: another
    // window of silence must produce a reminder rather than an escalation.
    runSilent(supervisor, spoke + REMINDER_AFTER, spoke + 2 * REMINDER_AFTER, spoke)
    expect(recipients(r)).toEqual([WORKER, WORKER, WORKER])
  })

  test('activity after the second reminder prevents the escalation entirely', () => {
    const { r, supervisor } = driver()
    runSilent(supervisor, T0, T0 + 2 * REMINDER_AFTER, T0)
    expect(recipients(r)).toEqual([WORKER, WORKER])

    const spoke = T0 + 2 * REMINDER_AFTER + MINUTE
    supervisor.tick(supervisionView({ now: spoke, tasks: [held(spoke)] }))
    runSilent(supervisor, spoke, spoke + REMINDER_AFTER - MINUTE, spoke)
    expect(recipients(r)).not.toContain(SENSEI)
  })

  test('a task that is not in-progress is not reminded about', () => {
    // Parked and finished tasks have their own scenarios (S7/S8 and the board).
    // Reminding a worker about a task it correctly parked is the S7 failure
    // arriving through S10's door.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + 3 * REMINDER_AFTER; t += MINUTE) {
      supervisor.tick(
        supervisionView({
          now: t,
          tasks: [{ ...held(T0), status: 'waiting', blockedOn: 'human', holder: 'chat-human' }],
        }),
      )
    }
    expect(recipients(r)).not.toContain(WORKER)
  })

  test('two silent tasks held by the same worker are tracked separately', () => {
    // Per task, not per agent: a worker that answered on one task has said
    // nothing about the other, and the ladder for the other must not reset.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + REMINDER_AFTER; t += MINUTE) {
      supervisor.tick(
        supervisionView({
          now: t,
          tasks: [
            { ...held(T0), id: '001' },
            { ...held(T0), id: '002' },
          ],
        }),
      )
    }
    expect(deliveries(r)).toBe(2)
    expect(recipients(r)).toEqual([WORKER, WORKER])
  })
})
