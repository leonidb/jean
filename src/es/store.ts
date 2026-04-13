/**
 * Event store — append events, read them back, manage snapshots.
 *
 * Two backends: in-memory (tests) and JSONL (production).
 */

import { appendFile } from 'node:fs/promises'
import type { NewEvent, Snapshot, SnapshotBackend, StoreBackend, StoredEvent } from './types.ts'

// ── EventStore ───────────────────────────────────────────────────

export type ReadOpts = {
  stream?: string // filter to a single stream
  afterId?: number // only events with id > afterId
  types?: string[] // filter by event type(s)
}

export type EventStore = {
  append(event: NewEvent): Promise<StoredEvent>
  read(opts?: ReadOpts): Promise<StoredEvent[]>
  lastId(): Promise<number>
}

export function createStore(backend: StoreBackend): EventStore {
  let nextId: number | null = null

  async function ensureId(): Promise<number> {
    if (nextId === null) nextId = await backend.lastId()
    return nextId
  }

  return {
    async append(event) {
      const id = (await ensureId()) + 1
      nextId = id // increment before async write to prevent concurrent duplicates
      const stored: StoredEvent = {
        id,
        stream: event.stream,
        type: event.type,
        ts: new Date().toISOString(),
        data: event.data,
      }
      await backend.append(stored)
      return stored
    },

    async read(opts) {
      let events = await backend.readAll()
      if (opts?.stream) events = events.filter((e) => e.stream === opts.stream)
      const afterId = opts?.afterId
      if (afterId !== undefined) events = events.filter((e) => e.id > afterId)
      if (opts?.types) {
        const set = new Set(opts.types)
        events = events.filter((e) => set.has(e.type))
      }
      return events
    },

    lastId: () => ensureId(),
  }
}

// ── In-memory backend ────────────────────────────────────────────

export function memoryBackend(): StoreBackend {
  const events: StoredEvent[] = []
  return {
    async append(event) {
      events.push(event)
    },
    async readAll() {
      return [...events]
    },
    async lastId() {
      return events.at(-1)?.id ?? 0
    },
  }
}

// ── JSONL file backend ───────────────────────────────────────────

export function jsonlBackend(path: string): StoreBackend {
  return {
    async append(event) {
      await appendFile(path, `${JSON.stringify(event)}\n`)
    },

    async readAll() {
      const file = Bun.file(path)
      if (!(await file.exists())) return []
      const text = await file.text()
      return text
        .trimEnd()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as StoredEvent)
    },

    async lastId() {
      const file = Bun.file(path)
      if (!(await file.exists())) return 0
      const text = await file.text()
      const lines = text.trimEnd().split('\n')
      const lastLine = lines.at(-1)
      if (!lastLine) return 0
      try {
        const last = JSON.parse(lastLine) as StoredEvent
        return last.id
      } catch {
        return 0
      }
    },
  }
}

// ── Snapshot backends ────────────────────────────────────────────

export function memorySnapshotBackend<S>(): SnapshotBackend<S> {
  const snapshots = new Map<string, Snapshot<S>>()
  return {
    async load(name) {
      return snapshots.get(name) ?? null
    },
    async save(name, snapshot) {
      snapshots.set(name, snapshot)
    },
  }
}

export function fileSnapshotBackend<S>(dir: string): SnapshotBackend<S> {
  return {
    async load(name) {
      const file = Bun.file(`${dir}/${name}.snapshot.json`)
      if (!(await file.exists())) return null
      return file.json() as Promise<Snapshot<S>>
    },
    async save(name, snapshot) {
      await Bun.write(`${dir}/${name}.snapshot.json`, `${JSON.stringify(snapshot)}\n`)
    },
  }
}
