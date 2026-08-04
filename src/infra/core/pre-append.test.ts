/**
 * The two condemned pre-append guards, as pure decisions (refactor stage 4 —
 * task 036).
 *
 * These are the PURE half of the two-row mutation rule (035): each guard keeps
 * its existing gated-store integration row in race-guards.test.ts AND gains a
 * row that breaks the pure function and requires a test here to fail. A moved
 * guard with one row proves less than it did before the move — the integration
 * test proves the wiring still holds, these prove the rule itself is right.
 *
 * What NEITHER kind of test can prove is the property that actually makes them
 * guards: that no `await` separates the decision from the append. That is
 * structural, and core/boundary.test.ts asserts it by reading the source.
 *
 * Everything here dies at the protocol build. See core/pre-append.ts for the
 * log-order formulations that replace it.
 */

import { describe, expect, test } from 'bun:test'
import { claimAckIds, confirmAutoClear, decideAutoClear } from './pre-append.ts'

describe('claimAckIds (GUARD 6)', () => {
  const pending = new Set([1, 2, 3])

  test('claims exactly the ids that are pending and unclaimed', () => {
    expect(claimAckIds([1, 2], pending, new Set())).toEqual([1, 2])
  })

  test('drops ids another writer already owns — the whole point of the guard', () => {
    // The historical bug: two acks for the same id produced two ack events, the
    // second carrying `clearedBy` with no `deliveredVia`, because the first
    // write had already dropped the ledger entry. A reader taking the LATEST
    // ack then concluded "delivery unknown" for an event that was demonstrably
    // woken. A 20-way interleave produced 20 ack events.
    expect(claimAckIds([1, 2, 3], pending, new Set([2]))).toEqual([1, 3])
  })

  test('drops ids that are not pending — already cleared, or never queued', () => {
    expect(claimAckIds([3, 99], pending, new Set())).toEqual([3])
    expect(claimAckIds([99], pending, new Set())).toEqual([])
  })

  test('DEDUPES ITS INPUT, and that is not redundant with the caller', () => {
    // No caller can pass a repeat today. But the caller's reservation is
    // populated AFTER this filter, so a repeated id would slip past the
    // in-flight check and land twice in the recorded `eventIds`. The guarantee
    // is local so it does not depend on every present and future caller.
    expect(claimAckIds([1, 1, 1, 2], pending, new Set())).toEqual([1, 2])
  })

  test('an empty claim is the signal to write nothing at all', () => {
    // Not merely "no ids": the caller returns early on this, which is what
    // stops an empty ack event being recorded.
    expect(claimAckIds([], pending, new Set())).toEqual([])
    expect(claimAckIds([1], pending, new Set([1]))).toEqual([])
  })

  test('preserves request order, not queue order', () => {
    expect(claimAckIds([3, 1], pending, new Set())).toEqual([3, 1])
  })
})

describe('decideAutoClear (GUARD 7, entry half)', () => {
  const base = { senderRole: 'sensei', targetRole: 'user', blockingFromTarget: [7] }

  test('the sensei answering a waiting human IS the ack', () => {
    expect(decideAutoClear(base)).toBe(7)
  })

  test('THE EXACTLY-ONE RULE: a burst requires an explicit ack', () => {
    // Standing down converts silent loss of question #2 into a visible
    // leftover, which is the trade the rule exists to make.
    expect(decideAutoClear({ ...base, blockingFromTarget: [7, 8] })).toBeNull()
    expect(decideAutoClear({ ...base, blockingFromTarget: [] })).toBeNull()
  })

  test('only the sensei auto-clears, and only when answering a user', () => {
    expect(decideAutoClear({ ...base, senderRole: 'worker' })).toBeNull()
    expect(decideAutoClear({ ...base, senderRole: undefined })).toBeNull()
    // Sensei → worker is ordinary dispatch, not an answer to anyone waiting.
    expect(decideAutoClear({ ...base, targetRole: 'worker' })).toBeNull()
    expect(decideAutoClear({ ...base, targetRole: undefined })).toBeNull()
  })
})

describe('confirmAutoClear (GUARD 7, tail half)', () => {
  test('confirms only when the entry candidate is STILL the sole blocking event', () => {
    expect(confirmAutoClear(7, [7])).toBe(true)
  })

  test('stands down when a message arrived mid-flight — it is a burst now', () => {
    // The candidate is still there, but it is no longer alone. This is the
    // half the entry snapshot cannot do on its own.
    expect(confirmAutoClear(7, [7, 8])).toBe(false)
  })

  test('is a no-op when a concurrent manual ack already cleared it', () => {
    expect(confirmAutoClear(7, [])).toBe(false)
  })

  test('never clears a DIFFERENT event than the one decided at entry', () => {
    // The failure this prevents: a brand-new message that arrived mid-flight
    // and was never seen, acked as though it had been answered. Note the count
    // is 1 here — only the identity check catches it.
    expect(confirmAutoClear(7, [9])).toBe(false)
  })
})
