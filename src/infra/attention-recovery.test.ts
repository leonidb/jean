// Attention phase 2 — the failure scenarios the review proved live (2026-07-24):
// the episode state machine must be SELF-HEALING across the routine
// discontinuities. A blocking event pending with no wake fired (infra restart,
// sensei absent at arrival, masked arrival) converges within ~one backoff tick
// of a sensei being available — never fails closed until the watchdog.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Subprocess } from 'bun'
import type { DeliverMsg, OutboundMsg } from './protocol.ts'
import { connectAgent } from './test-helpers.ts'

const TEST_PORT = 8806
const DATA_DIR = '/tmp/jean-test-attention-recovery'
const BACKOFF_MS = 500
const BASE = `http://127.0.0.1:${TEST_PORT}`
const WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`

let server: Subprocess | null = null

async function startServer(extraEnv: Record<string, string> = {}) {
  server = Bun.spawn(['bun', 'run', 'src/infra/server.ts'], {
    env: {
      ...process.env,
      JEAN_PORT: String(TEST_PORT),
      JEAN_DATA_DIR: DATA_DIR,
      JEAN_BLOCKING_BACKOFF_MS: String(BACKOFF_MS),
      JEAN_STALL_NUDGE_MS: String(60_000),
      ...extraEnv,
    },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`${BASE}/`)
      return
    } catch {
      await Bun.sleep(100)
    }
  }
  throw new Error('server did not start')
}

function stopServer() {
  server?.kill()
  server = null
}

beforeEach(() => {
  try {
    rmSync(DATA_DIR, { recursive: true })
  } catch {}
  mkdirSync(DATA_DIR, { recursive: true })
})
afterEach(() => {
  stopServer()
})

const isBlockingWake = (m: OutboundMsg): m is DeliverMsg =>
  m.type === 'deliver' && m.from === 'infra' && m.text.startsWith('A human is waiting')

async function waitForBlockingWake(sensei: { messages: OutboundMsg[] }, tries = 40): Promise<DeliverMsg | undefined> {
  for (let i = 0; i < tries; i++) {
    const wake = sensei.messages.find(isBlockingWake)
    if (wake) return wake
    await Bun.sleep(100)
  }
  return undefined
}

describe('attention phase 2 — self-healing recovery', () => {
  test('RESTART: blocking pending in seeded history (unregistered chat-* sender) wakes the sensei after boot', async () => {
    // Seed history with a pending human reply and NO register event — covers
    // both the restart scenario (in-memory episode state lost) and the chat-
    // prefix classification fallback (no persisted register to learn from).
    writeFileSync(
      resolve(DATA_DIR, 'history.jsonl'),
      `${JSON.stringify({
        id: 1,
        stream: 'agent:chat-999',
        type: 'reply',
        ts: new Date().toISOString(),
        data: { agent: 'chat-999', text: 'anyone there after the restart?' },
      })}\n`,
    )
    await startServer()

    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    const wake = await waitForBlockingWake(sensei)
    expect(wake).toBeDefined() // the tick self-heals the unstarted episode
    expect(wake?.text).toContain('anyone there after the restart?')
    expect(wake?.text).toContain('"blocking"')
  })

  test('SENSEI-ABSENT: a human message with no sensei connected wakes it soon after it connects; later messages still work', async () => {
    await startServer()
    using human = await connectAgent(WS_URL, 'human', 'user')
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'hello? nobody home?' }))
    await Bun.sleep(300) // arrival wake is a no-op (no sensei); episode must not poison

    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    const wake = await waitForBlockingWake(sensei)
    expect(wake).toBeDefined()
    expect(wake?.text).toContain('hello? nobody home?')

    // The recorded nudge event carries blocking: true (event-level contract).
    const history = (await (await fetch(`${BASE}/history?last=20`)).json()) as {
      events: Array<{ type: string; data: { blocking?: boolean } }>
    }
    expect(history.events.some((e) => e.type === 'nudge' && e.data.blocking === true)).toBe(true)

    // Drain, then a NEW human message still gets a fresh immediate wake (no poisoned state).
    const events = (await (await fetch(`${BASE}/events`)).json()) as { events: Array<{ id: number }> }
    await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upToId: Math.max(...events.events.map((e) => e.id)) }),
    })
    const before = sensei.messages.filter(isBlockingWake).length
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'second question' }))
    let after = before
    for (let i = 0; i < 20 && after === before; i++) {
      after = sensei.messages.filter(isBlockingWake).length
      if (after === before) await Bun.sleep(50)
    }
    expect(after).toBe(before + 1)
  })

  test('WATCHDOG STANDDOWN: no Watchdog fire while a blocking episode is active', async () => {
    // Watchdog window shrunk BELOW the blocking backoff — without the
    // standdown it would double-fire alongside the episode's re-wakes.
    stopServer()
    await startServer({ JEAN_STALL_NUDGE_MS: '900', JEAN_BLOCKING_BACKOFF_MS: '1500' })
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using human = await connectAgent(WS_URL, 'human', 'user')
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'urgent!' }))
    await waitForBlockingWake(sensei)

    await Bun.sleep(3_800) // several watchdog windows + ≥1 full backoff period elapse
    const watchdogs = sensei.messages.filter((m) => m.type === 'deliver' && m.text.startsWith('Watchdog:')).length
    expect(watchdogs).toBe(0) // backoff re-wakes own delivery during the episode
    expect(sensei.messages.filter(isBlockingWake).length).toBeGreaterThanOrEqual(2) // and they DID re-wake
  })
})
