import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { unlinkSync } from 'fs'
import { createStore, memoryBackend, jsonlBackend, memorySnapshotBackend, fileSnapshotBackend } from './store.ts'
import type { StoreBackend } from './types.ts'

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
    expect(all[0]!.id).toBe(1)
    expect(all[1]!.id).toBe(2)
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
  beforeEach(() => { try { unlinkSync(JSONL_PATH) } catch {} })
  afterEach(() => { try { unlinkSync(JSONL_PATH) } catch {} })

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
    expect(all[0]!.data).toEqual({ msg: 'hello' })
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
      expect(filtered.every(e => e.stream === 'a')).toBe(true)
    })

    test('read with afterId filter', async () => {
      const store = createStore(makeBackend())
      await store.append({ stream: 's', type: 't', data: 1 })
      await store.append({ stream: 's', type: 't', data: 2 })
      await store.append({ stream: 's', type: 't', data: 3 })
      const after = await store.read({ afterId: 1 })
      expect(after.length).toBe(2)
      expect(after[0]!.id).toBe(2)
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
      expect(result[0]!.data).toBe(1)
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
  try { unlinkSync(JSONL_PATH) } catch {}
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
    expect(snap!.state).toBe(42)
    expect(snap!.lastEventId).toBe(10)
  })
})

const SNAP_DIR = '/tmp/jean-test-es-snapshots'

describe('fileSnapshotBackend', () => {
  beforeEach(async () => {
    try { unlinkSync(`${SNAP_DIR}/test.snapshot.json`) } catch {}
  })

  test('load returns null when file missing', async () => {
    const b = fileSnapshotBackend(SNAP_DIR)
    expect(await b.load('missing')).toBeNull()
  })

  test('save and load round-trips', async () => {
    const b = fileSnapshotBackend<{ count: number }>(SNAP_DIR)
    await b.save('test', { state: { count: 7 }, lastEventId: 5, ts: '2026-01-01T00:00:00Z' })
    const snap = await b.load('test')
    expect(snap!.state).toEqual({ count: 7 })
    expect(snap!.lastEventId).toBe(5)
  })
})
