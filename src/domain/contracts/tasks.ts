/**
 * The tasks contract — lifecycle, gates, parking, revert, staleness
 * (design §3/§4; canon Task flow 7–10 as requirement input; old code read
 * under §8's extraction discipline: deliberate behaviour extracted,
 * accidents left behind, the calls recorded in task 082's report).
 *
 * ── THE LIFECYCLE ──
 *
 * `todo → assigned → in-progress → waiting ⇄ in-progress → done/cancelled`,
 * with `todo → in-progress` (start directly) and `todo/assigned → cancelled`
 * as the other legal edges, and `waiting → done/cancelled` (a parked task may
 * be closed without un-parking). Deliberate absences, extracted as such:
 * there is NO `todo/assigned → waiting` — parking presumes engagement; a
 * task nobody started has nobody to be blocked on. Terminal states have no
 * exits; the REVERT operation deliberately bypasses the DAG (it is stack-pop,
 * not forward progress).
 *
 * ── PARKING (canon 7/9, ruled 2026-08-14) ──
 *
 * `blockedOn: sensei | human | external` is REQUIRED on entry to `waiting` —
 * a task cannot be parked on nobody. `resumeAt` is a SNOOZE: a date modifier
 * valid alongside any blocker (who you wait on and when to resume reminding
 * are different facts); it demotes the reminder to a daily cadence and never
 * silences. Park fields are CLEAR-OR-REPLACE, never sticky: every entry to
 * `waiting` sets exactly what this park chose (an absent snooze on this park
 * must not inherit one from an earlier park), and LEAVING `waiting` clears
 * all four park fields — a sticky blocker would keep a moving task on a
 * reminder clock for a blocker that no longer exists.
 *
 * ── THE HANDOFF (canon 8) — extracted as a first-class act ──
 *
 * Moving the blocker (sensei escalates to human; anyone re-escalates back)
 * is its own operation, valid while `waiting`, replacing EVERY park field —
 * a note left from the previous blocker describes an answered question. The
 * old system shipped only the fold half of this (a `task-blocked` reducer
 * with no write path behind it); the contract restores the act deliberately
 * — extraction decision, recorded in the report. Infra accepts ANY
 * reassignment (no cycle guard — infra cannot see whether new information
 * arrived; anti-ping-pong is orchestrator judgement).
 *
 * ── ACTOR GATES (canon 7; 042's lesson) ──
 *
 * Two gates, both must pass: the DAG says whether the move is legal at all;
 * the actor's ROLE says whether this caller may make it. A worker's only
 * permitted transition is `in-progress → waiting` with a blocker — workers
 * cannot close tasks. Role resolution precedence (extracted with its
 * reasoning): the live registry's role wins; an unregistered caller's
 * CLAIMED role counts only when it claims `worker` — so a worker cannot
 * escape its restriction by omitting its role, and nobody acquires the
 * orchestrator's powers by asserting them. A caller with NO resolvable role
 * is ungated deliberately: that is the human's own tooling (`jean task …`),
 * and the human is not gated by infra.
 *
 * ── REVERT ──
 *
 * Stack-pop over the task's own history: statuses push as they are entered
 * (creation pushes `todo`), a revert pops back past the current one. With
 * fewer than two entries there is nothing to revert — refused loudly.
 * RULED AT EXTRACTION (report, decision D-1): reverting OUT of `waiting`
 * clears the park fields, exactly as a forward unpark does — the old fold
 * left them sticky, which contradicts its own clear-or-replace law and kept
 * a reverted task nagging a blocker it no longer had. Accident left behind.
 *
 * THE STACK LAW (named at task 090 — it was implicit in both hands' heads,
 * and two real bugs bred in exactly that gap): **THE STACK'S TOP ALWAYS
 * EQUALS THE TASK'S STATUS.** Every fold case maintains it — a status push
 * sets both, a revert pops the stack AND all entries the pop skips, and a
 * `task-reverted` whose `to` is not in the stack still leaves top === status
 * (the fold resolves the disagreement in the status's favour, never leaves a
 * departed status on top). `decideRevert` may assume it and must preserve
 * it. This is indirectly-visible state — nothing returns the stack — which
 * is precisely why the law is stated here and pinned in conformance.
 *
 * RULED (D-5, task 083): **revert never lands on `waiting` — it pops past
 * it to the nearest earlier status that is neither `waiting` nor the
 * current status.** `waiting` requires a blocker only its parker can
 * supply (blocker-required, ruled 2026-08-14: answered by the caller that
 * knows); a revert cannot answer "who is this waiting on", and the stack
 * carries statuses, not park fields — landing there would manufacture the
 * parked-on-nobody state that ruling abolishes, and restoring the old park
 * would resurrect a question already answered. Popping past keeps the
 * escape hatch for a mistakenly-closed parked task (done → revert →
 * in-progress, not done → refusal → stuck); a caller that wants the task
 * parked again parks it explicitly, with a fresh blocker.
 *
 * ── SUBSCRIPTIONS (A-SUB, ruled 2026-08-18 — the complete set) ──
 *
 * A task carries a SUBSCRIBER SET: the participant set spec §4's task row
 * always meant ("everyone involved"). The three constraints, all structural:
 * (1) TASKS NEVER HOLD MAIL — pairs are (agent, event) only; a subscription
 * is a routing rule mapping the task's events into agent mailboxes; (2)
 * subscribers receive task events in their ONE usual mailbox — subscription
 * changes what lands, never where; (3) SUBSCRIBER ⊆ MAILBOX-HOLDERS,
 * enforced at BOTH gates (codex pass, 092): `decideSubscribe` refuses a
 * non-roster name, AND the fold drops a well-shaped subscription event
 * naming one — the law survives a rogue or buggy writer, not just a polite
 * caller. That double gate is what makes never-invent-an-acker hold by
 * construction.
 *
 * THE AUTOMATIC SURFACE, complete and closed (ruled): creation → the owner
 * (if roster) and the orchestrator; reassignment → the new owner. Written
 * BY INFRA as explicit recorded events (`actor: 'infra'`) — subscriptions
 * are always data, never implicit rules, and resolution consults only
 * subscription state. NO automatic unsubscription anywhere: reassignment
 * does not unsubscribe the previous owner; commenting does NOT
 * auto-subscribe (too much noise by default — the explicit operation
 * exists; playbooks make conventions). The governing tiebreaker for
 * anything unruled: no automatic behaviour; an explicit option exists.
 * Unsubscribe semantics are deliberately MINIMAL — the operation exists,
 * the door stays open, nothing elaborate is designed through it.
 *
 * ONE RULE, TWO USES: `autoSubscriptionsFor` states the automatic surface
 * once. Going FORWARD the shell appends its output after the triggering
 * event; on REPLAY the fold applies the same derivation to old logs — which
 * IS the migration: a log with no subscription events resolves exactly as
 * today (owner + orchestrator), because the derivation reconstructs those
 * subscriptions. Set semantics make the two paths idempotent on new logs
 * (the derived and the explicitly-written subscription coincide).
 *
 * DOCUMENTED MIGRATION EDGE: subscriptions are per-NAME, so on an old log
 * the CREATION-TIME orchestrator is the derived subscriber; a later seat
 * handover does not move old subscriptions (today's predicate model follows
 * the current seat). Rare in practice — one sensei per dojo — and the
 * explicit subscribe operation is the remedy; recorded rather than
 * designed around.
 *
 * ── STALENESS (surfacing only) ──
 *
 * An `in-progress` task with no stream activity for the configured bound is
 * flagged stale. SURFACING ONLY, never auto-demotion: statuses are
 * orchestrator-owned and single-writer; infra informs, it does not obligate.
 *
 * ── DATA COMPATIBILITY ──
 *
 * The fold understands the legacy status names real logs hold (`inbox`,
 * `active`, `blocked`, `review`) and the historical `task-blocked` kind.
 * A duplicate `task-created` for an existing id is ignored — FIRST WINS
 * (ruled, task 083): the old fold appended a second board entry under the
 * same id, an accident left behind; logs are permanent and a replay must
 * not double a task.
 *
 * ── Q-1 RULED (2026-08-18): NEVER INVENT AN OWNER ──
 *
 * Starting a task with no agent assigns the QUEUE as the agent ONLY WHEN
 * the queue names a roster member — the fold consults an injected
 * `isRosterMember` fact (the same pattern as the mailbox's `recipientsOf`;
 * the tasks module never imports agents). A non-roster queue ('someday',
 * 'backlog') leaves the task UNOWNED: its events resolve per the table
 * (unassigned → history), and no pairs accumulate for a mailbox nobody can
 * read. The roster fact is supplied current-as-of-the-event, like every
 * injected fold fact.
 *
 * What the types cannot enforce, and what does: the DAG's exact edge set,
 * the gates' precedence, clear-or-replace, the revert ruling, and staleness
 * arithmetic are held by `tasks.conformance.test.ts`.
 */

