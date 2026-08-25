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
/** The injected roster fact (Q-1, ruled): who counts as a dojo agent. */
const ROSTER = (name: string) => name === WORKER_A || name === ORCH
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
  for (const e of log.events()) state = tasks.fold(state, e, ROSTER)
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
      ROSTER,
    )
    s = tasks.fold(
      s,
      log.append('task-status', 'task-001', { from: 'waiting', to: 'in-progress', actor: ORCH }),
      ROSTER,
    )
    const unParked = tasks.taskOf(s, '001')
    expect(unParked?.blockedOn).toBeUndefined()
    expect(unParked?.blockedNote).toBeUndefined() // all FOUR park fields clear
    expect(unParked?.resumeAt).toBeUndefined()
    expect(unParked?.blockedSince).toBeUndefined()
    // Park again WITHOUT a snooze — nothing inherited.
    s = tasks.fold(
      s,
      log.append('task-status', 'task-001', { from: 'in-progress', to: 'waiting', actor: ORCH, blockedOn: 'sensei' }),
      ROSTER,
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
    const s = tasks.fold(state, parkEvent, ROSTER)
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
      ROSTER,
    )
    expect(tasks.taskOf(snoozed, '001')?.resumeAt).toBeDefined()
    const moved = tasks.decideHandoff(snoozed, { taskId: '001', blockedOn: 'human', note: 'escalated', actor: ORCH })
    expect(moved.ok).toBe(true)
    if (moved.ok) {
      const s = tasks.fold(snoozed, log.append('task-blocked', 'task-001', moved.data), ROSTER)
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
      const s = tasks.fold(state, log.append('task-reverted', 'task-001', d.data), ROSTER)
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
    for (const e of log.events()) s = tasks.fold(s, e, ROSTER)
    const d = tasks.decideRevert(s, '001', ORCH)
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.from).toBe('done')
      expect(d.to).toBe('in-progress') // waiting skipped
      const after = tasks.fold(s, log.append('task-reverted', 'task-001', d.data), ROSTER)
      const t = tasks.taskOf(after, '001')
      expect(t?.status).toBe('in-progress')
      expect(t?.blockedOn).toBeUndefined() // and no park resurrects
    }
  })

  test('THE STACK LAW, case 1: a SECOND revert after a D-5 skip pops from where the first actually landed (090 pin)', () => {
    // Stack: todo → in-progress → waiting → done. First revert lands
    // in-progress (D-5 skips waiting) — the skipped waiting must LEAVE the
    // stack too, or this second revert pops "back" to it. The bug D3b fixed;
    // one assertion holds both halves of the law.
    const { log } = world()
    log.append('task-created', 'task-001', { title: 't', description: '', queue: WORKER_A, actor: ORCH })
    log.append('task-status', 'task-001', { from: 'todo', to: 'in-progress', actor: ORCH })
    log.append('task-status', 'task-001', { from: 'in-progress', to: 'waiting', actor: ORCH, blockedOn: 'human' })
    log.append('task-status', 'task-001', { from: 'waiting', to: 'done', actor: ORCH })
    let s = tasks.initial()
    for (const e of log.events()) s = tasks.fold(s, e, ROSTER)
    const first = tasks.decideRevert(s, '001', ORCH)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    s = tasks.fold(s, log.append('task-reverted', 'task-001', first.data), ROSTER)
    expect(tasks.taskOf(s, '001')?.status).toBe('in-progress')
    const second = tasks.decideRevert(s, '001', ORCH)
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.from).toBe('in-progress') // top === status: the pop starts where the task IS
      expect(second.to).toBe('todo') // never back to the skipped waiting
    }
  })

  test('THE STACK LAW, case 2: a task-reverted whose `to` is not in the stack leaves top === status (090 pin)', () => {
    // History deep enough that the follow-up revert MUST succeed, so the law
    // is asserted definitely — a conditional expect would let this pass as a
    // no-op (codex pass, 090).
    const { log } = world()
    log.append('task-created', 'task-001', { title: 't', description: '', queue: WORKER_A, actor: ORCH })
    log.append('task-status', 'task-001', { from: 'todo', to: 'in-progress', actor: ORCH })
    log.append('task-status', 'task-001', { from: 'in-progress', to: 'done', actor: ORCH })
    let s = tasks.initial()
    for (const e of log.events()) s = tasks.fold(s, e, ROSTER)
    // A rogue/foreign revert event naming a status never entered.
    s = tasks.fold(s, log.appendRaw('task-reverted', 'task-001', { from: 'done', to: 'waiting', actor: ORCH }), ROSTER)
    const t = tasks.taskOf(s, '001')
    if (!t) throw new Error('fixture: task missing')
    const d = tasks.decideRevert(s, '001', ORCH)
    expect(d.ok).toBe(true) // poppable history remains below — a refusal here would itself break the law
    if (d.ok) expect(d.from).toBe(t.status) // top === status, whatever the fold made of the rogue event
  })

  test('THE STACK LAW, case 3: decideRevert never reports a `from` that disagrees with the task status (090 pin)', () => {
    // Build several histories; in every one, decideRevert's `from` must equal
    // the folded status — the law observed through the only surface that
    // exposes the stack.
    const histories: TaskStatus[][] = [
      ['in-progress'],
      ['in-progress', 'waiting'],
      ['in-progress', 'waiting', 'in-progress'],
      ['in-progress', 'done'],
      ['assigned', 'in-progress', 'waiting', 'cancelled'],
    ]
    let checked = 0
    for (const chain of histories) {
      const { log } = world()
      log.append('task-created', 'task-001', { title: 't', description: '', queue: WORKER_A, actor: ORCH })
      let prev: TaskStatus = 'todo'
      for (const to of chain) {
        log.append('task-status', 'task-001', {
          from: prev,
          to,
          actor: ORCH,
          ...(to === 'waiting' && { blockedOn: 'sensei' as const }),
        })
        prev = to
      }
      let s = tasks.initial()
      for (const e of log.events()) s = tasks.fold(s, e, ROSTER)
      const d = tasks.decideRevert(s, '001', ORCH)
      if (d.ok) {
        expect(d.from).toBe(tasks.taskOf(s, '001')?.status as TaskStatus)
        checked++
      }
    }
    counted('stack-law revert decisions', checked, 4)
  })

  test('RULED (D-1): reverting OUT of waiting clears the park fields — no reminder clock survives on a moving task', () => {
    const { state, log } = withTask('waiting') // parked on sensei
    expect(tasks.taskOf(state, '001')?.blockedOn).toBe('sensei')
    const d = tasks.decideRevert(state, '001', ORCH)
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.to).toBe('in-progress')
      const s = tasks.fold(state, log.append('task-reverted', 'task-001', d.data), ROSTER)
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
    for (const e of log.events()) state = tasks.fold(state, e, ROSTER)
    expect(tasks.taskOf(state, '001')?.status).toBe('in-progress')
  })

  test('Q-1 RULED: starting an unassigned task assigns the queue as agent ONLY when the queue is a roster member', () => {
    const { state } = withTask('in-progress') // queue = WORKER_A, in ROSTER
    expect(tasks.taskOf(state, '001')?.agent).toBe(WORKER_A)
  })

  test('Q-1 RULED: a non-roster queue never becomes an owner — the task stays unowned (never invent an acker)', () => {
    const { log } = world()
    log.append('task-created', 'task-002', { title: 'someday item', description: '', queue: 'someday', actor: ORCH })
    log.append('task-status', 'task-002', { from: 'todo', to: 'in-progress', actor: ORCH })
    let s = tasks.initial()
    for (const e of log.events()) s = tasks.fold(s, e, ROSTER)
    const t = tasks.taskOf(s, '002')
    expect(t?.status).toBe('in-progress')
    expect(t?.agent).toBeUndefined() // unowned: its events resolve per the table (unassigned → history)
  })

  test('a duplicate task-created for an existing id is ignored — first wins, replay never doubles a task (084 report, gap 4)', () => {
    const { state, log } = withTask('in-progress')
    const s = tasks.fold(
      state,
      log.append('task-created', 'task-001', { title: 'impostor', description: '', queue: 'other-q', actor: ORCH }),
      ROSTER,
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
      ROSTER,
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

  test('nextTaskId is sequential and zero-padded; openTaskCount reads the board', () => {
    const { state } = withTask('in-progress')
    expect(tasks.nextTaskId(state)).toBe('002')
    expect(tasks.openTaskCount(state, WORKER_A)).toBe(1)
    expect(tasks.openTaskCount(state, ORCH)).toBe(0)
  })
})

describe('SUBSCRIPTIONS (A-SUB) — red against the pre-subscriber implementation, naming the D-side', () => {
  const withSubs = () => {
    const { log } = world()
    log.append('task-created', 'task-001', { title: 't', description: '', queue: WORKER_A, actor: ORCH })
    let s = tasks.initial()
    for (const e of log.events()) s = tasks.fold(s, e, ROSTER, ORCH)
    return { s, log }
  }

  test('the four members exist — the member-level red-by-absence naming the subscriber D-task', () => {
    expect(typeof tasks.subscribersOf).toBe('function')
    expect(typeof tasks.autoSubscriptionsFor).toBe('function')
    expect(typeof tasks.decideSubscribe).toBe('function')
    expect(typeof tasks.decideUnsubscribe).toBe('function')
  })

  test('MIGRATION: an old log with ZERO subscription events derives owner + orchestrator — resolves exactly as today', () => {
    const { s } = withSubs()
    const subs = [...(tasks.subscribersOf?.(s, '001') ?? [])].sort()
    expect(subs).toEqual([ORCH, WORKER_A].sort())
  })

  test('the automatic surface, stated once: creation yields owner-if-roster + orchestrator; a non-roster queue yields orchestrator only', () => {
    const { log } = world()
    const created = log.append('task-created', 'task-002', {
      title: 'x',
      description: '',
      queue: 'someday',
      actor: ORCH,
    })
    const auto = tasks.autoSubscriptionsFor?.(created, ROSTER, ORCH) ?? []
    expect(auto.map((a) => a.data.agent)).toEqual([ORCH]) // never invent an acker
    expect(auto.every((a) => a.data.actor === 'infra')).toBe(true) // written BY infra, as data
    const owned = log.append('task-created', 'task-003', { title: 'y', description: '', queue: WORKER_A, actor: ORCH })
    const auto2 = (tasks.autoSubscriptionsFor?.(owned, ROSTER, ORCH) ?? []).map((a) => a.data.agent).sort()
    expect(auto2).toEqual([ORCH, WORKER_A].sort())
  })

  test('reassignment subscribes the NEW owner and never unsubscribes the previous one', () => {
    const { s, log } = withSubs()
    const roster = (n: string) => n === WORKER_A || n === ORCH || n === 'worker-b'
    // THE TASK IS STARTED FIRST (D-SUB report, gap 1): without this line the
    // "previous owner" was only queue-derived — task.agent undefined — and an
    // implementation auto-unsubscribing the REAL previous owner passed. Same
    // shape as blockedSince: the indirect-state cluster.
    const started = tasks.fold(
      s,
      log.append('task-status', 'task-001', { from: 'todo', to: 'in-progress', actor: ORCH }),
      roster,
      ORCH,
    )
    expect(tasks.taskOf(started, '001')?.agent).toBe(WORKER_A) // the previous owner is REAL now
    const reassign = log.append('task-updated', 'task-001', { agent: 'worker-b', actor: ORCH })
    const auto = (tasks.autoSubscriptionsFor?.(reassign, roster, ORCH) ?? []).map((a) => a.data.agent)
    expect(auto).toEqual(['worker-b'])
    const after = tasks.fold(started, reassign, roster, ORCH)
    const subs = [...(tasks.subscribersOf?.(after, '001') ?? [])].sort()
    expect(subs).toEqual([ORCH, WORKER_A, 'worker-b'].sort()) // the previous owner KEEPS its subscription
  })

  test('RULED (097): provenance tolerance — a subscription with a valid agent but MISSING actor still subscribes', () => {
    // Typed tolerance governs EFFECT-DETERMINING fields (who is subscribed);
    // actor is provenance — a log with imperfect provenance is still a log
    // of what happened, and dropping a real subscription over a missing
    // actor would under-deliver mail. The WRITER'S obligation (vocabulary
    // types actor required) is unchanged; the fold tolerates history.
    const { s, log } = withSubs()
    const roster3 = (n: string) => ROSTER(n) || n === 'worker-b'
    const noActor = log.appendRaw('task-subscribed', 'task-001', { agent: 'worker-b' })
    const after = tasks.fold(s, noActor, roster3, ORCH)
    expect([...(tasks.subscribersOf?.(after, '001') ?? [])].sort()).toEqual([ORCH, WORKER_A, 'worker-b'].sort())
  })

  test('PINNED AS DELIBERATE (097): a seat handover does not move old subscriptions — the documented migration edge', () => {
    const { s, log } = withSubs() // created under ORCH
    // A new orchestrator takes the seat. The discriminating event is a
    // REASSIGNMENT under the new seat (codex pass, 097): the derivation runs
    // for it — the new OWNER subscribes — but the orchestrator rule fires at
    // CREATION only, so the new seat must NOT ride in. The explicit
    // subscribe operation is the remedy, not an automatic rule.
    const roster3 = (n: string) => ROSTER(n) || n === 'worker-b' || n === 'orchestrator-two'
    const reassigned = log.append('task-updated', 'task-001', { agent: 'worker-b', actor: 'orchestrator-two' })
    const after = tasks.fold(s, reassigned, roster3, 'orchestrator-two')
    const subs = [...(tasks.subscribersOf?.(after, '001') ?? [])].sort()
    expect(subs).toEqual([ORCH, WORKER_A, 'worker-b'].sort()) // creation-time seat kept; the NEW seat not auto-added
  })

  test('R10 at the fold boundary (097): orchestratorAt undefined means NO SEAT ON RECORD — owner-only subscription, never a fallback', () => {
    const { log } = world()
    const created = log.append('task-created', 'task-009', {
      title: 'b',
      description: '',
      queue: WORKER_A,
      actor: ORCH,
    })
    const auto = (tasks.autoSubscriptionsFor?.(created, ROSTER, undefined) ?? []).map((a) => a.data.agent)
    expect(auto).toEqual([WORKER_A]) // the between-boot state: empty seat is honest; a composer HAVING a seat and omitting it violates R10
    let s = tasks.initial()
    s = tasks.fold(s, created, ROSTER, undefined)
    expect(tasks.subscribersOf?.(s, '009')).toEqual([WORKER_A])
  })

  test('malformed unsubscribes fold to nothing: bad agent, and a well-shaped unsubscribe of a NON-subscriber (097)', () => {
    const { s, log } = withSubs()
    const badAgent = tasks.fold(
      s,
      log.appendRaw('task-unsubscribed', 'task-001', { agent: 42, actor: 'x' }),
      ROSTER,
      ORCH,
    )
    expect([...(tasks.subscribersOf?.(badAgent, '001') ?? [])].sort()).toEqual([ORCH, WORKER_A].sort())
    const phantom = tasks.fold(
      s,
      log.appendRaw('task-unsubscribed', 'task-001', { agent: 'worker-b', actor: 'worker-b' }),
      ROSTER,
      ORCH,
    )
    expect([...(tasks.subscribersOf?.(phantom, '001') ?? [])].sort()).toEqual([ORCH, WORKER_A].sort())
  })

  test('explicit subscribe: roster-only (constraint 3), unknown tasks refuse, duplicates refuse so no no-op event is appended', () => {
    const { s, log } = withSubs()
    const outsider = tasks.decideSubscribe?.(
      s,
      { taskId: '001', agent: 'not-on-roster', actor: 'not-on-roster' },
      ROSTER,
    )
    expect(outsider?.ok).toBe(false)
    if (outsider && !outsider.ok)
      expect(outsider.refusal).toEqual({ kind: 'not-a-mailbox-holder', name: 'not-on-roster' })
    const missing = tasks.decideSubscribe?.(s, { taskId: '404', agent: WORKER_A, actor: WORKER_A }, ROSTER)
    expect(missing?.ok).toBe(false)
    const dup = tasks.decideSubscribe?.(s, { taskId: '001', agent: WORKER_A, actor: WORKER_A }, ROSTER)
    expect(dup?.ok).toBe(false)
    if (dup && !dup.ok) expect(dup.refusal).toEqual({ kind: 'already-subscribed' })
    // A legitimate third subscriber decides ok and folds in.
    const roster3 = (n: string) => ROSTER(n) || n === 'worker-b'
    const third = tasks.decideSubscribe?.(s, { taskId: '001', agent: 'worker-b', actor: 'worker-b' }, roster3)
    expect(third?.ok).toBe(true)
    if (third?.ok) {
      const after = tasks.fold(s, log.append('task-subscribed', 'task-001', third.data), roster3, ORCH)
      expect([...(tasks.subscribersOf?.(after, '001') ?? [])].sort()).toEqual([ORCH, WORKER_A, 'worker-b'].sort())
    }
  })

  test('explicit unsubscribe: a subscriber may drop out; a non-subscriber refuses; the set reflects it', () => {
    const { s, log } = withSubs()
    const drop = tasks.decideUnsubscribe?.(s, { taskId: '001', agent: WORKER_A, actor: WORKER_A })
    expect(drop?.ok).toBe(true)
    if (drop?.ok) {
      const after = tasks.fold(s, log.append('task-unsubscribed', 'task-001', drop.data), ROSTER, ORCH)
      expect(tasks.subscribersOf?.(after, '001')).toEqual([ORCH])
    }
    const stranger = tasks.decideUnsubscribe?.(s, { taskId: '001', agent: 'worker-b', actor: 'worker-b' })
    expect(stranger?.ok).toBe(false)
    if (stranger && !stranger.ok) expect(stranger.refusal).toEqual({ kind: 'not-subscribed' })
  })

  test('replay tolerance: duplicate subscription events dedupe (a set, not a list); malformed ones fold to nothing', () => {
    const { s, log } = withSubs()
    let after = tasks.fold(
      s,
      log.appendRaw('task-subscribed', 'task-001', { agent: WORKER_A, actor: 'infra' }),
      ROSTER,
      ORCH,
    )
    after = tasks.fold(
      after,
      log.appendRaw('task-subscribed', 'task-001', { agent: WORKER_A, actor: 'infra' }),
      ROSTER,
      ORCH,
    )
    expect([...(tasks.subscribersOf?.(after, '001') ?? [])].sort()).toEqual([ORCH, WORKER_A].sort())
    const mangled = tasks.fold(after, log.appendRaw('task-subscribed', 'task-001', { agent: 42 }), ROSTER, ORCH)
    expect([...(tasks.subscribersOf?.(mangled, '001') ?? [])].sort()).toEqual([ORCH, WORKER_A].sort())
  })

  test('CONSTRAINT 3 AT THE FOLD: a WELL-SHAPED subscription event naming a non-roster agent folds to nothing (codex pass, 092)', () => {
    // The decision gate refuses polite callers; this gate stops a rogue or
    // buggy WRITER — without it, a valid-looking event would mint a
    // subscriber with no mailbox, and never-invent-an-acker would hold only
    // by convention.
    const { s, log } = withSubs()
    const rogue = log.appendRaw('task-subscribed', 'task-001', { agent: 'not-on-roster', actor: 'infra' })
    const after = tasks.fold(s, rogue, ROSTER, ORCH)
    expect([...(tasks.subscribersOf?.(after, '001') ?? [])].sort()).toEqual([ORCH, WORKER_A].sort())
  })
})

describe('the supervision load — the pinned held-work predicate (ruled, task 115)', () => {
  test('RED BY ABSENCE until the 115 D-side lands: supervisionLoadOf exists and answers the ruled predicate', () => {
    // Member-level red-by-absence, the A-SUB pattern: the contract carries
    // the member optionally one round; this asserts its presence so the
    // absence is loud and names its implementor.
    expect(
      tasks.supervisionLoadOf,
      'tasks.supervisionLoadOf is missing — task 115’s D-side implements the pinned predicate; nothing else may',
    ).toBeDefined()
    if (!tasks.supervisionLoadOf) throw new Error('unreachable')

    // The clock is HELD, not anonymous: every event otherwise carries one
    // identical `ts`, and a floor that must be the NEWEST of several claims
    // cannot be told from the oldest when they all coincide.
    const clock = createClock()
    const log = createLog(clock)
    let s = tasks.initial()
    // worker-a: one task parked (waiting), one merely assigned — the two
    // statuses the shakedown's probe loop wrongly counted as engagement.
    s = tasks.fold(
      s,
      log.append('task-created', 'task-201', { title: 'parked', description: '', queue: WORKER_A, actor: ORCH }),
      ROSTER,
      ORCH,
    )
    s = tasks.fold(
      s,
      // `from: 'todo'` — creation folds to `todo`, never to `assigned`. The
      // fold reads only `to`, so a false `from` folds the same and models an
      // edge the board cannot take.
      log.append('task-status', 'task-201', { from: 'todo', to: 'in-progress', actor: WORKER_A }),
      ROSTER,
      ORCH,
    )
    s = tasks.fold(
      s,
      log.append('task-status', 'task-201', {
        from: 'in-progress',
        to: 'waiting',
        actor: WORKER_A,
        blockedOn: 'external',
      }),
      ROSTER,
      ORCH,
    )
    s = tasks.fold(
      s,
      log.append('task-created', 'task-202', { title: 'queued', description: '', queue: WORKER_A, actor: ORCH }),
      ROSTER,
      ORCH,
    )
    // AND ASSIGNED — the status the floor below reads. Creation alone leaves a
    // task `todo`, which is nobody's claim: it would give this walk a parked
    // task and nothing else, and the floor assertion would then pass only for
    // an implementation that counted the parked one, which is the bug.
    s = tasks.fold(
      s,
      log.append('task-status', 'task-202', { from: 'todo', to: 'assigned', actor: ORCH }),
      ROSTER,
      ORCH,
    )

    const parkedLoad = tasks.supervisionLoadOf(s, WORKER_A)
    expect(parkedLoad.engaged).toBe(false) // waiting + assigned: on NO clock
    expect(parkedLoad.holdsUndone).toBe(true) // …but not idle-empty either
    // The disconnected floor comes from the STALLING claim only — the
    // assigned task's updatedAt, never the parked one's.
    expect(parkedLoad.newestStallingClaim).toBe(tasks.taskOf(s, '202')?.updatedAt)

    // THE NEWEST stalling claim, not merely one of them. A floor taken from
    // the older claim measures silence that already elapsed, which is the
    // premature-verdict direction this whole ruling exists to close.
    clock.advance(60_000)
    s = tasks.fold(
      s,
      log.append('task-created', 'task-204', { title: 'newer', description: '', queue: WORKER_A, actor: ORCH }),
      ROSTER,
      ORCH,
    )
    s = tasks.fold(
      s,
      log.append('task-status', 'task-204', { from: 'todo', to: 'assigned', actor: ORCH }),
      ROSTER,
      ORCH,
    )
    const twoClaims = tasks.supervisionLoadOf(s, WORKER_A)
    expect(twoClaims.newestStallingClaim).toBe(tasks.taskOf(s, '204')?.updatedAt)

    // A holder of NOTHING BUT PARKED WORK — the shakedown's own agent, and
    // the case the ruling is about. Not on the stuck clock, not idle-empty,
    // and NO floor: a parked claim cannot put its disconnected holder in the
    // supervision view. Asserted as the whole object, so a `waiting` task
    // leaking into the stalling set fails here rather than passing quietly
    // on a walk whose other agent supplies a floor anyway.
    s = tasks.fold(
      s,
      log.append('task-created', 'task-205', { title: 'only parked', description: '', queue: 'worker-c', actor: ORCH }),
      ROSTER,
      ORCH,
    )
    s = tasks.fold(
      s,
      log.append('task-status', 'task-205', { from: 'todo', to: 'in-progress', actor: 'worker-c' }),
      ROSTER,
      ORCH,
    )
    s = tasks.fold(
      s,
      log.append('task-status', 'task-205', {
        from: 'in-progress',
        to: 'waiting',
        actor: 'worker-c',
        blockedOn: 'human',
      }),
      ROSTER,
      ORCH,
    )
    expect(tasks.supervisionLoadOf(s, 'worker-c')).toEqual({
      engaged: false,
      engagedTaskIds: [],
      holdsUndone: true,
      holdsStalling: false,
    })

    // AN UNREADABLE STAMP IS NOT EVIDENCE. Logs are permanent and hold
    // whatever past writers wrote, so a claim whose `ts` no clock produced is
    // a shape the fold must survive — and it supplies NO floor: silence is
    // measured from when it began, and this claim cannot say. The holder is
    // therefore not in the disconnected view at all, which is the honest
    // answer; flooring it at `now` would read as inclusion while resetting
    // every tick, so the row could never alarm.
    s = tasks.fold(
      s,
      log.append('task-created', 'task-206', { title: 'undated', description: '', queue: 'worker-d', actor: ORCH }),
      ROSTER,
      ORCH,
    )
    s = tasks.fold(
      s,
      {
        ...log.append('task-status', 'task-206', { from: 'todo', to: 'assigned', actor: ORCH }),
        ts: 'no clock wrote this',
      },
      ROSTER,
      ORCH,
    )
    expect(tasks.taskOf(s, '206')?.status).toBe('assigned') // the claim IS stalling…
    expect(tasks.supervisionLoadOf(s, 'worker-d')).toEqual({
      engaged: false,
      engagedTaskIds: [],
      holdsUndone: true,
      holdsStalling: true,
    }) // …and floors nothing

    // worker-b: genuinely engaged.
    s = tasks.fold(
      s,
      log.append('task-created', 'task-203', { title: 'live', description: '', queue: 'worker-b', actor: ORCH }),
      ROSTER,
      ORCH,
    )
    s = tasks.fold(
      s,
      log.append('task-status', 'task-203', { from: 'todo', to: 'in-progress', actor: 'worker-b' }),
      ROSTER,
      ORCH,
    )
    const engagedLoad = tasks.supervisionLoadOf(s, 'worker-b')
    expect(engagedLoad.engaged).toBe(true)
    expect(engagedLoad.holdsUndone).toBe(true)

    // A stranger to the board: nothing at all — and no floor, so a
    // disconnected stranger is not supervised.
    const emptyLoad = tasks.supervisionLoadOf(s, 'worker-none')
    expect(emptyLoad).toEqual({ engaged: false, engagedTaskIds: [], holdsUndone: false, holdsStalling: false })
  })

  test('`engagedTaskIds` NAMES the in-progress claims this agent OWNS (task 132)', () => {
    // THE STUCK PROBE'S PAYLOAD COMES FROM HERE. `engaged` alone tells the
    // recipient it is being asked about work and not which — the 7224/7248
    // pair, whose two probes were identical and wanted opposite answers.
    //
    // OWNER-ONLY, AND THE RELATION TO `engaged` IS ONE-WAY. `engaged` is
    // computed over `heldBy` — owner OR queue — so ids non-empty ⇒ `engaged`,
    // never the converse. The first draft of this walk pinned it two-way and
    // the builder refuted that against the live board before building: naming
    // a queue-only task would tell its recipient to park work someone else
    // owns, mid-flight. A wrong instruction is worse than the silent
    // over-count it came from.
    //
    // AND THE GAP IS NARROWER THAN "OWNER OR QUEUE" SUGGESTS — the builder's
    // sharpening, measured against the fold rather than read off the decision
    // layer. Q-1 (`tasks/index.ts:216`) makes the queue the owner at start
    // when the queue is a ROSTER member, so in the ordinary case the two
    // coincide. The gap opens only when the owner is EXPLICITLY REASSIGNED
    // AWAY — which is the 127 and 132 shape exactly. So the empty-stuck
    // sentence fires on reassignment, not on any queued task.
    //
    // THIS WALK'S OWN ROSTER, because that is the fact the gap turns on and
    // the file's module-level one covers `worker-a` alone. The first draft
    // used off-roster names, so Q-1 never fired, every task folded to
    // `agent: undefined`, and the walk asked for ids from an agent that owned
    // nothing. Same defect class as 115's fixture and the same cause: written
    // from the decision layer's shape without checking what the fold does.
    const clock = createClock()
    const log = createLog(clock)
    const CREW = (name: string) => name === ORCH || name.startsWith('crew-')
    let s = tasks.initial()
    const create = (id: string, queue: string) => {
      s = tasks.fold(
        s,
        log.append('task-created', `task-${id}`, { title: id, description: '', queue, actor: ORCH }),
        CREW,
        ORCH,
      )
    }
    const move = (id: string, to: 'in-progress' | 'waiting' | 'assigned', actor: string) => {
      s = tasks.fold(s, log.append('task-status', `task-${id}`, { from: 'todo', to, actor }), CREW, ORCH)
    }

    // THE ORDINARY CASE: a roster queue, so Q-1 makes the queue the owner and
    // the two facts coincide. Two claims, so a single-id shortcut cannot pass.
    create('301', 'crew-e')
    move('301', 'in-progress', 'crew-e')
    create('302', 'crew-e')
    move('302', 'in-progress', 'crew-e')
    // Neither of these is what the probe asks about.
    create('303', 'crew-e')
    move('303', 'waiting', 'crew-e')
    create('304', 'crew-e')
    move('304', 'assigned', ORCH)

    const load = tasks.supervisionLoadOf(s, 'crew-e')
    expect([...load.engagedTaskIds].sort()).toEqual(['301', '302'])
    expect(load.engaged).toBe(true) // ids non-empty ⇒ engaged
    expect(load.holdsUndone).toBe(true)

    // No in-progress claim, no ids — the half a wrong implementation is
    // likelier to get wrong.
    create('305', 'crew-f')
    move('305', 'waiting', 'crew-f')
    expect(tasks.supervisionLoadOf(s, 'crew-f').engagedTaskIds).toEqual([])

    // THE GAP, PINNED, AND IT TAKES A REASSIGNMENT TO OPEN IT. Created in
    // `crew-g`'s queue, then handed to `crew-h` before it starts — so Q-1
    // never fires for the queue and the owner is somebody else. `crew-g` is
    // `engaged` and owns nothing. This dojo's own board carried exactly this
    // while the contract was being written: task 132, `queue: builder`,
    // `agent: architect`, in-progress.
    create('306', 'crew-g')
    s = tasks.fold(s, log.append('task-updated', 'task-306', { agent: 'crew-h', actor: ORCH }), CREW, ORCH)
    move('306', 'in-progress', 'crew-h')
    const queueOnly = tasks.supervisionLoadOf(s, 'crew-g')
    expect(queueOnly.engaged, 'owner-or-queue is what puts the queue-holder on the clock').toBe(true)
    expect(queueOnly.engagedTaskIds, 'and owner-only is what stops it being told to park someone else’s work').toEqual(
      [],
    )
    // The owner, meanwhile, is told about exactly the task it owns.
    expect(tasks.supervisionLoadOf(s, 'crew-h').engagedTaskIds).toEqual(['306'])

    // AND THE SECOND WAY THE GAP OPENS, which this walk's own prose denied
    // until it was checked. "Only on explicit reassignment" is false: Q-1
    // also DECLINES TO FIRE when the queue is not yet a dojo agent, and then
    // `agent` stays undefined with no reassignment anywhere. Ordinary
    // boot-order — a task dispatched and started for an agent that has not
    // connected yet — and the name enters the view engaged with nothing to
    // name the moment it registers.
    //
    // Worth the walk because of HOW it was missed: the fixture above was
    // repaired using exactly this Q-1 fact, and the sentence written
    // immediately after asserted that Q-1 always closes the gap — without
    // checking the case where Q-1 does not fire, which had just bitten it.
    const ORPHAN_QUEUE = (name: string) => name === ORCH // 'crew-z' has never registered
    let early = tasks.initial()
    early = tasks.fold(
      early,
      log.append('task-created', 'task-401', { title: 'early', description: '', queue: 'crew-z', actor: ORCH }),
      ORPHAN_QUEUE,
      ORCH,
    )
    early = tasks.fold(
      early,
      log.append('task-status', 'task-401', { from: 'todo', to: 'in-progress', actor: ORCH }),
      ORPHAN_QUEUE,
      ORCH,
    )
    expect(tasks.taskOf(early, '401')?.agent, 'Q-1 declines: the queue was not a dojo agent at start').toBeUndefined()
    const notYet = tasks.supervisionLoadOf(early, 'crew-z')
    expect(notYet.engaged).toBe(true)
    expect(notYet.engagedTaskIds, 'engaged with nothing to name, and nobody reassigned anything').toEqual([])
  })
})
