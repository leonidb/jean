/**
 * Supervision — parked-task nagging, worker status, broken-agent reports
 * (013 S7, S8, S10 as replaced by H4, S11; 039 O3 as refined by the H4
 * ruling; the transition, change G; the fix round, 2026-08-11).
 *
 * ── WHY THIS IS A SEPARATE MACHINE FROM `core/notify.ts` ──
 *
 * The delivery side asks "does this agent know about its mailbox yet?" and
 * reads a QUEUE. This side asks "is anything stuck?" and reads TASKS and AGENT
 * LIVENESS. Same foundations, different inputs, so one tick can drive both
 * without either reaching into the other's state.
 *
 * ── PLACEMENT ──
 *
 * Pure — no clock, no registry, no I/O — so it belongs in `core/`. Getting here
 * required widening `boundary.test.ts`'s import allowlist to admit `board.ts`,
 * which was done DELIBERATELY and with the justification written at the
 * allowlist entry rather than silently.
 *
 * ── H4 (RULED 2026-08-11): THE PER-TASK LADDER IS GONE ──
 *
 * The canon's replacement sentence, confirmed verbatim: "A stalled task has no
 * reporter of its own — a task surfaces through what it waits on. Worker state
 * is watched per-worker: the sensei receives worker status-change events
 * (down, up-but-stuck, recovered); a worker past its broken bound is reported
 * to the human once. No per-task reminders, no separate priority."
 *
 * What that DELETED from this file: the in-progress reminder arm — two
 * reminders to the worker, then escalate to the sensei — with its
 * `REMINDERS_BEFORE_ESCALATION` constant and both message shapes. Task-level
 * stall coverage is now: S7's sensei-nag for waiting-on-sensei, the S9 digest
 * for human/external, the resume date for time, and the worker-status events
 * here for in-progress work.
 *
 * THE WATCH-LIST IS THE BOARD: a worker is watched while it holds in-progress
 * work, derived from the tasks the view already carries — per WORKER, not per
 * task, so two silent tasks cost one event, not two ladders. The registry
 * cannot see a disconnected worker at all, so the board is the only possible
 * source; consequence, named and accepted at plan review: a task-less worker
 * disconnecting emits nothing (its `disconnect` event already told the
 * sensei), and a down worker whose tasks the sensei reroutes leaves the
 * watch-list silently — the broken bound then chases only down workers
 * sitting UNHANDLED, which is never-silently-vanishes with self-quieting.
 *
 * STATUS EVENTS ARE EMISSIONS, NOT PUSHES. "The sensei receives worker
 * status-change events" — and the mailbox is how every agent receives
 * everything now (the delivery unification, same day). The events enter
 * pending, land in the sensei's mailbox, and the notifier announces them by
 * priority like any other arrival. A second push path here would be the
 * special case the unification exists to delete.
 *
 * ── S7'S INVERSION IS THE WHOLE SCENARIO ──
 *
 * "…and the **sensei** is nagged, not the worker." Nagging whoever holds the
 * task is what any reasonable default does, and it is the measured failure: a
 * worker that has said everything it has to say cannot be un-stuck by being
 * asked again, so the reminder lands on the one party that cannot act while
 * the party that can hears nothing.
 *
 * ── S11: BUSY AND DEAD ARE ONE CASE (E3) ──
 *
 * Infra cannot tell a wedged agent from a thinking one, and the design's
 * answer is not to try. The report says "this agent has said nothing for four
 * hours", which is TRUE of both, rather than "this agent is broken", which
 * infra cannot know. The cost of a false positive is one message, cleared the
 * moment the agent speaks — CLEARED, not latched, so an agent that breaks
 * again is reported again.
 *
 * THE EVENT IS THE REPORT (H4 ruling): `agent-unresponsive` is emitted
 * unconditionally at the bound — with a bridge, the human ALSO gets the
 * direct push (S11 unchanged, not threshold-gated); with no bridge, the event
 * riding the sensei's mailbox + the S2 backstop IS the delivery ("the
 * no-bridge fallback rides normal mailbox + backstop"). Committing the report
 * on the emit rather than on a landed push is deliberate: the mailbox is
 * truth, and a refused bridge socket must not make infra believe it never
 * reported.
 */

import type { TaskStatus } from '../board.ts'

