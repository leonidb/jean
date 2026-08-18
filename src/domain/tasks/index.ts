/**
 * Tasks — lifecycle, gates, parking, revert, staleness (contract
 * `contracts/tasks.ts`, task D3).
 *
 * ── TWO GATES, KEPT APART ──
 *
 * `canTransition` is the DAG: is this move legal at all. `actorMayTransition`
 * is the role gate: may a caller of this role make it. They are separate
 * exports because they answer separate questions and the contract asks them
 * separately — `decideStatus` is where both are applied, in that order, so a
 * refusal names the reason a caller can act on. A worker told
 * `illegal-transition` when the truth is `actor-forbidden` goes looking for a
 * bug in the board instead of asking the orchestrator to close the task.
 *
 * ── PARK FIELDS ARE CLEAR-OR-REPLACE, IN ONE PLACE ──
 *
 * Every status change routes through `settle`, and `settle` has exactly two
 * branches: entering `waiting` writes the four park fields from THIS park's
 * data (absent means absent — never inherited), and every other destination
 * clears all four. There is no third branch and no conditional write, which is
 * what makes "never sticky" true by construction rather than by four
 * agreeing call sites.
 *
 * This is also why REVERT shares the function. The contract's ruling D-1 —
 * reverting out of `waiting` clears the park exactly as a forward unpark does
 * — is not a rule this file applies to reverts; it is what happens when
 * reverts go through the same door. The old fold gave `task-reverted` its own
 * status-only update, which is precisely how it ended up contradicting its own
 * clear-or-replace law and leaving a reverted task nagging for a blocker it
 * no longer had.
 *
 * A revert whose destination IS `waiting` therefore clears the park too: this
 * park chose nothing, so nothing is what it gets. The alternative — restoring
 * the park the task had the last time it was there — would need history the
 * stack does not carry, and inventing it is how sticky fields come back.
 *
 * ── THE STATUS STACK ──
 *
 * Revert is stack-pop, not a DAG edge: `done → in-progress` is refused by
 * `canTransition` and reachable by `decideRevert`, deliberately. Creation
 * pushes `todo`; every folded status change pushes its destination; a folded
 * revert pops one. Fewer than two entries means there is nowhere to pop back
 * to, and that is refused loudly rather than treated as a no-op — a silent
 * no-op here reads to the caller as "reverted" when nothing moved.
 *
 * ── WHAT IS EXTRACTED AS-IS, AND FLAGGED ──
 *
 * Starting a task with no agent assigns the QUEUE as the agent. Extracted
 * from the old fold unchanged, per the contract, and it is the contract's
 * OPEN Q-1: if a queue name is not a roster name, the owner it produces is an
 * agent nobody registered, and resolution will address task events to a
 * mailbox nobody reads. Implemented as written; not worked around.
 *
 * What this file cannot enforce, and what does: the DAG's exact edge set, the
 * gates' precedence, clear-or-replace, D-1, and the staleness boundary are
 * held by `tasks.conformance.test.ts`.
 */

import type {
  HandoffCommand,
  HandoffDecision,
  RevertDecision,
  StatusCommand,
  StatusDecision,
  Task,
  TaskStatus,
  TasksContract,
  TasksState,
} from '../contracts/tasks.ts'
import type {
  AgentName,
  AgentRole,
  BlockedOn,
  StoredEvent,
  TaskBlockedData,
  TaskCreatedData,
  TaskRevertedData,
  TaskStatusData,
  TaskUpdatedData,
} from '../contracts/vocabulary.ts'
import { taskIdFromStream } from '../contracts/vocabulary.ts'

// ── State ────────────────────────────────────────────────────────

/** One task plus the stack revert pops. The stack is not derivable from the
 *  task — `status` is only its top — so it is state, not a view. */
type Entry = { readonly task: Task; readonly stack: readonly TaskStatus[] }

/** Keyed by task id; insertion order is creation order, which is the order
 *  `all` reports and `nextTaskId` counts. */
type Board = ReadonlyMap<string, Entry>

function board(state: TasksState): Board {
  return state as unknown as Board
}
function seal(next: Board): TasksState {
  return next as unknown as TasksState
}

// ── The lifecycle ────────────────────────────────────────────────

/**
 * Legacy status names real logs hold. The fold must read them permanently:
 * a dojo's log is its state, and a reader that chokes on a name it used to
 * write is a migration nobody asked for. `review` folds to `waiting` — it was
 * a parked state awaiting a human, which is what `waiting` means now.
 */
const LEGACY: Record<string, TaskStatus> = {
  inbox: 'todo',
  active: 'in-progress',
  blocked: 'waiting',
  review: 'waiting',
}

