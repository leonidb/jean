/**
 * ██ TARGET API ██ STUB GROUP 5 — `blockedOn` + transition permissions
 * (013 REFERENCE DESIGN S7/S8 and its same-day amendment; 042 DEVIATION-4).
 *
 * Canon, verbatim (S7): "A worker that completes its task or hits a question
 * puts the task into waiting-on-sensei — same state, different message — and the
 * **sensei** is nagged, not the worker. Worker's only permitted transition:
 * `in-progress → waiting` with `blockedOn: sensei | human | external | time` and
 * a note; workers still cannot close tasks."
 *
 * Canon, verbatim (S8 + amendment): "`blockedOn` moves and the nagging follows
 * it. No mute mechanism exists or is needed." The no-return rule ("a blocker
 * cannot return to a party that already held it without new information") was
 * moved OUT of the infra contract — infra cannot see whether new information
 * arrived, because the human interaction happens inside the sensei's session.
 * **Infra accepts any reassignment. There is no cycle guard, and building one
 * would be the deviation.**
 *
 * ── TWO SEPARATE REQUIREMENTS THAT KEEP GETTING COLLAPSED INTO ONE ──
 *
 * 1. THE DATA: `blockedOn` + note on the task, moved by an explicit act.
 * 2. THE PERMISSION: workers cannot close tasks. 042 found this is the half with
 *    no owner — `PATCH /tasks/:id/status` checks `canTransition` and records
 *    `actor` WITHOUT EVER CHECKING IT, so any caller can drive any legal
 *    transition including `→ done`. The readiness order named "blockedOn on Task
 *    + reminder/escalation event types" — data, not authorization. Declaring the
 *    predicate here is what stops the requirement shipping as a field nobody
 *    enforces.
 *
 * ── ON THE EVENT NAMES BELOW ──
 *
 * They are this stub's proposal, not canon. The scenario tests assert on the
 * FOLDED STATE, and build their logs through local helpers, so renaming an event
 * at the transition is a one-line edit in each test rather than a rewrite. What
 * the tests do pin is that moving the blocker is its OWN act with its own event
 * — the explicit-acts-are-events principle (041's first amendment).
 */

import type { Reducer } from '../../es/index.ts'
import type { Task, TaskStatus } from '../board.ts'
import { notImplemented } from './stub.ts'

/** Who the task is waiting on. Closed set, per canon. */
export type BlockedOn = 'sensei' | 'human' | 'external' | 'time'

/** The board's task, plus the parked-work fields. */
export type TargetTask = Task & {
  blockedOn?: BlockedOn
  blockedNote?: string
  /** When the CURRENT holder took it — S9's per-item age is measured from here,
   *  not from task creation, so a re-parked task does not read as freshly
   *  blocked or as ancient. */
  blockedSince?: string
}

export type TargetBoard = { tasks: TargetTask[] }

/** `task-status` carrying the park. */
export type TargetTaskStatusData = {
  from: TaskStatus
  to: TaskStatus
  actor?: string
  actorRole?: string
  blockedOn?: BlockedOn
  blockedNote?: string
}

/** The explicit act of moving the blocker (S8's handoff). Its own event, per
 *  the explicit-acts principle — not a silent field rewrite riding on something
 *  else. */
export type TaskBlockedData = {
  blockedOn: BlockedOn
  note?: string
  actor?: string
}

/** The board fold under the target design. Everything the live `boardReducer`
 *  does, plus the park fields. */
export const targetBoardReducer: Reducer<TargetBoard> = (_state, _event) => {
  return notImplemented('targetBoardReducer', 'S7/S8 (blockedOn movement)')
}

/**
 * DEVIATION-4's missing predicate: may THIS actor drive this transition?
 *
 * Distinct from `canTransition` (board.ts), which answers whether the DAG allows
 * it at all. Both must pass. The canon's rule in one line: a worker may only go
 * `in-progress → waiting`; everything else — including every path to `done` — is
 * the sensei's.
 */
export function canActorTransition(_actorRole: string, _from: TaskStatus, _to: TaskStatus): boolean {
  return notImplemented('canActorTransition', 'S7 (workers still cannot close tasks) / DEVIATION-4')
}