/** Who a task is waiting on. Closed set, per canon. */
export type BlockedOn = 'sensei' | 'human' | 'external' | 'time'

/** One task as the supervisor sees it. */
export type SupervisedTask = {
  id: string
  title: string
  status: TaskStatus
  /** The agent holding the work — the H4 watch-list is derived from this. */
  agent?: string
  /** Set while parked. Absent ⇒ the task is not waiting on anyone. */
  blockedOn?: BlockedOn
  /** WHO GETS NAGGED while parked — the current holder, already resolved to a
   *  name by the adapter. Resolving it there is what keeps "the nag follows the
   *  holder" a single assertion rather than a role lookup scattered through the
   *  decisions. */
  holder?: string
  /** Last event on this task's stream (epoch ms). */
  lastEventAt: number
}

export type SupervisedAgent = {
  name: string
  role: string
  /** Last jean-visible activity (epoch ms). Canon E5: messaging events only,
   *  as sharpened by H7 (ruled 2026-08-11): originated BY the agent — the
   *  register handshake, Stop-hook posts and deliveries TO it do not count. */
  lastActivityAt: number
  /** Whether a live session exists right now. The adapter derives it from the
   *  registry + transport; a worker on the watch-list with no registry entry
   *  at all arrives here as `sessionLive: false` (S10 as replaced by H4 —
   *  "down = no live session"). */
  sessionLive: boolean
}

export type SupervisionView = {
  now: number
  /** The sensei's name, or null on a dojo where none has ever registered. */
  sensei: string | null
  /** The human's bridge surface, when one exists. When NULL the broken-agent
   *  report has no direct push at all — the emitted event riding the sensei's
   *  mailbox is the delivery (H4 ruling, refining 039 O3). */
  bridge: string | null
  /** Names with a live transport right now. */
  deliverable: string[]
  tasks: SupervisedTask[]
  agents: SupervisedAgent[]
  /** DIALS. `reminderAfterMs` paces the S7/S8 waiting-task nag; `stuckAfterMs`
   *  is H4's silence bound for a session-alive worker holding active work;
   *  `brokenAfterMs` is S11's human-report bound. */
  reminderAfterMs: number
  stuckAfterMs: number
  brokenAfterMs: number
}

/**
 * The adapter side — TWO effects, and deliberately not the notifier's three.
 *
 * ── NO `stamp`, AND ITS ABSENCE IS A FIX ──
 *
 * This machine had one, copied from the notifier, and it wrote a falsehood at
 * scale: `stamp(via)` defaults to "everything currently pending", but a
 * supervision push carries NO MAILBOX. It is one sentence about one task, or one
 * agent. So every reminder marked the WHOLE QUEUE `deliveredVia: 'wake'`, for
 * events the message did not mention and the agent was never shown.
 * First-delivery-wins then made those false marks permanent. The ledger records
 * how an event reached an agent; a push that carries no events records nothing.
 * (Found by Codex in the transition's adversarial pass, task 045.)
 */
export type SupervisionExecutor = {
  deliver: (to: string, text: string) => boolean
  emit: (type: string, data: Record<string, unknown>) => void
}

export type Supervisor = {
  /** One tick. Everything this machine does, it does from here. */
  tick: (view: SupervisionView) => void
}

/** Per-task nag bookkeeping (S7/S8 — waiting tasks only, since H4). */
type TaskState = { lastNaggedAt: number }
/** Per-agent broken-report bookkeeping (S11). */
type AgentState = { reportedAt: number }
/** H4's per-worker status machine. `ok` is the implicit initial state: a
 *  worker first observed already-down still announces, because the change is
 *  from the watcher's baseline, not from an unobservable past. */
type WorkerStatus = 'ok' | 'down' | 'up-but-stuck'

