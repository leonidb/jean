/**
 * The trigger scheduler — the job table, the boot catch-up, and R9
 * (design §5; task E3).
 *
 * ── THE DOMAIN DECIDES WHAT IS DUE; THIS FILE KEEPS THE JOBS ──
 *
 * The triggers contract is explicit that cron scheduling is the shell's job
 * ("a job table") and that its own half is which `at`s are due
 * (`dueOneShots`) and which crons missed a run (`shouldCatchUp`). Cron
 * ARITHMETIC is a library's opinion, injected: croner lives here and the
 * domain never learns its name.
 *
 * ── R9, THE ROW THIS TASK OWES ──
 *
 * `shouldCatchUp` deliberately does NOT check whether a trigger is active —
 * the extraction kept it faithful to the old startup loop, which filtered
 * BEFORE calling. So the filter is the caller's, and forgetting it has no
 * symptom: disabled triggers fire on every boot, nothing throws, nothing
 * turns red, and the person who disabled them watches them run. The filter
 * is one line below and it is pinned, because one line with no failure mode
 * of its own is exactly the kind that gets refactored away.
 *
 * ── WHAT IS NOT HERE ──
 *
 * The headless spawn. A `headless` trigger names a ROLE and its firing is
 * supposed to start a one-shot session — a process-spawning subsystem with
 * retries, timeouts, stream capture and its own completion event. The firing
 * is recorded either way (and resolves to history for headless, exactly as
 * §4 declares), but nothing runs. Recorded here and flagged for G1 rather
 * than half-built: a dojo whose nightly consolidation is a headless trigger
 * would find it silently not running.
 */

import { Cron } from 'croner'
import type { Trigger, TriggersState } from '../domain/contracts/triggers.ts'
import { triggers } from '../domain/triggers/index.ts'

/** The cron arithmetic the contract injects: the most recent scheduled
 *  instant at or before `now`, or undefined when there is none. */
export function previousScheduledRun(expr: string, now: number): number | undefined {
  try {
    const [previous] = new Cron(expr).previousRuns(1, new Date(now))
    return previous === undefined ? undefined : previous.getTime()
  } catch {
    // An unparseable expression has no previous run. It cannot reach here
    // through the API — `decideCreate` refuses it — but a log written by an
    // older system can hold one, and a boot that throws over a bad cron
    // string takes the whole dojo down to answer a question about one job.
    return undefined
  }
}

export type SchedulePorts = {
  now: () => number
  log: (line: string) => void
  triggersState: () => TriggersState
  /** Append the firing. The delivery half is the ordinary mail path — a
   *  firing resolves to its target and the notifier announces it — so this
   *  writes ONE event and nothing else. */
  fire: (trigger: Trigger, opts?: { awaitRun?: boolean }) => Promise<void>
  /** The job table's implementation. Injectable so a test can drive the
   *  scheduler without waiting for a real cron instant. */
  schedule?: (id: string, spec: { cron: string } | { at: string }, run: () => void) => void
  unschedule?: (id: string) => void
}

export type Scheduler = {
  /** Reconcile the job table with the trigger registry: schedule what should
   *  be running, cancel what should not, fire what is already overdue. */
  sync: () => void
  /**
   * The startup make-up run for crons that missed a fire while infra was
   * down. Sequential on purpose — see the loop.
   *
   * ── NOBODY AWAITS THIS ON THE BOOT PATH (task 131, ruled 2026-08-25) ──
   *
   * It used to be awaited inside `createAdapterServer`, so READINESS —
   * every runtime file, both attention clocks, the bridge, peer attach, the
   * registry upsert — waited on a headless run. On 2026-08-24 that was seven
   * minutes during which the dojo was live, unfindable, unstoppable through
   * its own CLI, unreachable over the bridge and by peers, and could not
   * even be given an agent: `jean agent start` refuses on the same missing
   * files. A live dojo with no door, and its error messages pointed in a
   * circle — `agent start` said "start infra first", `infra start` said
   * "already running".
   *
   * The ruling: start and stop must run unobstructed and consistently. A
   * start fires the run and must not wait for it.
   *
   * THE RETURNED PROMISE IS STILL HELD, and that is the whole difference
   * between backgrounding and abandoning. `stop` needs it, and the reason is
   * not tidiness: a run that outlives its instance calls `record` into a
   * store the caller has already drained — the write-after-drain class this
   * codebase fought twice in task 127 — and, because `enforceSingleInstance`
   * probes the PORT, a stop-then-start frees the port and gives one dojo two
   * catch-ups writing the same log. You cannot kill what you did not keep.
   */
  catchUpOnBoot: () => Promise<void>
  /**
   * Release everything the scheduler holds — the job table, and now the boot
   * catch-up if one is still running.
   *
   * KILLS RATHER THAN DRAINS (ruled: "on stop, I think you can kill it. It's
   * okay. Next start it will start again"). Draining would make `jean infra
   * stop` wait out a consolidation, which is the same hostage-taking at the
   * other end of the lifecycle — the reported problem is that START and STOP
   * are obstructed, and only fixing one half would be answering half of it.
   */
  stop: () => void
}

