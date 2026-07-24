// Attention phase 3 (docs/attention.md §5): answering a bridge human IS the
// ack — the sensei's outbound reply auto-clears that user's blocking event,
// but ONLY under the exactly-one rule (a burst requires an explicit ack so a
// quick reply to question #1 can't silently swallow question #2). Plus the
// per-event ack form (ids) alongside the upToId drain-all.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'
import { connectAgent } from './test-helpers.ts'

const TEST_PORT = 8805
const DATA_DIR = '/tmp/jean-test-attention-autoclear'
let server: Subprocess

beforeAll(async () => {
  try {
    rmSync(DATA_DIR, { recursive: true })
  } catch {}
  mkdirSync(DATA_DIR, { recursive: true })
  server = Bun.spawn(['bun', 'run', 'src/infra/server.ts'], {
    env: {
      ...process.env,
      JEAN_PORT: String(TEST_PORT),
      JEAN_DATA_DIR: DATA_DIR,
      JEAN_STALL_NUDGE_MS: String(60_000),
    },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(`http://127.0.0.1:${TEST_PORT}/`)
      break
    } catch {
      await Bun.sleep(100)
    }
  }
})

afterAll(() => {
  server.kill()
})

const BASE = `http://127.0.0.1:${TEST_PORT}`
const WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`

async function pendingFrom(sender: string): Promise<number[]> {
  const res = (await (await fetch(`${BASE}/events`)).json()) as {
    events: Array<{ id: number; type: string; data: { agent?: string } }>
  }
  return res.events.filter((e) => e.type === 'reply' && e.data.agent === sender).map((e) => e.id)
}

async function senseiSend(to: string, text: string) {
  return (await (
    await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'sensei', to, text }),
    })
  ).json()) as { delivered?: boolean }
}

describe('attention phase 3 — auto-clear-on-reply', () => {
  test('exactly one pending message: the reply auto-clears it (ack auto:reply recorded)', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using human = await connectAgent(WS_URL, 'human', 'user')
    void sensei

    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'single question' }))
    await Bun.sleep(150)
    expect((await pendingFrom('human')).length).toBe(1)

    const { delivered } = await senseiSend('human', 'here is your answer')
    expect(delivered).toBe(true)
    await Bun.sleep(150)

    // The human's event is gone from pending WITHOUT any manual ack…
    expect((await pendingFrom('human')).length).toBe(0)
    // …via an infra-generated ack marked auto:'reply'.
    const history = (await (await fetch(`${BASE}/history?last=15`)).json()) as {
      events: Array<{ type: string; data: { auto?: string } }>
    }
    expect(history.events.some((e) => e.type === 'ack' && e.data.auto === 'reply')).toBe(true)
  })

  test('burst (two pending): reply does NOT auto-clear — explicit selective ack does', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using human = await connectAgent(WS_URL, 'human', 'user')
    void sensei

    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'question A' }))
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'question B' }))
    await Bun.sleep(200)
    const ids = await pendingFrom('human')
    expect(ids.length).toBe(2)

    await senseiSend('human', 'answering A only')
    await Bun.sleep(150)
    // Exactly-one rule: BOTH stay pending — question B must not silently vanish.
    expect((await pendingFrom('human')).length).toBe(2)

    // Selective per-event ack clears just one, the other remains visible.
    const ackOne = (await (
      await fetch(`${BASE}/events/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [ids[0]] }),
      })
    ).json()) as { acknowledged: number }
    expect(ackOne.acknowledged).toBe(1)
    const left = await pendingFrom('human')
    expect(left).toEqual([ids[1] as number])

    // Now exactly one remains → the NEXT reply auto-clears it.
    await senseiSend('human', 'and here is B')
    await Bun.sleep(150)
    expect((await pendingFrom('human')).length).toBe(0)
  })

  test('a proactive send (nothing pending at initiation) never auto-clears — entry snapshot', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using human = await connectAgent(WS_URL, 'human', 'user')
    void sensei

    expect((await pendingFrom('human')).length).toBe(0)
    // Sensei speaks first (proactive) — snapshot at entry is empty, so nothing
    // this send can ever clear, even if a message lands mid-flight.
    await senseiSend('human', 'proactive: how was the ride?')
    // The human's message arrives after — must stay pending (it was never seen).
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'good! also, a question…' }))
    await Bun.sleep(150)
    expect((await pendingFrom('human')).length).toBe(1)

    const ids = await pendingFrom('human')
    await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
  })

  test('ack validation: empty/invalid ids and bad upToId fail loud (400), not success-shaped no-ops', async () => {
    const emptyIds = await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [] }),
    })
    expect(emptyIds.status).toBe(400)

    const stringIds = await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['110'] }),
    })
    expect(stringIds.status).toBe(400)

    const badUpTo = await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upToId: -1 }),
    })
    expect(badUpTo.status).toBe(400)
  })

  test('ack ids validation: non-pending ids are harmless no-ops; upToId+ids rejected', async () => {
    const noop = (await (
      await fetch(`${BASE}/events/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [999999] }),
      })
    ).json()) as { acknowledged: number }
    expect(noop.acknowledged).toBe(0)

    const both = await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upToId: 5, ids: [1] }),
    })
    expect(both.status).toBe(400)
  })

  test("a worker's reply to the sensei never triggers auto-clear (sender must be the sensei, target a user)", async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using human = await connectAgent(WS_URL, 'human', 'user')
    using worker = await connectAgent(WS_URL, 'w1', 'worker')
    void sensei
    void worker

    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'still pending?' }))
    await Bun.sleep(150)
    // Sensei messages the WORKER (not the human) — must not clear the human's event.
    await senseiSend('w1', 'status check please')
    await Bun.sleep(150)
    expect((await pendingFrom('human')).length).toBe(1)

    // Cleanup for isolation.
    const ids = await pendingFrom('human')
    await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
  })
})
