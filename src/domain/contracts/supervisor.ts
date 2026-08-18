/**
 * The supervisor contract — parked-work reminders and agent liveness, born
 * on the spec's liveness block (spec §0, §4-liveness; design §3 §11; canon
 * 7/9/10's ruled cadences).
 *
 * ── THE LIVENESS BLOCK, whole (spec §4) ──
 *
 *  - An agent WITH PENDING MAIL needs no probe: the ladder announcing its
 *    existing mail IS the probe — liveness is inferred from what its
 *    silence does next, not from a dedicated exchange. (Register row 8
 *    closes by construction: `decideSupervision` never probes an agent the
 *    view shows holding mail.) SCOPE, made precise at A6's composition
 *    round (task 102): the rule gates PROBE EMISSION — the stuck-path
 *    question and the idle ping — and nothing else. Down, the
 *    probed-verdict, and recovery are not probes, and mail never shields
 *    them: a disconnected agent with queued mail still reads down from
 *    silence alone, and a probe's OWN mail (agent-probe is addressed,
 *    queued mail) must not cancel the verdict it exists to produce — the
 *    composed system's first full loop showed a blanket mail exit making
 *    every report unreachable, since real agents hold mail most of the
 *    time and every probe mints some.
 *  - An IDLE worker — no task, no pending mail — is pinged after a
 *    configurable silence (default a day): ordinary addressed mail whose
 *    acknowledgement resets the clock. EDGE-TRIGGERED: never re-emitted
 *    while one is outstanding, so nothing accumulates in a down worker's
 *    mailbox.
 *  - DOWN KEYS ON ABSENCE OF ACTIVITY, never on absence of
 *    acknowledgement. An agent mid-task with unread mail is busy, not down.
 *  - INFRA DOES NOT SUPERVISE THE ORCHESTRATOR (§0): never probed, never
 *    the subject of a down report — reports go TO the orchestrator; a
 *    report about its own failure has no in-dojo consumer. The exclusion
 *    is BY SEAT (the orchestrator's name), not by role: a worker-role
 *    record holding the seat is excluded all the same (pinned, task 100 —
 *    the role filter alone pins only the weaker rule).
 *  - ONE EVENT, NOT A PAIR: a status report is a single addressed event.
 *  - EVERY REPORT GETS A MATCHING RETURN (register row 7 closes by
 *    construction; extended at D9's round, task 100): an episode that
 *    produced a report — `down` OR `up-but-stuck`; row 7 named down, but a
 *    stale stuck alarm is the same unclosed claim in the orchestrator's
 *    hands — ends with a recovery report when the agent comes back,
 *    whether or not it still holds work; an episode that produced no
 *    report ends silently.
 *  - THE STATE RECORDS ONLY WHAT WAS ACTUALLY EMITTED (ruled at D9's
 *    round, task 100 — both of D9's liveness bugs violated it, both in
 *    the orchestrator-absent moment, which is a between-boot gap: exactly
 *    when supervision matters). With no orchestrator there is nobody to
 *    tell, so nothing is emitted AND nothing is marked emitted: an open
 *    report waits for a recipient to exist — the matching return is never
 *    lost to the gap — and a verdict that could not be reported is not
 *    recorded as reported, so no stray `recovered` ever closes a report
 *    that was never made.
 *
 * ── REMINDERS (canon 7/9, ruled 2026-08-14) ──
 *
 * Every parked task reminds THE ORCHESTRATOR on its blocker's clock —
 * `sensei` short (transitory by design), `human` hourly, `external` daily —
 * measured from `blockedSince` (the CURRENT holder's claim, pinned as set
 * since A3b). A live snooze (`resumeAt` in the future) DEMOTES any blocker
 * to the daily clock; the instant it passes, the blocker's own cadence
 * resumes automatically — a snooze demotes, it never silences. The
 * reminder event IS the wake: an empty board produces no event at all
 * (the digest-is-not-a-job ruling — self-gating by construction).
 * Composing the day's reminders into one readable message is the
 * orchestrator's judgement, not infra's — this contract emits facts on
 * clocks, never presentation.
 *
 * ── DECIDE → EFFECTS ──
 *
 * `decide(state, view, config)` is pure and returns emit-intents: reminder,
 * probe, down, recovery. The state carries the episodes and reminder
 * clocks — indirectly-visible by design (nothing returns them; they show
 * only in when effects fire), which is exactly why the conformance suite
 * drives them through behaviour sequences.
 *
 * A RECORDED GAP, accepted loud until after the switch (ruled at task 107;
 * found by E3): decide ADVANCES state as it decides — there is no outcome
 * seam like the notifier's `applyOutcome`, so a shell whose append FAILS
 * holds state that believes the emission was made. The cost is bounded and
 * self-healing for reminders (that cadence period is skipped; the next
 * fires), and visible-but-confusing for reports (a lost down leaves
 * `reported` set, so the agent's return emits a `recovered` closing a
 * report nobody received — the stray-return class, reachable only through
 * an append failure the adapter logs as LOST EMISSION). The post-switch
 * fix is the notifier's shape: outcomes as data, episode and reminder
 *  records moving only on confirmed appends. Tracker R16 carries the
 * decision; G1's shakedown watches for LOST EMISSION lines. The executor unit's laws are
 * the notifier's (a)–(c), shared — STATED here, HELD by the executor
 * conformance suite that ships with the executor implementations (the
 * E-side obligation, tracker R11).
 *
 * ── UNASSUMED INPUTS, pinned ──
 *
 * A `waiting` task with NO blockedSince (old logs predate the pin): the
 * task's updatedAt is the honest floor, injected by the view's composer —
 * never a crash, never a nag storm. Unknown roles in the view are not
 * workers and are not probed. Facts are the composer's guarantee (R10):
 * this contract does not re-validate them.
 *
 * What the types cannot enforce, and what does: every liveness clause,
 * both by-construction row closures, the cadence table, snooze demotion
 * and automatic resumption, edge-triggering, and §0's exclusion are held
 * by `supervisor.conformance.test.ts`.
 */

