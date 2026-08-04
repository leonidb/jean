/**
 * ██ TARGET API ██ STUB GROUP 6 — the attention view and listener AS THEY MUST
 * BECOME (013 REFERENCE DESIGN S1-S3, S6; 042 DEVIATION-1 and DEVIATION-2;
 * Leonid's ruling (a), 2026-08-05).
 *
 * ██ THE LIVE `core/attention.ts` IS NOT TOUCHED. ██ This stubs the target
 * ALONGSIDE it (task 044 deliverable 1, explicit). The live core keeps the whole
 * main suite green while the scenario suite runs red against this.
 *
 * ── THE TWO DELETIONS AND THE ONE ADDITION ──
 *
 * DELETED: `idle`. Canon E3, verbatim: "nothing ever asks whether an agent is
 * busy — busy and dead are one case (no ack → keep trying)". 042 DEVIATION-1
 * found the gate alive and unscheduled, with `AttentionView.idle` existing
 * solely to feed it. **The absence of the field from this type IS scenario 2's
 * test** — there is no runtime assertion that can express "the machine no longer
 * asks", only a shape that cannot answer.
 *
 * ADDED: `lastActivityAt`. Canon S2, verbatim: a quiet agent is nudged "within
 * the configured interval, **measured from its last activity** — an agent
 * already quiet that long gets it immediately." 042 DEVIATION-2: today the clock
 * runs from `lastNudgeAt`, and the view carries no last-activity field at all,
 * so "already quiet ⇒ immediately" is not merely unimplemented — it is
 * INEXPRESSIBLE. The datum exists in the adapter already (`registry` entries
 * carry `lastActivityAt`, touched on every WS frame and every `x-jean-agent`
 * request); it simply never reached a decision.
 *
 * ADDED: `threshold`. Canon S3: each role has an infra-configured minimum
 * priority; at or above it an event is pushed ONCE, no retry; below it, counts
 * update silently.
 *
 * ── RULING (a): THE LADDER SURVIVES, AND SO DOES SOMETHING WATCHDOG-SHAPED ──
 *
 * S2's "no event waits longer than the interval, ever" reads as FIRST
 * notification. The interval governs how fast an agent first learns of a new
 * event, measured from its last activity; re-notification for a queue that is
 * still unhandled follows the backoff ladder. Consequence, ruled explicitly:
 * `stall-watchdog.test.ts` is NOT a whole-file casualty — a long-wait backstop
 * survives the idle gate that birthed it, and its cases adapt.
 *
 * ── WHY `emit` IS LOOSELY TYPED, ON PURPOSE ──
 *
 * These stubs must pin the DESIGN's requirements without pinning an
 * implementation the transition has not chosen yet. So the executor carries the
 * one thing every scenario actually asserts — WHO was delivered WHAT, and how
 * many times — and takes appended events as `(type, data)` without a schema.
 * The scenario tests assert on the delivery trace; if the transition wants
 * different event names or payloads, no test has to change.
 */

import type { StoredEvent } from '../../es/index.ts'
import type { DeliveredVia } from '../reducers.ts'
import type { Priority } from './priority.ts'
import { notImplemented } from './stub.ts'

/** One event in a mailbox, as a decision sees it. */
export type PendingEntry = {
  id: number
  priority: Priority
  /** Who it is from — the summary view's middle column, and enough for a
   *  decision to say "a human is waiting" without a second lookup. */
  from: string
}

/**
 * ONE agent's mailbox, as of `now`. Constructed fresh at every decision point —
 * that is S6 (fresh counts), and it is the one thing in this file that is
 * already true on main and must stay true.
 *
 * NOTE WHAT IS NOT HERE: `idle`. See the header.
 */
export type TargetAttentionView = {
  now: number
  /** WHOSE mailbox. Survives the owner's disconnects (task 040's owner /
   *  deliverable split, which the transition keeps). */
  agent: string | null
  /** Whether there is a live transport to push to right now. */
  deliverable: boolean
  /** When this agent was last seen doing ANYTHING jean-visible. The clock S2
   *  measures from. Activity evidence is messaging-system events only (canon
   *  E5) — no commits, no file mtimes. */
  lastActivityAt: number
  /** This role's minimum priority for a push (S3). A dial. */
  threshold: Priority
  /** The mailbox, as a filter of the one pending list (see mailbox-rules.ts). */
  pending: PendingEntry[]
  /** DIALS. `nudgeIntervalMs` is S2's interval; the ladder governs repeats
   *  (ruling (a)); `longWaitMs` is the surviving watchdog-shaped backstop. */
  nudgeIntervalMs: number
  nudgeBackoffMs: number[]
  longWaitMs: number
}

/**
 * The adapter side. Two effects, per the four-effects ruling: `deliver` pushes,
 * `emit` appends. Nothing asks whether an agent is busy, so there is no
 * `markBusy` — its disappearance is part of DEVIATION-1's correction.
 */
export type TargetExecutor = {
  /** Push. Returns whether the transport accepted it — the answer every commit
   *  hinges on (race guard 4, which survives the transition unchanged). */
  deliver: (to: string, text: string) => boolean
  /**
   * Append an event. Deliberately schema-free here — see the header.
   *
   * ONE FIELD IS PINNED, and only one: a push's event carries `pendingCount`,
   * the queue size AS OF EMISSION. Scenario 6 has nothing to assert otherwise,
   * and the field is continuous with today's `NudgeData.pendingCount` rather
   * than newly invented, so pinning it costs the transition nothing.
   */
  emit: (type: string, data: Record<string, unknown> & { pendingCount?: number }) => void
  /** Record how the currently-pending events reached the agent. */
  stamp: (via: DeliveredVia) => void
}

export type TargetListener = {
  /** An event has just been applied to the projections. */
  onEvent: (event: StoredEvent, view: TargetAttentionView) => void
  /** A timer tick. Both intervals call this and nothing else. */
  tick: (view: TargetAttentionView) => void
  /**
   * The agent did something jean-visible.
   *
   * Replaces the live `nudge(view)` turn-end entry point, and the rename is the
   * design change: the old one existed to ask "are you idle yet?", this one
   * reports activity and resets S2's clock. It never gates a push on busyness.
   */
  activity: (view: TargetAttentionView) => void
}

export function createTargetListener(_exec: TargetExecutor): TargetListener {
  return notImplemented('createTargetListener', 'S1-S3, S6 (delivery)')
}