import type {
  AgentName,
  AgentRole,
  BlockedOn,
  StoredEvent,
  TaskBlockedData,
  TaskRevertedData,
  TaskStatus,
  TaskStatusData,
  TaskSubscribedData,
  TaskUnsubscribedData,
} from './vocabulary.ts'

export type { BlockedOn, TaskStatus }

export type Task = {
  id: string
  title: string
  description: string
  status: TaskStatus
  queue: string
  playbook?: string
  agent?: AgentName
  createdAt: string
  updatedAt: string
  blockedOn?: BlockedOn
  blockedNote?: string
  /** When the CURRENT holder took the blocker — per-item age measures from
   *  here, never from creation. */
  blockedSince?: string
  resumeAt?: string
}

/** Opaque — constructed by `initial()`, evolved by `fold`. Holds the board
 *  AND each task's status stack (revert's input). */
export type TasksState = { readonly __tasksState: true }

// ── Commands and decisions ───────────────────────────────────────

/** Why a status change was refused — typed, so the adapter's 400s are
 *  renames of domain refusals, never judgements of its own. */
export type TransitionRefusal =
  | { kind: 'unknown-task' }
  | { kind: 'illegal-transition'; from: TaskStatus; to: TaskStatus }
  | { kind: 'actor-forbidden'; actorRole: AgentRole; from: TaskStatus; to: TaskStatus }
  | { kind: 'blocker-required' }
  | { kind: 'unparseable-resume'; resumeAt: string }

