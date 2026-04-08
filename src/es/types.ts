/**
 * Event sourcing primitives.
 *
 * Generic types — no domain knowledge. Jean-specific events,
 * reducers, and projections live in src/infra/.
 */

// ── Events ───────────────────────────────────────────────────────

/** Stored event — envelope assigned by the store + domain payload. */
export type StoredEvent<T = unknown> = {
  id: number // monotonic, assigned by store
  stream: string // grouping key (e.g. "task-001", "agent-scratch")
  type: string // event discriminator (e.g. "task-created")
  ts: string // ISO 8601, assigned by store
  data: T // domain payload
}

/** What callers pass to append. Store assigns id and ts. */
export type NewEvent<T = unknown> = {
  stream: string
  type: string
  data: T
}

// ── Reducer ──────────────────────────────────────────────────────

/** Pure function: fold one event into state. */
export type Reducer<S, E extends StoredEvent = StoredEvent> = (state: S, event: E) => S

// ── Snapshot ─────────────────────────────────────────────────────

export type Snapshot<S> = {
  state: S
  lastEventId: number
  ts: string
}

// ── Backends (swappable I/O) ─────────────────────────────────────

export type StoreBackend = {
  append(event: StoredEvent): Promise<void>
  readAll(): Promise<StoredEvent[]>
  lastId(): Promise<number>
}

export type SnapshotBackend<S> = {
  load(name: string): Promise<Snapshot<S> | null>
  save(name: string, snapshot: Snapshot<S>): Promise<void>
}
