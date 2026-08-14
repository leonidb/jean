/**
 * SCENARIO 11 — THE BROKEN AGENT, as a PROBE rather than an alarm.
 * LEVEL: core (supervision inputs in, emissions out).
 *
 * CANON (S11, verbatim): "An agent that stopped responding entirely — no
 * activity, no task updates, reminders unanswered — is reported to the human
 * within bounded time. Auto-clears on any activity."
 *
 * ── WHAT THIS FILE USED TO ASSERT, AND WHY IT WAS WRONG ──
 *
 * Every case here once ended in `expect(recipients(r)).toEqual([BRIDGE])` — a
 * direct push to the human's surface at the instant of suspicion. That shipped,
 * and the live measurement is the reason the design changed (ruled 2026-08-14):
 *
 *   bound trips → emit `agent-unresponsive` → push to the human's phone
 *   …the same event names the agent in `data.agent`, so derived mailbox
 *     membership delivers it TO THE ACCUSED, which wakes it
 *   …the agent answers in ~19 seconds
 *   …nothing is ever sent to say so
 *
 * 23 alarms in two days across two workers, zero all-clears, an empty board.
 * The alarm WAS the probe, fired in the wrong order and addressed to the one
 * party that could not act on it.
 *
 * ── WHAT IT ASSERTS NOW ──
 *
 * Ask first, escalate only on silence, and tell the SENSEI — never the human.
 * The two properties that carry the redesign:
 *
 *   1. SILENCE IS THE SUCCESS CASE. An agent that answers its probe produces
 *      NO event at all. That is why no all-clear exists and why none is needed:
 *      the absence of `agent-down` is the all-clear.
 *   2. SUPERVISION HAS NO TRANSPORT. `pushBridge` is deleted, port and all, so
 *      `deliveries(r)` is 0 in every case below — including the ones that end
 *      in a genuine down-report. Infra measures; the sensei decides who to
 *      bother. The recorder still counts pushes, so a reintroduced direct line
 *      would light up here even though the type system should stop it first.
 */

import { describe, expect, test } from 'bun:test'
import type { SupervisedAgent, SupervisedTask } from '../infra/target/supervision.ts'
import { createSupervisor } from '../infra/target/supervision.ts'
import {
  BROKEN_AFTER,
  BROKEN_AFTER_IDLE,
  deliveries,
  HOUR,
  MINUTE,
  PROBE_TIMEOUT,
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

/** A LIVE session that has gone silent — S11's classic case. The harness
 *  defaults `sessionLive: true`; down agents are s10-worker-status's cases. */
const silentSince = (at: number, name = WORKER, role = 'worker'): Omit<SupervisedAgent, 'sessionLive'> => ({
  name,
  role,
  lastActivityAt: at,
})

/** In-progress work, so the agent is on the SHORT bound. Without one it is
 *  idle and watched on the 24h clock instead — see the tiered-bound cases. */
const heldWork = (agent = WORKER): SupervisedTask => ({
  id: '001',
  title: 'something',
  status: 'in-progress',
  agent,
  lastEventAt: T0,
})

/** Tick across a stretch at one-minute resolution with the agent silent since
 *  `since`. FINE ENOUGH FOR THE PROBE WINDOW: at ten minutes the 5-minute
 *  timeout could be stepped over, and a test that cannot see the window cannot
 *  tell "probed then escalated" from "alarmed immediately" — which is the
 *  distinction this whole file exists to make. */
function run(supervisor: ReturnType<typeof createSupervisor>, from: number, to: number, since: number, idle = false) {
  for (let t = from; t <= to; t += MINUTE) {
    supervisor.tick(supervisionView({ now: t, agents: [silentSince(since)], ...(idle ? {} : { tasks: [heldWork()] }) }))
  }
}

const probes = (r: ReturnType<typeof recorder>) => r.emitted.filter((e) => e.type === 'agent-probe')
const downs = (r: ReturnType<typeof recorder>) => r.emitted.filter((e) => e.type === 'agent-down')

describe('S11 — the bound ASKS; it does not accuse', () => {
  test('an agent silent past the bound is PROBED, and nothing else happens yet', () => {
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER, T0)
    expect(probes(r)).toHaveLength(1)
    expect(downs(r)).toHaveLength(0)
    // The probe is addressed to the agent — that is how it reaches it at all.
    expect(probes(r)[0]?.data.agent).toBe(WORKER)
  })

  test('nothing at all before the bound', () => {
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER - 20 * MINUTE, T0)
    expect(probes(r)).toHaveLength(0)
    expect(downs(r)).toHaveLength(0)
  })

  test('a live agent is never probed, however long the dojo runs', () => {
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + 3 * BROKEN_AFTER; t += 10 * MINUTE) {
      supervisor.tick(supervisionView({ now: t, agents: [silentSince(t)], tasks: [heldWork()] }))
    }
    expect(r.emitted).toHaveLength(0)
  })

  test('the probe does not repeat while its answer is still due', () => {
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER + PROBE_TIMEOUT - MINUTE, T0)
    expect(probes(r)).toHaveLength(1)
  })
})

