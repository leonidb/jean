import { describe, test, expect } from 'bun:test'
import { createStore, memoryBackend, memorySnapshotBackend } from './store.ts'
import { createProjection } from './projection.ts'
import type { Reducer } from './types.ts'

// ── Trivial counter domain (no Jean knowledge) ──────────────────

type CounterEvent = { amount: number }

const counter: Reducer<number> = (n, event) => {
  if (event.type === 'add') return n + (event.data as CounterEvent).amount
  if (event.type === 'subtract') return n - (event.data as CounterEvent).amount
  return n
}

// ── Tests ────────────────────────────────────────────────────────

describe('createProjection', () => {
  test('catchUp with empty store returns initial state', async () => {
    const store = createStore(memoryBackend())
    const p = createProjection({ name: 'c', store, reducer: counter, initial: 0 })
    const state = await p.catchUp()
    expect(state).toBe(0)
    expect(p.version).toBe(0)
  })

  test('catchUp folds all events', async () => {
    const store = createStore(memoryBackend())
    await store.append({ stream: 's', type: 'add', data: { amount: 5 } })
    await store.append({ stream: 's', type: 'add', data: { amount: 3 } })
    await store.append({ stream: 's', type: 'subtract', data: { amount: 2 } })

    const p = createProjection({ name: 'c', store, reducer: counter, initial: 0 })
    const state = await p.catchUp()
    expect(state).toBe(6)
    expect(p.version).toBe(3)
  })

  test('apply folds a single event', async () => {
    const store = createStore(memoryBackend())
    const p = createProjection({ name: 'c', store, reducer: counter, initial: 0 })

    const e = await store.append({ stream: 's', type: 'add', data: { amount: 10 } })
    p.apply(e)
    expect(p.state).toBe(10)
    expect(p.version).toBe(1)
  })

  test('apply ignores events not matching type filter', async () => {
    const store = createStore(memoryBackend())
    const p = createProjection({
      name: 'c', store, reducer: counter, initial: 0,
      filter: { types: ['add'] },
    })

    const e1 = await store.append({ stream: 's', type: 'add', data: { amount: 10 } })
    const e2 = await store.append({ stream: 's', type: 'subtract', data: { amount: 3 } })
    p.apply(e1)
    p.apply(e2)
    expect(p.state).toBe(10) // subtract was ignored
  })

  test('apply ignores events not matching stream filter', async () => {
    const store = createStore(memoryBackend())
    const p = createProjection({
      name: 'c', store, reducer: counter, initial: 0,
      filter: { stream: 'a' },
    })

    const e1 = await store.append({ stream: 'a', type: 'add', data: { amount: 5 } })
    const e2 = await store.append({ stream: 'b', type: 'add', data: { amount: 100 } })
    p.apply(e1)
    p.apply(e2)
    expect(p.state).toBe(5) // stream b was ignored
  })

  test('catchUp with filter only replays matching events', async () => {
    const store = createStore(memoryBackend())
    await store.append({ stream: 's', type: 'add', data: { amount: 5 } })
    await store.append({ stream: 's', type: 'subtract', data: { amount: 2 } })
    await store.append({ stream: 's', type: 'add', data: { amount: 3 } })

    const p = createProjection({
      name: 'c', store, reducer: counter, initial: 0,
      filter: { types: ['add'] },
    })
    await p.catchUp()
    expect(p.state).toBe(8) // 5 + 3, subtract ignored
  })

  test('real-time apply matches catchUp result', async () => {
    const store = createStore(memoryBackend())

    // Approach 1: catchUp after all events
    const p1 = createProjection({ name: 'c1', store, reducer: counter, initial: 0 })

    // Approach 2: apply in real-time
    const p2 = createProjection({ name: 'c2', store, reducer: counter, initial: 0 })

    const events = [
      await store.append({ stream: 's', type: 'add', data: { amount: 10 } }),
      await store.append({ stream: 's', type: 'subtract', data: { amount: 3 } }),
      await store.append({ stream: 's', type: 'add', data: { amount: 7 } }),
    ]
    for (const e of events) p2.apply(e)

    await p1.catchUp()
    expect(p1.state).toBe(p2.state)
    expect(p1.state).toBe(14)
  })
})

describe('snapshots', () => {
  test('snapshot saves and catchUp restores', async () => {
    const store = createStore(memoryBackend())
    const snapshots = memorySnapshotBackend<number>()

    // Build state
    const p1 = createProjection({ name: 'c', store, reducer: counter, initial: 0, snapshots })
    await store.append({ stream: 's', type: 'add', data: { amount: 10 } })
    await store.append({ stream: 's', type: 'add', data: { amount: 5 } })
    await p1.catchUp()
    expect(p1.state).toBe(15)

    // Snapshot
    await p1.snapshot()

    // Add more events
    await store.append({ stream: 's', type: 'add', data: { amount: 3 } })

    // New projection catches up from snapshot + replays only event 3
    const p2 = createProjection({ name: 'c', store, reducer: counter, initial: 0, snapshots })
    await p2.catchUp()
    expect(p2.state).toBe(18)
    expect(p2.version).toBe(3)
  })

  test('catchUp without snapshot replays from beginning', async () => {
    const store = createStore(memoryBackend())
    const snapshots = memorySnapshotBackend<number>()

    await store.append({ stream: 's', type: 'add', data: { amount: 7 } })

    // No snapshot saved — catchUp replays everything
    const p = createProjection({ name: 'c', store, reducer: counter, initial: 0, snapshots })
    await p.catchUp()
    expect(p.state).toBe(7)
  })

  test('auto-snapshot triggers after threshold', async () => {
    const store = createStore(memoryBackend())
    const snapshots = memorySnapshotBackend<number>()

    // Append 5 events, auto-snapshot every 3
    for (let i = 0; i < 5; i++) {
      await store.append({ stream: 's', type: 'add', data: { amount: 1 } })
    }

    const p = createProjection({
      name: 'c', store, reducer: counter, initial: 0,
      snapshots, snapshotEvery: 3,
    })
    await p.catchUp()
    expect(p.state).toBe(5)

    // Snapshot should have been taken (5 >= 3)
    const snap = await snapshots.load('c')
    expect(snap).not.toBeNull()
    expect(snap!.state).toBe(5)
    expect(snap!.lastEventId).toBe(5)
  })

  test('auto-snapshot on apply', async () => {
    const store = createStore(memoryBackend())
    const snapshots = memorySnapshotBackend<number>()

    const p = createProjection({
      name: 'c', store, reducer: counter, initial: 0,
      snapshots, snapshotEvery: 2,
    })

    const e1 = await store.append({ stream: 's', type: 'add', data: { amount: 1 } })
    p.apply(e1)
    // Not yet — only 1 event
    expect(await snapshots.load('c')).toBeNull()

    const e2 = await store.append({ stream: 's', type: 'add', data: { amount: 1 } })
    p.apply(e2)
    // Auto-snapshot is fire-and-forget, give it a tick
    await Bun.sleep(10)
    const snap = await snapshots.load('c')
    expect(snap).not.toBeNull()
    expect(snap!.state).toBe(2)
  })
})