export function createSupervisor(exec: SupervisionExecutor): Supervisor {
  const tasks = new Map<string, TaskState>()
  const workers = new Map<string, WorkerStatus>()
  const agents = new Map<string, AgentState>()

  /** One push, with race guard 4 applied: nothing advances unless it landed. */
  function push(to: string, text: string, view: SupervisionView, commit: () => void, emit: () => void): void {
    if (!view.deliverable.includes(to)) return
    if (!exec.deliver(to, text)) return
    commit()
    emit()
  }

  return {
    tick(view) {
      // ── S7/S8 — a parked task nags whoever currently holds the blocker ──
      //
      // WAITING TASKS ONLY. The in-progress arm — the old S10 ladder — is
      // deleted per H4; an in-progress task's coverage is its worker's status,
      // watched below.
      for (const task of view.tasks) {
        if (task.status !== 'waiting') continue
        const state = tasks.get(task.id) ?? { lastNaggedAt: 0 }
        // ACTIVITY ON THE TASK RESETS THE CLOCK. Derived from the task's own
        // last event rather than signalled, so answering on task A does not
        // quiet task B.
        const since = Math.max(task.lastEventAt, state.lastNaggedAt)
        if (view.now - since < view.reminderAfterMs) continue
        const to = task.holder ?? null
        if (!to) continue
        push(
          to,
          `Task ${task.id} (${task.title}) is waiting${task.blockedOn ? ` on ${task.blockedOn}` : ''}.`,
          view,
          () => tasks.set(task.id, { lastNaggedAt: view.now }),
          () => exec.emit('task-reminder', { taskId: task.id, to }),
        )
      }

      // ── H4 — worker status, per worker, on change edges only ──
      const holding = new Set(
        view.tasks.filter((t) => t.status === 'in-progress' && t.agent).map((t) => t.agent as string),
      )
      for (const agent of view.agents) {
        if (agent.role !== 'worker' || !holding.has(agent.name)) continue
        const current: WorkerStatus = !agent.sessionLive
          ? 'down'
          : view.now - agent.lastActivityAt >= view.stuckAfterMs
            ? 'up-but-stuck'
            : 'ok'
        const previous = workers.get(agent.name) ?? 'ok'
        if (current === previous) continue
        workers.set(agent.name, current)
        // `ok → ok` is unreachable here; a transition TO ok is a recovery.
        // The event is the report — the sensei's mailbox delivers it.
        const held = view.tasks
          .filter((t) => t.status === 'in-progress' && t.agent === agent.name)
          .map((t) => t.id)
          .join(', ')
        const quietMinutes = Math.round((view.now - agent.lastActivityAt) / 60_000)
        const status = current === 'ok' ? 'recovered' : current
        exec.emit('worker-status', {
          agent: agent.name,
          status,
          text:
            current === 'down'
              ? `${agent.name} is down — no live session; holding ${held}.`
              : current === 'up-but-stuck'
                ? `${agent.name} looks stuck — session alive, nothing jean-visible for ${quietMinutes} min; holding ${held}.`
                : `${agent.name} recovered.`,
        })
      }
      // A worker no longer holding active work leaves the watch-list
      // SILENTLY — no 'recovered' for a worker that never recovered (the
      // sensei rerouted the tasks; it knows), and no further downs for a
      // worker holding nothing.
      for (const name of [...workers.keys()]) {
        if (!holding.has(name)) workers.delete(name)
      }

      // ── S11 — the broken bound, every agent in view, down or alive (E3) ──
      for (const agent of view.agents) {
        const state = agents.get(agent.name) ?? { reportedAt: 0 }
        // The report AUTO-CLEARS on any activity — a restart of the cycle
        // rather than a latch, because a latch that never clears is how every
        // ignored alert system begins.
        const reportedAt = agent.lastActivityAt > state.reportedAt ? 0 : state.reportedAt
        agents.set(agent.name, { reportedAt })
        if (view.now - agent.lastActivityAt < view.brokenAfterMs) continue
        if (reportedAt > 0) continue // already reported for this silence
        const quietMinutes = Math.round((view.now - agent.lastActivityAt) / 60_000)
        const text = `${agent.name} has not responded for ${quietMinutes} min — no activity, no task updates.`
        // THE EVENT IS THE REPORT — committed on the emit, not on a landed
        // push (see the header). With no bridge this is the whole delivery,
        // riding the sensei's mailbox and the S2 backstop.
        agents.set(agent.name, { reportedAt: view.now })
        exec.emit('agent-unresponsive', {
          agent: agent.name,
          quietMinutes,
          text,
          ...(view.bridge && { to: view.bridge }),
        })
        // The human's direct push when a surface exists — S11 unchanged, and
        // deliberately not threshold-gated (H4 ruling: no priority clause).
        if (view.bridge && view.deliverable.includes(view.bridge)) {
          exec.deliver(view.bridge, text)
        }
      }
    },
  }
}
