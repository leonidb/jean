/**
 * Tasks conformance — the executable form of the tasks contract.
 * RED BY ABSENCE until D3 lands `src/domain/tasks/index.ts` exporting
 * `tasks: TasksContract`. No plausible stubs anywhere (design §9).
 */

import { describe, expect, test } from 'bun:test'
import { counted, createClock, createLog } from '../fixture/index.ts'
import type { TaskStatus, TasksContract } from './tasks.ts'

const IMPL_PATH: string = '../tasks/index.ts'
const tasks: TasksContract = await import(IMPL_PATH)
  .then((m) => (m as { tasks: TasksContract }).tasks)
  .catch((err: unknown) => {
    if (String(err).includes('Cannot find module')) {
      throw new Error(
        'RED BY ABSENCE — src/domain/tasks/index.ts does not exist yet. ' +
          'Task D3 implements the TasksContract; nothing else may (no plausible stubs — design §9).',
      )
    }
    throw err
  })

const ORCH = 'orchestrator-o'
const WORKER_A = 'worker-a'
const NOW = 1_755_600_000_000

function world() {
  const clock = createClock()
  const log = createLog(clock)
  return { clock, log }
}

/** One task created and folded; returns state + ids. */
function withTask(status: TaskStatus = 'todo') {
  const { clock, log } = world()
  log.append('task-created', 'task-001', { title: 't', description: '', queue: WORKER_A, actor: ORCH })
  const chain: Record<TaskStatus, TaskStatus[]> = {
    todo: [],
    assigned: ['assigned'],
    'in-progress': ['in-progress'],
    waiting: ['in-progress', 'waiting'],
    done: ['in-progress', 'done'],
    cancelled: ['cancelled'],
  }
  let prev: TaskStatus = 'todo'
  for (const to of chain[status]) {
    log.append('task-status', 'task-001', {
      from: prev,
      to,
      actor: ORCH,
      // The park carries a note so clearing assertions cannot pass vacuously.
      ...(to === 'waiting' && { blockedOn: 'sensei' as const, blockedNote: 'why parked' }),
    })
    prev = to
  }
  let state = tasks.initial()
  for (const e of log.events()) state = tasks.fold(state, e)
  return { state, log, clock }
}

describe('the DAG — exact edge set, extracted as deliberate', () => {
  const LEGAL: Array<[TaskStatus, TaskStatus]> = [
    ['todo', 'assigned'],
    ['todo', 'in-progress'],
    ['todo', 'cancelled'],
    ['assigned', 'in-progress'],
    ['assigned', 'cancelled'],
    ['in-progress', 'waiting'],
    ['in-progress', 'done'],
    ['in-progress', 'cancelled'],
    ['waiting', 'in-progress'],
    ['waiting', 'done'],
    ['waiting', 'cancelled'],
  ]
  const STATUSES: TaskStatus[] = ['todo', 'assigned', 'in-progress', 'waiting', 'done', 'cancelled']

  test('every legal edge passes and every other pair refuses — including no todo/assigned → waiting, and terminal states exit nowhere', () => {
    const legal = new Set(LEGAL.map(([f, t]) => `${f}>${t}`))
    let checkedCount = 0
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        expect(tasks.canTransition(from, to)).toBe(legal.has(`${from}>${to}`))
        checkedCount++
      }
    }
    counted('DAG pairs', checkedCount, 36)
    expect(tasks.canTransition('todo', 'waiting')).toBe(false) // parking presumes engagement
    expect(tasks.canTransition('assigned', 'waiting')).toBe(false)
    expect(tasks.canTransition('done', 'in-progress')).toBe(false) // forward DAG; revert is the only way back
  })
})

