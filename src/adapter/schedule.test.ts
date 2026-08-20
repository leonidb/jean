/**
 * The trigger scheduler — R9, the job table, and the boot catch-up (task E3).
 *
 * No server here: the scheduler takes its trigger state, its clock and its
 * job table as ports, so this is a unit test of the shell's own bookkeeping.
 * WHICH triggers are due and WHICH missed a run are the domain's answers and
 * are pinned in `triggers.conformance.test.ts`; what is pinned here is that
 * the caller asks the right question, of the right triggers, once.
 */

import { describe, expect, test } from 'bun:test'
import type { Trigger, TriggersState } from '../domain/contracts/triggers.ts'
import { TRIGGERS_STREAM } from '../domain/contracts/vocabulary.ts'
import { triggers } from '../domain/triggers/index.ts'
import type { StoredEvent } from '../es/index.ts'
import { createScheduler, previousScheduledRun } from './schedule.ts'

let nextId = 1
const event = (type: string, data: unknown, ts = '2026-08-18T09:00:00.000Z'): StoredEvent => ({
  id: nextId++,
  ts,
  type,
  stream: TRIGGERS_STREAM,
  data,
})

/** A registry built the way the server builds it: by folding the log. */
function registry(events: readonly StoredEvent[]): TriggersState {
  let state = triggers.initial()
  for (const e of events) state = triggers.fold(state, e)
  return state
}

const NOW = Date.parse('2026-08-18T12:00:00.000Z')

/** A nightly cron that fired two days ago — so it has missed a run. */
const overdue = (id: string) => [
  event('trigger-created', { id, cron: '0 3 * * *', agent: 'worker-a', prompt: 'sweep', actor: 'api', kind: 'agent' }),
  event(
    'trigger-fired',
    { triggerId: id, agent: 'worker-a', prompt: 'sweep', kind: 'agent' },
    '2026-08-16T03:00:00.000Z',
  ),
]

function harness(events: readonly StoredEvent[]) {
  const fired: string[] = []
  const scheduled: string[] = []
  const unscheduled: string[] = []
  const scheduler = createScheduler({
    now: () => NOW,
    log: () => {},
    triggersState: () => registry(events),
    fire: async (t: Trigger) => {
      fired.push(t.id)
    },
    schedule: (id) => {
      scheduled.push(id)
    },
    unschedule: (id) => {
      unscheduled.push(id)
    },
  })
  return { scheduler, fired, scheduled, unscheduled }
}

describe('R9 — the active filter is the caller’s', () => {
  test('an ACTIVE cron that missed its run catches up on boot', async () => {
    const { scheduler, fired } = harness(overdue('nightly'))
    await scheduler.catchUpOnBoot()
    expect(fired).toEqual(['nightly']) // anti-vacuity: the fixture really is overdue
  })

  test('a DISABLED one does NOT — the row this task owes, and the one nothing else would catch', async () => {
    // `shouldCatchUp` deliberately omits the status check (extraction
    // fidelity: the old startup loop filtered before calling), so the filter
    // lives at the call site. Delete it and every disabled trigger in the
    // dojo makes up its missed runs on every boot — nothing throws, nothing
    // turns red, and the person who disabled them watches them fire.
    const events = [...overdue('nightly'), event('trigger-updated', { id: 'nightly', status: 'disabled' })]
    const { scheduler, fired } = harness(events)
    await scheduler.catchUpOnBoot()
    expect(fired).toEqual([])
  })

  test('a brand-new trigger does not catch up either — that answer is the domain’s', async () => {
    // Not a restatement of the rule: the point is that the caller asks
    // `shouldCatchUp` at all rather than deciding for itself.
    const { scheduler, fired } = harness([
      event('trigger-created', {
        id: 'fresh',
        cron: '0 3 * * *',
        agent: 'worker-a',
        prompt: 'sweep',
        actor: 'api',
        kind: 'agent',
      }),
    ])
    await scheduler.catchUpOnBoot()
    expect(fired).toEqual([])
  })
})

