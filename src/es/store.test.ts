import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { unlinkSync, writeFileSync } from 'node:fs'
import { createStore, fileSnapshotBackend, jsonlBackend, memoryBackend, memorySnapshotBackend } from './store.ts'
import type { StoreBackend, StoredEvent } from './types.ts'

// ── memoryBackend ────────────────────────────────────────────────

describe('memoryBackend', () => {
  test('starts empty', async () => {
    const b = memoryBackend()
    expect(await b.readAll()).toEqual([])
    expect(await b.lastId()).toBe(0)
  })

  test('append and readAll', async () => {
    const b = memoryBackend()
    await b.append({ id: 1, stream: 's', type: 't', ts: '', data: {} })
    await b.append({ id: 2, stream: 's', type: 't', ts: '', data: {} })
    const all = await b.readAll()
    expect(all.length).toBe(2)
    expect(all[0]?.id).toBe(1)
    expect(all[1]?.id).toBe(2)
  })

  test('lastId returns highest', async () => {
    const b = memoryBackend()
    await b.append({ id: 1, stream: 's', type: 't', ts: '', data: {} })
    await b.append({ id: 5, stream: 's', type: 't', ts: '', data: {} })
    expect(await b.lastId()).toBe(5)
  })

  test('readAll returns copies', async () => {
    const b = memoryBackend()
    await b.append({ id: 1, stream: 's', type: 't', ts: '', data: {} })
    const a = await b.readAll()
    const c = await b.readAll()
    expect(a).not.toBe(c)
  })
})

// ── jsonlBackend ─────────────────────────────────────────────────

const JSONL_PATH = '/tmp/jean-test-es-store.jsonl'

describe('jsonlBackend', () => {
  beforeEach(() => {
    try {
      unlinkSync(JSONL_PATH)
    } catch {}
  })
  afterEach(() => {
    try {
      unlinkSync(JSONL_PATH)
    } catch {}
  })

  test('starts empty when file missing', async () => {
    const b = jsonlBackend(JSONL_PATH)
    expect(await b.readAll()).toEqual([])
    expect(await b.lastId()).toBe(0)
  })

  test('append creates file and round-trips', async () => {
    const b = jsonlBackend(JSONL_PATH)
    await b.append({ id: 1, stream: 'test', type: 'ping', ts: '2026-01-01T00:00:00Z', data: { msg: 'hello' } })
    const all = await b.readAll()
    expect(all.length).toBe(1)
    expect(all[0]?.data).toEqual({ msg: 'hello' })
  })

  test('multiple appends are separate lines', async () => {
    const b = jsonlBackend(JSONL_PATH)
    await b.append({ id: 1, stream: 's', type: 't', ts: '', data: 'a' })
    await b.append({ id: 2, stream: 's', type: 't', ts: '', data: 'b' })
    await b.append({ id: 3, stream: 's', type: 't', ts: '', data: 'c' })
    const all = await b.readAll()
    expect(all.length).toBe(3)
    expect(await b.lastId()).toBe(3)
  })

  test('lastId reads from file', async () => {
    const b = jsonlBackend(JSONL_PATH)
    await b.append({ id: 10, stream: 's', type: 't', ts: '', data: null })
    // Fresh backend reads from file
    const b2 = jsonlBackend(JSONL_PATH)
    expect(await b2.lastId()).toBe(10)
  })
})

// ── createStore ──────────────────────────────────────────────────

