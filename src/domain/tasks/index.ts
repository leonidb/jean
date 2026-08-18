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
 * ── D-5: REVERT NEVER LANDS ON `waiting` ──
 *
 * My first reading of this file offered two options and took the wrong one:
 * a revert into `waiting` cleared the park, on the grounds that this park
 * chose nothing. The ruling (task 086) found a third way, and it is better
 * than either. `waiting` REQUIRES a blocker that only its parker can supply,
 * so landing there with a cleared park manufactures the parked-on-nobody
 * state that requirement abolishes — while restoring the old park would
 * resurrect a question already answered, and refusing outright would strand
 * a mistakenly-closed parked task with no way back.
 *
 * So a revert pops PAST `waiting`, to the nearest earlier status that is
 * neither `waiting` nor the one the task is in. `done → in-progress`, with
 * the park never resurrected; a caller who wants it parked again parks it
 * explicitly, with a fresh blocker. The stack truncates to the status it
 * lands on, so its top and the task's status can never disagree.
 *
 * ── THE STATUS STACK ──
 *
 * Revert is stack-pop, not a DAG edge: `done → in-progress` is refused by
 * `canTransition` and reachable by `decideRevert`, deliberately. Creation
 * pushes `todo`; every folded status change pushes its destination; a folded
 * revert truncates back to the status it lands on. No eligible earlier status
 * — fewer than two entries, or nothing but `waiting` and the current status
 * behind it — is refused loudly rather than treated as a no-op: a silent
 * no-op reads to the caller as "reverted" when nothing moved.
 *
 * A task is created ONCE. A second `task-created` for an id already on the
 * board is ignored — first wins. Logs are permanent and get replayed, and the
 * old fold appended a second entry under the same id, which is how one task
 * became two on a re-read.
 *
 * ── Q-1 RULED: NEVER INVENT AN OWNER ──
 *
 * Starting an unassigned task makes the queue its agent ONLY when the queue
 * names a roster member, which the fold learns from the injected
 * `isRosterMember` — the same shape as the mailbox's `recipientsOf`, and for
 * the same reason: this module never imports agents. A non-roster queue
 * ('someday', 'backlog') leaves the task UNOWNED, so its events resolve as
 * history rather than piling (recipient, event) pairs into a mailbox that has
 * no reader and no acker. My D3 note asked this question; the ruling answered
 * it, and the answer is in the fold rather than in a comment.
 *
 * What this file cannot enforce, and what does: the DAG's exact edge set, the
 * gates' precedence, clear-or-replace, D-1, D-5, the roster gate and the
 * staleness boundary are held by `tasks.conformance.test.ts`.
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
  TaskSubscribedData,
  TaskUnsubscribedData,
  TaskUpdatedData,
} from '../contracts/vocabulary.ts'
import { taskIdFromStream } from '../contracts/vocabulary.ts'

// ── State ────────────────────────────────────────────────────────

/** One task plus the stack revert pops. The stack is not derivable from the
 *  task — `status` is only its top — so it is state, not a view. */
