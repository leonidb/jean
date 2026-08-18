/** Event-log builder: append-only, ids monotonic from 1, timestamps from the
 *  injected clock. Produces plain StoredEvents — the same envelope real logs
 *  hold, so anything proven here is proven about the real shape. */

import type { KindDataMap, KnownKind, StoredEvent } from '../contracts/vocabulary.ts'
import type { Clock } from './clock.ts'

export type EventLog = {
  /** Append a known kind with its declared data shape, type-checked. */
  append: <K extends KnownKind>(kind: K, stream: string, data: KindDataMap[K]) => StoredEvent
  /** Append an arbitrary kind — logs are permanent and hold shapes newer and
   *  older than any census; the fold must survive them (vocabulary header). */
  appendRaw: (kind: string, stream: string, data: unknown) => StoredEvent
  events: () => readonly StoredEvent[]
}

export function createLog(clock: Clock): EventLog {
  const events: StoredEvent[] = []
  let nextId = 1
  const appendRaw = (kind: string, stream: string, data: unknown): StoredEvent => {
    const event: StoredEvent = {
      id: nextId++,
      ts: new Date(clock.now()).toISOString(),
      type: kind,
      stream,
      data,
    }
    events.push(event)
    return event
  }
  return {
    append: (kind, stream, data) => appendRaw(kind, stream, data),
    appendRaw,
    events: () => events,
  }
}
