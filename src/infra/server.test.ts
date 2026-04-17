import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'

const TEST_PORT = 8799
const DATA_DIR = '/tmp/jean-test-server'
let server: Subprocess

beforeAll(async () => {
  try {
    rmSync(DATA_DIR, { recursive: true })
  } catch {}
  mkdirSync(DATA_DIR, { recursive: true })
  server = Bun.spawn(['bun', 'run', 'src/infra/server.ts'], {
    env: { ...process.env, JEAN_PORT: String(TEST_PORT), JEAN_DATA_DIR: DATA_DIR, JEAN_AUTO_NUDGE: 'true' },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  // Wait for server to be ready
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

describe('infrastructure server', () => {
  test('health check returns name', async () => {
    const res = await fetch(`${BASE}/`)
    const data = (await res.json()) as { name: string }
    expect(data.name).toBe('jean-infra')
  })

  test('/agents returns empty list initially', async () => {
    const res = await fetch(`${BASE}/agents`)
    const data = (await res.json()) as { agents: string[] }
    expect(data.agents).toEqual([])
  })

  test('/board returns empty board', async () => {
    const res = await fetch(`${BASE}/board`)
    const data = (await res.json()) as { tasks: unknown[] }
    expect(data.tasks).toEqual([])
  })

  test('/send returns not delivered when no agent connected', async () => {
    const res = await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'scratch', from: 'test', text: 'hello' }),
    })
    const data = (await res.json()) as { delivered: boolean }
    expect(data.delivered).toBe(false)
  })

  test('/agent-idle GET for disconnected agent returns error', async () => {
    const res = await fetch(`${BASE}/agent-idle?name=scratch`)
    const data = (await res.json()) as { ok: boolean; error: string }
    expect(data.ok).toBe(false)
    expect(data.error).toBe('agent not connected')
  })

  test('/events returns pending events (empty initially)', async () => {
    const res = await fetch(`${BASE}/events`)
    const data = (await res.json()) as { events: unknown[] }
    expect(Array.isArray(data.events)).toBe(true)
  })

  test('/history returns persistent event log', async () => {
    const res = await fetch(`${BASE}/history`)
    const data = (await res.json()) as { events: Array<{ type: string }> }
    expect(Array.isArray(data.events)).toBe(true)
    expect(data.events.length).toBeGreaterThan(0)
    expect(data.events.some((e) => e.type === 'start')).toBe(true)
  })

  test('WebSocket registration works', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`)

    const registered = await new Promise<{ type: string; agent: string }>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'register', agent: 'test-agent', role: 'worker' }))
      }
      ws.onmessage = (e) => {
        resolve(JSON.parse(String(e.data)))
      }
      ws.onerror = reject
      setTimeout(() => reject(new Error('timeout')), 3000)
    })

    expect(registered.type).toBe('registered')
    expect(registered.agent).toBe('test-agent')

    // Verify the agent appears in /agents
    const res = await fetch(`${BASE}/agents`)
    const data = (await res.json()) as { agents: Array<{ name: string; role: string }> }
    expect(data.agents.some((a) => a.name === 'test-agent')).toBe(true)

    ws.close()
  })

  test('message routing: send to connected agent', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`)

    // Register and wait for messages
    const messages: Array<{ type: string; from: string; text: string }> = []

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'register', agent: 'routed-agent', role: 'worker' }))
      }
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data))
        messages.push(msg)
        if (msg.type === 'registered') resolve()
      }
      ws.onerror = reject
      setTimeout(() => reject(new Error('timeout')), 3000)
    })

    // Send a message via HTTP
    const sendRes = await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'routed-agent', from: 'test', text: 'hello routed' }),
    })
    const sendData = (await sendRes.json()) as { delivered: boolean }
    expect(sendData.delivered).toBe(true)

    // Wait for the message to arrive
    await new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        messages.push(JSON.parse(String(e.data)))
        resolve()
      }
      setTimeout(resolve, 1000)
    })

    const delivered = messages.find((m) => m.type === 'deliver')
    expect(delivered).toBeDefined()
    expect(delivered?.text).toBe('hello routed')
    expect(delivered?.from).toBe('test')

    ws.close()
  })
})