export type StatusCommand = {
  taskId: string
  to: TaskStatus
  actor: string
  /** The role the caller CLAIMS. Resolution against the registered role is
   *  the contract's (`resolveActorRole`); pass the resolved value here. */
  actorRole?: AgentRole
  blockedOn?: BlockedOn
  blockedNote?: string
  resumeAt?: string
}

/** `data` is exactly what the shell appends as the event's payload — typed
 *  by the vocabulary, so the adapter renames and never invents. */
export type StatusDecision = { ok: true; data: TaskStatusData } | { ok: false; refusal: TransitionRefusal }

export type HandoffCommand = {
  taskId: string
  blockedOn: BlockedOn
  note?: string
  actor: string
  resumeAt?: string
}

export type HandoffRefusal =
  | { kind: 'unknown-task' }
  | { kind: 'not-waiting'; status: TaskStatus }
  /** The snooze law applies to the handoff too (ruled, task 083): a
   *  malformed date must fail loudly here as well, or it rides into the
   *  record and the reminder comparison goes silently always-true. */
  | { kind: 'unparseable-resume'; resumeAt: string }

export type HandoffDecision = { ok: true; data: TaskBlockedData } | { ok: false; refusal: HandoffRefusal }

export type RevertDecision =
  | { ok: true; from: TaskStatus; to: TaskStatus; data: TaskRevertedData }
  | { ok: false; refusal: { kind: 'unknown-task' } | { kind: 'nothing-to-revert' } }

// ── Subscriptions (A-SUB) ────────────────────────────────────────

export type SubscribeRefusal =
  | { kind: 'unknown-task' }
  /** Constraint 3, type-level: only mailbox-holders subscribe. */
  | { kind: 'not-a-mailbox-holder'; name: string }
  /** Refused so the shell never appends a no-op event. */
  | { kind: 'already-subscribed' }

export type UnsubscribeRefusal = { kind: 'unknown-task' } | { kind: 'not-subscribed' }

export type SubscribeDecision = { ok: true; data: TaskSubscribedData } | { ok: false; refusal: SubscribeRefusal }

export type UnsubscribeDecision = { ok: true; data: TaskUnsubscribedData } | { ok: false; refusal: UnsubscribeRefusal }

// ── The contract ─────────────────────────────────────────────────