describe('S11 — silence is the success case', () => {
  test('an agent that ANSWERS its probe produces no report, ever', () => {
    // The measured failure this replaces: the old alarm fired, woke the agent,
    // the agent answered in seconds, and the human had already been told.
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER, T0)
    expect(probes(r)).toHaveLength(1)

    // It answers one minute later, then stays quiet for a good while.
    const answered = T0 + BROKEN_AFTER + MINUTE
    run(supervisor, answered, answered + BROKEN_AFTER - 20 * MINUTE, answered)
    expect(downs(r)).toHaveLength(0)
    // …and NOTHING was emitted to say it recovered. The absence of a report is
    // the all-clear; an explicit one would be the metronome wearing a hat.
    // Scoped to S11's own types: the H4 worker-status arm is watching the same
    // silent worker and correctly reports up-but-stuck/recovered on its own
    // edges — that is s10's assertion, not this file's.
    expect(r.emitted.filter((e) => e.type.startsWith('agent-')).map((e) => e.type)).toEqual(['agent-probe'])
  })

  test('answering resets the cycle — a later break is probed again', () => {
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER, T0)
    const answered = T0 + BROKEN_AFTER + MINUTE
    run(supervisor, answered, answered + BROKEN_AFTER, answered)
    expect(probes(r)).toHaveLength(2)
    expect(downs(r)).toHaveLength(0)
  })
})

describe('S11 — an UNANSWERED probe escalates, once', () => {
  test('past the probe timeout with no answer: one agent-down, to the sensei', () => {
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER + PROBE_TIMEOUT, T0)
    expect(probes(r)).toHaveLength(1)
    expect(downs(r)).toHaveLength(1)
    const down = downs(r)[0]
    expect(down?.data.to).toBe(SENSEI)
    // THE SUBJECT IS NOT IN `agent`, and that is the fix. `data.agent` is what
    // mailbox membership resolves on, so naming the subject there is exactly
    // what delivered the old alarm to the accused.
    expect(down?.data.subject).toBe(WORKER)
    expect(down?.data.agent).toBeUndefined()
  })

  test('EDGE-TRIGGERED — the report does not repeat, however long the outage', () => {
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER + PROBE_TIMEOUT + 6 * HOUR, T0)
    expect(downs(r)).toHaveLength(1)
    // …and no second probe either. One question per episode, one report per
    // episode. Re-probing on a cycle is the metronome with extra steps.
    expect(probes(r)).toHaveLength(1)
  })

  test('THE CYCLE RESTARTS — an agent that returns and breaks again is reported again', () => {
    // The difference between "cleared" and "latched". A latch reports the first
    // outage and stays silent through every one after it.
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER + PROBE_TIMEOUT, T0)
    expect(downs(r)).toHaveLength(1)

    const returned = T0 + BROKEN_AFTER + PROBE_TIMEOUT + MINUTE
    run(supervisor, returned, returned + BROKEN_AFTER + PROBE_TIMEOUT, returned)
    expect(downs(r)).toHaveLength(2)
  })

  test('a down agent that comes back produces NO recovery event', () => {
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER + PROBE_TIMEOUT, T0)
    const returned = T0 + BROKEN_AFTER + PROBE_TIMEOUT + MINUTE
    run(supervisor, returned, returned + 30 * MINUTE, returned)
    expect(r.emitted.filter((e) => e.type.startsWith('agent-')).map((e) => e.type)).toEqual([
      'agent-probe',
      'agent-down',
    ])
  })
})