function storeTests(name: string, makeBackend: () => StoreBackend) {
  describe(`createStore (${name})`, () => {
    test('append assigns sequential ids', async () => {
      const store = createStore(makeBackend())
      const e1 = await store.append({ stream: 's', type: 't', data: 'a' })
      const e2 = await store.append({ stream: 's', type: 't', data: 'b' })
      const e3 = await store.append({ stream: 's', type: 't', data: 'c' })
      expect(e1.id).toBe(1)
      expect(e2.id).toBe(2)
      expect(e3.id).toBe(3)
    })

    test('append assigns ts', async () => {
      const store = createStore(makeBackend())
      const e = await store.append({ stream: 's', type: 't', data: null })
      expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    test('read returns all events', async () => {
      const store = createStore(makeBackend())
      await store.append({ stream: 'a', type: 'x', data: 1 })
      await store.append({ stream: 'b', type: 'y', data: 2 })
      const all = await store.read()
      expect(all.length).toBe(2)
    })

    test('read with stream filter', async () => {
      const store = createStore(makeBackend())
      await store.append({ stream: 'a', type: 'x', data: 1 })
      await store.append({ stream: 'b', type: 'y', data: 2 })
      await store.append({ stream: 'a', type: 'z', data: 3 })
      const filtered = await store.read({ stream: 'a' })
      expect(filtered.length).toBe(2)
      expect(filtered.every((e) => e.stream === 'a')).toBe(true)
    })

    test('read with afterId filter', async () => {
      const store = createStore(makeBackend())
      await store.append({ stream: 's', type: 't', data: 1 })
      await store.append({ stream: 's', type: 't', data: 2 })
      await store.append({ stream: 's', type: 't', data: 3 })
      const after = await store.read({ afterId: 1 })
      expect(after.length).toBe(2)
      expect(after[0]?.id).toBe(2)
    })

    test('read with types filter', async () => {
      const store = createStore(makeBackend())
      await store.append({ stream: 's', type: 'add', data: 1 })
      await store.append({ stream: 's', type: 'remove', data: 2 })
      await store.append({ stream: 's', type: 'add', data: 3 })
      const adds = await store.read({ types: ['add'] })
      expect(adds.length).toBe(2)
    })

    test('read with combined filters', async () => {
      const store = createStore(makeBackend())
      await store.append({ stream: 'a', type: 'add', data: 1 })
      await store.append({ stream: 'a', type: 'remove', data: 2 })
      await store.append({ stream: 'b', type: 'add', data: 3 })
      const result = await store.read({ stream: 'a', types: ['add'] })
      expect(result.length).toBe(1)
      expect(result[0]?.data).toBe(1)
    })

    test('lastId returns current counter', async () => {
      const store = createStore(makeBackend())
      expect(await store.lastId()).toBe(0)
      await store.append({ stream: 's', type: 't', data: null })
      expect(await store.lastId()).toBe(1)
    })
  })
}

storeTests('memory', memoryBackend)
storeTests('jsonl', () => {
  try {
    unlinkSync(JSONL_PATH)
  } catch {}
  return jsonlBackend(JSONL_PATH)
})

// ── snapshot backends ────────────────────────────────────────────

describe('memorySnapshotBackend', () => {
  test('load returns null when empty', async () => {
    const b = memorySnapshotBackend()
    expect(await b.load('test')).toBeNull()
  })

  test('save and load round-trips', async () => {
    const b = memorySnapshotBackend<number>()
    await b.save('counter', { state: 42, lastEventId: 10, ts: '2026-01-01T00:00:00Z' })
    const snap = await b.load('counter')
    expect(snap?.state).toBe(42)
    expect(snap?.lastEventId).toBe(10)
  })
})

const SNAP_DIR = '/tmp/jean-test-es-snapshots'

describe('fileSnapshotBackend', () => {
  beforeEach(async () => {
    try {
      unlinkSync(`${SNAP_DIR}/test.snapshot.json`)
    } catch {}
  })

  test('load returns null when file missing', async () => {
    const b = fileSnapshotBackend(SNAP_DIR)
    expect(await b.load('missing')).toBeNull()
  })

  test('save and load round-trips', async () => {
    const b = fileSnapshotBackend<{ count: number }>(SNAP_DIR)
    await b.save('test', { state: { count: 7 }, lastEventId: 5, ts: '2026-01-01T00:00:00Z' })
    const snap = await b.load('test')
    expect(snap?.state).toEqual({ count: 7 })
    expect(snap?.lastEventId).toBe(5)
  })
})

// ── Append concurrency (task 011) ────────────────────────────────
//
// Found during task-001 rate verification: `event IDs are sequential` failed
// on a single fetch, meaning the LOG was out of order. Two distinct defects
// lived in append(), and these tests pin both. Each was verified to FAIL
// against the pre-fix code before the fix landed — a concurrency test that
// can't fail on the broken version is decoration.

const CONC_PATH = '/tmp/jean-test-es-concurrency.jsonl'

describe('createStore — concurrent appends (task 011)', () => {
  beforeEach(() => {
    try {
      unlinkSync(CONC_PATH)
    } catch {}
  })
  afterEach(() => {
    try {
      unlinkSync(CONC_PATH)
    } catch {}
  })

  test('ids issued in one tick are unique — the reservation is atomic', async () => {
    // PRE-FIX: 50 distinct ids collapsed to ONE (49 collisions). ensureId()
    // RETURNED the counter, so every caller that entered before the first one
    // resumed captured the same value and computed the same id.
    const store = createStore(jsonlBackend(CONC_PATH))
    await store.append({ stream: 's', type: 'warmup', data: {} }) // steady state, not first-call init

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => store.append({ stream: 's', type: 'burst', data: { i } })),
    )
    const ids = results.map((r) => r.id)
    expect(new Set(ids).size).toBe(50)
    // …and they are consecutive: reservation order with no gaps.
    expect(ids).toEqual(ids.map((_, i) => (ids[0] as number) + i))
  })

  test('a cold store handing out its first ids concurrently does not hand out the same one twice', async () => {
    // The init path had its own version of the race: two first-callers each
    // loaded lastId and each ASSIGNED it, the second clobbering the first's
    // reservation. Both got id 1.
    const store = createStore(jsonlBackend(CONC_PATH))
    const [a, b] = await Promise.all([
      store.append({ stream: 's', type: 'a', data: {} }),
      store.append({ stream: 's', type: 'b', data: {} }),
    ])
    expect(a?.id).not.toBe(b?.id)
    expect([a?.id, b?.id].sort()).toEqual([1, 2])
  })

  test('THE LOG STAYS ORDERED: concurrent appends reach the file in id order', async () => {
    // PRE-FIX: 240 concurrent sends produced 30 out-of-order pairs on a live
    // server, 27 via a WS burst. O_APPEND makes each line atomic and says
    // nothing about order between writers.
    const store = createStore(jsonlBackend(CONC_PATH))
    await Promise.all(Array.from({ length: 60 }, (_, i) => store.append({ stream: 's', type: 'e', data: { i } })))
    const onDisk = await createStore(jsonlBackend(CONC_PATH)).read()
    const ids = onDisk.map((e) => e.id)
    expect(ids.length).toBe(60)
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i] as number).toBeGreaterThan(ids[i - 1] as number)
    }
  })

  test('one failed write does not wedge every later append', async () => {
    // The chain swallows failures so a single bad write can't stall the queue
    // forever — but the caller whose write failed must still see its own error.
    let failNext = false
    const backend: StoreBackend = {
      async append(event) {
        if (failNext) {
          failNext = false
          throw new Error('disk full')
        }
        events.push(event)
      },
      async readAll() {
        return [...events]
      },
      async lastId() {
        return events.at(-1)?.id ?? 0
      },
    }
    const events: StoredEvent[] = []
    const store = createStore(backend)

    await store.append({ stream: 's', type: 'ok', data: {} })
    failNext = true
    await expect(store.append({ stream: 's', type: 'doomed', data: {} })).rejects.toThrow('disk full')
    // The queue keeps moving.
    const after = await store.append({ stream: 's', type: 'after', data: {} })
    expect(after.id).toBe(3) // the failed append still consumed its id — gaps beat reuse
    expect((await store.read()).map((e) => e.type)).toEqual(['ok', 'after'])
  })

  test('a FAILED id load does not poison the store — the next append retries', async () => {
    // Review finding (2026-07-27), found independently by two readers. The
    // shared init promise is assigned with `??=` and was never cleared on
    // rejection, so one failed `lastId()` — a transient FS error, an EMFILE
    // under load — handed that same rejected promise to every later append for
    // the rest of the process's life. The pre-fix code retried on the next call
    // because it kept no promise; this asserts that behaviour is back.
    let failNextLoad = true
    const events: StoredEvent[] = []
    const backend: StoreBackend = {
      async append(event) {
        events.push(event)
      },
      async readAll() {
        return [...events]
      },
      async lastId() {
        if (failNextLoad) {
          failNextLoad = false
          throw new Error('lastId unavailable')
        }
        return events.at(-1)?.id ?? 0
      },
    }
    const store = createStore(backend)

    // The caller that triggers the failed load must still SEE the failure…
    await expect(store.append({ stream: 's', type: 'first', data: {} })).rejects.toThrow('lastId unavailable')
    // …and the store must not be dead afterwards.
    const recovered = await store.append({ stream: 's', type: 'second', data: {} })
    expect(recovered.id).toBe(1)
    expect((await store.read()).map((e) => e.type)).toEqual(['second'])
  })

  test('an append QUEUED BEHIND an in-flight failure still lands, in order', async () => {
    // The existing failed-write test awaits the rejection before issuing the
    // next append, so it only proves recovery AFTER the failure is observed.
    // This one issues both in the same tick, so the second is already sitting
    // on the chain when the first rejects — the case where a non-swallowing
    // chain would wedge every later append.
    const events: StoredEvent[] = []
    const backend: StoreBackend = {
      async append(event) {
        if (event.type === 'doomed') throw new Error('disk full')
        events.push(event)
      },
      async readAll() {
        return [...events]
      },
      async lastId() {
        return events.at(-1)?.id ?? 0
      },
    }
    const store = createStore(backend)
    await store.append({ stream: 's', type: 'ok', data: {} })

    const doomed = store.append({ stream: 's', type: 'doomed', data: {} })
    const queued = store.append({ stream: 's', type: 'queued', data: {} })
    await expect(doomed).rejects.toThrow('disk full')
    expect((await queued).id).toBe(3)
    expect((await store.read()).map((e) => e.type)).toEqual(['ok', 'queued'])
  })
})