describe('actor gates — the role gate and the precedence rule', () => {
  test("a worker's ONLY permitted move is in-progress → waiting; everyone else is ungated by role", () => {
    const STATUSES: TaskStatus[] = ['todo', 'assigned', 'in-progress', 'waiting', 'done', 'cancelled']
    let workerAllowed = 0
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const allowed = tasks.actorMayTransition('worker', from, to)
        if (allowed) workerAllowed++
        expect(allowed).toBe(from === 'in-progress' && to === 'waiting')
        expect(tasks.actorMayTransition('sensei', from, to)).toBe(true)
      }
    }
    counted('worker-permitted edges', workerAllowed, 1)
  })

  test('precedence: the registered role wins; a claim counts only when it claims worker; otherwise unresolvable', () => {
    expect(tasks.resolveActorRole('sensei', 'worker')).toBe('worker') // registry beats the claim
    expect(tasks.resolveActorRole('worker', undefined)).toBe('worker') // claiming worker binds
    expect(tasks.resolveActorRole('sensei', undefined)).toBeUndefined() // asserting power confers none
    expect(tasks.resolveActorRole(undefined, undefined)).toBeUndefined() // the human's tooling — ungated
    expect(tasks.resolveActorRole(undefined, 'sensei')).toBe('sensei')
  })

  test('decideStatus refuses a worker closing a task, with the typed refusal', () => {
    const { state } = withTask('in-progress')
    const d = tasks.decideStatus(state, { taskId: '001', to: 'done', actor: WORKER_A, actorRole: 'worker' })
    expect(d.ok).toBe(false)
    if (!d.ok)
      expect(d.refusal).toEqual({ kind: 'actor-forbidden', actorRole: 'worker', from: 'in-progress', to: 'done' })
  })

  test('unknown-task and illegal-transition refuse with their typed refusals — the adapter renames, never judges', () => {
    const { state } = withTask('in-progress')
    const unknown = tasks.decideStatus(state, { taskId: '404', to: 'done', actor: ORCH })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.refusal).toEqual({ kind: 'unknown-task' })
    const illegal = tasks.decideStatus(state, { taskId: '001', to: 'assigned', actor: ORCH })
    expect(illegal.ok).toBe(false)
    if (!illegal.ok)
      expect(illegal.refusal).toEqual({ kind: 'illegal-transition', from: 'in-progress', to: 'assigned' })
  })
})

describe('parking — blocker required, snooze validated, clear-or-replace', () => {
  test('entry to waiting without blockedOn refuses; with a blocker it carries the park data', () => {
    const { state } = withTask('in-progress')
    const bare = tasks.decideStatus(state, { taskId: '001', to: 'waiting', actor: ORCH })
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.refusal).toEqual({ kind: 'blocker-required' })
    const parked = tasks.decideStatus(state, {
      taskId: '001',
      to: 'waiting',
      actor: ORCH,
      blockedOn: 'human',
      blockedNote: 'needs answer',
    })
    expect(parked.ok).toBe(true)
    if (parked.ok) {
      expect(parked.data.blockedOn).toBe('human')
      expect(parked.data.blockedNote).toBe('needs answer')
    }
  })

  test('an unparseable resumeAt refuses loudly — a silently-always-true snooze is the September bug', () => {
    const { state } = withTask('in-progress')
    const d = tasks.decideStatus(state, {
      taskId: '001',
      to: 'waiting',
      actor: ORCH,
      blockedOn: 'external',
      resumeAt: 'not-a-date',
    })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.refusal).toEqual({ kind: 'unparseable-resume', resumeAt: 'not-a-date' })
  })

  test('a fresh park never inherits an earlier park’s snooze, and leaving waiting clears every park field', () => {
    const { state, log } = withTask('in-progress')
    let s = state
    s = tasks.fold(
      s,
      log.append('task-status', 'task-001', {
        from: 'in-progress',
        to: 'waiting',
        actor: ORCH,
        blockedOn: 'external',
        blockedNote: 'vendor asked',
        resumeAt: new Date(NOW + 86_400_000).toISOString(),
      }),
    )
    s = tasks.fold(s, log.append('task-status', 'task-001', { from: 'waiting', to: 'in-progress', actor: ORCH }))
    const unParked = tasks.taskOf(s, '001')
    expect(unParked?.blockedOn).toBeUndefined()
    expect(unParked?.blockedNote).toBeUndefined() // all FOUR park fields clear
    expect(unParked?.resumeAt).toBeUndefined()
    expect(unParked?.blockedSince).toBeUndefined()
    // Park again WITHOUT a snooze — nothing inherited.
    s = tasks.fold(
      s,
      log.append('task-status', 'task-001', { from: 'in-progress', to: 'waiting', actor: ORCH, blockedOn: 'sensei' }),
    )
    const reParked = tasks.taskOf(s, '001')
    expect(reParked?.blockedOn).toBe('sensei')
    expect(reParked?.resumeAt).toBeUndefined()
  })

  test('parking SETS blockedSince to the park event’s time — the cadence clock A5/D9 build on (084 report, gap 1)', () => {
    const { state, log } = withTask('in-progress')
    const parkEvent = log.append('task-status', 'task-001', {
      from: 'in-progress',
      to: 'waiting',
      actor: ORCH,
      blockedOn: 'human',
    })
    const s = tasks.fold(state, parkEvent)
    expect(tasks.taskOf(s, '001')?.blockedSince).toBe(parkEvent.ts)
  })
})

