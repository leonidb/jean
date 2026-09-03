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
   *  agent enters the view only if the board says it holds STALLING work
   *  — assigned or in-progress; NEVER waiting (task 115's ruling reaches
   *  here too: a parked task puts its holder on no clock, and its
   *  unparking is an orchestrator act that re-engages the holder in
   *  view) — measuring from its newest such task's claim; an agent with
   *  neither is NOT in the view at all (nothing to supervise, nothing
   *  honest to measure).
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
  /** ENGAGED: holds an IN-PROGRESS task — the ONLY input to the
   *  up-but-stuck path (RULED at task 115, from the live shakedown's
   *  31-minute probe loop). The predicate is pinned deliberately, not
   *  inherited: `waiting` is EXCLUDED — a parked task reminds the
   *  ORCHESTRATOR on its blocker's clock, and its holder owes nothing,
   *  whoever the blocker is; putting the holder on a clock too was the
   *  bug (the composer had inherited `activeTaskOf`'s engaged set, whose
   *  `waiting` member exists for a different consumer). `assigned` is
   *  ALSO excluded here: an undispatched assignment is the orchestrator's
   *  board follow-up — probing a live session over work it never started
   *  asks the wrong party. */
  engaged: boolean
  /** The in-progress claims this agent OWNS (task 132). Carried so the stuck
   *  probe can name the work it is asking about — the recipient cannot select
   *  an action for a task it has to guess at, and guessing is what the
   *  7224/7248 pair measured.
   *
   *  OWNER-ONLY, AND THEREFORE NOT `engaged`'S OWN SET. `engaged` is computed
   *  over `heldBy` — owner OR queue (`tasks/index.ts:499`) — so the relation
   *  is ONE-WAY: a non-empty list implies `engaged`, and `engaged` does NOT
   *  imply a non-empty list. The conformance pins both halves, including the
   *  gap.
   *
   *  THE GAP IS 084's UNPROPAGATED RULING, made visible rather than papered
   *  over. Its first draft here asserted the two-way invariant, and the
   *  builder refuted it against the live board: a task REASSIGNED away from
   *  the queue it was created in leaves the queue-holder on the stuck clock
   *  owning nothing. Q-1 makes queue and owner coincide otherwise, so
   *  reassignment is the whole of the gap. Under a
   *  two-way reading the probe would then have named that task and, by the
   *  ruled worker action, told the worker to park work belonging to someone
   *  else mid-flight. Owner-only is what stops the payload turning a silent
   *  over-inclusion into an explicit wrong instruction.
   *
   *  Narrowing `engaged` itself is 084/135's business and is not done here. */
  engagedTaskIds: readonly string[]
  /** Holds ANY undone claim on the board (assigned | in-progress |
   *  waiting). Consumed ONLY to suppress the idle-empty ping — a holder
   *  of parked or queued work is not "idle and empty", and pinging a
   *  waiting-task holder daily would be task 115's bug at a slower
   *  cadence. This field never STARTS a clock; `engaged` is the only
   *  clock-starter. */
  holdsUndone: boolean
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
  /** blockedOn: 'human' — daily, same floor as `dailyReminderMs`.
   *  Ruled 2026-09-02: an hourly clock on a human blocker is spam,
   *  because a person does not answer faster for being asked twelve times.
   *  Kept as its own field rather than folded into `dailyReminderMs`: the
   *  two are the same NUMBER today and different FACTS — a human blocker
   *  is chased, an external one is only surfaced. */
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

