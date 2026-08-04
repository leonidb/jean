/**
 * The bus contract (refactor stage 3, commit 1 — task 033; contract = task 034
 * deliverable 2).
 *
 * Three of these four assertions pin things a "helpful" future edit would
 * happily break, which is the only reason they are worth writing: order is
 * semantics, not style; a throwing subscriber must stay fatal; and re-entrant
 * subscription must be refused rather than resolved arbitrarily. The
 * synchronous-completion test is the one that reads as obvious — it is here
 * because `record()`'s seven race guards all live on the assumption.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../../es/index.ts'
import { createEventBus } from './bus.ts'

/** The publish context is guard 1's pre-append fact; nothing here reads it, so
 *  one constant serves every case. */
const CTX = { hadBlockingPending: false }

function event(id: number): StoredEvent {
  return { id, stream: 'system', type: 'probe', ts: new Date(0).toISOString(), data: {} }
}

describe('event bus', () => {
  test('subscribers run in registration order, to completion, before publish returns', () => {
    const bus = createEventBus()
    const seen: string[] = []
    for (const name of ['first', 'second', 'third']) {
      bus.subscribe({ name, apply: () => void seen.push(name) })
    }

    bus.publish(event(1), CTX)

    // Order: the real list's tail (the attention listener, commit 2) reads
    // projection state the earlier subscribers just wrote.
    expect(seen).toEqual(['first', 'second', 'third'])
    // Completion: everything has already run by the time publish returns, so a
    // caller reading state on the next line sees the fully-applied event. An
    // async subscriber would reintroduce the interleaving class the race guards
    // exist for.
    expect(bus.names()).toEqual(['first', 'second', 'third'])
  })

  test('a throwing subscriber propagates — earlier subscribers applied, later ones skipped', () => {
    const bus = createEventBus()
    const seen: string[] = []
    bus.subscribe({ name: 'before', apply: () => void seen.push('before') })
    bus.subscribe({
      name: 'thrower',
      apply: () => {
        throw new Error('boom')
      },
    })
    bus.subscribe({ name: 'after', apply: () => void seen.push('after') })

    // NO try/catch inside publish, deliberately. Today a throwing
    // projection.apply propagates out of record(), and 16 `void record(...)`
    // call sites turn that into an unhandled rejection, which Bun answers by
    // exiting(1). The in-memory divergence therefore never outlives the crash —
    // restart re-folds from the log and is correct again. Swallowing it here
    // would trade a loud crash for silent, persistent projection divergence.
    expect(() => bus.publish(event(1), CTX)).toThrow('boom')
    expect(seen).toEqual(['before'])

    // ...and the bus is still usable afterwards: the re-entrancy flag is
    // cleared on the way out, so the crash path's own bookkeeping (a final
    // record(), a shutdown event) is not refused on top of the original fault.
    const late: string[] = []
    bus.subscribe({ name: 'late', apply: () => void late.push('late') })
    expect(late).toEqual([])
  })

  test('subscribing from inside a subscriber is refused', () => {
    const bus = createEventBus()
    let caught: unknown
    bus.subscribe({
      name: 'reentrant',
      apply: () => {
        try {
          bus.subscribe({ name: 'newcomer', apply: () => {} })
        } catch (err) {
          caught = err
        }
      },
    })

    bus.publish(event(1), CTX)

    // Whether the newcomer saw the in-flight event would depend on where it
    // landed relative to the loop index — so refuse rather than pick one.
    expect((caught as Error)?.message).toContain('cannot subscribe "newcomer" during publish')
    expect(bus.names()).toEqual(['reentrant'])
  })

  test('every subscriber sees every published event', () => {
    const bus = createEventBus()
    const a: number[] = []
    const b: number[] = []
    bus.subscribe({ name: 'a', apply: (e) => void a.push(e.id) })
    bus.subscribe({ name: 'b', apply: (e) => void b.push(e.id) })

    // The bus does no filtering — each projection's own `filter` decides what it
    // reacts to, exactly as it did when record() called them directly.
    bus.publish(event(1), CTX)
    bus.publish(event(2), CTX)

    expect(a).toEqual([1, 2])
    expect(b).toEqual([1, 2])
  })
})
