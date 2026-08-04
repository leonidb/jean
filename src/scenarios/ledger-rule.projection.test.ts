/**
 * THE LEDGER READING RULE + THE THREE GENUINELY-NEW ACK ASSERTIONS.
 * LEVEL: projection (a log in → pending and a ledger read out; pure).
 *
 * RULING 3 (task 041, Leonid-ratified, and the one ruling that survived all
 * three of his corrections unchanged): **the authoritative ack for an id is the
 * FIRST in log order.** Under fold-decides, that is the ack whose fold actually
 * cleared the id; later duplicates are structural no-ops. The carrier and the
 * authority coincide by construction — the first ack's `takeFor` found the
 * in-memory entry, the no-op's found nothing.
 *
 * ── WHY THIS FILE EXISTS AT ALL: THE BUG IT RE-OPENS AND CLOSES ──
 *
 * The claim machinery guaranteed one ack event per id, which made "how did this
 * event get delivered?" unambiguous. Deleting it re-opens the question in the
 * READING direction: A acks X and materializes `{deliveredVia:'wake'}`, B acks X
 * concurrently and finds the entry gone, so B's event carries `clearedBy` with
 * NO `deliveredVia`. Both land in the log by design. A reader taking the LATEST
 * ack then concludes "delivery unknown" for an event that was demonstrably
 * woken — verbatim the failure guard 6 was introduced to fix.
 *
 * ── THE THREE RED ASSERTIONS, NAMED ──
 *
 * These are the new-behaviour coverage that `src/infra/core/fold-decides.test.ts`
 * deliberately is NOT (that file is characterization — green on arrival, and it
 * says so):
 *   1. two ack events for one id both land in the log;
 *   2. both callers report the ids as cleared (idempotent responses);
 *   3. the FIRST-in-log event carries the ledger, and a rule-following reader
 *      gets the right answer from it.
 *
 * ── THE LOG-READERS OF `ledger`, ENUMERATED (ruling 3 requirement (b)) ──
 *
 * Grepped on main, at the wiring-guard ordering commit. Reading the ledger OUT OF THE LOG:
 *   - `src/infra/attention-ledger.test.ts` — the only reader in the codebase.
 *     Its auto-clear cases are on 043's casualty list; its ack cases must adopt
 *     first-wins.
 * Reading `deliveredVia` from the LIVE in-memory ledger via `/events` (not from
 * the log, so unaffected by the rule):
 *   - `src/infra/stall-watchdog.test.ts:113,177`.
 * Prose:
 *   - `docs/attention.md` §"Observability: the delivery ledger".
 * **No production code and no agent skill reads this field out of the log.** So
 * the rule's blast radius is one test file and one doc paragraph — worth
 * knowing, since ruling 3 was accepted on the assumption that it changes how an
 * existing durable field must be read.
 *
 * Requirement (a) of ruling 3 — amending the contract doc at `AckData.ledger` —
 * is a PRODUCTION edit and therefore belongs to the transition, not to this
 * red-test task, whose gate forbids touching production beyond additive stubs.
 * Flagged on the board rather than done here.
 *
 * STATUS: RED — `deliveredViaFor`, `acknowledgedCount`, `targetPendingReducer`
 * all throw.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../es/index.ts'
import { pendingReducer } from '../infra/reducers.ts'
import { acknowledgedCount, deliveredViaFor, targetPendingReducer } from '../infra/target/codes.ts'
import { ev, humanSays } from './harness.ts'

const HUMAN = 'chat-human'

/** An ack event in the shape today's writer produces — `eventIds` plus the
 *  materialized ledger. The transition changes the clearing FORM (to `{id,
 *  code}` pairs) but not this question, which is about how many ack events one
 *  id may have and which of them is believed. */
function ackEvent(eventIds: number[], ledger?: Record<string, { deliveredVia?: string; clearedBy: string }>) {
  return ev('ack', 'system', { eventIds, ...(ledger && { ledger }) })
}

const fold = (log: readonly StoredEvent[]) =>
  log.reduce<StoredEvent[]>((s, e) => pendingReducer(s, e) as StoredEvent[], [])
const ids = (q: readonly StoredEvent[]) => q.map((e) => e.id)

