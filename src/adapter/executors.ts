/**
 * The effect executors — the shell's half of the decide→effects split
 * (design §5's execute step, §6's bag-or-unit; task E1, closing R11).
 *
 * ── THE THREE PAIR-LAWS, AND WHERE EACH IS HELD ──
 *
 * A5 states them; this file is where they become true, and
 * `executors.conformance.test.ts` is where they are held:
 *
 *   (a) EFFECT ORDER — one decision's effects are performed in the order
 *       listed, completely, before anything else reads state.
 *   (b) STAMP RIDES ITS DELIVER — the evidence recorded for an announcement
 *       is the evidence OF THAT deliver, never batched apart from it.
 *   (c) NO INTERLEAVING — one decision's effects never interleave with
 *       another decision's reads.
 *
 * ── WHY THESE ARE LAWS AND NOT COMMENTS ──
 *
 * They are the residue of two welds the old system held BY ADJACENCY. Weld 1
 * put the delivery-ledger take one line above the ack append, so take order
 * and log order coincided; weld 2 put announcement synchronously inside
 * `record()`, so a probe reached its subject before the orchestrator could
 * clear it. Both were true because of where lines sat, and nothing local
 * enforced either — the file headers said so in as many words.
 *
 * `runAnnouncements` replaces the first with structure: the stamp for an
 * announcement is emitted inside the same loop iteration as its deliver, from
 * that deliver's own ids, so there is no window in which a second decision's
 * evidence could be taken first. There is nothing to batch and therefore
 * nothing to batch wrongly.
 *
 * The second is replaced by the runner being SYNCHRONOUS. No `await`, no
 * deferral, no promise: one decision's effects run to completion before
 * control returns, so a reader can only see the state before or after, never
 * during. That is why the conformance suite holds this one STRUCTURALLY as
 * well as behaviourally — a microtask-sized break preserves ordering under
 * bun's scheduler in every test-scale run and would ship green (measured on
 * task 074, whose finding is the reason this file says so out loud). A
 * behavioural test cannot see the defect that matters; reading the source can.
 */

import type { AnnounceEffect, NotifierExecutor, NotifyOutcome } from '../domain/contracts/notifier.ts'
import type { SupervisorEffect } from '../domain/contracts/supervisor.ts'
import type { AgentName, DeliveredVia } from '../domain/contracts/vocabulary.ts'

/** What the shell can do with a supervision effect. Separate from the
 *  notifier's because the two decide different things — sharing one executor
 *  would make an unrelated change to one able to break the other. */
export type SupervisionExecutor = {
  deliver: (to: AgentName, text: string) => boolean
  emit: (type: string, data: unknown) => void
}

/** The summary line's rendering — the ONE place announcement prose exists.
 *  Core returns counts and flags (`pendingCount`, `hasBlocking`); turning them
 *  into words is presentation, and presentation is the adapter's. */
export function renderAnnouncement(effect: AnnounceEffect): string {
  const what = effect.pendingCount === 1 ? '1 event' : `${effect.pendingCount} events`
  return effect.hasBlocking
    ? `${what} pending — someone is waiting on you. Read with the inbox tool; acking is what clears them.`
    : `${what} pending. Read with the inbox tool; acking is what clears them.`
}

/**
 * Perform one notifier decision's announcements and report what happened.
 *
 * SYNCHRONOUS BY CONSTRUCTION — see the header. Every effect is finished
 * before the next begins, and the whole list is finished before this returns,
 * which is laws (a) and (c) with no mechanism beyond the absence of a yield.
 *
 * Returns the outcomes rather than applying them: `applyOutcome` is the
 * domain's, and a shell that folded feedback itself would be deciding.
 */
export function runAnnouncements(
  effects: readonly AnnounceEffect[],
  exec: NotifierExecutor,
  via: DeliveredVia = 'wake',
): NotifyOutcome[] {
  const outcomes: NotifyOutcome[] = []
  for (const effect of effects) {
    const accepted = exec.deliver(effect.to, renderAnnouncement(effect))
    // LAW (b), structural: the stamp is written here, from THIS effect's ids,
    // in the same iteration as the deliver whose evidence it is. Collecting
    // ids to stamp after the loop would be the batching the law forbids — and
    // would reintroduce exactly the window weld 1 held shut by adjacency.
    //
    // A refused deliver stamps NOTHING: there is no delivery to be evidence
    // of, and recording one would tell a later reader the agent was reached.
    if (accepted) exec.stamp(via, effect.ids)
    // The history record — `nudge` carries the queue as of emission, which is
    // what makes a replayed log show what the agent was told at the time.
    exec.emit('nudge', { pendingCount: effect.pendingCount })
    outcomes.push({ kind: 'announced', agent: effect.to, ids: effect.ids, accepted })
  }
  return outcomes
}

/**
 * Perform one supervisor decision's effects. Same shape and the same laws;
 * there is no stamp here because a reminder, probe or report is addressed
 * mail, not an announcement about mail — the events it emits go through the
 * ordinary resolution path and get their evidence when they are delivered.
 */
export function runSupervision(effects: readonly SupervisorEffect[], exec: SupervisionExecutor): void {
  for (const effect of effects) {
    switch (effect.kind) {
      case 'remind':
        exec.emit('task-reminder', {
          taskId: effect.taskId,
          to: effect.to,
          text: `Task ${effect.taskId} is parked on ${effect.blockedOn}.`,
          queued: true,
        })
        break
      case 'probe':
        exec.emit('agent-probe', {
          agent: effect.agent,
          quietMinutes: Math.round(effect.quietMs / 60_000),
          text: 'Still there? Acknowledging this resets your liveness clock.',
          queued: true,
        })
        break
      case 'report':
        // ONE EVENT, NOT A PAIR (the liveness block): the addressed record IS
        // the report. A general record plus a follow-up to handle would
        // reintroduce the forgot-to-route hazard one level up.
        exec.emit(effect.status === 'recovered' || effect.status === 'up-but-stuck' ? 'worker-status' : 'agent-down', {
          ...(effect.status === 'down'
            ? { subject: effect.subject, to: effect.to }
            : { agent: effect.subject, status: effect.status }),
          quietMinutes: Math.round(effect.quietMs / 60_000),
          text: `${effect.subject}: ${effect.status}`,
          queued: true,
        })
        break
    }
  }
}