function migrate(status: string): TaskStatus {
  return LEGACY[status] ?? (status as TaskStatus)
}

/**
 * THE DAG, as the exact edge set. Deliberate absences, each extracted as
 * intent rather than as an oversight:
 *  - no `todo → waiting` and no `assigned → waiting`: parking presumes
 *    engagement, and a task nobody started has nobody to be blocked on;
 *  - no exits from `done` or `cancelled`: terminal means terminal, and the
 *    way back is revert, which is not a DAG edge;
 *  - no `waiting → assigned`: un-parking returns to the work, not to the
 *    queue.
 */
const EDGES: ReadonlyMap<TaskStatus, ReadonlySet<TaskStatus>> = new Map([
  ['todo', new Set<TaskStatus>(['assigned', 'in-progress', 'cancelled'])],
  ['assigned', new Set<TaskStatus>(['in-progress', 'cancelled'])],
  ['in-progress', new Set<TaskStatus>(['waiting', 'done', 'cancelled'])],
  ['waiting', new Set<TaskStatus>(['in-progress', 'done', 'cancelled'])],
  ['done', new Set<TaskStatus>()],
  ['cancelled', new Set<TaskStatus>()],
])

const canTransition = (from: TaskStatus, to: TaskStatus): boolean => EDGES.get(from)?.has(to) === true

/**
 * The role gate. A worker's ONLY permitted move is parking the task it is
 * working on — workers cannot close, cancel, assign or start tasks, because
 * status is orchestrator-owned and single-writer. Every other role is ungated
 * here; the DAG is still the other half.
 */
const actorMayTransition = (role: AgentRole, from: TaskStatus, to: TaskStatus): boolean =>
  role === 'worker' ? from === 'in-progress' && to === 'waiting' : true

/**
 * Whose role counts. The registry wins outright — it is the dojo's own record
 * of who this is. An unregistered caller's CLAIM counts only when it claims
 * `worker`, and the asymmetry is the point in both directions: a worker
 * cannot escape its one restriction by omitting its role, and nobody acquires
 * the orchestrator's powers by asserting them.
 *
 * Unresolvable is UNGATED, deliberately: that caller is the human's own
 * tooling (`jean task …`), and infra does not gate the human.
 */
const resolveActorRole = (claimed: AgentRole | undefined, registered: AgentRole | undefined): AgentRole | undefined =>
  registered ?? (claimed === 'worker' ? 'worker' : undefined)

// ── The fold ─────────────────────────────────────────────────────

/** What a park writes. Absent fields are absent, not inherited. */
type Park = { blockedOn?: BlockedOn; blockedNote?: string; resumeAt?: string }

/**
 * THE ONE DOOR every status change goes through — forward or reverted.
 * Entering `waiting` writes this park's four fields; every other destination
 * clears all four. Two branches, no conditionals inside them: that is
 * clear-or-replace as a shape rather than as a rule four call sites remember.
 */
function settle(task: Task, to: TaskStatus, ts: string, park: Park): Task {
  const next: Task = { ...task, status: to, updatedAt: ts }
  // Starting an unassigned task makes the queue its agent. Extracted as-is —
  // see the header on OPEN Q-1.
  if (to === 'in-progress' && next.agent === undefined) next.agent = task.queue
  if (to === 'waiting') {
    next.blockedOn = park.blockedOn
    next.blockedNote = park.blockedNote
    next.resumeAt = park.resumeAt
    // `blockedSince` dates the CURRENT holder's claim, so it is stamped only
    // when there is a holder; per-item age measures from here, never from
    // the task's creation.
    next.blockedSince = park.blockedOn === undefined ? undefined : ts
  } else {
    next.blockedOn = undefined
    next.blockedNote = undefined
    next.resumeAt = undefined
    next.blockedSince = undefined
  }
  return next
}

/**
 * The one place an entry is stored — and where its task is FROZEN.
 *
 * `all` and `taskOf` hand back the state's own task objects, so without this a
 * caller could edit one in place and change the board through a read. The
 * contract says the state is "evolved by `fold`" and read through its
 * functions; freezing is that sentence enforced rather than trusted (codex
 * pass, task 084). Shallow is enough — a `Task` is all primitives — and
 * spreading a frozen object is unaffected, so only the mutation this forbids
 * is forbidden.
 */
function replace(current: Board, id: string, entry: Entry): Board {
  const next = new Map(current)
  next.set(id, { ...entry, task: Object.freeze(entry.task) })
  return next
}