describe('the ledger reading rule — first ack in log order is authoritative', () => {
  test('two acks for one id: the FIRST carries the ledger, and that is the answer', () => {
    const x = humanSays(HUMAN, 'still waiting')
    // A woke the sensei, so A's takeFor found the delivery mark and materialized
    // it. B raced, found nothing left, and could only record that it cleared.
    const ackA = ackEvent([x.id], { [String(x.id)]: { deliveredVia: 'wake', clearedBy: 'ack' } })
    const ackB = ackEvent([x.id], { [String(x.id)]: { clearedBy: 'ack' } })

    expect(deliveredViaFor([x, ackA, ackB], x.id)).toBe('wake')

    // THE WRONG ANSWER, DOCUMENTED: a reader taking the LATEST ack reads ackB,
    // finds no `deliveredVia`, and reports "delivery unknown" for an event that
    // was demonstrably woken. That is guard 6's founding failure, and it is why
    // the rule is first-wins rather than a matter of taste.
    const latest = [x, ackA, ackB].filter((e) => e.type === 'ack').at(-1) as StoredEvent
    expect(
      (latest.data as { ledger: Record<string, { deliveredVia?: string }> }).ledger[String(x.id)]?.deliveredVia,
    ).toBeUndefined()
  })

  test('order in the LOG decides, not order of arrival at the reader', () => {
    // The rule is about log position. Handing the reader the same two events in
    // the other order must not change the answer, or "first in log order" would
    // silently mean "first one I happened to see".
    const x = humanSays(HUMAN)
    const first = ackEvent([x.id], { [String(x.id)]: { deliveredVia: 'piggyback', clearedBy: 'ack' } })
    const second = ackEvent([x.id], { [String(x.id)]: { clearedBy: 'ack' } })
    const log = [x, first, second]
    expect(deliveredViaFor(log, x.id)).toBe('piggyback')
    expect(deliveredViaFor([...log].reverse(), x.id)).toBe('piggyback')
  })

  test('a single ack that never had a delivery mark reads UNKNOWN, not wrong', () => {
    // The restart window, unchanged and still honest (ruling 3, explicitly): an
    // event pending across a restart loses its in-memory mark, so its ack
    // carries `clearedBy` alone. Absence must read as "unknown" — never as a
    // path that did not happen.
    const x = humanSays(HUMAN)
    expect(deliveredViaFor([x, ackEvent([x.id], { [String(x.id)]: { clearedBy: 'ack' } })], x.id)).toBeUndefined()
  })

  test('an id with no ack at all reads UNKNOWN', () => {
    const x = humanSays(HUMAN)
    expect(deliveredViaFor([x], x.id)).toBeUndefined()
  })
})

describe('fold-decides acks — the three genuinely-new assertions', () => {
  test('CHARACTERIZATION — the fold already survives two acks for one id', () => {
    // ⚠ THIS IS NOT "NEW 1", AND THE FIRST DRAFT MISLABELLED IT AS SUCH.
    //
    // "Two ack events for one id both land in the log" is a claim about the
    // WRITE SITE — today's claim machinery stops the second writer before it
    // appends. A test that BUILDS the two-ack log by hand assumes the very thing
    // it purports to prove, and duly passed on arrival, which is how it was
    // caught: the red run reported it green.
    //
    // The real assertion is at the wiring level, against two concurrent acks
    // through the real server — see `ack-concurrency.wiring.test.ts`. What is
    // left here is the fold's half, which is genuine and already true: given
    // such a log, the queue is unharmed because the second ack is a no-op.
    const x = humanSays(HUMAN)
    const log = [x, ackEvent([x.id]), ackEvent([x.id])]
    expect(log.filter((e) => e.type === 'ack')).toHaveLength(2)
    expect(ids(fold(log))).toEqual([])
  })

  test('NEW 2 — both callers report the ids as cleared (idempotent responses)', () => {
    // Leonid's second correction: no attribution, no hook, no per-caller truth.
    // A and B each asked about the same id; after the dust settles the id is
    // gone, so both are told so.
    const x = humanSays(HUMAN)
    const after = fold([x, ackEvent([x.id]), ackEvent([x.id])])
    expect(acknowledgedCount([x.id], after)).toBe(1)
    expect(acknowledgedCount([x.id], after)).toBe(1) // B asks the same question and gets the same answer
  })

  test('NEW 2b — the count covers only what was REQUESTED, cleared or not', () => {
    const x = humanSays(HUMAN)
    const y = humanSays('chat-other')
    const after = fold([x, y, ackEvent([x.id])])
    expect(acknowledgedCount([x.id, y.id], after)).toBe(1)
    expect(acknowledgedCount([x.id], after)).toBe(1)
    expect(acknowledgedCount([y.id], after)).toBe(0)
    expect(acknowledgedCount([], after)).toBe(0)
  })

  test('NEW 3 — the authoritative ledger entry rides the first-in-log event', () => {
    // The composition of the two rules: append-unconditionally makes two events
    // possible, and first-in-log decides which one is believed. Neither is
    // sufficient alone — that is why they were ruled together.
    const x = humanSays(HUMAN)
    const log = [
      x,
      ackEvent([x.id], { [String(x.id)]: { deliveredVia: 'heartbeat', clearedBy: 'ack' } }),
      ackEvent([x.id], { [String(x.id)]: { clearedBy: 'ack' } }),
    ]
    expect(deliveredViaFor(log, x.id)).toBe('heartbeat')
    expect(ids(fold(log))).toEqual([])
  })

  test('the target fold agrees with today’s on every no-op an ack can be', () => {
    // The bridge between this file and `core/fold-decides.test.ts`: the
    // characterization cases there prove today's reducer is idempotent, and this
    // asserts the TARGET reducer inherits that rather than re-deriving it.
    const x = humanSays(HUMAN)
    const y = humanSays('chat-other')
    const log = [x, y, ackEvent([x.id]), ackEvent([x.id]), ackEvent([999_999]), ackEvent([])]
    const target = log.reduce<StoredEvent[]>((s, e) => targetPendingReducer(s, e), [])
    expect(ids(target)).toEqual(ids(fold(log)))
    expect(ids(target)).toEqual([y.id])
  })
})
