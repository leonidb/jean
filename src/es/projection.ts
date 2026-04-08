/**
 * Projection — materialized view derived from events via a reducer.
 *
 * catchUp() on startup: load snapshot + replay newer events.
 * apply() in real-time: fold one event synchronously after append.
 */

import type { EventStore, ReadOpts } from './store.ts'
import type { Reducer, SnapshotBackend, StoredEvent } from './types.ts'

// ── Projection ───────────────────────────────────────────────────

export type Projection<S> = {
  readonly state: S
  readonly version: number
  catchUp(): Promise<S>
  apply(event: StoredEvent): S
  snapshot(): Promise<void>
}

export type ProjectionOpts<S> = {
  name: string
  store: EventStore
  reducer: Reducer<S>
  initial: S
  filter?: Pick<ReadOpts, 'stream' | 'types'>
  snapshots?: SnapshotBackend<S>
  snapshotEvery?: number
  /** Optional migration for snapshot state (e.g. legacy field renames). */
  migrate?: (state: S) => S
}

export function createProjection<S>(opts: ProjectionOpts<S>): Projection<S> {
  let state = opts.initial
  let version = 0
  let eventsSinceSnapshot = 0

  function matchesFilter(event: StoredEvent): boolean {
    if (opts.filter?.stream && event.stream !== opts.filter.stream) return false
    if (opts.filter?.types && !opts.filter.types.includes(event.type)) return false
    return true
  }

  const projection: Projection<S> = {
    get state() {
      return state
    },
    get version() {
      return version
    },

    async catchUp() {
      // Try loading snapshot first
      if (opts.snapshots && version === 0) {
        const snap = await opts.snapshots.load(opts.name)
        if (snap) {
          state = opts.migrate ? opts.migrate(snap.state) : snap.state
          version = snap.lastEventId
        }
      }

      // Replay events after snapshot (or from beginning)
      const events = await opts.store.read({
        afterId: version,
        ...opts.filter,
      })

      for (const event of events) {
        state = opts.reducer(state, event)
        version = event.id
        eventsSinceSnapshot++
      }

      // Auto-snapshot if configured
      if (opts.snapshotEvery && eventsSinceSnapshot >= opts.snapshotEvery) {
        await projection.snapshot()
      }

      return state
    },

    apply(event) {
      if (!matchesFilter(event)) return state
      state = opts.reducer(state, event)
      version = event.id
      eventsSinceSnapshot++

      // Auto-snapshot (fire-and-forget)
      if (opts.snapshotEvery && eventsSinceSnapshot >= opts.snapshotEvery) {
        void projection.snapshot()
      }

      return state
    },

    async snapshot() {
      if (!opts.snapshots) return
      await opts.snapshots.save(opts.name, {
        state,
        lastEventId: version,
        ts: new Date().toISOString(),
      })
      eventsSinceSnapshot = 0
    },
  }

  return projection
}