/**
 * THE PROBE CARRIES THE QUESTION IT IS ASKING (task 132, ruled 2026-08-24).
 *
 * ── THE BAR IS NOT AUDITABILITY ──
 *
 * The framing: a probe exists to get the right thing to HAPPEN, not to
 * detect liveness for its own sake. So the bar is not "a reader could
 * reconstruct why this fired" — it is THE RECIPIENT CAN SELECT THE CORRECT
 * ACTION ON RECEIPT. A probe that says only "are you stuck?" cannot produce
 * the act that would end the situation.
 *
 * ── THE MEASUREMENT THAT SETS IT ──
 *
 * Two probes this dojo sent the builder on 2026-08-23, events 7224 and 7248,
 * are byte-identical apart from id and timestamp: same agent, same
 * `quietMinutes: 31`, same text, same stream. THEY WANTED OPPOSITE
 * RESPONSES. At 7224 they were mid-implementation and "still working" was
 * correct; at 7248 they had delivered their half and the correct act was
 * parking the task on the sensei. No field existed that could have told them
 * which. That is the whole defect, and it is why this is a payload change
 * rather than a predicate one.
 *
 * ── THE REASON EXISTS ALREADY AND DIES AT THIS BOUNDARY ──
 *
 * The decision knows: `probeKind` is recorded on the episode (task 115's
 * round) precisely so a verdict can only answer the question that was asked.
 * It simply was not carried out. The two arms are different questions —
 * "you are mid-work and silent, alive?" and "you have nothing; still
 * there?" — and a recipient that cannot tell them apart cannot answer
 * either.
 *
 * ── A UNION, NOT AN OPTIONAL FIELD ──
 *
 * `engagedTaskIds` is meaningless on the idle arm and REQUIRED on the stuck
 * one, and the shape says so rather than leaving a reader to find out. The
 * idle ping is reached only past `if (agent.holdsUndone) continue`, so an
 * idle-armed probe has no tasks BY CONSTRUCTION; the stuck arm fires only
 * on `engaged`, so it always has at least one. The non-empty tuple is that
 * second half stated in the type — this repo's own habit (`Record<AgentRole,
 * true>` over a hand-written set) applied to a list.
 */
export type SupervisorEffect =
  | { kind: 'remind'; taskId: string; to: AgentName; blockedOn: BlockedOn; ageMs: number }
  | {
      kind: 'probe'
      /** MID-WORK AND SILENT. The recipient holds in-progress work and has
       *  gone quiet; the acts that answer it are "still working", "blocked
       *  on X", or parking the task on whoever owes the next move. */
      probeKind: 'stuck'
      agent: AgentName
      quietMs: number
      /** The in-progress claims the recipient OWNS. Without them it is asked
       *  about work it must guess at, which is the 7224/7248 pair verbatim.
       *
       *  MAY BE EMPTY, and the first draft of this contract said it could not
       *  be — a non-empty tuple, on the reasoning that `engaged` reaches this
       *  arm and `engaged` IS holding one. That is false, and the builder
       *  found it against the live board before it was built: `engaged` is
       *  computed over `heldBy` (`tasks/index.ts:499`), which is owner OR
       *  QUEUE, while this list is owner-only.
       *
       *  AND THE GAP IS NARROWER THAN THAT SOUNDS, though not as narrow as
       *  this contract first claimed. Q-1 (`tasks/index.ts:216`) makes the
       *  queue the owner at start WHEN THE QUEUE IS A ROSTER MEMBER, so the
       *  two coincide in the ordinary case. TWO things open the gap, and the
       *  first draft named only one:
       *    · the owner is EXPLICITLY REASSIGNED away — the 127 and 132 shape;
       *    · Q-1 DECLINED TO FIRE, because the queue was not yet a dojo agent
       *      when the task was started. The task keeps `agent: undefined`,
       *      and once that name registers it enters the view engaged with
       *      nothing to name. An ordinary boot-order case: a task dispatched
       *      and started for an agent that has not connected yet.
       *  Measured both, against the fold.
       *
       *  SO AN EMPTY LIST IS A FACT, not a gap: it says "you are on the stuck
       *  clock for work you do not own." That is 084's unpropagated
       *  owner-only ruling, and this payload is the first thing that makes it
       *  visible in the field rather than as an over-count nobody can see.
       *  The recipient's correct act on receipt is to say so — which is the
       *  bar met, not dodged. Narrowing the predicate is 084/135's business
       *  and deliberately not done here. */
      engagedTaskIds: readonly string[]
    }
  | {
      kind: 'probe'
      /** NOTHING HELD, NOTHING WAITING. A liveness question and only that;
       *  the act that answers it is an ack. */
      probeKind: 'idle'
      agent: AgentName
      quietMs: number
    }
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