import type { AgentName, AgentRole, BlockedOn, TaskStatus } from './vocabulary.ts'

/** Opaque — probe ledgers, down episodes, reminder clocks. */
export type SupervisorState = { readonly __supervisorState: true }

export type SupervisedTaskFacts = {
  id: string
  status: TaskStatus
  blockedOn?: BlockedOn
  /** Epoch ms — from blockedSince, or the composer's honest floor
   *  (updatedAt) for pre-pin logs. REQUIRED: supplying the floor is the
   *  composer's obligation (R10) — an optional field here would smuggle
   *  the legacy gap into every consumer (codex pass, 095). */
  blockedSinceMs: number
  /** Epoch ms of a live snooze; absent or past = the blocker's own clock. */
  resumeAtMs?: number
}

export type SupervisedAgentFacts = {
  name: AgentName
  role: AgentRole
  /** Live session present right now. */
  connected: boolean
  /** Epoch ms of the agent's last own act — WITH THE COMPOSER'S FLOORS
   *  (RULED at task 107, confirming E3's composition): an agent with no
   *  recorded act ever reaches this view with the honest floor substituted
   *  — a live session measures from when it CONNECTED; a disconnected
   *  agent enters the view only if the board says it holds work, measuring
   *  from its newest held task's claim; an agent with neither is NOT in
   *  the view at all (nothing to supervise, nothing honest to measure).
   *  Without the floors the first post-boot tick reads the whole dojo as
   *  dead. This is the `blockedSinceMs` pattern (R10: the composer's
   *  obligation), and it is NOT R8's forbidden fallback: R8's display
   *  claimed "the agent ACTED at T" (false); the floor answers a different
   *  question — "when did the window in which we have heard nothing
   *  BEGIN" (true). The NOTIFIER's view keeps the honest blank: absent
   *  reads maximally quiet and the waiting mail announces — an
   *  announcement costs a wake; a down report costs an alarm a human
   *  reads. */
  lastActivityAt?: number
  /** Holds active work (in-progress or assigned, per the board). */
  holdsWork: boolean
  /** Holds pending mail (per the mailbox) — the no-probe condition. */
  hasPendingMail: boolean
}

export type SupervisorView = {
  now: number
  orchestrator: AgentName | undefined
  tasks: readonly SupervisedTaskFacts[]
  agents: readonly SupervisedAgentFacts[]
}

/** Named configuration — every bound injected, none in prose. */
export type SupervisorConfig = {
  /** blockedOn: 'sensei' — the tight clock. */
  senseiReminderMs: number
  /** blockedOn: 'human' — the live-workday clock. */
  humanReminderMs: number
  /** blockedOn: 'external' and every snoozed task — the daily floor. */
  dailyReminderMs: number
  /** The idle-empty worker ping bound (the ruled default: a day). */
  idlePingAfterMs: number
  /** How long a probed agent has to answer before it reads down. */
  probeTimeoutMs: number
  /** The silence bound — ONE bound, two consequences (D9's reading,
   *  CONFIRMED at task 100): a LIVE session quiet this long is PROBED
   *  (ask if you can); a DISCONNECTED agent quiet this long reads DOWN
   *  (conclude if you cannot — there is no session to ask, so the verdict
   *  comes from silence alone). Both consequences answer the same
   *  question — "how long is too long to hear nothing" — so a separate
   *  `downAfterMs` would be a second number with no independent meaning.
   *  If operations ever want the bounds apart, that is an additive config
   *  field, not a rewrite. */
  stuckAfterMs: number
}

export type SupervisorEffect =
  | { kind: 'remind'; taskId: string; to: AgentName; blockedOn: BlockedOn; ageMs: number }
  | { kind: 'probe'; agent: AgentName; quietMs: number }
  | {
      kind: 'report'
      to: AgentName
      subject: AgentName
      status: 'down' | 'up-but-stuck' | 'recovered'
      quietMs: number
    }

export type SupervisorDecision = {
  next: SupervisorState
  effects: readonly SupervisorEffect[]
}

/** `export const supervisor: SupervisorContract` — src/domain/supervisor/
 *  (D9). */
export type SupervisorContract = {
  initial: () => SupervisorState

  /** Pure; the tick. All clocks read from the view's `now` and the injected
   *  config — never ambient time. */
  decide: (state: SupervisorState, view: SupervisorView, config: SupervisorConfig) => SupervisorDecision
}