const fold = (state: TasksState, event: StoredEvent): TasksState => {
  const current = board(state)
  const id = taskIdFromStream(event.stream)
  if (id === undefined) return state
  const data = (event.data ?? {}) as Record<string, unknown>

  if (event.type === 'task-created') {
    const d = data as TaskCreatedData
    const task: Task = {
      id,
      title: d.title,
      description: d.description,
      status: 'todo',
      queue: d.queue,
      playbook: d.playbook,
      createdAt: event.ts,
      updatedAt: event.ts,
    }
    // Creation pushes `todo`: the stack is the task's history of statuses
    // ENTERED, and it entered this one.
    return seal(replace(current, id, { task, stack: ['todo'] }))
  }

  const entry = current.get(id)
  // An event for a task this fold never saw created. Ignored rather than
  // invented: a partial log prefix is a normal thing to fold.
  if (entry === undefined) return state

  switch (event.type) {
    case 'task-status': {
      const d = data as TaskStatusData
      const to = migrate(d.to)
      return seal(
        replace(current, id, {
          task: settle(entry.task, to, event.ts, {
            blockedOn: d.blockedOn,
            blockedNote: d.blockedNote,
            resumeAt: d.resumeAt,
          }),
          stack: [...entry.stack, to],
        }),
      )
    }

    case 'task-reverted': {
      const d = data as TaskRevertedData
      const to = migrate(d.to)
      // Pop one. `slice(0, -1)` on a single-entry stack yields an empty one,
      // which `decideRevert` then reports as nothing to revert — the refusal
      // and the fold agree without either checking the other.
      return seal(
        replace(current, id, {
          task: settle(entry.task, to, event.ts, {}),
          stack: entry.stack.slice(0, -1),
        }),
      )
    }

    case 'task-blocked': {
      // The historical handoff kind, and canon 8's act. A FULL park
      // replacement: a note left from the previous blocker describes a
      // question that has already been answered, and a snooze left from a
      // previous park would demote this one to a daily cadence on a date
      // nobody chose for it. Status is untouched — a handoff moves the
      // blocker, not the task.
      const d = data as TaskBlockedData
      return seal(
        replace(current, id, {
          ...entry,
          task: {
            ...entry.task,
            blockedOn: d.blockedOn,
            blockedNote: d.note,
            blockedSince: event.ts,
            resumeAt: d.resumeAt,
            updatedAt: event.ts,
          },
        }),
      )
    }

    case 'task-updated': {
      const d = data as TaskUpdatedData
      return seal(
        replace(current, id, {
          ...entry,
          task: {
            ...entry.task,
            ...(d.agent !== undefined && { agent: d.agent }),
            ...(d.description !== undefined && { description: d.description }),
            updatedAt: event.ts,
          },
        }),
      )
    }

    default:
      // Comments, replies, reminders — traffic on the task's stream that says
      // nothing about the task's own fields. Staleness reads that traffic,
      // but it reads it from the caller's activity fact, not from here.
      return state
  }
}

// ── Queries ──────────────────────────────────────────────────────

/** Owner OR queue. A task dispatched to a queue and not yet started has no
 *  agent, and the queue is the only name that says who holds it. */
function heldBy(task: Task, agent: AgentName): boolean {
  return task.agent === agent || task.queue === agent
}

/** The statuses that mean an agent is engaged. `waiting` counts: a parked
 *  task is still that agent's, which is exactly why it is being nagged. */
const ENGAGED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['in-progress', 'waiting'])

// ── Decisions ────────────────────────────────────────────────────

const decideStatus = (state: TasksState, cmd: StatusCommand): StatusDecision => {
  const entry = board(state).get(cmd.taskId)
  if (entry === undefined) return { ok: false, refusal: { kind: 'unknown-task' } }
  const from = entry.task.status

  // ORDER IS THE MESSAGE. The DAG first (is this move a thing at all), then
  // the role (may you make it), then the park's own validity. A caller told
  // the first reason that applies can act on it.
  if (!canTransition(from, cmd.to)) {
    return { ok: false, refusal: { kind: 'illegal-transition', from, to: cmd.to } }
  }
  if (cmd.actorRole !== undefined && !actorMayTransition(cmd.actorRole, from, cmd.to)) {
    return { ok: false, refusal: { kind: 'actor-forbidden', actorRole: cmd.actorRole, from, to: cmd.to } }
  }
  if (cmd.to === 'waiting' && cmd.blockedOn === undefined) {
    return { ok: false, refusal: { kind: 'blocker-required' } }
  }
  // A snooze that cannot be parsed is refused rather than dropped. Dropping
  // it silently is the September bug: a date the caller believes is set,
  // which no clock ever reads, so the reminder never demotes.
  if (cmd.resumeAt !== undefined && Number.isNaN(Date.parse(cmd.resumeAt))) {
    return { ok: false, refusal: { kind: 'unparseable-resume', resumeAt: cmd.resumeAt } }
  }

  return {
    ok: true,
    data: {
      from,
      to: cmd.to,
      actor: cmd.actor,
      ...(cmd.actorRole !== undefined && { actorRole: cmd.actorRole }),
      ...(cmd.blockedOn !== undefined && { blockedOn: cmd.blockedOn }),
      ...(cmd.blockedNote !== undefined && { blockedNote: cmd.blockedNote }),
      ...(cmd.resumeAt !== undefined && { resumeAt: cmd.resumeAt }),
    },
  }
}

