/**
 * The supervisor — parked-work reminders and agent liveness (spec §0,
 * §4-liveness; contract `contracts/supervisor.ts`, task D9).
 *
 * ── THE TWO ROW-CLOSURES ARE STRUCTURAL, NOT CHECKED ──
 *
 * Register row 8 (an agent with pending mail is probed anyway) cannot be
 * written here, because `hasPendingMail` guards BOTH probe-emission sites —
 * the stuck question and the idle ping — and nothing else emits a probe.
 * Its ladder is already the probe: silence with mail waiting is answered by
 * the notifier repeating, so a second mechanism asking the same question
 * would only add a message the agent must clear. The guard is scoped to
 * probe EMISSION deliberately (task 102): down, the probed verdict, and
 * recovery are not probes, and mail never shields them — a probe mints
 * mail, so a blanket exit made every verdict cancel itself.
 *
 * Register row 7 (a report with no matching return — extended to EVERY
 * report kind, down or up-but-stuck, at task 100's round) cannot be written
 * either, because the recovery is emitted by the same code that clears the
 * episode — the report and its return are one branch, not two that have to
 * agree. An episode that never reported ends silently for the same reason:
 * there is nothing to clear.
 *
 * ── PROBE BEFORE VERDICT ──
 *
 * `up-but-stuck` is never emitted without a probe first, and never before the
 * answer window has elapsed. Two bounds, both injected: the agent is asked
 * only after `stuckAfterMs` of silence, and reported only `probeTimeoutMs`
 * after being asked. A verdict without a question is a guess about a session
 * nobody interrogated — and the whole point of the probe is that being asked
 * is itself the thing that might wake it.
 *
 * ── ONE READING THE CONFIG DOES NOT NAME ──
 *
 * There is no `downAfterMs`. A DISCONNECTED agent has no session to probe, so
 * the probe-then-report shape has nothing to hang on, and the verdict has to
 * come from silence alone. `stuckAfterMs` is used as that bound: it is the
 * configured answer to "how long is too long to hear nothing", and reading it
 * as one bound with two consequences — ask if you can, conclude if you cannot
 * — is the only interpretation that does not invent a number. Recorded on
 * task 099; CONFIRMED into the contract at task 100 (see `stuckAfterMs`'s
 * doc there — splitting, if operations ever want it, is an additive config
 * field, not a rewrite).
 *
 * ── REMINDERS: THE BLOCKER PICKS THE CLOCK, THE SNOOZE DEMOTES IT ──
 *
 * Cadence comes from `blockedOn`, measured from `blockedSinceMs` — the CURRENT
 * holder's claim, not the task's age. A live `resumeAtMs` demotes any blocker
 * to the daily floor and NEVER silences: the parked task still surfaces once a
 * day, and the instant the date passes the blocker's own cadence resumes with
 * no event needed to restart it, because the demotion is computed per tick
 * rather than stored. A snooze that had to be un-set would be a snooze that
 * could be forgotten.
 *
 * An empty board emits nothing, which is the digest-is-not-a-job ruling
 * holding by construction: reminders are per parked task, so with none parked
 * there is no loop body to run.
 *
 * ── FACTS ARE THE COMPOSER'S (R10) ──
 *
 * `blockedSinceMs` is required, so a pre-pin task arrives with the composer's
 * honest floor already substituted. Nothing here re-validates it — and that
 * is what stops a legacy gap becoming a nag storm: there is no branch that
 * could treat "missing" as "zero" and remind every tick.
 *
 * What this file cannot enforce, and what does: every liveness clause, both
 * row closures, the cadence table, snooze demotion and resumption, and §0's
 * exclusion are held by `supervisor.conformance.test.ts`.
 */

import type {
  SupervisedAgentFacts,
  SupervisedTaskFacts,
  SupervisorConfig,
  SupervisorContract,
  SupervisorDecision,
  SupervisorEffect,
  SupervisorState,
  SupervisorView,
} from '../contracts/supervisor.ts'
import type { AgentName } from '../contracts/vocabulary.ts'

// ── State ────────────────────────────────────────────────────────

type Episode = {
  /** A probe is outstanding — the edge-trigger guard. One question at a time,
   *  so nothing accumulates in a down worker's mailbox. */
  readonly probedAt: number | undefined
  /** WHICH question is outstanding (task 115's round): the stuck probe and
   *  the idle ping share the edge-trigger, and the verdict may fire only
   *  off a STUCK ask — an idle ping's mark reaching the engaged branch
   *  would trigger an up-but-stuck report with no fresh question (a stale
   *  verdict, reachable pre-115 via idle→engaged). */
  readonly probeKind: 'stuck' | 'idle' | undefined
  /** What this episode has already told the orchestrator, so the return can
   *  match the report. Undefined = nothing reported, so nothing to close. */
  readonly reported: 'down' | 'up-but-stuck' | undefined
}

