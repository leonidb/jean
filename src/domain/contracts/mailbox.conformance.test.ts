/**
 * Mailbox conformance — the executable form of spec §2 and P1–P7, P10.
 *
 * RED BY ABSENCE until D2 lands `src/domain/mailbox/index.ts` exporting
 * `mailbox: MailboxContract`. No plausible stubs anywhere (design §9).
 *
 * Written from the spec and the design only. Every scenario keeps agents'
 * mailboxes non-coincident (§5) — pairwise distinct and never equal to the
 * dojo-wide total — and composed cases run the generic replay checker
 * alongside their specific assertions (design §7's two-kinds rule).
 *
 * The fold takes an INJECTED resolver (`recipientsOf`, ruled task 083), so
 * the scripted cases inject an EXPLICIT per-event recipients table — their
 * verdicts genuinely do not depend on the resolution module's correctness.
 * Only the randomized run composes the real resolution (D1), deliberately:
 * that run is the cross-module detector.
 */

import { describe, expect, test } from 'bun:test'
import {
  assertNonCoincident,
  counted,
  createCast,
  createClock,
  createLog,
  createRng,
  replayCheck,
} from '../fixture/index.ts'
import type { MailboxContract } from './mailbox.ts'
import type { ResolutionContext, ResolutionContract } from './resolution.ts'
import type { AgentName, AgentRole, DeliveredVia } from './vocabulary.ts'

const IMPL_PATH: string = '../mailbox/index.ts'
const mailbox: MailboxContract = await import(IMPL_PATH)
  .then((m) => (m as { mailbox: MailboxContract }).mailbox)
  .catch((err: unknown) => {
    if (String(err).includes('Cannot find module')) {
      throw new Error(
        'RED BY ABSENCE — src/domain/mailbox/index.ts does not exist yet. ' +
          'Task D2 implements the MailboxContract; nothing else may (no plausible stubs — design §9).',
      )
    }
    throw err
  })

const ORCH = 'orchestrator-o'
const WORKER_A = 'worker-a'
const WORKER_B = 'worker-b'
const HUMAN = 'human-h'

const roleOf = (name: AgentName): AgentRole | undefined =>
  name === ORCH ? 'sensei' : name === HUMAN ? 'user' : name === WORKER_A || name === WORKER_B ? 'worker' : undefined

/** The suite's own authorship declaration — the speech kinds only, per the
 *  SenderOf composition rule. Machine senders (`infra`, `api`) have no
 *  authorship, exactly as resolution.authorOf answers (codex pass, 090). */
const senderOf = (e: { type: string; data: unknown }): AgentName | undefined => {
  const d = (e.data ?? {}) as { agent?: unknown; from?: unknown }
  if (e.type === 'send')
    return typeof d.from === 'string' && d.from !== 'infra' && d.from !== 'api' ? d.from : undefined
  if (e.type === 'reply' || e.type === 'task-comment' || e.type === 'memory')
    return typeof d.agent === 'string' ? d.agent : undefined
  return undefined
}
const FACTS = { roleOf, senderOf }

const noEvidence = (): DeliveredVia | undefined => undefined

/** A three-recipient scripted world with an EXPLICIT recipients table —
 *  membership by declaration, not by any module's logic. Non-coincident by
 *  construction: A holds {send1, comment}, B holds {send2}, ORCH holds
 *  {reply, comment}. */
function scriptedWorld() {
  const log = createLog(createClock())
  const send1 = log.append('send', `agent-${WORKER_A}`, { agent: WORKER_A, from: ORCH, text: 'to A', queued: true })
  const send2 = log.append('send', `agent-${WORKER_B}`, { agent: WORKER_B, from: ORCH, text: 'to B', queued: true })
  const reply = log.append('reply', 'task-101', { agent: WORKER_A, text: 'progress' })
  // WORKER_B comments on A's task → held by BOTH ORCH and WORKER_A (the
  // multi-recipient case §5 requires as a positive).
  const comment = log.append('task-comment', 'task-101', { agent: WORKER_B, role: 'worker', text: 'drive-by' })
  const table = new Map<number, readonly string[]>([
    [send1.id, [WORKER_A]],
    [send2.id, [WORKER_B]],
    [reply.id, [ORCH]],
    [comment.id, [ORCH, WORKER_A]],
  ])
  const recipientsOf = (e: { id: number }) => table.get(e.id) ?? []
  return { log, send1, send2, reply, comment, recipientsOf }
}