describe('S11 — INFRA NEVER MESSAGES THE HUMAN', () => {
  test('not one push, in any case above — supervision has no transport at all', () => {
    // The structural half of the 2026-08-14 ruling: `pushBridge` is deleted
    // rather than merely unused, so this cannot regress by someone adding a
    // call site. Asserted behaviourally anyway, because the recorder can still
    // count pushes and a future executor could still grow one.
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER + PROBE_TIMEOUT + HOUR, T0)
    expect(downs(r)).toHaveLength(1)
    expect(deliveries(r)).toBe(0)
  })

  test('no sensei registered: the report is still recorded, for whoever arrives', () => {
    // The never-registered dojo (task 040's accepted corner). The emit is
    // unconditional — the log holds the report, and the sensei's universal
    // mailbox claims it the moment one exists.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + BROKEN_AFTER + PROBE_TIMEOUT; t += MINUTE) {
      supervisor.tick(supervisionView({ now: t, sensei: null, agents: [silentSince(T0)], tasks: [heldWork()] }))
    }
    expect(downs(r)).toHaveLength(1)
    expect(downs(r)[0]?.data.to).toBeUndefined()
    expect(deliveries(r)).toBe(0)
  })
})

describe('S11 — busy and dead are one case (E3)', () => {
  test('the sensei itself is subject to the same rule', () => {
    // Canon E6: one mechanism for sensei and worker. A wedged sensei is the
    // most consequential broken agent there is, and it is the one an
    // agent-role branch would exempt. Note the report about the SENSEI is
    // addressed to the sensei — odd, and deliberately preferred to the
    // alternative, which is an event in nobody's mailbox at all.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + BROKEN_AFTER_IDLE + 2 * PROBE_TIMEOUT; t += 5 * MINUTE) {
      supervisor.tick(supervisionView({ now: t, agents: [silentSince(T0, SENSEI, 'sensei')] }))
    }
    expect(downs(r)).toHaveLength(1)
    expect(downs(r)[0]?.data.subject).toBe(SENSEI)
  })

  test('two silent agents produce two probes and two reports', () => {
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + BROKEN_AFTER + PROBE_TIMEOUT; t += MINUTE) {
      supervisor.tick(
        supervisionView({
          now: t,
          agents: [silentSince(T0, 'builder'), silentSince(T0, 'architect')],
          tasks: [heldWork('builder'), { ...heldWork('architect'), id: '002' }],
        }),
      )
    }
    expect(probes(r)).toHaveLength(2)
    expect(downs(r)).toHaveLength(2)
  })
})

describe('S11 — the bound is TIERED by whether the agent holds work', () => {
  test('an agent holding NOTHING is not probed on the short bound', () => {
    // "if the worker is not on any task, then ping it once a day." An idle
    // agent that stopped costs nothing until someone dispatches to it.
    const { r, supervisor } = driver()
    run(supervisor, T0, T0 + BROKEN_AFTER + HOUR, T0, true)
    expect(probes(r)).toHaveLength(0)
    expect(downs(r)).toHaveLength(0)
  })

  test('…and IS probed on the long one', () => {
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + BROKEN_AFTER_IDLE; t += 10 * MINUTE) {
      supervisor.tick(supervisionView({ now: t, agents: [silentSince(T0)] }))
    }
    expect(probes(r)).toHaveLength(1)
  })

  test('ASSIGNED work counts as holding — the gap that was watched by nothing', () => {
    // A worker that stopped while holding a dispatched-but-unstarted task was
    // covered by neither arm: `worker-status` saw in-progress only, the nag saw
    // waiting only. It fired on 2026-07-28 when two dispatches vanished in a
    // restart and nothing noticed.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + BROKEN_AFTER; t += MINUTE) {
      supervisor.tick(
        supervisionView({
          now: t,
          agents: [silentSince(T0)],
          tasks: [{ ...heldWork(), status: 'assigned' }],
        }),
      )
    }
    expect(probes(r)).toHaveLength(1)
  })

  test('a GONE session is never probed — worker-status owns that case', () => {
    // Probing a corpse produces a guaranteed timeout and a second report of one
    // fact. Infra already knows the answer the instant the session drops.
    const { r, supervisor } = driver()
    for (let t = T0; t <= T0 + BROKEN_AFTER + PROBE_TIMEOUT; t += MINUTE) {
      supervisor.tick(
        supervisionView({
          now: t,
          agents: [{ ...silentSince(T0), sessionLive: false }],
          tasks: [heldWork()],
        }),
      )
    }
    expect(probes(r)).toHaveLength(0)
    expect(downs(r)).toHaveLength(0)
    // `worker-status: down` is what reports it, on the edge, exactly once.
    expect(r.emitted.filter((e) => e.type === 'worker-status')).toHaveLength(1)
  })
})