describe('the handoff — canon 8, a first-class act', () => {
  test('valid only while waiting; replaces EVERY park field', () => {
    const { state, log } = withTask('waiting')
    // Give the CURRENT park a snooze first, so the clearing assertion below
    // cannot pass vacuously (codex pass, task 082: the field was never set).
    const snoozed = tasks.fold(
      state,
      log.appendRaw('task-blocked', 'task-001', {
        blockedOn: 'sensei',
        note: 'old question',
        actor: ORCH,
        resumeAt: new Date(NOW + 86_400_000).toISOString(),
      }),
    )
    expect(tasks.taskOf(snoozed, '001')?.resumeAt).toBeDefined()
    const moved = tasks.decideHandoff(snoozed, { taskId: '001', blockedOn: 'human', note: 'escalated', actor: ORCH })
    expect(moved.ok).toBe(true)
    if (moved.ok) {
      const s = tasks.fold(snoozed, log.append('task-blocked', 'task-001', moved.data))
      const t = tasks.taskOf(s, '001')
      expect(t?.blockedOn).toBe('human')
      expect(t?.blockedNote).toBe('escalated')
      expect(t?.resumeAt).toBeUndefined() // the old snooze does not survive the handoff
    }
    const { state: active } = withTask('in-progress')
    const refused = tasks.decideHandoff(active, { taskId: '001', blockedOn: 'human', actor: ORCH })
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.refusal).toEqual({ kind: 'not-waiting', status: 'in-progress' })
  })

  test('any reassignment is accepted — no cycle guard, deliberately (re-escalation must never be refused)', () => {
    const { state } = withTask('waiting') // blockedOn: sensei
    const backToSensei = tasks.decideHandoff(state, { taskId: '001', blockedOn: 'sensei', actor: ORCH })
    expect(backToSensei.ok).toBe(true)
  })

  test('the snooze law applies to the handoff too: an unparseable resumeAt refuses loudly (084 report, gap 3)', () => {
    const { state } = withTask('waiting')
    const d = tasks.decideHandoff(state, { taskId: '001', blockedOn: 'external', actor: ORCH, resumeAt: 'someday' })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.refusal).toEqual({ kind: 'unparseable-resume', resumeAt: 'someday' })
  })
})

describe('revert — stack-pop, and the park-clearing ruling (D-1)', () => {
  test('pops to the previous status; refuses with nothing to revert; a revert event folds the pop', () => {
    const { state, log } = withTask('in-progress') // stack: todo, in-progress
    const d = tasks.decideRevert(state, '001', ORCH)
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.from).toBe('in-progress')
      expect(d.to).toBe('todo')
      const s = tasks.fold(state, log.append('task-reverted', 'task-001', d.data))
      expect(tasks.taskOf(s, '001')?.status).toBe('todo')
      // The stack popped: a second revert now has nothing left.
      const again = tasks.decideRevert(s, '001', ORCH)
      expect(again.ok).toBe(false)
      if (!again.ok) expect(again.refusal).toEqual({ kind: 'nothing-to-revert' })
    }
  })

  test('RULED (D-5): revert never lands on waiting — a mistakenly-closed parked task pops PAST it to in-progress', () => {
    // Stack: todo → in-progress → waiting → done. Without D-5 the pop lands
    // on `waiting` with no blocker — the parked-on-nobody state the 2026-08-14
    // ruling abolishes; refusing instead would strand the task (done has no
    // DAG exit). Popping past keeps the escape hatch honest.
    const { log } = world()
    log.append('task-created', 'task-001', { title: 't', description: '', queue: WORKER_A, actor: ORCH })
    log.append('task-status', 'task-001', { from: 'todo', to: 'in-progress', actor: ORCH })
    log.append('task-status', 'task-001', { from: 'in-progress', to: 'waiting', actor: ORCH, blockedOn: 'human' })
    log.append('task-status', 'task-001', { from: 'waiting', to: 'done', actor: ORCH })
    let s = tasks.initial()
    for (const e of log.events()) s = tasks.fold(s, e)
    const d = tasks.decideRevert(s, '001', ORCH)
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.from).toBe('done')
      expect(d.to).toBe('in-progress') // waiting skipped
      const after = tasks.fold(s, log.append('task-reverted', 'task-001', d.data))
      const t = tasks.taskOf(after, '001')
      expect(t?.status).toBe('in-progress')
      expect(t?.blockedOn).toBeUndefined() // and no park resurrects
    }
  })

  test('RULED (D-1): reverting OUT of waiting clears the park fields — no reminder clock survives on a moving task', () => {
    const { state, log } = withTask('waiting') // parked on sensei
    expect(tasks.taskOf(state, '001')?.blockedOn).toBe('sensei')
    const d = tasks.decideRevert(state, '001', ORCH)
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.to).toBe('in-progress')
      const s = tasks.fold(state, log.append('task-reverted', 'task-001', d.data))
      const t = tasks.taskOf(s, '001')
      expect(t?.status).toBe('in-progress')
      expect(t?.blockedOn).toBeUndefined() // the old fold left this sticky — accident, left behind
      expect(t?.blockedNote).toBeUndefined()
      expect(t?.blockedSince).toBeUndefined()
      expect(t?.resumeAt).toBeUndefined()
    }
  })
})