/** Fold a scripted log into state with its declared table. */
function foldAll(
  events: readonly Parameters<MailboxContract['fold']>[1][],
  recipientsOf: Parameters<MailboxContract['fold']>[2],
) {
  let state = mailbox.initial()
  for (const e of events) state = mailbox.fold(state, e, recipientsOf)
  return state
}

describe('P1/P4 — the fold: pairs from resolution, history never enters', () => {
  test('per-agent mailboxes match ground truth exactly, non-coincident, and pending is their union', () => {
    const { log, send1, send2, reply, comment, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)

    const boxA = mailbox.mailboxOf(state, WORKER_A).map((e) => e.id)
    const boxB = mailbox.mailboxOf(state, WORKER_B).map((e) => e.id)
    const boxO = mailbox.mailboxOf(state, ORCH).map((e) => e.id)

    expect(boxA).toEqual([send1.id, comment.id])
    expect(boxB).toEqual([send2.id])
    expect(boxO).toEqual([reply.id, comment.id])

    const pairs = mailbox.pendingPairs(state)
    const global = pairs.map((p) => `${p.recipient}:${p.eventId}`).sort()
    const union = [
      ...boxA.map((id) => `${WORKER_A}:${id}`),
      ...boxB.map((id) => `${WORKER_B}:${id}`),
      ...boxO.map((id) => `${ORCH}:${id}`),
    ].sort()
    expect(global).toEqual(union) // P4: pending IS the union of mailboxes

    assertNonCoincident(
      new Map([
        [WORKER_A, boxA],
        [WORKER_B, boxB],
        [ORCH, boxO],
      ]),
      pairs.map((p) => p.eventId),
    )
  })

  test('an empty resolution enters nothing — even for a normally-addressed send — and a stray ack clears nothing', () => {
    // Which kinds ARE history is resolution's contract (pinned there); the
    // mailbox's own obligation is that a zero-recipient event never touches
    // pending — INCLUDING a mail-shaped send, which is the discriminating
    // case: a fold deriving recipients for mail-like kinds itself, instead
    // of consulting the injected resolver, fails here (codex pass, 083).
    const log = createLog(createClock())
    log.append('send', `agent-${WORKER_A}`, { agent: WORKER_A, from: ORCH, text: 'looks like mail', queued: true })
    log.append('ack', 'system', { eventIds: [999] })
    log.append('nudge', `agent-${WORKER_A}`, { pendingCount: 1 })
    log.append('memory', 'memory', { agent: WORKER_A, role: 'worker', text: 'learned', scope: 'dojo' })
    const state = foldAll(log.events(), () => [])
    expect(mailbox.pendingPairs(state)).toEqual([])
    expect(mailbox.mailboxOf(state, WORKER_A)).toEqual([])
    expect(mailbox.mailboxOf(state, ORCH)).toEqual([])
  })
})

