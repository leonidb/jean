/**
 * SCENARIO 7 (the NAG half) — a parked task nags the SENSEI, not the worker.
 * LEVEL: core (supervision inputs in, EMISSIONS out; `now` is data).
 *
 * CANON (S7, verbatim): "A worker that completes its task or hits a question
 * puts the task into waiting-on-sensei — same state, different message — and the
 * **sensei** is nagged, not the worker."
 *
 * The DATA half — `blockedOn` and the transition permissions — is
 * `s07-blocked.projection.test.ts`.
 *
 * ── THE NAG IS A MAILBOX EVENT (task 050 ruling, 2026-08-11) ──
 *
 * RULED: the mailbox is THE path for how agents receive messages; channel
 * pushes are announce legs. The original build delivered the nag as a bare
 * channel push and recorded only a bookkeeping event that never entered
 * pending — no code, no ack, no ledger trace (observed live, 2026-08-11
 * ~14:53Z). So "nagged" now means: the supervisor EMITS an addressed
 * `task-reminder` that enters the holder's pending, and the notifier announces
 * it by priority like any other arrival. Every case below therefore asserts
 * about emissions and their `data.to`, not about pushes — a push from this arm
 * to a dojo agent IS the failure now.
 *
 * Repetition moved with the delivery (decision (a), recorded on task 050): an
 * unacked nag is still "told" — the notifier's quiet clock and backoff ladder
 * re-announce it (canon E2's repetition lives THERE) — so the supervisor
 * re-emits only after the holder cleared the previous nag, paced from the
 * clearing. `nagOutstanding` on the view is how the adapter reports that.
 *
 * ── THE INVERSION IS STILL THE SCENARIO ──
 *
 * Nagging whoever holds the task is what any reasonable default does, and it is
 * the measured failure: a worker that has said everything it has to say cannot
 * be un-stuck by being asked again. Every case below is some form of "the nag
 * was addressed to the right agent", because that is the entire requirement.
 */

import { describe, expect, test } from 'bun:test'
import type { SupervisedTask } from '../infra/target/supervision.ts'
import { createSupervisor } from '../infra/target/supervision.ts'
import {
  deliveries,
  HOUR,
  MINUTE,
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

/** A task the worker parked on the sensei, last touched `agoMs` ago. */
function parkedTask(agoMs: number, over: Partial<SupervisedTask> = {}): SupervisedTask {
  return {
    id: '044',
    title: 'red suite',
    status: 'waiting',
    agent: WORKER,
    blockedOn: 'sensei',
    lastEventAt: T0 - agoMs,
    ...over,
  }
}

describe('S7 — the nag goes to the holder, and the holder is the sensei', () => {
  test('a task parked on the sensei nags the SENSEI — an addressed mailbox event, no push', () => {
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [parkedTask(SENSEI_REMINDER)] }))
    expect(nagTargets(r)).toEqual([SENSEI])
    // The event is the nag. A push here would be the second delivery path the
    // unification deleted — announcing is the notifier's job.
    expect(deliveries(r)).toBe(0)
  })

  test('the nag is ADMISSIBLE — addressed, queued, and it says what is waiting', () => {
    // The write site decides (the send precedent): `queued: true` is what the
    // pending fold admits, so a nag emitted without it would be the old
    // bookkeeping event wearing the new name — recorded, never delivered.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [parkedTask(SENSEI_REMINDER)] }))
    const [nag] = nags(r)
    expect(nag?.data).toMatchObject({ taskId: '044', to: SENSEI, queued: true })
    expect(String(nag?.data.text)).toContain('is waiting')
    expect(String(nag?.data.text)).toContain('044')
  })

  test('the worker who parked it is NEVER the addressee', () => {
    // The inversion, asserted as an absence. A nag addressed to the worker is
    // not a duplicate — it is the failure, and it looks like diligence.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + 6 * HOUR; t += SENSEI_REMINDER) {
      supervisor.tick(supervisionView({ now: t, tasks: [parkedTask(SENSEI_REMINDER + (t - T0))] }))
    }
    expect(nags(r).length).toBeGreaterThan(0)
    expect(nagTargets(r)).not.toContain(WORKER)
    expect(deliveries(r)).toBe(0)
  })

  test('a task nobody parked nags nobody', () => {
    const { r, supervisor } = driver()
    const active: SupervisedTask = {
      id: '044',
      title: 'red suite',
      status: 'in-progress',
      agent: WORKER,
      lastEventAt: T0 - MINUTE,
    }
    supervisor.tick(supervisionView({ now: T0, tasks: [active] }))
    expect(nags(r)).toHaveLength(0)
  })

  test('a freshly parked task is not nagged instantly', () => {
    // Parking is itself an act, and the sensei was told by the act. The nag
    // exists for what happens when that lands on a sensei that never acts on it.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [parkedTask(MINUTE)] }))
    expect(nags(r)).toHaveLength(0)
  })

  test('the nag REPEATS while the task stays parked — after each one is handled', () => {
    // Canon E2: "the guarantee comes from repetition over an unreliable
    // channel." The repetition SPLIT with the delivery move: while a nag sits
    // unacked the NOTIFIER repeats the announcement (its ladder, its clock);
    // what the supervisor repeats is the EVENT — a fresh nag once the holder
    // cleared the previous one and the task still has not moved.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + 4 * HOUR; t += 15 * MINUTE) {
      // Each prior nag was acked before the next tick — `nagOutstanding` stays
      // false, so every due window emits.
      supervisor.tick(supervisionView({ now: t, tasks: [parkedTask(SENSEI_REMINDER + (t - T0))] }))
    }
    expect(nags(r).length).toBeGreaterThan(2)
    expect(new Set(nagTargets(r))).toEqual(new Set([SENSEI]))
  })

  test('activity on the task stops the nagging', () => {
    // The task moved, so there is nothing to nag about. Without this, a task
    // being actively worked would keep generating reminders.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [parkedTask(SENSEI_REMINDER)] }))
    const after = nags(r).length
    supervisor.tick(supervisionView({ now: T0 + MINUTE, tasks: [parkedTask(0)] }))
    expect(nags(r)).toHaveLength(after)
  })
})

