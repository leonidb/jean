/**
 * The attention timers — the shell's half of the two decide→effects units
 * (design §5's outbound leg; task E3).
 *
 * ── EACH TICK IS ONE BRANCH-FREE CALL ──
 *
 * `decide` over a freshly composed view, perform the effects, report the
 * outcomes. No conditional in this file asks anything about an agent: which
 * agent is due, whether an episode advances, whether a probe is warranted —
 * every one of those is inside the unit, where it is tested. The per-agent
 * fan-out lives in `decide`, and the day it stops living there is the day a
 * cadence starts being decided in two places.
 *
 * ── THE VIEW IS BUILT FRESH, NEVER CACHED ──
 *
 * The delivered announcement and the `pendingCount` recorded on its `nudge`
 * both come out of ONE snapshot, so they cannot disagree. `now` is a
 * parameter rather than a clock read inside, so the instant is taken at the
 * call site and every clock in one tick is the same clock.
 *
 * ── WHY THERE IS A RE-ENTRANCY GUARD ──
 *
 * A run's own `emit` appends a `nudge`, and every append feeds the arrival
 * hook, which runs the notifier. Today that recursion terminates for two
 * reasons — the append is asynchronous, so the outcome has already been
 * applied by the time the nested call happens, and a discharged episode is
 * not due again — but BOTH are properties of code elsewhere. `decide`
 * deliberately does not suppress on an in-flight announcement (ruled, task
 * 098: silence is the worse failure), so a synchronous store would recurse
 * until the stack ended it. Termination must not be a coincidence of the
 * backend's async-ness; the guard makes it structural, and the conformance
 * suite drives a synchronously re-entrant executor at it.
 *
 * ── WHAT THE TICKS DO NOT DO ──
 *
 * They do not compose the views. That happens in the server, where the
 * projections live and where every fact can be taken from its owning
 * contract (R10). Passing the composers in keeps this file unable to form a
 * second opinion about who is on the roster or who holds mail.
 */

import type { NotifierConfig, NotifierExecutor, NotifierView } from '../domain/contracts/notifier.ts'
import type { SupervisorConfig, SupervisorView } from '../domain/contracts/supervisor.ts'
import type { AgentName, DeliveredVia, StoredEvent } from '../domain/contracts/vocabulary.ts'
import { notifier } from '../domain/notifier/index.ts'
import { supervisor } from '../domain/supervisor/index.ts'
import { runAnnouncements, runSupervision, type SupervisionExecutor } from './executors.ts'

export type AttentionConfig = {
  notifier: NotifierConfig
  supervisor: SupervisorConfig
  /** Tick grids. Finer than the smallest window they serve, so the promise
   *  is "by the first tick at or after the deadline" rather than a whole
   *  window late. */
  notifyTickMs: number
  superviseTickMs: number
}

export type AttentionPorts = {
  now: () => number
  log: (line: string) => void
  notifyView: (now: number) => NotifierView
  supervisionView: (now: number) => SupervisorView
  notifierExecutor: NotifierExecutor
  supervisionExecutor: SupervisionExecutor
  config: AttentionConfig
}

export type Attention = {
  /** One notifier pass. Idempotent under re-entry — see the header. */
  runNotifier: () => void
  /** One supervision pass. */
  runSupervisor: () => void
  /** An event was appended: the activity reset and the new-arrival trigger,
   *  taken from the log the shell is already writing. `actor` is whose OWN
   *  act it was, per the agents contract's definition — the composer's job,
   *  not this file's. */
  observe: (event: StoredEvent, actor: AgentName | undefined) => void
  /** The agent saw its inbox by its own act — a fetch, or the inbox line
   *  riding a response it asked for. Discharges the current announcement
   *  obligation without terminating the ladder: told is not done. */
  carried: (agent: AgentName, ids: readonly number[], via: DeliveredVia) => void
  start: () => void
  stop: () => void
}