describe('§2 — independent acknowledgement, the invariant', () => {
  test("one recipient's ack clears its pair only; the event stays in the other mailbox; last clear removes it from pending", () => {
    const { log, comment, recipientsOf } = scriptedWorld()
    let state = foldAll(log.events(), recipientsOf)
    const code = mailbox.codeFor(comment)

    // ORCH clears its pair on the jointly-held comment.
    const d1 = mailbox.applyAck(state, ORCH, [{ id: comment.id, code }], noEvidence)
    state = d1.next
    expect(d1.cleared.map((c) => c.eventId)).toEqual([comment.id])
    expect(mailbox.mailboxOf(state, ORCH).map((e) => e.id)).not.toContain(comment.id)
    // WORKER_A still holds it — §2's whole point.
    expect(mailbox.mailboxOf(state, WORKER_A).map((e) => e.id)).toContain(comment.id)
    expect(mailbox.pendingPairs(state).some((p) => p.eventId === comment.id)).toBe(true)

    // WORKER_A clears its own pair — now the event leaves pending entirely.
    const d2 = mailbox.applyAck(state, WORKER_A, [{ id: comment.id, code }], noEvidence)
    state = d2.next
    expect(mailbox.pendingPairs(state).some((p) => p.eventId === comment.id)).toBe(false)
  })

  test('double-ack of one pair: the second clears nothing, and acknowledgedCount reads success for both (idempotence)', () => {
    const { log, send1, recipientsOf } = scriptedWorld()
    let state = foldAll(log.events(), recipientsOf)
    const code = mailbox.codeFor(send1)
    const first = mailbox.applyAck(state, WORKER_A, [{ id: send1.id, code }], noEvidence)
    state = first.next
    const second = mailbox.applyAck(state, WORKER_A, [{ id: send1.id, code }], noEvidence)
    expect(first.cleared.length).toBe(1)
    expect(second.cleared.length).toBe(0)
    expect(mailbox.acknowledgedCount(second.next, WORKER_A, [send1.id])).toBe(1)
  })

  test('081 pins: the decision is deeply independent of its inputs and its record; old states stay readable', () => {
    const { log, comment, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    const beforePairs = mailbox
      .pendingPairs(state)
      .map((p) => `${p.recipient}:${p.eventId}`)
      .sort()
    const d = mailbox.applyAck(state, ORCH, [{ id: comment.id, code: mailbox.codeFor(comment) }], noEvidence)
    // Mutating the RETURNED record must not reach the states (indirectly-
    // visible state first — the mutation-survivor class).
    d.record.eventIds.push(999_999)
    d.record.cleared.length = 0
    const oldStill = mailbox
      .pendingPairs(state)
      .map((p) => `${p.recipient}:${p.eventId}`)
      .sort()
    expect(oldStill).toEqual(beforePairs) // the OLD state is genuinely unchanged
    expect(mailbox.mailboxOf(d.next, ORCH).map((e) => e.id)).not.toContain(comment.id) // and the new one holds
    expect(mailbox.mailboxOf(state, ORCH).map((e) => e.id)).toContain(comment.id)
  })

  test('081 pin: acknowledgedCount on a PARTIALLY-cleared joint event answers per caller', () => {
    const { log, comment, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    const d = mailbox.applyAck(state, ORCH, [{ id: comment.id, code: mailbox.codeFor(comment) }], noEvidence)
    // ORCH's pair is cleared; WORKER_A still holds — the entry survives, so
    // both answers come from live state, not the bounded-memory fallback.
    expect(mailbox.acknowledgedCount(d.next, ORCH, [comment.id])).toBe(1)
    expect(mailbox.acknowledgedCount(d.next, WORKER_A, [comment.id])).toBe(0)
  })

  test('acknowledgedCount: the blessed bounded-memory limit — an unknown id also reads 1', () => {
    // Documented limit (contract, ruled task 083): the state is bounded by
    // PENDING, so cleared-long-ago and never-existed are indistinguishable
    // and both read "not held by you" = acknowledged. Attribution questions
    // are the log's, not this counter's.
    const { log, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    expect(mailbox.acknowledgedCount(state, WORKER_A, [999_999])).toBe(1)
  })
})

describe('P5 — read before clear, authorized to clear', () => {
  test('a wrong code clears nothing and is not an error; the right half of a batch still clears', () => {
    const { log, send1, comment, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    const d = mailbox.applyAck(
      state,
      WORKER_A,
      [
        { id: send1.id, code: 'wrong0' },
        { id: comment.id, code: mailbox.codeFor(comment) },
      ],
      noEvidence,
    )
    expect(d.cleared.map((c) => c.eventId)).toEqual([comment.id])
  })

  test('a NON-RECIPIENT presenting a correct code clears nothing — for anyone (register row 3, closed by construction)', () => {
    const { log, send1, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    const code = mailbox.codeFor(send1) // send1 is WORKER_A's mail
    const d = mailbox.applyAck(state, WORKER_B, [{ id: send1.id, code }], noEvidence)
    expect(d.cleared).toEqual([])
    // Nobody's mailbox moved — B's act consumed nothing of A's (§2).
    expect(mailbox.mailboxOf(d.next, WORKER_A).map((e) => e.id)).toContain(send1.id)
    expect(mailbox.acknowledgedCount(d.next, WORKER_B, [send1.id])).toBe(0)
  })

  test('codes are content-derived over the FULL event — envelope and data each move the code', () => {
    const log = createLog(createClock())
    const e1 = log.append('send', `agent-${WORKER_A}`, { agent: WORKER_A, from: ORCH, text: 'one', queued: true })
    const e2 = log.append('send', `agent-${WORKER_A}`, { agent: WORKER_A, from: ORCH, text: 'two', queued: true })
    expect(mailbox.codeFor(e1)).not.toBe(mailbox.codeFor(e2))
    expect(mailbox.codeFor(e1)).toBe(mailbox.codeFor({ ...e1 })) // deterministic
    // Every component of the content participates (codex pass, task 080):
    expect(mailbox.codeFor(e1)).not.toBe(mailbox.codeFor({ ...e1, data: { ...(e1.data as object), text: 'oné' } }))
    expect(mailbox.codeFor(e1)).not.toBe(mailbox.codeFor({ ...e1, id: e1.id + 1000 }))
    expect(mailbox.codeFor(e1)).not.toBe(mailbox.codeFor({ ...e1, ts: new Date(1_755_999_999_999).toISOString() }))
    expect(mailbox.codeFor(e1)).not.toBe(mailbox.codeFor({ ...e1, type: 'reply' }))
    expect(mailbox.codeFor(e1)).not.toBe(mailbox.codeFor({ ...e1, stream: 'agent-somebody-else' }))
  })
})

describe('P6 — accountable clearing: the record names the clearer, carries the evidence', () => {
  test('the decision record: caller, presented pairs verbatim, cleared pairs with per-pair deliveredVia, and old-fold-readable eventIds', () => {
    const { log, send1, comment, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    const presented = [
      { id: send1.id, code: mailbox.codeFor(send1) },
      { id: comment.id, code: 'wrong0' },
    ]
    const evidence = (eventId: number): DeliveredVia | undefined => (eventId === send1.id ? 'wake' : undefined)
    const d = mailbox.applyAck(state, WORKER_A, presented, evidence)

    expect(d.record.caller).toBe(WORKER_A) // P6: named, not "ack"
    expect(d.record.pairs).toEqual(presented) // auditable, including the miss
    expect(d.record.cleared).toEqual([{ eventId: send1.id, deliveredVia: 'wake' }])
    expect(d.record.eventIds).toEqual([send1.id]) // the old fold reads this
  })

  test('absent evidence is recorded as unknown, never invented', () => {
    const { log, send2, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    const d = mailbox.applyAck(state, WORKER_B, [{ id: send2.id, code: mailbox.codeFor(send2) }], noEvidence)
    expect(d.record.cleared).toEqual([{ eventId: send2.id }])
  })

  test('folding the decision record back reproduces the decision state — from `cleared`, never from `pairs`', () => {
    const { log, send1, comment, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    // The record deliberately contains a MISS (wrong code on send1): an
    // implementation that replays `pairs` instead of `cleared` clears the
    // missed pair on refold and fails here (codex pass, task 080).
    const d = mailbox.applyAck(
      state,
      WORKER_A,
      [
        { id: comment.id, code: mailbox.codeFor(comment) },
        { id: send1.id, code: 'wrong0' },
      ],
      noEvidence,
    )
    expect(d.cleared.map((c) => c.eventId)).toEqual([comment.id])
    const ackEvent = log.appendRaw('ack', 'system', d.record)
    const refolded = mailbox.fold(state, ackEvent, recipientsOf)
    const key = (pairs: readonly { recipient: string; eventId: number }[]) =>
      pairs.map((p) => `${p.recipient}:${p.eventId}`).sort()
    expect(key(mailbox.pendingPairs(refolded))).toEqual(key(mailbox.pendingPairs(d.next)))
    // The missed pair survives the refold in WORKER_A's mailbox.
    expect(mailbox.mailboxOf(refolded, WORKER_A).map((e) => e.id)).toContain(send1.id)
  })

  test('a HISTORICAL ack (eventIds, no caller) clears every pair of the named events — replay tolerance, permanently', () => {
    const { log, comment, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    const oldAck = log.appendRaw('ack', 'system', { eventIds: [comment.id] })
    const refolded = mailbox.fold(state, oldAck, recipientsOf)
    expect(mailbox.pendingPairs(refolded).some((p) => p.eventId === comment.id)).toBe(false)
  })

  test('a MALFORMED attributed record clears NOTHING — attribution decides the path, and decides first (D2 report, priority pin)', () => {
    // The 059 shared-flag class reachable through DATA: a record naming a
    // caller but with a damaged `cleared` list also carries eventIds (for the
    // old fold), and an implementation testing `caller && Array.isArray(cleared)`
    // falls through to the historical branch and bulk-clears every holder's
    // pair. D2 reproduced exactly that before fixing it; this pins the fix.
    const { log, comment, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    const before = mailbox
      .pendingPairs(state)
      .map((p) => `${p.recipient}:${p.eventId}`)
      .sort()
    const malformed = [
      log.appendRaw('ack', 'system', { eventIds: [comment.id], caller: ORCH }),
      log.appendRaw('ack', 'system', { eventIds: [comment.id], caller: ORCH, cleared: 'not-a-list' }),
      log.appendRaw('ack', 'system', { eventIds: [comment.id], caller: ORCH, cleared: [{ wrong: 'shape' }] }),
    ]
    let checked = 0
    for (const bad of malformed) {
      const refolded = mailbox.fold(state, bad, recipientsOf)
      const after = mailbox
        .pendingPairs(refolded)
        .map((p) => `${p.recipient}:${p.eventId}`)
        .sort()
      expect(after).toEqual(before) // nothing cleared — for ANY holder
      checked++
    }
    counted('malformed attributed records', checked, 3)
  })
})

describe('P7/P10 — views: three rungs, pure, fresh', () => {
  test('reads change nothing: state answers identically before and after every view', () => {
    const { log, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    const before = mailbox.pendingPairs(state).map((p) => `${p.recipient}:${p.eventId}`)
    mailbox.countsFor(state, ORCH, FACTS)
    mailbox.summaryFor(state, ORCH, FACTS, 1_755_500_100_000)
    mailbox.fetchFor(state, ORCH)
    mailbox.select(state, ORCH, { ids: [1] }, FACTS)
    const after = mailbox.pendingPairs(state).map((p) => `${p.recipient}:${p.eventId}`)
    expect(after).toEqual(before)
  })

  test('freshness is the falling case (P10): views over an evolved state reflect the change immediately', () => {
    const { log, reply, comment, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    const countBefore = mailbox.countsFor(state, ORCH, FACTS).total
    // Read every rung, then evolve the state — the same view calls over the
    // NEW state must answer from it, not from anything a prior call retained.
    mailbox.summaryFor(state, ORCH, FACTS, 1_755_500_100_000)
    mailbox.fetchFor(state, ORCH)
    const d = mailbox.applyAck(state, ORCH, [{ id: reply.id, code: mailbox.codeFor(reply) }], noEvidence)
    const countAfter = mailbox.countsFor(d.next, ORCH, FACTS).total
    expect(countBefore).toBe(2)
    expect(countAfter).toBe(1)
    expect(mailbox.summaryFor(d.next, ORCH, FACTS, 1_755_500_100_000).map((l) => l.id)).toEqual([comment.id])
    expect(mailbox.fetchFor(d.next, ORCH).map((f) => f.event.id)).toEqual([comment.id])
  })

  test('only fetch carries codes; counts and summary carry none, and summary previews cannot leak one', () => {
    const { log, reply, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    const counts = mailbox.countsFor(state, ORCH, FACTS)
    const summary = mailbox.summaryFor(state, ORCH, FACTS, 1_755_500_100_000)
    const fetched = mailbox.fetchFor(state, ORCH)
    expect(counts.total).toBe(2)
    expect(JSON.stringify(counts)).not.toContain(mailbox.codeFor(reply))
    expect(JSON.stringify(summary)).not.toContain(mailbox.codeFor(reply))
    expect(fetched.find((f) => f.event.id === reply.id)?.code).toBe(mailbox.codeFor(reply))
  })

  test('P2, the divergence state: after ORCH clears its pair on a still-jointly-held event, EVERY rung agrees it is gone for ORCH and present for WORKER_A', () => {
    // D2's mutation pass proved a second membership path in the view rungs
    // ships green: filtering on recipients instead of holders only diverges
    // for an agent that cleared its pair while another agent still holds the
    // event — a state no view was read in (task 083). fetchFor is the
    // serious half: it hands out codes, so the defect returns an agent an
    // event it already cleared WITH a valid code.
    const { log, reply, comment, recipientsOf } = scriptedWorld()
    let state = foldAll(log.events(), recipientsOf)
    const d = mailbox.applyAck(state, ORCH, [{ id: comment.id, code: mailbox.codeFor(comment) }], noEvidence)
    state = d.next
    // WORKER_A still holds the comment — on every rung, counts included…
    expect(mailbox.mailboxOf(state, WORKER_A).map((e) => e.id)).toContain(comment.id)
    expect(mailbox.countsFor(state, WORKER_A, FACTS).total).toBe(2)
    expect(mailbox.summaryFor(state, WORKER_A, FACTS, 1_755_500_100_000).map((l) => l.id)).toContain(comment.id)
    expect(mailbox.fetchFor(state, WORKER_A).map((f) => f.event.id)).toContain(comment.id)
    // …and for ORCH every rung says it is gone — none may re-derive
    // membership from recipients.
    expect(mailbox.countsFor(state, ORCH, FACTS).total).toBe(1)
    expect(mailbox.summaryFor(state, ORCH, FACTS, 1_755_500_100_000).map((l) => l.id)).toEqual([reply.id])
    const fetched = mailbox.fetchFor(state, ORCH)
    expect(fetched.map((f) => f.event.id)).toEqual([reply.id])
    expect(fetched.some((f) => f.event.id === comment.id)).toBe(false) // no code for a cleared pair, ever
    const selected = mailbox.select(state, ORCH, { ids: [comment.id] }, FACTS)
    expect(selected.events).toEqual([])
    expect(selected.missing).toEqual([comment.id])
  })

  test('the three rungs describe ONE list: counts total = summary lines = fetch length, per agent (P2 behaviourally)', () => {
    const { log, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    let checked = 0
    for (const agent of [WORKER_A, WORKER_B, ORCH]) {
      const counts = mailbox.countsFor(state, agent, FACTS)
      const summary = mailbox.summaryFor(state, agent, FACTS, 1_755_500_100_000)
      const fetched = mailbox.fetchFor(state, agent)
      expect(counts.total).toBe(summary.length)
      expect(counts.total).toBe(fetched.length)
      expect(summary.map((l) => l.id)).toEqual(fetched.map((f) => f.event.id))
      checked++
    }
    counted('rung agreement per agent', checked, 3)
  })

  test('classification consumes the INJECTED authorship only: a lifecycle act by a human queues; the old drift kind queues (090)', () => {
    // The speech restriction is part of the SenderOf composition: a
    // task-status with a user actor is an act, not speech — it must not jump
    // the queue. And trigger-created (the kind D2's local heuristic drifted
    // on, wrong from birth) has no speaker under the composition at all.
    const log = createLog(createClock())
    const act = log.append('task-status', 'task-101', { from: 'in-progress', to: 'done', actor: HUMAN })
    const drift = log.append('trigger-created', 'triggers', {
      id: 'tr1',
      cron: '0 9 * * *',
      agent: WORKER_A,
      prompt: 'p',
      actor: HUMAN,
    })
    expect(mailbox.groupOf(act, FACTS).kind).toBe('queued')
    expect(mailbox.groupOf(drift, FACTS).kind).toBe('queued')
    // And machine senders have no authorship — infra's own sends queue even
    // when they are speech-shaped (the exclusion lives in the composition).
    const fromInfra = log.append('send', `agent-${ORCH}`, { agent: ORCH, from: 'infra', text: 'notice', queued: true })
    expect(mailbox.groupOf(fromInfra, FACTS).kind).toBe('queued')
  })

  test('a human sender classifies blocking; machine mail queues — and the summary group IS the selector key', () => {
    const log = createLog(createClock())
    const humanMsg = log.append('reply', 'system', { agent: HUMAN, text: 'urgent question' })
    const machineMsg = log.append('send', `agent-${ORCH}`, { agent: ORCH, from: WORKER_A, text: 'fyi', queued: true })
    const table = new Map<number, readonly string[]>([
      [humanMsg.id, [ORCH]],
      [machineMsg.id, [ORCH]],
    ])
    const state = foldAll(log.events(), (e) => table.get(e.id) ?? [])
    expect(mailbox.groupOf(humanMsg, FACTS)).toEqual({ kind: 'blocking', from: HUMAN })
    expect(mailbox.groupOf(machineMsg, FACTS).kind).toBe('queued')
    const summary = mailbox.summaryFor(state, ORCH, FACTS, 1_755_500_100_000)
    const humanLine = summary.find((l) => l.id === humanMsg.id)
    expect(humanLine?.group).toEqual({ kind: 'blocking', from: HUMAN })
    // The key read off the summary works verbatim as the selector.
    const viaFrom = mailbox.select(state, ORCH, { from: HUMAN }, FACTS)
    expect(viaFrom.events.map((f) => f.event.id)).toEqual([humanMsg.id])
  })
})

describe('selectors — inside the reader’s mailbox, loud misses', () => {
  test('ids: found events come with codes; misses land in `missing`, present even when empty', () => {
    const { log, send1, send2, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    const hit = mailbox.select(state, WORKER_A, { ids: [send1.id] }, FACTS)
    expect(hit.events.map((f) => f.event.id)).toEqual([send1.id])
    expect(hit.missing).toEqual([])
    // send2 is B's mail: for A it is a MISS, never a disclosure.
    const cross = mailbox.select(state, WORKER_A, { ids: [send1.id, send2.id] }, FACTS)
    expect(cross.events.map((f) => f.event.id)).toEqual([send1.id])
    expect(cross.missing).toEqual([send2.id])
  })

  test('type: selects by the summary’s queued key within the mailbox only', () => {
    const { log, comment, recipientsOf } = scriptedWorld()
    const state = foldAll(log.events(), recipientsOf)
    const group = mailbox.groupOf(comment, FACTS)
    if (group.kind !== 'queued') throw new Error('fixture: comment must queue')
    const picked = mailbox.select(state, WORKER_A, { type: group.type }, FACTS)
    expect(picked.events.map((f) => f.event.id)).toContain(comment.id)
    expect(picked.missing).toBeUndefined()
    for (const f of picked.events) {
      expect(mailbox.mailboxOf(state, WORKER_A).map((e) => e.id)).toContain(f.event.id)
    }
  })
})

describe('randomized scaled run — generic validity alongside the specifics (spec §5; design §7)', () => {
  test('7 agents, 150 seeded events, acks applied through the implementation: replay invariants hold and joint holds occur', async () => {
    const resolutionImpl = await import('../resolution/index.ts' as string)
      .then((m) => (m as { resolution: ResolutionContract }).resolution)
      .catch(() => {
        throw new Error('randomized run needs D1 (resolution) — red until it lands')
      })

    const rng = createRng(0xa2a2)
    const clock = createClock()
    const log = createLog(clock)
    const workers = ['w-red', 'w-blue', 'w-green', 'w-gold', 'w-slate']
    // A graded spread of unreliability, deliberately (task 083): reliable
    // agents drain to empty, and two empty mailboxes coincide by definition —
    // the earlier all-reliable cast ended with four empties failing §5
    // against the fixture's own ground truth. Unreliability is baseline
    // (spec §0), and here it also keeps final mailboxes populated and
    // distinct.
    const failRates = [0.6, 0.5, 0.3, 0, 0] as const
    const cast = createCast([
      { name: 'orch-1', role: 'sensei', behaviour: { kind: 'reliable' } },
      { name: 'human-1', role: 'user', behaviour: { kind: 'failing', rate: 0.7 } },
      ...workers.map((name, i) => {
        const rate = failRates[i] ?? 0
        return {
          name,
          role: 'worker' as const,
          behaviour: rate > 0 ? ({ kind: 'failing', rate } as const) : ({ kind: 'reliable' } as const),
        }
      }),
    ])
    const runCtx: ResolutionContext = {
      orchestrator: 'orch-1',
      taskOwner: (id) => workers[Number(id) % workers.length],
    }
    // The composed resolver — the REAL resolution bound to the run's context.
    // This is the one place the suite crosses modules, deliberately.
    const recipientsOf = (e: Parameters<ResolutionContract['resolve']>[0]) => resolutionImpl.resolve(e, runCtx)

    let state = mailbox.initial()
    for (let i = 0; i < 150; i++) {
      clock.advance(1_000 + rng.int(60_000))
      const roll = rng.next()
      if (roll < 0.4) {
        const to = rng.pick([...workers, 'orch-1'])
        const from = rng.pick(['orch-1', 'human-1', ...workers].filter((n) => n !== to))
        const e = log.append('send', `agent-${to}`, { agent: to, from, text: `m${i}`, queued: true })
        state = mailbox.fold(state, e, recipientsOf)
      } else if (roll < 0.5) {
        // Mail TO the human — the orchestrator answering a bridge user. This
        // is what makes a user-role agent a RECIPIENT (task 083: without it
        // the run was unsatisfiable — human-1 could only ever send, its
        // mailbox was empty at every instant, and non-coincidence rightly
        // rejected the fixture's own world). Also the run's only source of
        // the blocking group.
        const from = rng.pick(['orch-1', ...workers])
        const e = log.append('send', 'agent-human-1', { agent: 'human-1', from, text: `a${i}`, queued: true })
        state = mailbox.fold(state, e, recipientsOf)
      } else if (roll < 0.65) {
        const taskId = String(rng.int(8))
        const author = rng.pick(['orch-1', ...workers])
        const role = author === 'orch-1' ? ('sensei' as const) : ('worker' as const)
        const e = log.append('task-comment', `task-${taskId}`, { agent: author, role, text: `c${i}` })
        state = mailbox.fold(state, e, recipientsOf)
      } else {
        // An agent acts on (some of) its mailbox through the REAL decision.
        const actor = rng.pick(cast)
        const offered = mailbox.mailboxOf(state, actor.name)
        const acting = actor.actsOn(offered, rng)
        if (acting.length > 0) {
          const d = mailbox.applyAck(
            state,
            actor.name,
            acting.map((e) => ({ id: e.id, code: mailbox.codeFor(e) })),
            noEvidence,
          )
          state = d.next
          log.appendRaw('ack', 'system', d.record)
        }
      }
    }

    // Generic validity over the WHOLE log, ground truth from resolution:
    const result = replayCheck(log.events(), {
      resolution: resolutionImpl,
      ctx: runCtx,
      clearedPairsOf: (event) => {
        if (event.type !== 'ack') return []
        const d = event.data as { caller?: AgentName; cleared?: { eventId: number }[] }
        if (!d.caller || !d.cleared) return []
        return d.cleared.map((c) => ({ recipient: d.caller as AgentName, eventId: c.eventId }))
      },
    })
    counted('joint holds observed', result.observedJointHolds)
    counted('pairs cleared in the run', result.pairsCleared)

    // The implementation's final pending agrees with ground truth exactly.
    const groundTruth = result.pending.map((p) => `${p.recipient}:${p.eventId}`).sort()
    const implPending = mailbox
      .pendingPairs(state)
      .map((p) => `${p.recipient}:${p.eventId}`)
      .sort()
    expect(implPending).toEqual(groundTruth)

    // The human was a RECIPIENT in this run — asserted against the
    // RESOLUTION, not a data field (codex pass: a broken recipient path
    // could otherwise still satisfy a shape check on the send events).
    const eventsResolvingToHuman = log.events().filter((e) => recipientsOf(e).includes('human-1')).length
    counted('events resolving to human-1', eventsResolvingToHuman)

    // Per-agent answers are non-coincident (§5) — the P2-class detector.
    // The comparison set is derived from GROUND TRUTH, never by filtering
    // the implementation's own output (codex pass: filtering impl output
    // could mask a wrongly-empty mailbox behind the floor). Every agent
    // ground truth says holds mail must be non-empty in the implementation.
    const truthHolders = [...new Set(result.pending.map((p) => p.recipient))]
    counted('ground-truth non-empty final mailboxes', truthHolders.length, 3)
    const perAgent = new Map(
      truthHolders.map((name) => [name, mailbox.mailboxOf(state, name).map((e) => e.id) as unknown[]]),
    )
    for (const [name, ids] of perAgent) {
      if (ids.length === 0) {
        throw new Error(`ground truth holds mail for ${name}; the implementation's mailbox is empty`)
      }
    }
    assertNonCoincident(
      perAgent,
      mailbox.pendingPairs(state).map((p) => p.eventId),
    )
  })
})

// The suite trusts nothing silently: this fails until BOTH the fold half and
// the decision half exist, and D2 may not ship one without the other.
describe('contract completeness', () => {
  test('every contract member is present', () => {
    const members: (keyof MailboxContract)[] = [
      'initial',
      'fold',
      'mailboxOf',
      'pendingPairs',
      'codeFor',
      'groupOf',
      'countsFor',
      'summaryFor',
      'fetchFor',
      'select',
      'applyAck',
      'acknowledgedCount',
    ]
    let present = 0
    for (const m of members) {
      expect(typeof mailbox[m]).toBe('function')
      present++
    }
    counted('contract members', present, members.length)
  })
})
