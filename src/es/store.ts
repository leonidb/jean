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
  /** In-flight first-call id load, shared so concurrent cold appends init once. */
  let initializing: Promise<void> | null = null
  /** Tail of the write chain. Appends queue behind it in id order. */
  let writes: Promise<unknown> = Promise.resolve()

  async function ensureInitialized(): Promise<void> {
    if (nextId !== null) return
    // Two concurrent first appends must not each load and each ASSIGN — the
    // second assignment would clobber the first's reservation and hand both
    // callers the same id. One load, shared.
    initializing ??= backend
      .lastId()
      .then((last) => {
        nextId = last
      })
      .catch((err) => {
        // A FAILED load must not be cached (review, 2026-07-27). `??=` would
        // hand the same rejected promise to every later append for the rest of
        // the process's life, turning a transient FS error — an EMFILE under
        // load, a permissions blip — into a permanent one. The pre-fix code
        // retried on the next call because it kept no promise; clearing here
        // restores that. The caller still sees this failure: the rethrow keeps
        // the rejection flowing to whoever awaited.
        initializing = null
        throw err
      })
    await initializing
  }

  return {
    /**
     * Append one event: reserve an id, then write.
     *
     * Both halves are concurrency-critical, and both were broken (task 011,
     * found during task-001 rate verification, 2026-07-25):
     *
     * RESERVATION had to become atomic. The old code did `const id = (await
     * ensureId()) + 1`, where ensureId RETURNED the counter — so every caller
     * that entered before the first one resumed captured the same value and
     * computed the same id. Measured at the store's own API: 50 appends
     * started in one tick returned ONE distinct id, 49 collisions. Reading and
     * incrementing with no await between them is what makes it safe; the
     * server's current call paths happened not to trigger it (frames land in
     * separate macrotasks), but `void record(...)` makes it one careless line
     * away.
     *
     * WRITES had to become ordered. `appendFile` uses O_APPEND, which makes
     * each line atomic but says nothing about ORDER between concurrent
     * writers, so a higher id could land first. Measured on a live server: 240
     * concurrent sends produced 30 out-of-order pairs; a WS burst produced 27.
     * That is not cosmetic — `jsonlBackend.lastId()` used to read the file's
     * LAST LINE, so a log whose tail wasn't its max id made the next restart
     * REISSUE a live id into history.jsonl, the one file this system never
     * rewrites. (Every production dojo's log carries inversions today; they are
     * benign only because none happens to sit at the tail. See lastId below,
     * which no longer trusts position, and scripts/audit-history.ts.)
     *
     * Cost: none worth measuring. The writes were already serialized by the
     * kernel; this just makes the order deterministic and the reservation
     * honest.
     */
    async append(event) {
      await ensureInitialized()
      // Atomic reservation: no await between the read and the increment.
      nextId = (nextId as number) + 1
      const stored: StoredEvent = {
        id: nextId,
        stream: event.stream,
        type: event.type,
        ts: new Date().toISOString(),
        data: event.data,
      }
      // Queue behind whatever is already writing, so ids reach the log in the
      // order they were issued. The chain swallows failures (`catch`) so one
      // bad write can't wedge every later append; the caller still sees its own
      // rejection by awaiting `write` directly.
      const write = writes.then(() => backend.append(stored))
      writes = write.catch(() => {})
      await write
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

    async lastId() {
      await ensureInitialized()
      return nextId as number
    },
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

    /**
     * Highest id in the log — by VALUE, not by position.
     *
     * This used to read the last line and trust it. That is only correct if
     * the log is ordered, which the append race broke (task 011): a log whose
     * tail isn't its max id made a restart under-read and REISSUE a live id.
     * Reproduced deterministically on a log of ids 1,3,2 — the next append got
     * id 3, colliding with an existing event.
     *
     * Serialized writes stop new logs from going out of order, but every log
     * written before the fix still can be, and this file is append-only — so
     * recovery has to be read-side. Scanning is affordable: readAll() already
     * parses the whole file, and this runs once per process at startup.
     * Unparseable lines are skipped rather than fatal, matching readAll's
     * tolerance — a truncated tail from a hard kill must not reset the counter
     * to 0 and start overwriting the log's own history.
     */
    async lastId() {
      const file = Bun.file(path)
      if (!(await file.exists())) return 0
      const text = await file.text()
      let max = 0
      for (const line of text.trimEnd().split('\n')) {
        if (line.length === 0) continue
        try {
          const { id } = JSON.parse(line) as StoredEvent
          if (typeof id === 'number' && id > max) max = id
        } catch {
          // skip malformed line
        }
      }
      return max
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