/** `export const tasks: TasksContract` — src/domain/tasks/ (task D3). */
export type TasksContract = {
  initial: () => TasksState
  /** Fold one event: task kinds evolve the board, the status stacks, and
   *  (A-SUB) the subscription sets. `isRosterMember` is the injected roster
   *  fact (Q-1): the start-assigns-queue clause and the automatic
   *  owner-subscription both consult it. `orchestratorAt` is the seat
   *  current AS OF the event (injected like every fold fact) — the
   *  migration derivation subscribes it at creation; optional this one
   *  round so the merged implementation stays assignable, REQUIRED once
   *  the subscriber D-task lands (it may consolidate the two facts into
   *  one object then). */
  fold: (
    state: TasksState,
    event: StoredEvent,
    isRosterMember: (name: AgentName) => boolean,
    orchestratorAt?: AgentName,
  ) => TasksState

  // The four subscription members are OPTIONAL exactly one round — the
  // member-level red-by-absence: the conformance suite asserts their
  // presence (red against the pre-subscriber implementation, naming the
  // D-side), and the subscriber D-task makes them required.
  /** The task's subscriber set — THE definition of "involved" the shell
   *  injects into resolution's context. Explicit subscriptions ∪ the
   *  derivation, deduped; empty for unknown tasks. Indirectly-visible
   *  state: nothing else returns it. */
  subscribersOf?: (state: TasksState, taskId: string) => readonly AgentName[]

  /** The automatic surface, stated ONCE (see the prose): the subscription
   *  events infra must append after `event` (a task-created or a
   *  task-updated that reassigns). Empty for everything else. The fold
   *  applies the same rule on replay — that is the migration. */
  autoSubscriptionsFor?: (
    event: StoredEvent,
    isRosterMember: (name: AgentName) => boolean,
    orchestratorAt: AgentName | undefined,
  ) => readonly { taskId: string; data: TaskSubscribedData }[]

  decideSubscribe?: (
    state: TasksState,
    cmd: { taskId: string; agent: AgentName; actor: string },
    isRosterMember: (name: AgentName) => boolean,
  ) => SubscribeDecision

  decideUnsubscribe?: (
    state: TasksState,
    cmd: { taskId: string; agent: AgentName; actor: string },
  ) => UnsubscribeDecision

  all: (state: TasksState) => readonly Task[]
  taskOf: (state: TasksState, id: string) => Task | undefined
  /** The task an agent currently holds (in-progress or waiting, as owner or
   *  queue), if any — messaging attribution's board half. */
  activeTaskOf: (state: TasksState, agent: AgentName) => Task | undefined
  /** Sequential, zero-padded — derived from the board, never random. */
  nextTaskId: (state: TasksState) => string

  /** The DAG alone. */
  canTransition: (from: TaskStatus, to: TaskStatus) => boolean
  /** The role gate alone: may an actor OF THIS ROLE drive this move? */
  actorMayTransition: (role: AgentRole, from: TaskStatus, to: TaskStatus) => boolean
  /** The precedence rule: registered role wins; a claimed role counts only
   *  when it claims `worker`; otherwise unresolvable (= ungated: the
   *  human's own tooling). */
  resolveActorRole: (claimed: AgentRole | undefined, registered: AgentRole | undefined) => AgentRole | undefined

  /** Both gates + park validation, one decision. `ok` carries the event
   *  data the shell appends as `task-status`. (`now` was a parameter here
   *  and is REMOVED — ruled task 083, shape-earns-its-keep: no behaviour
   *  consults it; validation checks parseability, deliberately not
   *  future-ness — a past resumeAt simply means already back on cadence.) */
  decideStatus: (state: TasksState, cmd: StatusCommand) => StatusDecision
  /** Canon 8's act. `ok` carries the event data for `task-blocked`. */
  decideHandoff: (state: TasksState, cmd: HandoffCommand) => HandoffDecision
  /** Stack-pop. `ok` carries the event data for `task-reverted`. */
  decideRevert: (state: TasksState, taskId: string, actor: string) => RevertDecision

  /** Ids of in-progress tasks quiet past the bound. `lastEventAt` is the
   *  caller's per-task activity fact (from its stream), epoch ms; absent
   *  entries fall back to the task's updatedAt. Surfacing only. */
  staleTasks: (
    state: TasksState,
    now: number,
    staleAfterMs: number,
    lastEventAt: (taskId: string) => number | undefined,
  ) => readonly string[]

  /** In-progress count for one agent — the availability half the agents
   *  surface reports as `openTasks`. */
  openTaskCount: (state: TasksState, agent: AgentName) => number
}