type Supervision = {
  readonly agents: ReadonlyMap<AgentName, Episode>
  /** taskId → when it was last reminded. Absent = never, and then the zero is
   *  `blockedSinceMs`. */
  readonly reminded: ReadonlyMap<string, number>
}

const NO_EPISODE: Episode = { probedAt: undefined, probeKind: undefined, reported: undefined }

function unwrap(state: SupervisorState): Supervision {
  return state as unknown as Supervision
}
function seal(next: Supervision): SupervisorState {
  return next as unknown as SupervisorState
}

// ── Reminders ────────────────────────────────────────────────────

/** The blocker's own clock, or the daily floor while a snooze is live. The
 *  demotion is computed per tick and never stored — see the header. */
function cadenceFor(task: SupervisedTaskFacts, now: number, config: SupervisorConfig): number {
  if (task.resumeAtMs !== undefined && task.resumeAtMs > now) return config.dailyReminderMs
  switch (task.blockedOn) {
    case 'sensei':
      return config.senseiReminderMs
    case 'human':
      return config.humanReminderMs
    default:
      // `external`, and anything a newer writer parks on: the daily floor is
      // the safe cadence for a blocker this build does not recognise — it
      // still surfaces, just not often.
      return config.dailyReminderMs
  }
}

// ── Liveness ─────────────────────────────────────────────────────

/** Never observed reads MAXIMALLY QUIET — the same rule the notifier uses,
 *  and for the same reason: absence of evidence is not evidence of presence. */
function quietFor(agent: SupervisedAgentFacts, now: number): number {
  return now - (agent.lastActivityAt ?? Number.NEGATIVE_INFINITY)
}

// ── The contract ─────────────────────────────────────────────────