const decideHandoff = (state: TasksState, cmd: HandoffCommand): HandoffDecision => {
  const entry = board(state).get(cmd.taskId)
  if (entry === undefined) return { ok: false, refusal: { kind: 'unknown-task' } }
  // A handoff moves a blocker, so there must be one to move.
  if (entry.task.status !== 'waiting') {
    return { ok: false, refusal: { kind: 'not-waiting', status: entry.task.status } }
  }
  // NO CYCLE GUARD, deliberately. Handing a blocker back to where it came
  // from is a re-escalation carrying new information, and infra cannot see
  // whether information arrived — anti-ping-pong is orchestrator judgement,
  // and a guard here would refuse the legitimate case to prevent a case infra
  // cannot recognise.
  return {
    ok: true,
    data: {
      blockedOn: cmd.blockedOn,
      ...(cmd.note !== undefined && { note: cmd.note }),
      actor: cmd.actor,
      ...(cmd.resumeAt !== undefined && { resumeAt: cmd.resumeAt }),
    },
  }
}

const decideRevert = (state: TasksState, taskId: string, actor: string): RevertDecision => {
  const entry = board(state).get(taskId)
  if (entry === undefined) return { ok: false, refusal: { kind: 'unknown-task' } }
  // Two entries minimum: the one the task is in, and the one to pop back to.
  if (entry.stack.length < 2) return { ok: false, refusal: { kind: 'nothing-to-revert' } }
  const from = entry.stack[entry.stack.length - 1] as TaskStatus
  const to = entry.stack[entry.stack.length - 2] as TaskStatus
  return { ok: true, from, to, data: { from, to, actor } }
}

export const tasks: TasksContract = {
  initial: () => seal(new Map()),
  fold,

  all: (state) => [...board(state).values()].map((e) => e.task),

  taskOf: (state, id) => board(state).get(id)?.task,

  activeTaskOf: (state, agent) =>
    [...board(state).values()].map((e) => e.task).find((t) => ENGAGED.has(t.status) && heldBy(t, agent)),

  nextTaskId: (state) => {
    let highest = 0
    for (const id of board(state).keys()) {
      const n = Number.parseInt(id, 10)
      if (Number.isFinite(n) && n > highest) highest = n
    }
    // Derived from the board, never random: ids are read aloud and typed by
    // humans, and a sequence is the only thing that makes "task 84" a name.
    return String(highest + 1).padStart(3, '0')
  },

  canTransition,
  actorMayTransition,
  resolveActorRole,

  decideStatus,
  decideHandoff,
  decideRevert,

  staleTasks: (state, now, staleAfterMs, lastEventAt) => {
    const stale: string[] = []
    for (const { task } of board(state).values()) {
      // ONLY `in-progress`. A parked task is silent because it is waiting on
      // somebody — reporting it stale would turn the blocker's own cadence
      // into a second alarm for the same fact.
      if (task.status !== 'in-progress') continue
      const last = lastEventAt(task.id) ?? Date.parse(task.updatedAt)
      // `>=`: a task exactly at the bound is stale. The boundary belongs on
      // this side so that a bound of zero means "everything is stale" rather
      // than "nothing ever is".
      if (now - last >= staleAfterMs) stale.push(task.id)
    }
    return stale
  },

  openTaskCount: (state, agent) => {
    let count = 0
    for (const { task } of board(state).values()) {
      // OWNER ONLY — deliberately narrower than `activeTaskOf`'s owner-or-queue.
      // This is the dispatchability signal, and the queue is where a task
      // STARTED, not who holds it now: a task created in one agent's queue and
      // later reassigned would otherwise keep the original agent looking busy
      // forever. An in-progress task always has an owner (starting one assigns
      // the queue as agent), so nothing is missed by not falling back
      // (codex pass, task 084 — extracted from the old availability helper,
      // which reads `t.agent === name` and calls itself exactly this).
      if (task.status === 'in-progress' && task.agent === agent) count++
    }
    return count
  },
}
