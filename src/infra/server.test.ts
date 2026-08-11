import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
    env: { ...process.env, JEAN_PORT: String(TEST_PORT), JEAN_DATA_DIR: DATA_DIR },
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

  // Task 006: /status now reads bridge.health(). With no bridge configured the
  // handler must still answer — the health lookup is the one place a missing
  // bridge could throw and take the whole endpoint down.
  test('/status reports an unconfigured bridge without touching health', async () => {
    const res = await fetch(`${BASE}/status`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as { bridge: { configured: boolean; lastPollAt?: unknown } }
    expect(data.bridge.configured).toBe(false)
    // No fabricated health fields on a bridge that doesn't exist.
    expect(data.bridge.lastPollAt).toBeUndefined()
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

  test('/context/memorize records a memory event with id', async () => {
    const res = await fetch(`${BASE}/context/memorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'sensei',
        role: 'sensei',
        text: 'Gym membership cancelled, ~$45/mo saved',
        scope: 'dojo',
      }),
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { id: number }
    expect(typeof data.id).toBe('number')

    // Verify event landed in history with the right shape
    const histRes = await fetch(`${BASE}/history?stream=memory`)
    const hist = (await histRes.json()) as {
      events: Array<{ type: string; data: { agent: string; role: string; text: string; scope: string } }>
    }
    const ev = hist.events.find((e) => e.type === 'memory')
    expect(ev).toBeDefined()
    expect(ev?.data.agent).toBe('sensei')
    expect(ev?.data.role).toBe('sensei')
    expect(ev?.data.text).toBe('Gym membership cancelled, ~$45/mo saved')
    expect(ev?.data.scope).toBe('dojo')
  })

  test('/context/memorize trims whitespace and defaults scope to dojo', async () => {
    const res = await fetch(`${BASE}/context/memorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'worker-a',
        role: 'worker',
        text: '   leading and trailing whitespace   ',
        // scope omitted → defaults to 'dojo'
      }),
    })
    expect(res.status).toBe(200)
    const histRes = await fetch(`${BASE}/history?stream=memory`)
    const hist = (await histRes.json()) as {
      events: Array<{ type: string; data: { text: string; scope: string } }>
    }
    const ev = hist.events.findLast((e) => e.type === 'memory')
    expect(ev?.data.text).toBe('leading and trailing whitespace')
    expect(ev?.data.scope).toBe('dojo')
  })

  test('/context/memorize records taskId when provided', async () => {
    const res = await fetch(`${BASE}/context/memorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agent: 'worker-a',
        role: 'worker',
        text: 'finding from task',
        taskId: '042',
      }),
    })
    expect(res.status).toBe(200)
    const histRes = await fetch(`${BASE}/history?stream=memory`)
    const hist = (await histRes.json()) as {
      events: Array<{ type: string; data: { taskId?: string; text: string } }>
    }
    const ev = hist.events.findLast((e) => e.type === 'memory' && e.data.text === 'finding from task')
    expect(ev?.data.taskId).toBe('042')
  })

  test('/context/consolidated records a wiki-consolidated event with summary fields', async () => {
    const res = await fetch(`${BASE}/context/consolidated`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pagesUpdated: 3,
        pagesCreated: 1,
        corrections: 0,
        tasksDistilled: 2,
        eventsProcessed: 5,
        anomalies: ['raw_context/foo.pdf was referenced but unreadable'],
      }),
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { id: number }
    expect(typeof data.id).toBe('number')

    const histRes = await fetch(`${BASE}/history?stream=system`)
    const hist = (await histRes.json()) as {
      events: Array<{ type: string; data: { pagesUpdated?: number; anomalies?: string[] } }>
    }
    const ev = hist.events.findLast((e) => e.type === 'wiki-consolidated')
    expect(ev?.data.pagesUpdated).toBe(3)
    expect(ev?.data.anomalies).toEqual(['raw_context/foo.pdf was referenced but unreadable'])
  })

  test('/context/consolidated omits empty fields and empty anomalies array', async () => {
    const res = await fetch(`${BASE}/context/consolidated`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pagesUpdated: 2, anomalies: [] }),
    })
    expect(res.status).toBe(200)
    const histRes = await fetch(`${BASE}/history?stream=system`)
    const hist = (await histRes.json()) as { events: Array<{ type: string; data: Record<string, unknown> }> }
    const ev = hist.events.findLast((e) => e.type === 'wiki-consolidated' && e.data.pagesUpdated === 2)
    expect(ev?.data.pagesUpdated).toBe(2)
    // Empty anomalies array should be omitted (undefined)
    expect(ev?.data.anomalies).toBeUndefined()
  })

  test('/context/recent without cursor file returns all memorize events with cursor:null', async () => {
    const res = await fetch(`${BASE}/context/recent`)
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      cursor: null | { lastEventId: number }
      events: Array<{ id: number; agent: string; text: string }>
    }
    expect(data.cursor).toBeNull()
    expect(Array.isArray(data.events)).toBe(true)
    // At least the events created by the memorize tests above
    expect(data.events.length).toBeGreaterThan(0)
    expect(data.events[0]).toHaveProperty('id')
    expect(data.events[0]).toHaveProperty('agent')
    expect(data.events[0]).toHaveProperty('text')
  })

  test('/context/recent honors ?since= override and ?limit= cap', async () => {
    // First grab everything to know our id range
    const all = (await (await fetch(`${BASE}/context/recent`)).json()) as {
      events: Array<{ id: number }>
    }
    expect(all.events.length).toBeGreaterThan(1)
    const firstId = all.events[0]?.id ?? 0

    // since=<firstId> drops the first event
    const sinceRes = await fetch(`${BASE}/context/recent?since=${firstId}`)
    const since = (await sinceRes.json()) as { events: Array<{ id: number }> }
    expect(since.events.every((e) => e.id > firstId)).toBe(true)
    expect(since.events.length).toBe(all.events.length - 1)

    // limit=1 returns the most recent only
    const limitRes = await fetch(`${BASE}/context/recent?limit=1`)
    const limited = (await limitRes.json()) as { events: Array<{ id: number }> }
    expect(limited.events.length).toBe(1)
    expect(limited.events[0]?.id).toBe(all.events[all.events.length - 1]?.id)
  })

  test('/context/recent reads cursor from .consolidator/cursor.json', async () => {
    const all = (await (await fetch(`${BASE}/context/recent`)).json()) as {
      events: Array<{ id: number }>
    }
    const ids = all.events.map((e) => e.id)
    const midId = ids[Math.floor(ids.length / 2) - 1] ?? 0

    // Simulate a librarian run: cursor at midId means events with id > midId
    // are pending. Endpoint should return only those.
    const consolidatorDir = resolve(DATA_DIR, '.consolidator')
    mkdirSync(consolidatorDir, { recursive: true })
    writeFileSync(
      resolve(consolidatorDir, 'cursor.json'),
      JSON.stringify({ lastEventId: midId, lastConsolidatedAt: '2026-05-04T00:00:00Z' }),
    )

    const res = await fetch(`${BASE}/context/recent`)
    const data = (await res.json()) as {
      cursor: { lastEventId: number; lastConsolidatedAt?: string } | null
      events: Array<{ id: number }>
    }
    expect(data.cursor?.lastEventId).toBe(midId)
    expect(data.cursor?.lastConsolidatedAt).toBe('2026-05-04T00:00:00Z')
    expect(data.events.every((e) => e.id > midId)).toBe(true)

    // Cleanup so subsequent tests start without cursor
    rmSync(consolidatorDir, { recursive: true })
  })

  test('/context/memorize 400s on missing agent / role / empty text', async () => {
    const cases = [
      { role: 'sensei', text: 'no agent' },
      { agent: 'a', text: 'no role' },
      { agent: 'a', role: 'sensei' }, // no text
      { agent: 'a', role: 'sensei', text: '' }, // empty text
      { agent: 'a', role: 'sensei', text: '   ' }, // whitespace-only
    ]
    for (const body of cases) {
      const res = await fetch(`${BASE}/context/memorize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
    }
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

    // Send a message via HTTP. OLD (fix-round casualty, licensed by the
    // delivery-unification ruling 2026-08-11): {delivered: true} plus the raw
    // frame at the socket. The send QUEUES in the worker's mailbox now; what
    // reaches the socket is the notifier's push, and the content is fetched.
    const sendRes = await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'routed-agent', from: 'test', text: 'hello routed' }),
    })
    const sendData = (await sendRes.json()) as { queued?: boolean }
    expect(sendData.queued).toBe(true)

    // Wait for the push to arrive
    await new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        messages.push(JSON.parse(String(e.data)))
        resolve()
      }
      setTimeout(resolve, 1000)
    })

    const pushed = messages.find((m) => m.type === 'deliver' && m.from === 'infra')
    expect(pushed).toBeDefined()

    const box = (await (await fetch(`${BASE}/events?for=routed-agent`)).json()) as {
      events: Array<{ type: string; data: { text?: string; from?: string } }>
    }
    const queued = box.events.find((e) => e.type === 'send' && e.data.text === 'hello routed')
    expect(queued).toBeDefined()
    expect(queued?.data.from).toBe('test')

    ws.close()
  })
})