export const supervisor: SupervisorContract = {
  initial: () => seal({ agents: new Map(), reminded: new Map() }),

  decide(state: SupervisorState, view: SupervisorView, config: SupervisorConfig): SupervisorDecision {
    const current = unwrap(state)
    const effects: SupervisorEffect[] = []
    const reminded = new Map(current.reminded)
    const agents = new Map(current.agents)
    const orchestrator = view.orchestrator

    // ── Reminders ──
    // Every effect below is addressed TO the orchestrator, so with no
    // orchestrator on record there is nobody to tell and nothing is emitted —
    // never a fallback recipient (P4's orphan class, same rule as resolution).
    if (orchestrator !== undefined) {
      for (const task of view.tasks) {
        // Only PARKED work reminds. A task in flight is not waiting on anyone.
        if (task.status !== 'waiting') continue
        // THE ZERO IS THE LATER OF THE TWO. A task that was reminded, unparked
        // and parked again keeps its old `reminded` entry — and that entry
        // predates the CURRENT holder's claim, so measuring from it would fire
        // the new park's first reminder early, sometimes immediately (codex
        // pass, task 099). `blockedSinceMs` is the floor: no reminder made
        // before this park began is a reminder about this park.
        const since = Math.max(reminded.get(task.id) ?? Number.NEGATIVE_INFINITY, task.blockedSinceMs)
        if (now(view) - since < cadenceFor(task, now(view), config)) continue
        effects.push({
          kind: 'remind',
          taskId: task.id,
          to: orchestrator,
          // The blocker as recorded. The cadence may have been demoted by a
          // snooze, but WHO is being waited on does not change with it.
          blockedOn: task.blockedOn ?? 'external',
          // Age from the CURRENT holder's claim, which is what the reminder is
          // about — not from the task's creation.
          ageMs: now(view) - task.blockedSinceMs,
        })
        reminded.set(task.id, now(view))
      }
    }

    // ── Liveness ──
    for (const agent of view.agents) {
      // ONLY WORKERS ARE SUPERVISED. A `user` or `peer` shape in this view is
      // not a worker and has no session this dojo runs — unassumed input,
      // answered by not answering.
      if (agent.role !== 'worker') continue
      // §0, stated separately because it is a separate rule: infra does not
      // supervise the orchestrator, however silent. A report about the
      // orchestrator's own failure has no in-dojo consumer — it would be
      // addressed to the agent whose silence caused it.
      if (orchestrator !== undefined && agent.name === orchestrator) continue

      const episode = agents.get(agent.name) ?? NO_EPISODE
      const quiet = quietFor(agent, view.now)

      // RECOVERY FIRST, so a returning agent is closed out before any new
      // verdict can be opened on it. Back = a live session that has been heard
      // from recently; that is the same signal `down` keys on, read the other
      // way round.
      if (agent.connected && quiet < config.stuckAfterMs) {
        if (episode.reported !== undefined) {
          // A REPORT IS OUTSTANDING AND MUST BE CLOSED. With no orchestrator
          // there is nobody to tell, so the episode STAYS OPEN and the return
          // is emitted when a recipient exists. Clearing it here would lose
          // the matching return outright — row 7 broken by a between-boot
          // moment nobody would ever connect to the missing report (codex
          // pass, task 099).
          if (orchestrator === undefined) continue
          effects.push({ kind: 'report', to: orchestrator, subject: agent.name, status: 'recovered', quietMs: quiet })
        }
        // An episode that reported nothing ends silently — row 7's other half,
        // and the same line.
        agents.delete(agent.name)
        continue
      }

      // REGISTER ROW 8 gates PROBE EMISSION ONLY (scoped at task 102): mail
      // waiting means the notifier's ladder is already asking the liveness
      // question, so no NEW probe is emitted below — but down, the probed
      // verdict, and recovery are not probes, and mail never shields them.
      // The earlier blanket exit here made every report unreachable under
      // composition: a probe MINTS mail (agent-probe is queued, addressed),
      // so the verdict tick always saw a mail-holder and skipped, and a
      // disconnected agent with queued dispatches could never read down.

      if (!agent.connected) {
        // No session to probe: the verdict has to come from silence alone —
        // mail or no mail (its ladder is refused wakes, not liveness).
        // Edge-triggered — one report per episode, not a stream.
        if (quiet >= config.stuckAfterMs && episode.reported === undefined && orchestrator !== undefined) {
          effects.push({ kind: 'report', to: orchestrator, subject: agent.name, status: 'down', quietMs: quiet })
          agents.set(agent.name, { ...episode, reported: 'down' })
        }
        continue
      }

      if (agent.engaged) {
        // UP-BUT-STUCK: a live session MID-WORK that has gone quiet.
        // `engaged` is in-progress only (ruled, task 115): a waiting
        // task's holder is on no clock — the parked task reminds the
        // orchestrator — and an assigned-not-started task is the
        // orchestrator's follow-up, not a session fault.
        if (episode.probedAt === undefined || episode.probeKind !== 'stuck') {
          // No STUCK question outstanding (an idle ping's mark does not
          // count — the verdict may only answer the question that was
          // asked). Row 8's actual scope: never probe a mail-holder.
          if (!agent.hasPendingMail && quiet >= config.stuckAfterMs) {
            effects.push({ kind: 'probe', agent: agent.name, quietMs: quiet })
            agents.set(agent.name, { ...episode, probedAt: view.now, probeKind: 'stuck' })
          }
          continue
        }
        // Asked, and the answer window has run out. Reported ONCE.
        if (view.now - episode.probedAt >= config.probeTimeoutMs && episode.reported === undefined) {
          // THE STATE RECORDS ONLY WHAT WAS ACTUALLY EMITTED. With no
          // orchestrator nothing is reported, so nothing may be marked
          // reported — otherwise the agent's return later emits a `recovered`
          // closing a report that was never made, which is a return for a
          // silent episode (codex pass, task 099). The verdict simply waits
          // for a recipient; the probe has already been asked.
          if (orchestrator === undefined) continue
          effects.push({
            kind: 'report',
            to: orchestrator,
            subject: agent.name,
            status: 'up-but-stuck',
            quietMs: quiet,
          })
          agents.set(agent.name, { ...episode, reported: 'up-but-stuck' })
        }
        continue
      }

      // AN OUTSTANDING STUCK PROBE LAPSES WITH THE ENGAGEMENT (task 115's
      // round): the probe asked "you are mid-work and silent — alive?";
      // with the work parked or closed the question is moot, and keeping
      // the mark would let a LATER re-engagement trigger the verdict off
      // the stale ask — an up-but-stuck report with no fresh question,
      // minutes into new silence. Only the STUCK mark lapses (an idle
      // ping's edge-trigger must survive, or every tick past the idle
      // bound re-pings — the D8 storm's shape); a REPORTED episode is
      // kept: the report is an open claim only the agent's return closes
      // (row 7).
      let current2 = episode
      if (episode.probeKind === 'stuck' && episode.reported === undefined) {
        agents.delete(agent.name)
        current2 = NO_EPISODE
      }
      // A holder of only waiting or assigned work: neither probed nor
      // pinged (task 115) — not engaged, and not idle-empty either.
      if (agent.holdsUndone) continue

      // IDLE AND EMPTY: no work, no mail. Pinged once after the configured
      // silence — ordinary addressed mail whose acknowledgement resets the
      // clock. Edge-triggered, so a worker that never comes back accumulates
      // exactly one. Row 8's guard again: a mail-holder is never pinged.
      if (!agent.hasPendingMail && quiet >= config.idlePingAfterMs && current2.probedAt === undefined) {
        effects.push({ kind: 'probe', agent: agent.name, quietMs: quiet })
        agents.set(agent.name, { ...current2, probedAt: view.now, probeKind: 'idle' })
      }
    }

    return { next: seal({ agents, reminded }), effects }
  },
}

/** The view's instant. A named read so no branch above can reach for an
 *  ambient clock by habit — every bound in this module is measured against
 *  this one value. */
function now(view: SupervisorView): number {
  return view.now
}