describe('the fold — data compatibility and start semantics', () => {
  test('legacy status names fold to current ones (real logs hold them)', () => {
    const { log } = world()
    log.append('task-created', 'task-001', { title: 't', description: '', queue: WORKER_A, actor: ORCH })
    log.appendRaw('task-status', 'task-001', { from: 'todo', to: 'active', actor: ORCH })
    let state = tasks.initial()
    for (const e of log.events()) state = tasks.fold(state, e)
    expect(tasks.taskOf(state, '001')?.status).toBe('in-progress')
  })

  test('starting an unassigned task assigns the queue as the agent (extracted as-is; see OPEN Q-1)', () => {
    const { state } = withTask('in-progress')
    expect(tasks.taskOf(state, '001')?.agent).toBe(WORKER_A)
  })

  test('a duplicate task-created for an existing id is ignored — first wins, replay never doubles a task (084 report, gap 4)', () => {
    const { state, log } = withTask('in-progress')
    const s = tasks.fold(
      state,
      log.append('task-created', 'task-001', { title: 'impostor', description: '', queue: 'other-q', actor: ORCH }),
    )
    expect(tasks.all(s).filter((t) => t.id === '001').length).toBe(1)
    const t = tasks.taskOf(s, '001')
    expect(t?.title).toBe('t') // the original, untouched
    expect(t?.status).toBe('in-progress')
  })

  test('the historical task-blocked kind folds as a full park replacement', () => {
    const { state, log } = withTask('waiting')
    const s = tasks.fold(
      state,
      log.appendRaw('task-blocked', 'task-001', { blockedOn: 'external', note: 'vendor', actor: ORCH }),
    )
    const t = tasks.taskOf(s, '001')
    expect(t?.blockedOn).toBe('external')
    expect(t?.blockedNote).toBe('vendor')
  })
})

describe('queries — staleness, ids, activity attribution, availability', () => {
  test('staleness flags in-progress tasks quiet past the bound — and only in-progress', () => {
    const { state } = withTask('in-progress')
    const quiet = () => NOW - 3_600_000 // an hour silent
    expect(tasks.staleTasks(state, NOW, 1_800_000, quiet)).toEqual(['001'])
    expect(tasks.staleTasks(state, NOW, 7_200_000, quiet)).toEqual([]) // inside the bound
    // Exactly AT the bound is stale — the >= boundary, pinned.
    expect(tasks.staleTasks(state, NOW, 3_600_000, quiet)).toEqual(['001'])
    const { state: parked } = withTask('waiting')
    expect(tasks.staleTasks(parked, NOW, 1_800_000, quiet)).toEqual([]) // parked is not stale — it is parked
  })

  test('staleness falls back to updatedAt when no stream activity is known', () => {
    const { state } = withTask('in-progress') // updatedAt = fixture epoch, far before NOW
    const unknown = () => undefined
    expect(tasks.staleTasks(state, NOW, 1_800_000, unknown)).toEqual(['001'])
  })

  test('nextTaskId is sequential and zero-padded; activeTaskOf and openTaskCount read the board', () => {
    const { state } = withTask('in-progress')
    expect(tasks.nextTaskId(state)).toBe('002')
    expect(tasks.activeTaskOf(state, WORKER_A)?.id).toBe('001')
    expect(tasks.activeTaskOf(state, ORCH)).toBeUndefined()
    expect(tasks.openTaskCount(state, WORKER_A)).toBe(1)
    expect(tasks.openTaskCount(state, ORCH)).toBe(0)
  })

  test('activeTaskOf finds a WAITING task too, and matches by queue when no agent was ever set', () => {
    const { state: parked } = withTask('waiting')
    expect(tasks.activeTaskOf(parked, WORKER_A)?.id).toBe('001')
    // A dispatched-but-unstarted task has no agent; the queue names its holder.
    const { log } = world()
    log.append('task-created', 'task-001', { title: 't', description: '', queue: WORKER_A, actor: ORCH })
    log.append('task-status', 'task-001', { from: 'todo', to: 'in-progress', actor: ORCH })
    let s = tasks.initial()
    for (const e of log.events()) s = tasks.fold(s, e)
    expect(tasks.activeTaskOf(s, WORKER_A)?.id).toBe('001')
  })
})