/** Thrown at composition time rather than carried into a running dojo: a
 *  ladder that shrinks violates P8 silently, forever, and the one moment it
 *  can still be caught is before the first tick. */
export class AttentionConfigError extends Error {}

export function createAttention(ports: AttentionPorts): Attention {
  const valid = notifier.validateConfig(ports.config.notifier)
  if (!valid.ok) {
    throw new AttentionConfigError(`invalid notifier configuration: ${valid.refusal.kind}`)
  }

  let notifierState = notifier.initial()
  let supervisorState = supervisor.initial()
  /** When the supervision tick last ran, for the gap detector below. */
  let lastSupervisorTickAt: number | undefined
  let running = false
  let timers: ReturnType<typeof setInterval>[] = []

  function runNotifier(): void {
    // THE GUARD. Not a performance concern — a correctness one; see header.
    if (running) return
    running = true
    try {
      const now = ports.now()
      const decision = notifier.decide(notifierState, ports.notifyView(now), ports.config.notifier)
      notifierState = decision.next
      // PERFORM, then report. Executor law (a) — every effect of this
      // decision is performed, and every outcome applied, before anything
      // reads notifier state again.
      for (const outcome of runAnnouncements(decision.effects, ports.notifierExecutor)) {
        notifierState = notifier.applyOutcome(notifierState, outcome)
      }
    } finally {
      running = false
    }
  }

  /**
   * The sleep detector, and it exists because the fields could not be one.
   *
   * A laptop that sleeps does not stop its timers so much as skip them: the
   * process runs in short DarkWake bursts, so every poll counter reads
   * "attempted seconds ago" while the machine has been effectively off for
   * three quarters of an hour. On 2026-08-21 that is exactly what happened,
   * and everyone looking at it — reading `/status`, probing the endpoint by
   * hand — concluded the remote service was failing, because every instrument
   * they had was refreshed inside one of those bursts.
   *
   * Wall clock is the right measure here rather than the wrong one: the timer
   * does not fire while asleep, so the gap between two fires IS the sleep. A
   * tick that lands more than twice its interval late says so, once, in the
   * one place someone reads afterwards.
   */
  function noteClockGap(now: number, interval: number): void {
    const previous = lastSupervisorTickAt
    lastSupervisorTickAt = now
    if (previous === undefined) return
    const elapsed = now - previous
    if (elapsed <= interval * 2) return
    ports.log(
      `[jean:new] clock jumped ${Math.round(elapsed / 1000)}s (tick interval ${interval}ms) — machine likely slept\n`,
    )
  }

  function runSupervisor(): void {
    const now = ports.now()
    noteClockGap(now, ports.config.superviseTickMs)
    const decision = supervisor.decide(supervisorState, ports.supervisionView(now), ports.config.supervisor)
    supervisorState = decision.next
    runSupervision(decision.effects, ports.supervisionExecutor)
  }

  return {
    runNotifier,
    runSupervisor,

    observe(event, actor) {
      notifierState = notifier.observeEvent(notifierState, event, actor)
      // ARRIVAL AND TICK ARE THE SAME CALL (E6: one mechanism — the trigger
      // is the view's `now`, not the call site). Blocking mail announces on
      // arrival because `decide` says so, not because this line is here.
      runNotifier()
    },

    carried(agent, ids, via) {
      if (ids.length === 0) return
      notifierState = notifier.applyOutcome(notifierState, { kind: 'carried', agent, ids, via })
    },

    start() {
      timers = [
        setInterval(runNotifier, ports.config.notifyTickMs),
        setInterval(runSupervisor, ports.config.superviseTickMs),
      ]
      ports.log(
        `[jean:new] attention ticking every ${ports.config.notifyTickMs}ms / ${ports.config.superviseTickMs}ms\n`,
      )
    },

    stop() {
      for (const timer of timers) clearInterval(timer)
      timers = []
    },
  }
}