type Entry = {
  readonly task: Task
  readonly stack: readonly TaskStatus[]
  /** THE SUBSCRIBER SET — "everyone involved", as data. A set because
   *  subscribing twice is subscribing once, and because the automatic
   *  derivation and an explicit event must coincide rather than stack. */
  readonly subs: ReadonlySet<AgentName>
}

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
function settle(
  task: Task,
  to: TaskStatus,
  ts: string,
  park: Park,
  isRosterMember: (name: AgentName) => boolean,
): Task {
  const next: Task = { ...task, status: to, updatedAt: ts }
  // Q-1, RULED: starting an unassigned task makes the queue its agent ONLY if
  // the queue is somebody. A non-roster queue is a shelf, not an agent, and
  // naming it as owner would address every later task event to a mailbox with
  // no reader — pairs that can never be acked, which is the orphan class P4
  // abolishes.
  if (to === 'in-progress' && next.agent === undefined && isRosterMember(task.queue)) next.agent = task.queue
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

/**
 * THE AUTOMATIC SURFACE, STATED ONCE — and this function is what "once" means.
 *
 * Going forward the shell appends these events after the triggering one; on
 * replay the fold applies the same call to old events. That is the whole
 * migration: a log with no subscription events resolves as it always did,
 * because the derivation reconstructs the subscriptions that were implicit in
 * the old owner+orchestrator predicate. Two paths, one rule — so they cannot
 * drift, and on a new log they coincide (set semantics make the derived and the
 * written subscription the same fact).
 *
 * The surface is CLOSED, and its absences are the ruling rather than gaps.
 * Creation subscribes the queue-owner (if roster) and the orchestrator;
 * reassignment subscribes the new owner. Nothing else: commenting does not
 * subscribe, and nothing anywhere unsubscribes automatically — the previous
 * owner keeps its subscription through a reassignment, because it was involved
 * and still is. The tiebreaker for anything unruled is no automatic behaviour
 * plus an explicit operation, and that is why this list is short.
 */
const autoSubscriptionsFor = (
  event: StoredEvent,
  isRosterMember: (name: AgentName) => boolean,
  orchestratorAt: AgentName | undefined,
): readonly { taskId: string; data: TaskSubscribedData }[] => {
  const taskId = taskIdFromStream(event.stream)
  if (taskId === undefined) return []
  const data = (event.data ?? {}) as Record<string, unknown>

  // `actor: 'infra'` on every one: subscriptions are always DATA, never an
  // implicit rule resolution has to know about, and the log says who wrote
  // them.
  const subscribe = (agent: unknown): { taskId: string; data: TaskSubscribedData }[] =>
    typeof agent === 'string' && agent.length > 0 && isRosterMember(agent)
      ? [{ taskId, data: { agent, actor: 'infra' } }]
      : []

  if (event.type === 'task-created') {
    // The QUEUE, not `task.agent` — at creation there is no owner yet, and the
    // queue is who the task was dispatched to. Gated by the roster, which is
    // Q-1's never-invent-an-acker holding here too: a 'someday' shelf gets no
    // subscription, so nothing accumulates for a mailbox nobody reads.
    //
    // DEDUPED ON THE WAY OUT. The fold's set would absorb a repeat, but this
    // list is what the SHELL APPENDS: an orchestrator that queues a task to
    // itself would otherwise put two identical subscribe events in the log for
    // one subscription (codex pass, task 094). Set semantics in the state do
    // not excuse writing the same fact twice.
    const emitted = [...subscribe((data as TaskCreatedData).queue), ...subscribe(orchestratorAt)]
    const byAgent = new Map(emitted.map((e) => [e.data.agent, e]))
    return [...byAgent.values()]
  }
  if (event.type === 'task-updated') {
    // A reassignment, and only a reassignment: a description edit carries no
    // `agent` and subscribes nobody.
    return subscribe((data as TaskUpdatedData).agent)
  }
  return []
}

const fold = (
  state: TasksState,
  event: StoredEvent,
  isRosterMember: (name: AgentName) => boolean,
  orchestratorAt?: AgentName,
): TasksState => {
  const current = board(state)
  const id = taskIdFromStream(event.stream)
  if (id === undefined) return state
  const data = (event.data ?? {}) as Record<string, unknown>

  /** The automatic derivation, applied on replay. Same call the shell makes
   *  forward — see `autoSubscriptionsFor`. */
  const derived = (into: ReadonlySet<AgentName>): ReadonlySet<AgentName> => {
    const next = new Set(into)
    for (const { data: sub } of autoSubscriptionsFor(event, isRosterMember, orchestratorAt)) next.add(sub.agent)
    return next
  }

  if (event.type === 'task-created') {
    // FIRST WINS. A task is created once; a second `task-created` for an id
    // already on the board is a replay, not a new task. The old fold appended
    // a second entry under the same id, which is how a re-read doubled a
    // task — and the doubled copy would carry the impostor's title and queue
    // while the original's history stayed on the first.
    if (current.has(id)) return state
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
    // ENTERED, and it entered this one. And it seeds the subscriber set from
    // the derivation, which is what makes an old log's tasks resolve exactly as
    // they did before subscriptions existed.
    return seal(replace(current, id, { task, stack: ['todo'], subs: derived(new Set()) }))
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
          task: settle(
            entry.task,
            to,
            event.ts,
            { blockedOn: d.blockedOn, blockedNote: d.blockedNote, resumeAt: d.resumeAt },
            isRosterMember,
          ),
          stack: [...entry.stack, to],
          subs: entry.subs,
        }),
      )
    }

    case 'task-reverted': {
      const d = data as TaskRevertedData
      const to = migrate(d.to)
      // TRUNCATE TO WHERE IT LANDS, rather than popping a fixed number. D-5
      // lets a revert skip over `waiting`, so "one pop" and "back to `to`"
      // are no longer the same thing — and if the stack kept the skipped
      // entries, its top would say `waiting` while the task says
      // `in-progress`. Cutting at the nearest earlier occurrence of `to`
      // keeps top and status the same fact.
      //
      // A revert event naming a status the stack does not hold — hand-written,
      // or folded from a prefix that never saw the earlier events — REPLACES
      // the top instead of cutting: leave the status we left, record the one
      // we landed on. Popping one there looked equivalent and was not, because
      // it left the top naming a status the task is no longer in, and
      // `decideRevert` reads `from` off the stack; the next revert would then
      // report a `from` the board disagrees with (codex pass, task 088).
      // Both branches land on the same invariant, which is the only reason
      // this fold is allowed to have two: TOP ALWAYS EQUALS STATUS.
      let cut = -1
      for (let i = entry.stack.length - 2; i >= 0; i--) {
        if (entry.stack[i] === to) {
          cut = i
          break
        }
      }
      return seal(
        replace(current, id, {
          task: settle(entry.task, to, event.ts, {}, isRosterMember),
          stack: cut >= 0 ? entry.stack.slice(0, cut + 1) : [...entry.stack.slice(0, -1), to],
          subs: entry.subs,
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
          // A reassignment subscribes the new owner, and never unsubscribes the
          // previous one — `derived` only adds.
          subs: derived(entry.subs),
        }),
      )
    }

    case 'task-subscribed': {
      const d = data as TaskSubscribedData
      // CONSTRAINT 3 AT THE FOLD — the second of the two gates. The decision
      // refuses a polite caller; THIS stops a rogue or buggy writer, and it is
      // the reason never-invent-an-acker holds by construction rather than by
      // convention: a well-shaped event naming a non-roster agent would
      // otherwise mint a subscriber with no mailbox, and every later task event
      // would pile an unclearable pair into nothing.
      //
      // A malformed agent folds to nothing for the same reason it does
      // everywhere else here: the log is permanent, and a reader that trusts
      // `data.agent` to be a string is one bad writer away from a set with a
      // number in it.
      if (typeof d?.agent !== 'string' || d.agent.length === 0 || !isRosterMember(d.agent)) return state
      if (entry.subs.has(d.agent)) return state
      return seal(replace(current, id, { ...entry, subs: new Set(entry.subs).add(d.agent) }))
    }

    case 'task-unsubscribed': {
      const d = data as TaskUnsubscribedData
      // No roster gate here, deliberately: LEAVING is always allowed. A name
      // that should not have been subscribed must still be able to come out,
      // and gating the exit on the roster would trap exactly the agents a
      // roster change stranded.
      if (typeof d?.agent !== 'string' || !entry.subs.has(d.agent)) return state
      const subs = new Set(entry.subs)
      subs.delete(d.agent)
      return seal(replace(current, id, { ...entry, subs }))
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
  // THE SNOOZE LAW APPLIES HERE TOO (ruled, task 083 — my D3 report found
  // this arm missing). A handoff replaces every park field including the
  // date, so a malformed one riding into the record is the same defect as on
  // a status change: the reminder's comparison against it goes silently
  // always-true and the blocker's cadence never demotes. Same shape of
  // refusal, same reason.
  if (cmd.resumeAt !== undefined && Number.isNaN(Date.parse(cmd.resumeAt))) {
    return { ok: false, refusal: { kind: 'unparseable-resume', resumeAt: cmd.resumeAt } }
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
  const from = entry.stack[entry.stack.length - 1] as TaskStatus
  // D-5: walk BACK past anything a revert may not land on, rather than taking
  // the entry immediately below. Two are excluded, for different reasons:
  //
  //   `waiting` — it requires a blocker only its parker can supply, and this
  //   act cannot answer "who is this waiting on". Landing there would
  //   manufacture parked-on-nobody; the stack carries statuses, not park
  //   fields, so the old park cannot be restored either — and it should not
  //   be, being an answer to a question already answered.
  //
  //   `from` itself — a task can enter one status twice in a row through a
  //   legacy name that folds to the same place, and "reverting" to where you
  //   already are is a no-op wearing a success.
  //
  // Nothing eligible behind it is a refusal, not a silent no-op: the caller
  // asked to move and must learn that nothing did.
  for (let i = entry.stack.length - 2; i >= 0; i--) {
    const to = entry.stack[i] as TaskStatus
    if (to === 'waiting' || to === from) continue
    return { ok: true, from, to, data: { from, to, actor } }
  }
  return { ok: false, refusal: { kind: 'nothing-to-revert' } }
}

export const tasks: TasksContract = {
  initial: () => seal(new Map()),
  fold,

  autoSubscriptionsFor,

  /** Indirectly-visible state — nothing else returns it, which is exactly why
   *  the mutation pass aimed here. Empty for an unknown task: nobody is
   *  involved with a task that does not exist, and resolution reads that as
   *  history rather than as an error. */
  subscribersOf: (state, taskId) => [...(board(state).get(taskId)?.subs ?? [])],

  decideSubscribe: (state, cmd, isRosterMember) => {
    const entry = board(state).get(cmd.taskId)
    if (entry === undefined) return { ok: false, refusal: { kind: 'unknown-task' } }
    // CONSTRAINT 3, first gate. Named with the offending name so the caller
    // learns WHICH name was rejected — the usual case is a typo, and a bare
    // "not allowed" sends them looking at permissions instead.
    if (!isRosterMember(cmd.agent)) {
      return { ok: false, refusal: { kind: 'not-a-mailbox-holder', name: cmd.agent } }
    }
    // REFUSED rather than treated as a no-op, so the shell never appends an
    // event that changes nothing. A no-op subscription event would still cost
    // a log entry and a re-fold, and it would read to a later reader as a
    // moment when something happened.
    if (entry.subs.has(cmd.agent)) return { ok: false, refusal: { kind: 'already-subscribed' } }
    return { ok: true, data: { agent: cmd.agent, actor: cmd.actor } }
  },

  decideUnsubscribe: (state, cmd) => {
    const entry = board(state).get(cmd.taskId)
    if (entry === undefined) return { ok: false, refusal: { kind: 'unknown-task' } }
    // Same no-op argument as above, mirrored: dropping out of something you
    // are not in changes nothing, so it is refused rather than recorded.
    if (!entry.subs.has(cmd.agent)) return { ok: false, refusal: { kind: 'not-subscribed' } }
    return { ok: true, data: { agent: cmd.agent, actor: cmd.actor } }
  },

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
      // forever (codex pass, task 084 — extracted from the old availability
      // helper, which reads `t.agent === name` and calls itself exactly this).
      //
      // Since Q-1 an in-progress task may have NO owner at all — a non-roster
      // queue never becomes one — and that is counted for nobody, correctly:
      // an unowned task occupies no agent's capacity. Falling back to the
      // queue there would make a shelf name look like a busy worker.
      if (task.status === 'in-progress' && task.agent === agent) count++
    }
    return count
  },
}