describe('jsonlBackend.lastId — recovery for logs written before task 011', () => {
  beforeEach(() => {
    try {
      unlinkSync(CONC_PATH)
    } catch {}
  })
  afterEach(() => {
    try {
      unlinkSync(CONC_PATH)
    } catch {}
  })

  test('RESTART REISSUE REGRESSION: an out-of-order tail must not make the next append reuse a live id', async () => {
    // The severe consequence, reproduced verbatim from the finding: a log of
    // ids 1,3,2 (max 3, LAST LINE 2). Reading the last line under-reads by one
    // and the next append returns id 3 — a collision inside history.jsonl, the
    // file this system never rewrites. Serialized writes stop NEW logs from
    // going out of order; this covers every log already written by the old code
    // (all eight production dojos carry inversions today).
    const line = (id: number) => JSON.stringify({ id, stream: 's', type: 't', ts: '', data: {} })
    writeFileSync(CONC_PATH, `${[line(1), line(3), line(2)].join('\n')}\n`)

    expect(await jsonlBackend(CONC_PATH).lastId()).toBe(3) // by value, not position
    const next = await createStore(jsonlBackend(CONC_PATH)).append({ stream: 's', type: 'after-restart', data: {} })
    expect(next.id).toBe(4)
  })

  test('a truncated final line does not reset the counter and start overwriting history', async () => {
    // A hard kill mid-write leaves a half line. Parsing it fails; returning 0
    // would restart ids from 1 and bury the existing log under duplicates.
    const line = (id: number) => JSON.stringify({ id, stream: 's', type: 't', ts: '', data: {} })
    writeFileSync(CONC_PATH, `${line(1)}\n${line(2)}\n{"id":3,"stream":"s"`)
    expect(await jsonlBackend(CONC_PATH).lastId()).toBe(2)
  })
})