describe('S7 — an unacked nag re-announces, it does not re-emit (decision (a), task 050)', () => {
  test('while the nag sits unacked, no duplicate enters the mailbox — however long that lasts', () => {
    // The holder has been TOLD: the event is in its pending, the notifier is
    // re-announcing on its ladder. A supervisor that re-emitted every window
    // would inflate the mailbox with copies of one fact — the count-inflation
    // class the A2 invariant exists to keep out.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [parkedTask(SENSEI_REMINDER)] }))
    expect(nags(r)).toHaveLength(1)
    for (let t = T0 + 15 * MINUTE; t <= T0 + 6 * HOUR; t += 15 * MINUTE) {
      supervisor.tick(
        supervisionView({
          now: t,
          tasks: [parkedTask(SENSEI_REMINDER + (t - T0), { nagOutstanding: true })],
        }),
      )
    }
    expect(nags(r)).toHaveLength(1)
  })

  test('the next nag is paced from the CLEARING, not from the emission', () => {
    // An ack is the holder saying "seen". Re-nagging one tick later would
    // punish exactly the read-before-ack behaviour the codes exist to produce;
    // the reminder window restarts from the moment the mailbox cleared.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [parkedTask(SENSEI_REMINDER)] }))
    expect(nags(r)).toHaveLength(1)

    // Unacked for two hours — the pace clock slides with the outstanding nag.
    const acked = T0 + 2 * HOUR
    for (let t = T0 + 15 * MINUTE; t <= acked; t += 15 * MINUTE) {
      supervisor.tick(
        supervisionView({ now: t, tasks: [parkedTask(SENSEI_REMINDER + (t - T0), { nagOutstanding: true })] }),
      )
    }
    // Cleared now — but the window restarts: nothing emits a minute later…
    supervisor.tick(supervisionView({ now: acked + MINUTE, tasks: [parkedTask(SENSEI_REMINDER + 2 * HOUR + MINUTE)] }))
    expect(nags(r)).toHaveLength(1)
    // …and a full reminder window after the clearing, the second nag lands.
    const due = acked + SENSEI_REMINDER + MINUTE
    supervisor.tick(supervisionView({ now: due, tasks: [parkedTask(SENSEI_REMINDER + (due - T0))] }))
    expect(nags(r)).toHaveLength(2)
    expect(nagTargets(r)).toEqual([SENSEI, SENSEI])
  })
})

describe('S7 — the mailbox outlives the connection', () => {
  test('a disconnected sensei is STILL nagged — the event enters its mailbox and waits', () => {
    // THE DEFECT THIS SCENARIO PINS (task 050): the original arm checked a
    // `deliverable` list and pushed, so a disconnected sensei was never told
    // and nothing was recorded — no pending entry, no code, no ledger trace.
    // The emission needs no live transport: the mailbox is the truth (E1), and
    // the notifier announces on reconnect. `deliverable` no longer exists on
    // the view at all, which is the stronger form of the same guarantee.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, tasks: [parkedTask(SENSEI_REMINDER)] }))
    expect(nagTargets(r)).toEqual([SENSEI])
    expect(deliveries(r)).toBe(0)
  })

  test('a dojo with NO SENSEI spends no clock — the first one to exist is nagged at once', () => {
    // A never-registered dojo has nobody to address (task 040's accepted
    // corner). The window must not be consumed by ticks that had no recipient.
    const { r, supervisor } = driver()
    supervisor.tick(supervisionView({ now: T0, sensei: null, tasks: [parkedTask(SENSEI_REMINDER)] }))
    expect(nags(r)).toHaveLength(0)

    supervisor.tick(supervisionView({ now: T0 + MINUTE, tasks: [parkedTask(SENSEI_REMINDER + MINUTE)] }))
    expect(nagTargets(r)).toEqual([SENSEI])
  })
})
