/**
 * The delivery ledger (refactor stage 4 — task 036).
 *
 * Small surface, but every one of these properties is load-bearing somewhere
 * that reads the ack event afterwards, and none of them was reachable without a
 * running server before the move.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../../es/index.ts'
import { createDeliveryLedger } from './ledger.ts'

function ev(id: number): StoredEvent {
  return { id, stream: 'agent-w1', type: 'reply', ts: '2026-08-04T12:00:00.000Z', data: { agent: 'w1' } }
}

describe('delivery ledger', () => {
  test('FIRST DELIVERY WINS — a wake followed by ten piggybacks stays a wake', () => {
    const ledger = createDeliveryLedger()
    ledger.stamp('wake', [1])
    for (let i = 0; i < 10; i++) ledger.stamp('piggyback', [1])
    expect(ledger.withDeliveredVia(ev(1)).deliveredVia).toBe('wake')
  })

  test('an undelivered event carries NO deliveredVia — absence reads as unknown', () => {
    const ledger = createDeliveryLedger()
    // Never "none" or "unknown" as a value: an in-memory ledger forgets
    // in-flight marks across a restart, so absence has to mean "we do not
    // know", never a claim about which path was used.
    expect(ledger.withDeliveredVia(ev(1))).not.toHaveProperty('deliveredVia')
  })

  test('withDeliveredVia renders the API shape, not the raw event', () => {
    const ledger = createDeliveryLedger()
    ledger.stamp('piggyback', [1])
    const out = ledger.withDeliveredVia(ev(1))
    expect(out).toMatchObject({ id: 1, type: 'reply', agent: 'w1', deliveredVia: 'piggyback' })
    // `stream` is an internal detail — toApiEvent turns it into taskId/agent.
    expect(out).not.toHaveProperty('stream')
  })

  test('takeFor materializes onto the ack AND drops the entries', () => {
    const ledger = createDeliveryLedger()
    ledger.stamp('wake', [1, 2])
    ledger.stamp('heartbeat', [3])

    expect(ledger.takeFor([1, 3], 'ack')).toEqual({
      '1': { deliveredVia: 'wake', clearedBy: 'ack' },
      '3': { deliveredVia: 'heartbeat', clearedBy: 'ack' },
    })
    // Dropped, because pending is the only thing keeping them alive and ack is
    // the only exit from pending. Read-and-delete is ONE call precisely so a
    // caller cannot do the first without the second.
    expect(ledger.size()).toBe(1)
    expect(ledger.withDeliveredVia(ev(1))).not.toHaveProperty('deliveredVia')
    expect(ledger.withDeliveredVia(ev(2)).deliveredVia).toBe('wake')
  })

  test('an id with no delivery still records HOW it was cleared', () => {
    const ledger = createDeliveryLedger()
    // The restart case: pending across a restart, acked with no deliveredVia.
    // `clearedBy` is still true and still worth recording.
    expect(ledger.takeFor([9], 'auto-clear')).toEqual({ '9': { clearedBy: 'auto-clear' } })
  })

  test('stamping accepts any iterable — the default set is the whole pending queue', () => {
    const ledger = createDeliveryLedger()
    ledger.stamp('piggyback', new Set([1, 2]))
    expect(ledger.size()).toBe(2)
  })
})
