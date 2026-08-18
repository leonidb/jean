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
 * The resolution implementation (D1) is a dependency of the RANDOMIZED cases
 * only; the scripted cases use a local table-resolution so this suite's
 * verdicts do not depend on another module's correctness (design §6:
 * testable without other modules' behaviour).
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

const ctx: ResolutionContext = {
  orchestrator: ORCH,
  taskOwner: (taskId) => (taskId === '101' ? WORKER_A : undefined),
}

const noEvidence = (): DeliveredVia | undefined => undefined

/** Fold a scripted log into state. */
function foldAll(
  events: readonly Parameters<MailboxContract['fold']>[1][],
  into?: ReturnType<MailboxContract['initial']>,
) {
  let state = into ?? mailbox.initial()
  for (const e of events) state = mailbox.fold(state, e, ctx)
  return state
}

/** A three-recipient scripted world, non-coincident by construction:
 *  A holds {send1}, B holds {send2, task-comment}, ORCH holds {reply, task-comment}. */
function scriptedWorld() {
  const log = createLog(createClock())
  const send1 = log.append('send', `agent-${WORKER_A}`, { agent: WORKER_A, from: ORCH, text: 'to A', queued: true })
  const send2 = log.append('send', `agent-${WORKER_B}`, { agent: WORKER_B, from: ORCH, text: 'to B', queued: true })
  const reply = log.append('reply', 'task-101', { agent: WORKER_A, text: 'progress' })
  // WORKER_B comments on A's task → held by BOTH ORCH and WORKER_A (the
  // multi-recipient case §5 requires as a positive).
  const comment = log.append('task-comment', 'task-101', { agent: WORKER_B, role: 'worker', text: 'drive-by' })
  return { log, send1, send2, reply, comment }
}

