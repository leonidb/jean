// Attention phase 2 (docs/attention.md §4): blocking (human) events wake the
// sensei REGARDLESS of the idle flag, with burst coalescing and escalating
// backoff re-wakes; machine events keep the idle-gated nudge. The first test is
// the stall-class kill: the exact stuck-idle state that produced the measured
// 3-hour stall must no longer starve a waiting human.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'
import type { DeliverMsg, OutboundMsg } from './protocol.ts'
import { connectAgent } from './test-helpers.ts'

const TEST_PORT = 8807
const DATA_DIR = '/tmp/jean-test-attention-wake'
const BACKOFF_MS = 700 // env-shrunk so re-wakes are observable in-test
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
      JEAN_BLOCKING_BACKOFF_MS: String(BACKOFF_MS),
      JEAN_STALL_NUDGE_MS: String(60_000), // park the watchdog far away — isolate phase-2 behavior
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

const isBlockingWake = (m: OutboundMsg): m is DeliverMsg =>
  m.type === 'deliver' && m.from === 'infra' && m.text.startsWith('A human is waiting')

async function ackAll() {
  const events = (await (await fetch(`${BASE}/events`)).json()) as { events: Array<{ id: number }> }
  if (events.events.length === 0) return
  const maxId = Math.max(...events.events.map((e) => e.id))
  await fetch(`${BASE}/events/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upToId: maxId }),
  })
}

describe('attention phase 2 — blocking wake', () => {
  test('STALL-KILL: a human message wakes a sensei stuck non-idle; a machine event does not', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using human = await connectAgent(WS_URL, 'human', 'user')
    void human

    // Wedge the sensei exactly like the measured failure: a machine event
    // (worker register) fires the idle-gated nudge → idle:false; no /agent-idle
    // ever arrives (the missed Stop hook).
    using _w = await connectAgent(WS_URL, 'w1', 'worker')
    let stuck = false
    for (let i = 0; i < 20 && !stuck; i++) {
      const s = (await (await fetch(`${BASE}/status`)).json()) as { sensei: { idle: boolean } }
      stuck = !s.sensei.idle
      if (!stuck) await Bun.sleep(25)
    }
    expect(stuck).toBe(true)
    expect(sensei.messages.filter(isBlockingWake).length).toBe(0)

    // A second machine event while stuck: idle-gated → must NOT deliver anything new.
    const deliversBefore = sensei.messages.filter((m) => m.type === 'deliver').length
    using _w2 = await connectAgent(WS_URL, 'w2', 'worker')
    await Bun.sleep(200)
    expect(sensei.messages.filter((m) => m.type === 'deliver').length).toBe(deliversBefore)

    // The human speaks: the wake must arrive DESPITE idle:false.
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'are you there?' }))
    let wake: DeliverMsg | undefined
    for (let i = 0; i < 20 && !wake; i++) {
      wake = sensei.messages.find(isBlockingWake)
      if (!wake) await Bun.sleep(50)
    }
    expect(wake).toBeDefined()
    expect(wake?.text).toContain('"blocking"') // carries the full inbox
    expect(wake?.text).toContain('are you there?')

    await ackAll() // clean slate for the next test
  })

  test('burst coalescing: messages during an active episode do not multiply wakes; backoff re-wakes while unhandled; ack ends the episode', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using human = await connectAgent(WS_URL, 'human', 'user')

    // Burst of three messages in quick succession → exactly ONE immediate wake.
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'q1' }))
    await Bun.sleep(80)
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'q2' }))
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'q3' }))
    await Bun.sleep(250)
    expect(sensei.messages.filter(isBlockingWake).length).toBe(1)

    // Unhandled → the backoff loop re-wakes (env-shrunk schedule).
    let rewakes = 0
    for (let i = 0; i < 40; i++) {
      rewakes = sensei.messages.filter(isBlockingWake).length
      if (rewakes >= 2) break
      await Bun.sleep(100)
    }
    expect(rewakes).toBeGreaterThanOrEqual(2)
    // The re-wake carries the coalesced entry: count 3, oldest age, latest preview.
    const last = sensei.messages.filter(isBlockingWake).at(-1)
    expect(last?.text).toContain('"count": 3')
    expect(last?.text).toContain('q3')

    // Ack drains the episode → no further blocking wakes.
    await ackAll()
    await Bun.sleep(BACKOFF_MS + 400)
    const afterAck = sensei.messages.filter(isBlockingWake).length
    await Bun.sleep(BACKOFF_MS + 200)
    expect(sensei.messages.filter(isBlockingWake).length).toBe(afterAck)

    // A NEW human message after the drain starts a fresh episode: immediate wake.
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'new question' }))
    let fresh = afterAck
    for (let i = 0; i < 20 && fresh === afterAck; i++) {
      fresh = sensei.messages.filter(isBlockingWake).length
      if (fresh === afterAck) await Bun.sleep(50)
    }
    expect(fresh).toBe(afterAck + 1)
    await ackAll()
  })
})