describe('the job table', () => {
  test('active triggers get jobs; disabled ones lose theirs', () => {
    const base = [
      event('trigger-created', {
        id: 'nightly',
        cron: '0 3 * * *',
        agent: 'worker-a',
        prompt: 'sweep',
        actor: 'api',
        kind: 'agent',
      }),
    ]
    const live = [...base]
    const fired: string[] = []
    const scheduled: string[] = []
    const unscheduled: string[] = []
    const scheduler = createScheduler({
      now: () => NOW,
      log: () => {},
      triggersState: () => registry(live),
      fire: async (t) => {
        fired.push(t.id)
      },
      schedule: (id) => {
        scheduled.push(id)
      },
      unschedule: (id) => {
        unscheduled.push(id)
      },
    })

    scheduler.sync()
    expect(scheduled).toEqual(['nightly'])

    // Idempotent: a second sync over an unchanged registry changes nothing.
    scheduler.sync()
    expect(scheduled).toEqual(['nightly'])
    expect(unscheduled).toEqual([])

    live.push(event('trigger-updated', { id: 'nightly', status: 'disabled' }))
    scheduler.sync()
    expect(unscheduled).toEqual(['nightly'])
  })

  test('an overdue one-shot FIRES instead of being scheduled — there is no future to wait for', () => {
    const { scheduler, fired, scheduled } = harness([
      event('trigger-created', {
        id: 'once',
        at: '2026-08-18T10:00:00.000Z', // two hours before NOW
        agent: 'worker-a',
        prompt: 'now please',
        actor: 'api',
        kind: 'agent',
      }),
    ])
    scheduler.sync()
    expect(fired).toEqual(['once'])
    expect(scheduled).toEqual([])
  })

  test('a FUTURE one-shot is scheduled and not fired', () => {
    const { scheduler, fired, scheduled } = harness([
      event('trigger-created', {
        id: 'later',
        at: '2026-08-19T10:00:00.000Z',
        agent: 'worker-a',
        prompt: 'tomorrow',
        actor: 'api',
        kind: 'agent',
      }),
    ])
    scheduler.sync()
    expect(fired).toEqual([])
    expect(scheduled).toEqual(['later'])
  })

  test('stop cancels every job it asked for', () => {
    const { scheduler, unscheduled } = harness([
      event('trigger-created', {
        id: 'nightly',
        cron: '0 3 * * *',
        agent: 'worker-a',
        prompt: 'sweep',
        actor: 'api',
        kind: 'agent',
      }),
    ])
    scheduler.sync()
    scheduler.stop()
    expect(unscheduled).toEqual(['nightly'])
  })
})

