/**
 * The delivery ledger (refactor stage 4 — task 036).
 *
 * Two facts per event, no more: HOW it reached the agent (`deliveredVia`) and
 * WHAT cleared it (`clearedBy`). Deliberately minimal — the fuller ledger in the
 * design (wake attempted/landed/failed, per-path counters, a query endpoint) is
 * scope creep until a measured need shows up.
 *
 * Live state is in-memory; it MATERIALIZES onto the `ack` event, which is the
 * durable record. (The phase-3 `auto: 'reply'` tag is the precedent this
 * generalizes — the goals dojo's phase-3 QA leaned on it as its only
 * ledger-like evidence.)
 *
 * IN-MEMORY MEANS A RESTART FORGETS in-flight delivery marks: an event pending
 * across a restart acks with no `deliveredVia`. Honest and bounded — absence
 * reads as "unknown", never as a wrong path.
 *
 * State, but not world: this holds a Map and nothing else, exactly as the
 * attention listener holds its episodes. It reaches no clock, registry,
 * projection or socket, which is what makes it core.
 */

import type { StoredEvent } from '../../es/index.ts'
import { type AckData, type ClearedBy, type DeliveredVia, toApiEvent } from '../reducers.ts'

export type DeliveryLedger = {
  /** Record how a set of events reached an agent. FIRST DELIVERY WINS: a wake
   *  followed by ten piggybacks stays 'wake'. (The design's `at` timestamp is
   *  deliberately not kept — nothing surfaces it, and the ack event's own ts is
   *  the clear time.) */
  stamp: (via: DeliveredVia, ids: Iterable<number>) => void
  /** A pending event as the API renders it, plus how it reached the agent —
   *  absent until something has actually delivered it. */
  withDeliveredVia: (event: StoredEvent) => ReturnType<typeof toApiEvent> & { deliveredVia?: DeliveredVia }
  /** Materialize the ledger for ids being acked AND drop their entries: pending
   *  is the only thing keeping them alive, and ack is the only exit from
   *  pending. Read-and-delete in one call because doing it in two invites a
   *  caller that does one without the other. */
  takeFor: (ids: readonly number[], clearedBy: ClearedBy) => NonNullable<AckData['ledger']>
  /** Entry count. Diagnostics and tests only — nothing branches on it. */
  size: () => number
}

export function createDeliveryLedger(): DeliveryLedger {
  const via = new Map<number, DeliveredVia>()

  return {
    stamp(v, ids) {
      for (const id of ids) {
        if (!via.has(id)) via.set(id, v)
      }
    },

    withDeliveredVia(event) {
      const deliveredVia = via.get(event.id)
      return { ...toApiEvent(event), ...(deliveredVia && { deliveredVia }) }
    },

    takeFor(ids, clearedBy) {
      const ledger: NonNullable<AckData['ledger']> = {}
      for (const id of ids) {
        const deliveredVia = via.get(id)
        ledger[String(id)] = { ...(deliveredVia && { deliveredVia }), clearedBy }
        via.delete(id)
      }
      return ledger
    },

    size: () => via.size,
  }
}