describe('P1/P4 — the fold: pairs from resolution, history never enters', () => {
  test('per-agent mailboxes match ground truth exactly, non-coincident, and pending is their union', () => {
    const { log, send1, send2, reply, comment } = scriptedWorld()
    const state = foldAll(log.events())

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

  test('history kinds put nothing anywhere: ack, nudge, agent-idle, register, memory', () => {
    const log = createLog(createClock())
    log.append('ack', 'system', { eventIds: [999] })
    log.append('nudge', `agent-${WORKER_A}`, { pendingCount: 1 })
    log.append('agent-idle', `agent-${WORKER_A}`, { agent: WORKER_A, role: 'worker' })
    log.append('register', `agent-${WORKER_A}`, { agent: WORKER_A, role: 'worker', idle: true })
    log.append('memory', 'memory', { agent: WORKER_A, role: 'worker', text: 'learned', scope: 'dojo' })
    const state = foldAll(log.events())
    expect(mailbox.pendingPairs(state)).toEqual([])
    expect(mailbox.mailboxOf(state, WORKER_A)).toEqual([])
    expect(mailbox.mailboxOf(state, ORCH)).toEqual([])
  })
})

describe('§2 — independent acknowledgement, the invariant', () => {
  test("one recipient's ack clears its pair only; the event stays in the other mailbox; last clear removes it from pending", () => {
    const { log, comment } = scriptedWorld()
    let state = foldAll(log.events())
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
    const { log, send1 } = scriptedWorld()
    let state = foldAll(log.events())
    const code = mailbox.codeFor(send1)
    const first = mailbox.applyAck(state, WORKER_A, [{ id: send1.id, code }], noEvidence)
    state = first.next
    const second = mailbox.applyAck(state, WORKER_A, [{ id: send1.id, code }], noEvidence)
    expect(first.cleared.length).toBe(1)
    expect(second.cleared.length).toBe(0)
    expect(mailbox.acknowledgedCount(second.next, WORKER_A, [send1.id])).toBe(1)
  })
})

describe('P5 — read before clear, authorized to clear', () => {
  test('a wrong code clears nothing and is not an error; the right half of a batch still clears', () => {
    const { log, send1, comment } = scriptedWorld()
    const state = foldAll(log.events())
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
    const { log, send1 } = scriptedWorld()
    const state = foldAll(log.events())
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
    const { log, send1, comment } = scriptedWorld()
    const state = foldAll(log.events())
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
    const { log, send2 } = scriptedWorld()
    const state = foldAll(log.events())
    const d = mailbox.applyAck(state, WORKER_B, [{ id: send2.id, code: mailbox.codeFor(send2) }], noEvidence)
    expect(d.record.cleared).toEqual([{ eventId: send2.id }])
  })

  test('folding the decision record back reproduces the decision state — from `cleared`, never from `pairs`', () => {
    const { log, send1, comment } = scriptedWorld()
    const state = foldAll(log.events())
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
    const refolded = mailbox.fold(state, ackEvent, ctx)
    const key = (pairs: readonly { recipient: string; eventId: number }[]) =>
      pairs.map((p) => `${p.recipient}:${p.eventId}`).sort()
    expect(key(mailbox.pendingPairs(refolded))).toEqual(key(mailbox.pendingPairs(d.next)))
    // The missed pair survives the refold in WORKER_A's mailbox.
    expect(mailbox.mailboxOf(refolded, WORKER_A).map((e) => e.id)).toContain(send1.id)
  })

  test('a HISTORICAL ack (eventIds, no caller) clears every pair of the named events — replay tolerance, permanently', () => {
    const { log, comment } = scriptedWorld()
    const state = foldAll(log.events())
    const oldAck = log.appendRaw('ack', 'system', { eventIds: [comment.id] })
    const refolded = mailbox.fold(state, oldAck, ctx)
    expect(mailbox.pendingPairs(refolded).some((p) => p.eventId === comment.id)).toBe(false)
  })
})

describe('P7/P10 — views: three rungs, pure, fresh', () => {
  test('reads change nothing: state answers identically before and after every view', () => {
    const { log } = scriptedWorld()
    const state = foldAll(log.events())
    const before = mailbox.pendingPairs(state).map((p) => `${p.recipient}:${p.eventId}`)
    mailbox.countsFor(state, ORCH, roleOf)
    mailbox.summaryFor(state, ORCH, roleOf, 1_755_500_100_000)
    mailbox.fetchFor(state, ORCH)
    mailbox.select(state, ORCH, { ids: [1] }, roleOf)
    const after = mailbox.pendingPairs(state).map((p) => `${p.recipient}:${p.eventId}`)
    expect(after).toEqual(before)
  })

  test('freshness is the falling case (P10): views over an evolved state reflect the change immediately', () => {
    const { log, reply, comment } = scriptedWorld()
    const state = foldAll(log.events())
    const countBefore = mailbox.countsFor(state, ORCH, roleOf).total
    // Read every rung, then evolve the state — the same view calls over the
    // NEW state must answer from it, not from anything a prior call retained.
    mailbox.summaryFor(state, ORCH, roleOf, 1_755_500_100_000)
    mailbox.fetchFor(state, ORCH)
    const d = mailbox.applyAck(state, ORCH, [{ id: reply.id, code: mailbox.codeFor(reply) }], noEvidence)
    const countAfter = mailbox.countsFor(d.next, ORCH, roleOf).total
    expect(countBefore).toBe(2)
    expect(countAfter).toBe(1)
    expect(mailbox.summaryFor(d.next, ORCH, roleOf, 1_755_500_100_000).map((l) => l.id)).toEqual([comment.id])
    expect(mailbox.fetchFor(d.next, ORCH).map((f) => f.event.id)).toEqual([comment.id])
  })

  test('only fetch carries codes; counts and summary carry none, and summary previews cannot leak one', () => {
    const { log, reply } = scriptedWorld()
    const state = foldAll(log.events())
    const counts = mailbox.countsFor(state, ORCH, roleOf)
    const summary = mailbox.summaryFor(state, ORCH, roleOf, 1_755_500_100_000)
    const fetched = mailbox.fetchFor(state, ORCH)
    expect(counts.total).toBe(2)
    expect(JSON.stringify(counts)).not.toContain(mailbox.codeFor(reply))
    expect(JSON.stringify(summary)).not.toContain(mailbox.codeFor(reply))
    expect(fetched.find((f) => f.event.id === reply.id)?.code).toBe(mailbox.codeFor(reply))
  })

  test('the three rungs describe ONE list: counts total = summary lines = fetch length, per agent (P2 behaviourally)', () => {
    const { log } = scriptedWorld()
    const state = foldAll(log.events())
    let checked = 0
    for (const agent of [WORKER_A, WORKER_B, ORCH]) {
      const counts = mailbox.countsFor(state, agent, roleOf)
      const summary = mailbox.summaryFor(state, agent, roleOf, 1_755_500_100_000)
      const fetched = mailbox.fetchFor(state, agent)
      expect(counts.total).toBe(summary.length)
      expect(counts.total).toBe(fetched.length)
      expect(summary.map((l) => l.id)).toEqual(fetched.map((f) => f.event.id))
      checked++
    }
    counted('rung agreement per agent', checked, 3)
  })

  test('a human sender classifies blocking; machine mail queues — and the summary group IS the selector key', () => {
    const log = createLog(createClock())
    const humanMsg = log.append('reply', 'system', { agent: HUMAN, text: 'urgent question' })
    const machineMsg = log.append('send', `agent-${ORCH}`, { agent: ORCH, from: WORKER_A, text: 'fyi', queued: true })
    const state = foldAll(log.events())
    expect(mailbox.groupOf(humanMsg, roleOf)).toEqual({ kind: 'blocking', from: HUMAN })
    expect(mailbox.groupOf(machineMsg, roleOf).kind).toBe('queued')
    const summary = mailbox.summaryFor(state, ORCH, roleOf, 1_755_500_100_000)
    const humanLine = summary.find((l) => l.id === humanMsg.id)
    expect(humanLine?.group).toEqual({ kind: 'blocking', from: HUMAN })
    // The key read off the summary works verbatim as the selector.
    const viaFrom = mailbox.select(state, ORCH, { from: HUMAN }, roleOf)
    expect(viaFrom.events.map((f) => f.event.id)).toEqual([humanMsg.id])
  })
})

describe('selectors — inside the reader’s mailbox, loud misses', () => {
  test('ids: found events come with codes; misses land in `missing`, present even when empty', () => {
    const { log, send1, send2 } = scriptedWorld()
    const state = foldAll(log.events())
    const hit = mailbox.select(state, WORKER_A, { ids: [send1.id] }, roleOf)
    expect(hit.events.map((f) => f.event.id)).toEqual([send1.id])
    expect(hit.missing).toEqual([])
    // send2 is B's mail: for A it is a MISS, never a disclosure.
    const cross = mailbox.select(state, WORKER_A, { ids: [send1.id, send2.id] }, roleOf)
    expect(cross.events.map((f) => f.event.id)).toEqual([send1.id])
    expect(cross.missing).toEqual([send2.id])
  })

  test('type: selects by the summary’s queued key within the mailbox only', () => {
    const { log, comment } = scriptedWorld()
    const state = foldAll(log.events())
    const group = mailbox.groupOf(comment, roleOf)
    if (group.kind !== 'queued') throw new Error('fixture: comment must queue')
    const picked = mailbox.select(state, WORKER_A, { type: group.type }, roleOf)
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
    const cast = createCast([
      { name: 'orch-1', role: 'sensei', behaviour: { kind: 'reliable' } },
      { name: 'human-1', role: 'user', behaviour: { kind: 'reliable' } },
      ...workers.map((name, i) => ({
        name,
        role: 'worker' as const,
        behaviour: i === 0 ? ({ kind: 'failing', rate: 0.6 } as const) : ({ kind: 'reliable' } as const),
      })),
    ])
    const runCtx: ResolutionContext = {
      orchestrator: 'orch-1',
      taskOwner: (id) => workers[Number(id) % workers.length],
    }

    let state = mailbox.initial()
    for (let i = 0; i < 150; i++) {
      clock.advance(1_000 + rng.int(60_000))
      const roll = rng.next()
      if (roll < 0.45) {
        const to = rng.pick([...workers, 'orch-1'])
        const from = rng.pick(['orch-1', 'human-1', ...workers].filter((n) => n !== to))
        const e = log.append('send', `agent-${to}`, { agent: to, from, text: `m${i}`, queued: true })
        state = mailbox.fold(state, e, runCtx)
      } else if (roll < 0.65) {
        const taskId = String(rng.int(8))
        const author = rng.pick(['orch-1', ...workers])
        const role = author === 'orch-1' ? ('sensei' as const) : ('worker' as const)
        const e = log.append('task-comment', `task-${taskId}`, { agent: author, role, text: `c${i}` })
        state = mailbox.fold(state, e, runCtx)
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

    // And per-agent answers are non-coincident (§5) — the P2-class detector.
    const perAgent = new Map(cast.map((a) => [a.name, mailbox.mailboxOf(state, a.name).map((e) => e.id) as unknown[]]))
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
