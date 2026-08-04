/**
 * ██ TARGET API ██ STUB GROUP 7a — nagging, reminders, escalation, broken-agent
 * reports (013 REFERENCE DESIGN S7, S8, S10, S11 + the S10 amendment; 039 O3).
 *
 * ── WHY THIS IS A SEPARATE MACHINE FROM `attention.ts` ──
 *
 * The delivery side (S1-S3, S6) asks "does this agent know about its mailbox
 * yet?" This side asks "is anything stuck?" — and it reads TASKS and AGENT
 * LIVENESS, not queues. Same foundations, different inputs, so the same tick can
 * drive both without either reaching into the other's state.
 *
 * ── THE FOUR REQUIREMENTS, AND THE ONE WORD THAT CARRIES S7 ──
 *
 * S7: a worker that finishes or gets stuck parks the task, "and the **sensei**
 * is nagged, NOT the worker." That inversion is the whole scenario. Nagging the
 * worker is what today's machinery would do by default, and it is the measured
 * failure — a worker that has said everything it has to say cannot be un-stuck
 * by being asked again.
 *
 * S8: the blocker moves, and the nag follows the CURRENT holder. No mute
 * mechanism, and no cycle guard (the amendment moved the no-return rule out of
 * infra entirely — see blocked.ts).
 *
 * S10, as amended: TWO reminders, then escalate. Reads: reminder → silent window
 * → second reminder → silent window → the sensei is told. "The worker gets a
 * second chance before its silence becomes the sensei's problem."
 *
 * S11: an agent with no activity, no task updates, and unanswered reminders is
 * reported to the human within bounded time, and the report AUTO-CLEARS on any
 * activity. O3: when there is no bridge, the report goes to the sensei's chat —
 * a report nobody can receive is not a report.
 *
 * ── ACTIVITY EVIDENCE IS MESSAGING EVENTS ONLY (canon E5) ──
 *
 * `lastActivityAt` and `lastEventAt` both come from the event log and the live
 * registry. No commits, no file mtimes, no process liveness: Jean is not
 * code-only, and a worker thinking hard in silence is indistinguishable from a
 * dead one BY DESIGN — busy and dead are one case.
 */

import type { TaskStatus } from '../board.ts'
import type { TargetExecutor } from './attention.ts'
import type { BlockedOn } from './blocked.ts'
import { notImplemented } from './stub.ts'

/** One task as the supervisor sees it. */
export type SupervisedTask = {
  id: string
  title: string
  status: TaskStatus
  /** The agent holding the work (S10's reminder target while in-progress). */
  agent?: string
  /** Set while parked. Absent ⇒ the task is not waiting on anyone. */
  blockedOn?: BlockedOn
  /** WHO GETS NAGGED — the current holder, already resolved to a name by the
   *  adapter. S7 makes this the sensei for a worker-parked task; S8 makes it
   *  move. Resolving it in the adapter is what keeps "the nag follows the
   *  holder" a single assertion rather than a role-lookup scattered through the
   *  decisions. */
  holder?: string
  /** Last event on this task's stream (epoch ms). */
  lastEventAt: number
}

export type SupervisedAgent = {
  name: string
  role: string
  /** Last jean-visible activity (epoch ms). Canon E5. */
  lastActivityAt: number
}

export type TargetSupervisionView = {
  now: number
  /** The sensei's name, or null on a dojo where none has ever registered. */
  sensei: string | null
  /** The human's bridge surface, when one exists. NULL is the case O3 rules on:
   *  the broken-agent report goes to the sensei instead. */
  bridge: string | null
  /** Names with a live transport right now. */
  deliverable: string[]
  tasks: SupervisedTask[]
  agents: SupervisedAgent[]
  /** DIALS. */
  reminderAfterMs: number
  brokenAfterMs: number
}

export type Supervisor = {
  /** One tick. Everything this machine does, it does from here. */
  tick: (view: TargetSupervisionView) => void
}

export function createSupervisor(_exec: TargetExecutor): Supervisor {
  return notImplemented('createSupervisor', 'S7/S8/S10/S11 (nag, reminders, escalation, broken agent)')
}
