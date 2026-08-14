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
 * Its last clause is the one the 2026-08-14 ruling amends: a worker past its
 * bound is now PROBED, and reported to the SENSEI if it does not answer. The
 * human hears about it if and when the sensei decides they should.
 *
 * What that DELETED from this file: the in-progress reminder arm — two
 * reminders to the worker, then escalate to the sensei — with its
 * `REMINDERS_BEFORE_ESCALATION` constant and both message shapes. Task-level
 * stall coverage is: the waiting-task reminder below on the blocker's own
 * clock, and the worker-status events here for work in flight.
 *
 * THE WATCH-LIST IS THE BOARD: a worker is watched while it HOLDS WORK
 * (in-progress or assigned), derived from the tasks the view already carries —
 * per WORKER, not per task, so two silent tasks cost one event, not two
 * ladders. The registry cannot see a disconnected worker at all, so the board
 * is the only possible source; consequence, named and accepted at plan review:
 * a task-less worker disconnecting emits nothing (its `disconnect` event
 * already told the sensei), and a down worker whose tasks the sensei reroutes
 * leaves the watch-list silently — self-quieting when the sensei does its job.
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
 * ── THE NAG IS A MAILBOX EVENT (task 050, ruled 2026-08-11) ──
 *
 * The nag is an ADDRESSED EMISSION — `task-reminder {taskId, to, text,
 * queued:true}` — that enters the recipient's pending, and the notifier
 * announces it by priority like any other arrival. `queued` is the admission
 * flag (the send precedent): the write site decides, the fold applies, and the
 * bookkeeping events already in every dojo's log stay out on replay.
 *
 * Repetition SPLIT with the delivery (decision (a), recorded on task 050): an
 * unacked nag is still "told" — the notifier's ladder re-announces it — so
 * this machine re-emits only after the recipient cleared the previous nag
 * (`nagOutstanding`, resolved by the adapter from pending), paced from the
 * clearing: while a nag sits unacked the pace clock slides, so the next window
 * is measured from the ack, not from an emission the recipient may only just
 * have read. What clears a nag is an ACK and nothing else (decision (b)) — no
 * status-change auto-supersede; infra deciding a nag became moot is the exact
 * judgement read-before-ack exists to keep with the agent.
 *
 * ── INFRA MEASURES, SENSEI DECIDES (ruled 2026-08-14) ──
 *
 * The governing principle of this file, and the reason it has no transport
 * effect at all any more. Leonid, verbatim: "a reminder to the human was
 * always, from the start, meant to remind Sensei, not the human… there
 * shouldn't be automatic messages to the human from infra. That's why there is
 * a Sensei there to apply some knowledge, some thought."
 *
 * So: deterministic facts live HERE — did the agent answer within N, how long
 * has this task been parked, has the resume date arrived. Judgements live in
 * the sensei's skill and are overridable by a playbook — whether an escalation
 * is worth a human's attention, what to say, when to move a task. The
 * practical consequence is that **infra never decides who to bother**: every
 * arm below emits a fact into the SENSEI's mailbox and stops.
 *
 * There is no `pushBridge` and no `bridge` in the view. The absence is
 * structural rather than remembered: infra is now incapable of reaching the
 * human, so the rule cannot be broken by a future call site.
 *
 * ── CADENCE IS THE BLOCKER'S, AND SNOOZE ONLY DEMOTES IT ──
 *
 * Recipient is always the sensei; what the blocker decides is the CLOCK.
 *
 *   sensei    → short. Transitory by design: a worker is stalled while this
 *               sits, so the reminder exists to force "am I resolving this or
 *               escalating it to the human?"
 *   human     → hourly. Meant to read as immediate, expecting the human to be
 *               available — the cadence for a live workday.
 *   external  → daily. Nothing to chase; it is a picture, not a prompt.
 *
 * `resumeAt` is a SNOOZE: a temporary demotion to the daily clock that
 * RESTORES ITSELF when the date passes. It is a modifier on the existing
 * blocker, never a blocker of its own — which is exactly what makes the
 * restore free: the task never stopped being human-blocked, so when the date
 * passes there is no state to remember and nothing to transition. It falls
 * back onto its own clock because it was always on it.
 *
 * Snooze DEMOTES, it does not SILENCE (ruled 2026-08-14, Leonid: "it's okay to
 * have, if there are any waiting events or snoozed events, send them in a
 * once-a-day message… it's easy to just ignore for a few days. It's not
 * spamming."). A snoozed task keeps one line a day until its date arrives.
 * That is the floor the whole parked picture rests on: nothing parked is ever
 * invisible, which is what S9's "never silently vanishes" now means.
 *
 * NO GROUPING MACHINERY, anywhere (ruled 2026-08-14). One reminder per parked
 * task per its own clock. Whether the sensei folds several into one message on
 * a given morning is an in-the-moment judgement, which is the principle
 * applied: there is no consolidation code to write, test, or tune.
 *
 * ── S11 IS A PROBE, NOT AN ALARM (ruled 2026-08-14) ──
 *
 * What stood here emitted `agent-unresponsive` as a FACT at the instant of
 * suspicion, and — because the event named the agent in `data.agent` — derived
 * mailbox membership put it in THAT AGENT'S OWN MAILBOX, which is what woke
 * the agent. The alarm WAS the probe, fired in the wrong order. Measured over
 * four consecutive cycles: bound trips → emit → push to the human's phone →
 * the same event wakes the agent → the agent answers in ~19s → nothing is ever
 * sent to say so. 23 alarms in two days, zero all-clears, both workers, an
 * empty board.
 *
 * The order is now:
 *
 *   silent past its bound  → PROBE the agent, start a timer
 *     answered in window   → NOTHING. no event, no notification. silence is
 *                            the success case.
 *     not answered         → emit `agent-down` into the SENSEI's mailbox
 *
 * Three properties this buys, and each was a defect before:
 *   1. The probe is an ordinary addressed message. It reaches the agent the
 *      way everything else does and pushes nowhere else. The old conflation —
 *      one emission that both asked and accused — is the bug.
 *   2. `agent-down` exists only once an agent has genuinely failed, so its
 *      EXISTENCE is the evidence. That is why there is no all-clear to emit:
 *      the absence of the event is the all-clear.
 *   3. EDGE-TRIGGERED. One event per down-episode, cleared when the agent
 *      returns. Re-probing on a cycle would rebuild the metronome with extra
 *      steps ("it's important to know, but it's important to not nag about it
 *      too much").
 *
 * HALF THE CASES NEED NO TIMER. If the session is gone, infra knows at once —
 * that is `worker-status: down`, already edge-triggered and already correct.
 * The probe path is only for SESSION ALIVE BUT SILENT, which is why this is a
 * smaller machine than it looks.
 *
 * ── THE BOUND IS TIERED (ruled 2026-08-14) ──
 *
 * "if the worker is not on any task, then ping it once a day. If, at some
 * point, a worker really disconnects or stops working, you'll know before
 * dispatching a task for it." An agent holding work is watched on the short
 * bound; an idle one on the long one. WORK INCLUDES `assigned`, deliberately:
 * a worker that stopped while holding a dispatched-but-unstarted task was
 * watched by NOTHING before — `worker-status` saw in-progress only and the nag
 * saw waiting only. That gap fired on 2026-07-28 when two dispatches vanished
 * in a restart and nothing noticed.
 */

import type { TaskStatus } from '../board.ts'

/** WHO a task is waiting on. Closed set, per canon.
 *
 *  WHEN to start reminding again is `resumeAt`, and the two are deliberately
 *  different fields: a blocker names a party, a snooze names a date. */
export type BlockedOn = 'sensei' | 'human' | 'external'

/** One task as the supervisor sees it. */
export type SupervisedTask = {
  id: string
  title: string
  status: TaskStatus
  /** The agent holding the work — the H4 watch-list is derived from this. */
  agent?: string
  /** Set while parked. Absent ⇒ the task is not waiting on anyone. Required on
   *  entry to `waiting` at the adapter, so an absent value here means a legacy
   *  park rather than a legal one. */
  blockedOn?: BlockedOn
  /** THE SNOOZE (epoch ms), parsed by the adapter so this stays clock-free.
   *  While it is in the future the task drops to the daily clock; the moment it
   *  passes, the task is back on its blocker's own clock with no transition and
   *  nothing remembered. */
  resumeAt?: number
  /** Last event on this task's stream (epoch ms). */
  lastEventAt: number
  /** An unacked nag for this task, addressed to the CURRENT holder, sits in
   *  pending — resolved by the adapter from the pending projection. While
   *  true the holder is still TOLD (the notifier re-announces on its ladder),
   *  so this machine emits nothing and its pace clock slides (decision (a),
   *  task 050). Per-holder on purpose: a handoff makes the old nag stale, and
   *  the new holder's first nag must not be gated on someone else's ack. */
  nagOutstanding?: boolean
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
  /** The sensei's name, or null on a dojo where none has ever registered.
   *  EVERY emission below is addressed here — there is no second recipient. */
  sensei: string | null
  tasks: SupervisedTask[]
  agents: SupervisedAgent[]
  /** DIALS — the three reminder clocks, one per blocker. `senseiReminderMs` is
   *  the short one and is deliberately the tightest: a `sensei` block is
   *  transitory by design and a worker is stalled while it sits. */
  senseiReminderMs: number
  humanReminderMs: number
  /** `external` blocks, and any snoozed task whatever its blocker. */
  dailyReminderMs: number
  /** H4's silence bound for a session-alive worker holding active work. */
  stuckAfterMs: number
  /** The probe bound for an agent HOLDING WORK (in-progress or assigned). */
  brokenAfterMs: number
  /** The probe bound for an agent holding nothing — deliberately far longer:
   *  an idle agent that has stopped costs nothing until it is dispatched to,
   *  and the point is to know before that happens rather than at once. */
  brokenAfterIdleMs: number
  /** How long a probed agent has to answer before it is reported down. */
  probeTimeoutMs: number
}

/**
 * The adapter side — ONE effect, and the singularity is the guard.
 *
 * ── NO TRANSPORT AT ALL (ruled 2026-08-14) ──
 *
 * There was a `pushBridge` here: the direct line to the human's surface, used
 * by S8's human-held nag and S11's broken-agent report. It is deleted, port and
 * all. Infra emits facts; the sensei decides what is worth a human's attention.
 * Removing the port rather than its call sites is what makes that structural —
 * a future arm cannot reach the human by remembering to, because there is
 * nothing to reach it with.
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
 * (Found by Codex in the transition's adversarial pass, task 045. The nag's
 * announce leg now stamps correctly for free: it is the notifier's own push,
 * which stamps by decision-snapshot ids — decision (c), task 050.)
 */
export type SupervisionExecutor = {
  emit: (type: string, data: Record<string, unknown>) => void
}

export type Supervisor = {
  /** One tick. Everything this machine does, it does from here. */
  tick: (view: SupervisionView) => void
}

/** Per-task nag bookkeeping (S7/S8 — waiting tasks only, since H4). */
type TaskState = { lastNaggedAt: number }
/**
 * Per-agent liveness bookkeeping (S11).
 *
 * THREE STATES, and the middle one is the whole redesign. `ok` is the implicit
 * initial state; `probed` means a question is outstanding and its answer is
 * still due; `down` means the question went unanswered and the sensei has been
 * told once. Any activity returns an agent to `ok` from either of the others —
 * which is what makes this edge-triggered rather than a metronome.
 */
type AgentState = { status: 'ok' | 'probed' | 'down'; probedAt: number }
/** H4's per-worker status machine. `ok` is the implicit initial state: a
 *  worker first observed already-down still announces, because the change is
 *  from the watcher's baseline, not from an unobservable past. */
type WorkerStatus = 'ok' | 'down' | 'up-but-stuck'

/** Statuses that put a worker on the watch-list. `assigned` is here on purpose
 *  — see the header's tiered-bound note. */
function holdsWork(status: TaskStatus): boolean {
  return status === 'in-progress' || status === 'assigned'
}

/**
 * How often this parked task should remind, or null if it should not.
 *
 * The blocker picks the clock; a live snooze demotes it to daily. Both are read
 * fresh from `now` every tick, which is what makes the restore automatic: there
 * is no "snoozed" flag to unset and no memory of what the task was demoted
 * FROM, because it never left its blocker.
 *
 * A legacy park with no blocker at all gets the daily clock rather than
 * silence: an unclassifiable parked task is exactly the thing that must not
 * vanish, and daily is the floor for everything parked.
 */
function cadenceFor(task: SupervisedTask, view: SupervisionView): number | null {
  if (task.resumeAt !== undefined && view.now < task.resumeAt) return view.dailyReminderMs
  switch (task.blockedOn) {
    case 'sensei':
      return view.senseiReminderMs
    case 'human':
      return view.humanReminderMs
    case 'external':
      return view.dailyReminderMs
    default:
      return view.dailyReminderMs
  }
}

export function createSupervisor(exec: SupervisionExecutor): Supervisor {
  const tasks = new Map<string, TaskState>()
  const workers = new Map<string, WorkerStatus>()
  const agents = new Map<string, AgentState>()

  return {
    tick(view) {
      // ── S7/S8 — a parked task nags whoever currently holds the blocker ──
      //
      // WAITING TASKS ONLY. The in-progress arm — the old S10 ladder — is
      // deleted per H4; an in-progress task's coverage is its worker's status,
      // watched below.
      for (const task of view.tasks) {
        if (task.status !== 'waiting') continue
        // THE BLOCKER PICKS THE CLOCK, and a snooze demotes it to daily until
        // its date passes. Computed per tick from `now`, so the restore needs
        // no transition and no memory: the moment `resumeAt` is in the past the
        // task is simply back on its own blocker's clock.
        const cadence = cadenceFor(task, view)
        if (cadence === null) continue
        const state = tasks.get(task.id) ?? { lastNaggedAt: 0 }
        // AN OUTSTANDING NAG GATES RE-EMISSION (decision (a), task 050). The
        // holder is still told — the event sits unacked in its mailbox and
        // the notifier re-announces on its ladder; a second emission would be
        // a duplicate of one fact. The pace clock SLIDES meanwhile, so the
        // next window is measured from the clearing: re-nagging one tick
        // after an ack would punish exactly the read-before-ack behaviour
        // the codes exist to produce.
        if (task.nagOutstanding) {
          tasks.set(task.id, { lastNaggedAt: view.now })
          continue
        }
        // ACTIVITY ON THE TASK RESETS THE CLOCK. Derived from the task's own
        // last event rather than signalled, so answering on task A does not
        // quiet task B.
        const since = Math.max(task.lastEventAt, state.lastNaggedAt)
        if (view.now - since < cadence) continue
        // ONE RECIPIENT, ALWAYS: the sensei. No holder lookup, because there is
        // no longer a holder to look up — a human-blocked task is the sensei's
        // to carry to the human, which is the whole of "infra measures, sensei
        // decides". No sensei, no clock spent (task 040's never-registered
        // corner): the first one to exist is reminded at once.
        const to = view.sensei
        if (!to) continue
        const snoozed = task.resumeAt !== undefined && view.now < task.resumeAt
        const text =
          `Task ${task.id} (${task.title}) is waiting${task.blockedOn ? ` on ${task.blockedOn}` : ''}` +
          `${snoozed ? ' (snoozed)' : ''}.`
        // THE EVENT IS THE NAG (task 050) — it enters the sensei's pending
        // with a code, and the notifier's announcement is the delivery. No
        // transport check, no landed-gate: the mailbox outlives the
        // connection (E1), and announce-on-reconnect is the notifier's job.
        tasks.set(task.id, { lastNaggedAt: view.now })
        exec.emit('task-reminder', { taskId: task.id, to, text, queued: true })
      }

      // ── H4 — worker status, per worker, on change edges only ──
      //
      // WORK INCLUDES `assigned` (ruled 2026-08-14): a worker that stopped
      // holding a dispatched-but-unstarted task used to be watched by nothing
      // at all.
      const holding = new Set(view.tasks.filter((t) => holdsWork(t.status) && t.agent).map((t) => t.agent as string))
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

      // ── S11 — PROBE, THEN ESCALATE. Never alarm first. ──
      for (const agent of view.agents) {
        const state = agents.get(agent.name) ?? { status: 'ok' as const, probedAt: 0 }

        // ANY ACTIVITY ENDS THE EPISODE, from either non-ok state. Measured
        // against the probe rather than against `now`, because that is the
        // question actually being asked: did anything happen AFTER we asked?
        if (state.status !== 'ok' && agent.lastActivityAt > state.probedAt) {
          agents.set(agent.name, { status: 'ok', probedAt: 0 })
          continue
        }

        // ALREADY REPORTED. One event per down-episode: re-emitting on a cycle
        // is the metronome this redesign exists to delete.
        if (state.status === 'down') continue

        if (state.status === 'probed') {
          if (view.now - state.probedAt < view.probeTimeoutMs) continue
          // The question went unanswered, so now there is something to say.
          // ADDRESSED TO THE SENSEI ALONE, and the subject is deliberately NOT
          // in `data.agent`: that field is what derived mailbox membership
          // resolves on, and naming the subject there is precisely what used to
          // deliver the alarm to the accused (waking it, which then cleared the
          // alarm, which is why 23 of these produced zero all-clears). `subject`
          // carries the name; membership resolves to nobody, so only the
          // sensei's universal mailbox claims it — including when the subject
          // IS the sensei, which is the case that must never orphan.
          const quietMinutes = Math.round((view.now - agent.lastActivityAt) / 60_000)
          agents.set(agent.name, { status: 'down', probedAt: state.probedAt })
          exec.emit('agent-down', {
            subject: agent.name,
            to: view.sensei ?? undefined,
            quietMinutes,
            text: `${agent.name} did not answer a liveness probe — silent ${quietMinutes} min.`,
            queued: true,
          })
          continue
        }

        // ── `ok`: is it time to ASK? ──
        //
        // SESSION-ALIVE ONLY. A gone session is not a question — infra already
        // knows the answer, and `worker-status: down` above reports it on the
        // edge. Probing a corpse would produce a guaranteed timeout and a
        // second report of one fact.
        if (!agent.sessionLive) continue
        const bound = holding.has(agent.name) ? view.brokenAfterMs : view.brokenAfterIdleMs
        if (view.now - agent.lastActivityAt < bound) continue
        const quietMinutes = Math.round((view.now - agent.lastActivityAt) / 60_000)
        agents.set(agent.name, { status: 'probed', probedAt: view.now })
        // AN ORDINARY MESSAGE, and that is the point. It is addressed to the
        // agent, enters its mailbox, and the notifier announces it exactly as
        // it announces anything else. It accuses nobody and pushes nowhere
        // else; if the agent answers, this exchange leaves no report at all.
        exec.emit('agent-probe', {
          agent: agent.name,
          quietMinutes,
          text: `Liveness check — you have been quiet for ${quietMinutes} min. Reply to confirm you are alive.`,
          queued: true,
        })
      }
    },
  }
}