export function createScheduler(ports: SchedulePorts): Scheduler {
  /** The DEFAULT job table — croner, and nothing else. It decides nothing. */
  const jobs = new Map<string, Cron>()
  /** What the schedule PORT has been asked to run, which is not the same as
   *  what croner is running: an injected port keeps its own table (or none),
   *  and deriving "what is scheduled" from croner would mean an injected
   *  `schedule` never produced a matching `unschedule`. */
  const scheduled = new Set<string>()

  const schedule =
    ports.schedule ??
    ((id, spec, run) => {
      if (jobs.has(id)) return
      try {
        const job =
          'cron' in spec ? new Cron(spec.cron, { catch: true }, run) : new Cron(new Date(spec.at), { catch: true }, run)
        jobs.set(id, job)
      } catch (err) {
        // A SCHEDULE THE LIBRARY WILL NOT TAKE. It cannot arrive through the
        // API — `decideCreate` refuses it — but the log is permanent, an
        // older system could have written one, and croner throws from its
        // CONSTRUCTOR. Unguarded, one bad row in the registry takes the whole
        // boot down (codex reproduced it, task 104). The job does not run and
        // the dojo is told which one; the alternative is no dojo at all.
        ports.log(`[jean:new] trigger ${id} has an unusable schedule and will not run: ${String(err)}\n`)
      }
    })

  const unschedule =
    ports.unschedule ??
    ((id) => {
      jobs.get(id)?.stop()
      jobs.delete(id)
    })

  /**
   * Fire once, even if asked twice.
   *
   * `fire` appends, and the append is what marks the trigger fired — so
   * between the call and the fold the registry still reads "due". `sync`
   * runs on every trigger-stream append, so a second one landing in that
   * window fires the same one-shot again (codex pass, task 104).
   */
  const firing = new Set<string>()
  function fireOnce(trigger: Trigger): void {
    if (firing.has(trigger.id)) return
    firing.add(trigger.id)
    void ports.fire(trigger).finally(() => firing.delete(trigger.id))
  }

  /**
   * The trigger AS IT STANDS, at the moment its job runs.
   *
   * A job scheduled today may fire in a month, and `agent`, `prompt` and
   * `status` are all mutable in between — while the SCHEDULE is not, so
   * `sync` never has a reason to re-register the job. A callback closing
   * over the trigger object therefore fires last month's prompt at last
   * month's target, and a trigger disabled since scheduling fires anyway
   * (codex pass, task 104). Look it up by id, and let a lapsed one lapse.
   */
  function fireCurrent(id: string): void {
    const current = triggers.triggerOf(ports.triggersState(), id)
    if (current === undefined || current.status !== 'active') return
    fireOnce(current)
  }

  function sync(): void {
    const state = ports.triggersState()
    const all = triggers.all(state)
    const active = all.filter((t) => t.status === 'active')

    // OVERDUE ONE-SHOTS FIRE RATHER THAN BEING SCHEDULED — the domain's
    // answer to "which `at`s are due", so they never enter the scheduled set
    // at all. A one-shot whose instant has passed has no future to wait for.
    const due = new Set(triggers.dueOneShots(state, ports.now()).map((t) => t.id))
    for (const trigger of triggers.dueOneShots(state, ports.now())) {
      if (trigger.status !== 'active') continue
      fireOnce(trigger)
    }

    for (const trigger of active) {
      if (scheduled.has(trigger.id) || due.has(trigger.id)) continue
      // `Trigger` is a discriminated union: exactly one of cron or at.
      schedule(trigger.id, trigger.cron !== undefined ? { cron: trigger.cron } : { at: trigger.at }, () =>
        fireCurrent(trigger.id),
      )
      scheduled.add(trigger.id)
    }

    const shouldRun = new Set(active.map((t) => t.id))
    for (const id of [...scheduled]) {
      if (shouldRun.has(id)) continue
      unschedule(id)
      scheduled.delete(id)
    }
  }

  async function catchUpOnBoot(): Promise<void> {
    const now = ports.now()
    for (const trigger of triggers.all(ports.triggersState())) {
      // ── R9 ── The active-status filter is the CALLER'S, because
      // `shouldCatchUp` deliberately omits it. Delete this line and disabled
      // triggers make up their missed runs on every boot, with nothing
      // failing anywhere.
      if (trigger.status !== 'active') continue
      if (!triggers.shouldCatchUp(trigger, now, previousScheduledRun)) continue
      ports.log(`[jean:new] trigger ${trigger.id} catch-up fire on startup (last fired ${trigger.lastFiredAt})\n`)
      // SEQUENTIAL, awaited: several overdue triggers on one boot are the
      // normal case after a laptop was shut, and firing them in parallel
      // means the whole backlog lands in one mailbox in one instant.
      firing.add(trigger.id)
      try {
        // AWAITING THE RUN, not just its event: several overdue triggers is
        // the normal case after a laptop was shut, and a headless firing
        // detaches a process. Launching them in parallel is a stampede on
        // one machine (codex pass, task 114).
        await ports.fire(trigger, { awaitRun: true })
      } finally {
        firing.delete(trigger.id)
      }
    }
  }

  return {
    sync,
    catchUpOnBoot,
    stop() {
      for (const id of [...scheduled]) unschedule(id)
      scheduled.clear()
      for (const job of jobs.values()) job.stop()
      jobs.clear()
    },
  }
}
