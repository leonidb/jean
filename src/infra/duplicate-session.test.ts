import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'
import type { OutboundMsg } from './protocol.ts'

/**
 * When two processes register as the same agent name with different sessionIds
 * and the first's WS is still live, the server must:
 *   - keep the incumbent
 *   - send an ErrorMsg with code='duplicate-session' to the newcomer
 *   - close the newcomer's WS
 *   - NOT mutate the agents map
 *
 * Without this guard, each eviction triggers a 2s-delay reconnect on the
 * kicked side, which evicts the other — an infinite ping-pong that also
 * wakes sensei via register→nudge every ~2s.
 */

const TEST_PORT = 8794
const DATA_DIR = '/tmp/jean-test-duplicate-session'
let server: Subprocess

beforeAll(async () => {
  try {
    rmSync(DATA_DIR, { recursive: true })
  } catch {}
  mkdirSync(DATA_DIR, { recursive: true })
  server = Bun.spawn(['bun', 'run', 'src/infra/server.ts'], {
    env: { ...process.env, JEAN_PORT: String(TEST_PORT), JEAN_DATA_DIR: DATA_DIR },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${TEST_PORT}/`)
      if (r.ok) break
    } catch {}
    await Bun.sleep(100)
  }
})

afterAll(() => {
  server.kill()
})

const WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`
const BASE = `http://127.0.0.1:${TEST_PORT}`

function connect(agent: string, sessionId: string): Promise<{ ws: WebSocket; messages: OutboundMsg[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const messages: OutboundMsg[] = []
    ws.onopen = () => ws.send(JSON.stringify({ type: 'register', agent, role: 'worker', sessionId }))
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as OutboundMsg
      messages.push(msg)
      if (msg.type === 'registered' || msg.type === 'error') resolve({ ws, messages })
    }
    ws.onerror = () => reject(new Error('ws error'))
    setTimeout(() => reject(new Error('timeout')), 3000)
  })
}

describe('duplicate-session guard', () => {
  test('second registration with a different sessionId is rejected; incumbent survives', async () => {
    const first = await connect('dup-worker', 'session-1')
    expect(first.messages.find((m) => m.type === 'registered')).toBeDefined()

    const second = await connect('dup-worker', 'session-2')
    const err = second.messages.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    expect(err?.type).toBe('error')
    if (err?.type === 'error') {
      expect(err.code).toBe('duplicate-session')
      expect(err.agent).toBe('dup-worker')
    }

    // Server should close the newcomer's WS shortly after sending the error.
    await Bun.sleep(100)
    expect(second.ws.readyState).toBeGreaterThanOrEqual(2) // CLOSING or CLOSED

    // Incumbent still in /agents — check by probing the registry.
    const res = await fetch(`${BASE}/agents`)
    const data = (await res.json()) as { agents: Array<{ name: string }> }
    expect(data.agents.find((a) => a.name === 'dup-worker')).toBeDefined()

    first.ws.close()
  })

  test('same-session reconnect after close is NOT rejected (legitimate reconnect)', async () => {
    const first = await connect('reconn-worker', 'stable-session')
    expect(first.messages.find((m) => m.type === 'registered')).toBeDefined()
    first.ws.close()
    await Bun.sleep(100) // let the close handler fire on the server

    const second = await connect('reconn-worker', 'stable-session')
    expect(second.messages.find((m) => m.type === 'registered')).toBeDefined()
    expect(second.messages.find((m) => m.type === 'error')).toBeUndefined()
    second.ws.close()
  })

  test('different session after incumbent disconnects IS accepted (crash recovery)', async () => {
    const first = await connect('crash-worker', 'session-A')
    expect(first.messages.find((m) => m.type === 'registered')).toBeDefined()
    first.ws.close()
    await Bun.sleep(100)

    const second = await connect('crash-worker', 'session-B')
    expect(second.messages.find((m) => m.type === 'registered')).toBeDefined()
    expect(second.messages.find((m) => m.type === 'error')).toBeUndefined()
    second.ws.close()
  })
})
