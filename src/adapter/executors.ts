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
import type { DeliveredVia } from '../domain/contracts/vocabulary.ts'

/**
 * What the shell can do with a supervision effect: EMIT, and nothing else.
 *
 * Separate from the notifier's because the two decide different things —
 * sharing one executor would make an unrelated change to one able to break
 * the other. And narrower than the notifier's on purpose: E1 gave this type a
 * `deliver` that `runSupervision` never called, and an executor capability
 * nobody uses is a weld waiting to be made. A reminder, a probe and a report
 * are ADDRESSED MAIL — they reach their subjects through the ordinary
 * resolution path, and a shell that also handed them to a transport here
 * would deliver each of them twice. The type is now unable to say it (E2).
 */
export type SupervisionExecutor = {
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
    //
    // AND NOTHING THAT DID NOT HAPPEN IS RECORDED. A refused deliver leaves
    // no stamp AND no `nudge`: the record exists so a replayed log shows what
    // the agent was told at the time, and an agent that was never reached was
    // never told. This matters more than it reads — a refused announcement
    // does not advance the episode (the ladder must not go quiet over a wake
    // nobody received), so the agent is due again at the very next tick. Emit
    // unconditionally and a disconnected agent holding one message writes a
    // `nudge` per tick, forever, each one claiming a telling that did not
    // occur. E1 shipped that; E3 fixed it, and the loud direction is the same
    // one D8's non-suppression ruling guards from the other side.
    if (accepted) {
      exec.stamp(via, effect.ids)
      exec.emit('nudge', { pendingCount: effect.pendingCount })
    }
    outcomes.push({ kind: 'announced', agent: effect.to, ids: effect.ids, accepted })
  }
  return outcomes
}

/** Minutes, rounded, never NaN (R13): a quietMs the composer could not
 *  measure must not become a `NaN` in a fact — it fails every comparison and
 *  reads LOUD downstream. Zero is the honest floor for "no measured silence". */
const quietMinutes = (ms: number): number => (Number.isFinite(ms) ? Math.round(ms / 60_000) : 0)

/**
 * Perform one supervisor decision's effects.
 *
 * SYNCHRONOUS BY CONSTRUCTION, like `runAnnouncements` and for the same
 * reason — laws (a) and (c) with no mechanism beyond the absence of a yield.
 * Law (b) has nothing to bind here: there is no stamp, because a reminder,
 * probe or report is ADDRESSED MAIL rather than an announcement ABOUT mail;
 * the events below go through the ordinary resolution path and get their
 * delivery evidence when they are delivered.
 *
 * ── WHAT THIS FUNCTION IS ACTUALLY DECIDING, AND WHY IT IS PINNED ──
 *
 * It looks like a rename and is not quite one: the effect union says
 * `status: 'down' | 'up-but-stuck' | 'recovered'`, and the VOCABULARY has two
 * different kinds with two different data shapes behind those three values.
 * Choosing the kind, and filling the shape that kind declares, is this
 * executor's own mapping — which is exactly the kind of code that can be
 * wrong in silence. `data.agent` on an `agent-probe` is what the resolution
 * table reads to address the probe; spell it `subject` and the probe is
 * written, folded, and delivered to nobody, with nothing anywhere failing.
 * `executors.conformance.test.ts` holds the mapping against the vocabulary
 * and against the real resolver, which is the only reader whose opinion
 * decides whether these events arrive.
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
        // `agent` IS THE ADDRESS. §4 resolves a probe by reading this field —
        // it is the one event whose entire purpose is to reach the agent it
        // is about, and the only field name here that can fail silently.
        exec.emit('agent-probe', {
          agent: effect.agent,
          quietMinutes: quietMinutes(effect.quietMs),
          text: 'Still there? Acknowledging this resets your liveness clock.',
          queued: true,
        })
        break
      case 'report':
        // ONE EVENT, NOT A PAIR (the liveness block): the addressed record IS
        // the report. A general record plus a follow-up to handle would
        // reintroduce the forgot-to-route hazard one level up.
        //
        // TWO KINDS, TWO SHAPES. `agent-down` names its `subject` and its
        // addressee; `worker-status` names the `agent` and its verdict and
        // has NO quietMinutes field in the census — so the silence goes into
        // the prose, where it is presentation, rather than into an undeclared
        // field a reader of the vocabulary would never look for.
        if (effect.status === 'down') {
          exec.emit('agent-down', {
            subject: effect.subject,
            to: effect.to,
            quietMinutes: quietMinutes(effect.quietMs),
            text: `${effect.subject} is down — silent for ${quietMinutes(effect.quietMs)} minutes.`,
            queued: true,
          })
          break
        }
        exec.emit('worker-status', {
          agent: effect.subject,
          status: effect.status,
          text:
            effect.status === 'recovered'
              ? `${effect.subject} is back.`
              : `${effect.subject} is up but stuck — silent for ${quietMinutes(effect.quietMs)} minutes.`,
          queued: true,
        })
        break
    }
  }
}
