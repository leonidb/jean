import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'
import type { DeliverMsg, OutboundMsg } from './protocol.ts'
import { connectAgent } from './test-helpers.ts'

const TEST_PORT = 8800
const DATA_DIR = '/tmp/jean-test-stall-watchdog'
const STALL_MS = 500
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
      JEAN_STALL_NUDGE_MS: String(STALL_MS),
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

const isWatchdogNudge = (m: OutboundMsg): m is DeliverMsg =>
  m.type === 'deliver' && m.from === 'infra' && m.text.startsWith('Watchdog:')

describe('stall watchdog', () => {
  test('force-nudges a sensei stuck non-idle, then goes quiet once pending drains', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using _worker = await connectAgent(WS_URL, 'w1', 'worker')

    // Precondition: the worker's register event entered pending and the normal
    // idle-gated nudge fired, marking the sensei non-idle. No agent-idle is
    // ever posted — this is exactly the stuck-Stop-hook state that stalls a
    // dojo. It must be established BEFORE the watchdog window elapses, or the
    // test wouldn't prove the nudge fired despite idle:false.
    let stuck = false
    for (let i = 0; i < 10 && !stuck; i++) {
      const s = (await (await fetch(`${BASE}/status`)).json()) as { sensei: { idle: boolean } }
      stuck = !s.sensei.idle
      if (!stuck) await Bun.sleep(25)
    }
    expect(stuck).toBe(true)
    expect(sensei.messages.some((m) => m.type === 'deliver' && m.text === 'Events pending. Check the board.')).toBe(
      true,
    )
    expect(sensei.messages.filter(isWatchdogNudge).length).toBe(0)

    // With pending non-empty and idle stuck false, the watchdog must still fire.
    let watchdog: DeliverMsg | undefined
    for (let i = 0; i < 40 && !watchdog; i++) {
      watchdog = sensei.messages.find(isWatchdogNudge)
      if (!watchdog) await Bun.sleep(50)
    }
    expect(watchdog).toBeDefined()
    expect(watchdog?.text).toContain('idle')

    // Drain pending; the watchdog must go quiet (clock clears on empty).
    const ack = await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upToId: 999999 }),
    })
    const acked = (await ack.json()) as { remaining: number }
    expect(acked.remaining).toBe(0)

    // Absorb any watchdog tick already in flight, then measure silence.
    await Bun.sleep(STALL_MS)
    const countAfterDrain = sensei.messages.filter(isWatchdogNudge).length
    await Bun.sleep(STALL_MS * 3)
    expect(sensei.messages.filter(isWatchdogNudge).length).toBe(countAfterDrain)
  })
})