describe('firing exactly once, with what the trigger says NOW', () => {
  test('two syncs before the append lands fire the one-shot ONCE', () => {
    // `fire` appends, and the append is what marks a trigger fired — so
    // between the call and the fold the registry still reads "due", and
    // `sync` runs on every trigger-stream append. A second one landing in
    // that window fired the same one-shot twice (codex pass).
    const fired: string[] = []
    const scheduler = createScheduler({
      now: () => NOW,
      log: () => {},
      triggersState: () =>
        registry([
          event('trigger-created', {
            id: 'once',
            at: '2026-08-18T10:00:00.000Z',
            agent: 'worker-a',
            prompt: 'now please',
            actor: 'api',
            kind: 'agent',
          }),
        ]),
      // Never resolves: the append is still in flight for the whole test.
      fire: async (t) => {
        fired.push(t.id)
        await new Promise(() => {})
      },
      schedule: () => {},
      unschedule: () => {},
    })
    scheduler.sync()
    scheduler.sync()
    scheduler.sync()
    expect(fired).toEqual(['once'])
  })

  test('a job fires the trigger AS IT STANDS, not as it was when scheduled', () => {
    // The schedule is immutable, so `sync` never re-registers a job — and a
    // callback closing over the trigger object fires last month's prompt at
    // last month's target (codex pass).
    const live = [
      event('trigger-created', {
        id: 'nightly',
        cron: '0 3 * * *',
        agent: 'worker-a',
        prompt: 'old prompt',
        actor: 'api',
        kind: 'agent',
      }),
    ]
    const fired: { id: string; prompt: string }[] = []
    let job: (() => void) | undefined
    const scheduler = createScheduler({
      now: () => NOW,
      log: () => {},
      triggersState: () => registry(live),
      fire: async (t) => {
        fired.push({ id: t.id, prompt: t.prompt })
      },
      schedule: (_id, _spec, run) => {
        job = run
      },
      unschedule: () => {},
    })
    scheduler.sync()
    expect(job).toBeDefined()

    live.push(event('trigger-updated', { id: 'nightly', prompt: 'new prompt' }))
    job?.()
    expect(fired).toEqual([{ id: 'nightly', prompt: 'new prompt' }])

    // And a trigger disabled since it was scheduled lapses rather than
    // firing: nothing unscheduled it, because the schedule never changed.
    live.push(event('trigger-updated', { id: 'nightly', status: 'disabled' }))
    job?.()
    expect(fired.length).toBe(1)
  })

  test('a schedule the library will not take costs one job, not the boot', () => {
    // It cannot arrive through the API — `decideCreate` refuses it — but the
    // log is permanent, croner throws from its CONSTRUCTOR, and one bad row
    // took the whole startup down (codex reproduced it).
    const lines: string[] = []
    const scheduler = createScheduler({
      now: () => NOW,
      log: (line) => lines.push(line),
      triggersState: () =>
        registry([
          event('trigger-created', {
            id: 'broken',
            cron: 'not a cron',
            agent: 'worker-a',
            prompt: 'x',
            actor: 'api',
            kind: 'agent',
          }),
          event('trigger-created', {
            id: 'fine',
            cron: '0 3 * * *',
            agent: 'worker-a',
            prompt: 'y',
            actor: 'api',
            kind: 'agent',
          }),
        ]),
      fire: async () => {},
      // No injected table: this must exercise the real croner path.
    })
    expect(() => scheduler.sync()).not.toThrow()
    expect(lines.join('')).toContain('broken')
    scheduler.stop()
  })
})

describe('catch-up awaits the RUN, not just its event', () => {
  test('overdue headless triggers do not stampede — each finishes before the next fires', async () => {
    // A headless firing detaches a process. Several triggers overdue after a
    // laptop was shut is the normal case, and launching their spawns in
    // parallel puts N Claude processes on one machine — the old startup loop
    // awaited each for exactly this reason (codex pass).
    const events = [...overdue('nightly'), ...overdue('second')]
    const running: string[] = []
    let overlapped = false
    const scheduler = createScheduler({
      now: () => NOW,
      log: () => {},
      triggersState: () => registry(events),
      fire: async (t, opts) => {
        expect(opts?.awaitRun).toBe(true) // catch-up asks for the whole run
        if (running.length > 0) overlapped = true
        running.push(t.id)
        await new Promise((r) => setTimeout(r, 20))
        running.pop()
      },
      schedule: () => {},
      unschedule: () => {},
    })
    await scheduler.catchUpOnBoot()
    expect(overlapped).toBe(false)
  })
})

describe('the injected cron arithmetic', () => {
  test('a real expression yields the most recent instant at or before now', () => {
    const previous = previousScheduledRun('0 3 * * *', NOW)
    expect(previous).toBe(Date.parse('2026-08-18T03:00:00.000Z'))
  })

  test('an unparseable expression yields NOTHING rather than throwing', () => {
    // It cannot arrive through the API — `decideCreate` refuses it — but a
    // log written by an older system can hold one, and a boot that throws
    // over a bad cron string takes the whole dojo down to answer a question
    // about a single job.
    expect(previousScheduledRun('not a cron', NOW)).toBeUndefined()
  })
})
