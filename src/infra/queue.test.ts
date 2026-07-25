import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'
import { connectAgent } from './test-helpers.ts'

const TEST_PORT = 8795
const DATA_DIR = '/tmp/jean-test-queue'
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

describe('event queue', () => {
  test('worker reply creates a queued event', async () => {
    using agent = await connectAgent(WS_URL, 'reply-worker')

    agent.ws.send(JSON.stringify({ type: 'reply', from: 'reply-worker', text: 'done with task' }))
    await Bun.sleep(100)

    const res = await fetch(`${BASE}/events/pending?agent=reply-worker`)
    const data = (await res.json()) as { events: Array<{ type: string; agent: string; data: { text: string } }> }
    expect(data.events.length).toBeGreaterThanOrEqual(1)
    const event = data.events.find((e) => e.type === 'reply')
    expect(event).toBeDefined()
    expect(event?.data.text).toBe('done with task')
  })

  test('agent idle does NOT create a queued event (diagnostic-only) but IS recorded in history', async () => {
    using _agent = await connectAgent(WS_URL, 'idle-worker')

    await fetch(`${BASE}/agent-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'idle-worker' }),
    })

    // Not in pending — idle no longer wakes the sensei
    const pendingRes = await fetch(`${BASE}/events/pending?agent=idle-worker`)
    const pending = (await pendingRes.json()) as { events: Array<{ type: string }> }
    expect(pending.events.some((e) => e.type === 'agent-idle')).toBe(false)

    // But still recorded in history for diagnostic/observability purposes
    const histRes = await fetch(`${BASE}/history`)
    const hist = (await histRes.json()) as {
      events: Array<{ type: string; data: Record<string, unknown> }>
    }
    expect(hist.events.some((e) => e.type === 'agent-idle' && e.data?.agent === 'idle-worker')).toBe(true)
  })

  test('task creation creates a queued event', async () => {
    await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Queue test task', description: '', queue: 'queue-test' }),
    })

    const res = await fetch(`${BASE}/events/pending?agent=queue-test`)
    const data = (await res.json()) as { events: Array<{ type: string; agent: string }> }
    expect(data.events.some((e) => e.type === 'task-created')).toBe(true)
  })

  test('GET /events/agents returns per-agent counts', async () => {
    const res = await fetch(`${BASE}/events/agents`)
    const data = (await res.json()) as { agents: Record<string, number> }
    expect(typeof data.agents).toBe('object')
    // Should have at least the agents from previous tests
    expect(Object.keys(data.agents).length).toBeGreaterThan(0)
  })

  test('POST /events/:id/ack removes single event', async () => {
    using agent = await connectAgent(WS_URL, 'ack-worker')
    agent.ws.send(JSON.stringify({ type: 'reply', from: 'ack-worker', text: 'ack me' }))
    await Bun.sleep(100)

    // Get the event
    const res = await fetch(`${BASE}/events/pending?agent=ack-worker`)
    const data = (await res.json()) as { events: Array<{ id: number }> }
    const event = data.events[0]
    if (!event) throw new Error('expected pending event for ack-worker')

    // Ack it
    const ackRes = await fetch(`${BASE}/events/${event.id}/ack`, { method: 'POST' })
    const ackData = (await ackRes.json()) as { ok: boolean }
    expect(ackData.ok).toBe(true)

    // Verify it's gone
    const after = await fetch(`${BASE}/events/pending?agent=ack-worker`)
    const afterData = (await after.json()) as { events: Array<{ id: number }> }
    expect(afterData.events.find((e) => e.id === event.id)).toBeUndefined()
  })

  test('POST /events/ack batch acks up to ID', async () => {
    using agent = await connectAgent(WS_URL, 'batch-worker')
    agent.ws.send(JSON.stringify({ type: 'reply', from: 'batch-worker', text: 'msg 1' }))
    await Bun.sleep(50)
    agent.ws.send(JSON.stringify({ type: 'reply', from: 'batch-worker', text: 'msg 2' }))
    await Bun.sleep(50)
    agent.ws.send(JSON.stringify({ type: 'reply', from: 'batch-worker', text: 'msg 3' }))
    await Bun.sleep(100)

    // Get events — filter to replies (register event also lands in pending now)
    const res = await fetch(`${BASE}/events/pending?agent=batch-worker`)
    const data = (await res.json()) as { events: Array<{ id: number; type: string }> }
    const replies = data.events.filter((e) => e.type === 'reply')
    expect(replies.length).toBe(3)

    // Ack up to the second reply
    const secondId = replies[1]?.id
    const ackRes = await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'batch-worker', upToId: secondId }),
    })
    const ackData = (await ackRes.json()) as { acknowledged: number; remaining: number }
    // register event is earlier than reply[0] so acking up to secondId also clears register.
    expect(ackData.acknowledged).toBe(3)
    expect(typeof ackData.remaining).toBe('number')

    // Third reply should still be there
    const after = await fetch(`${BASE}/events/pending?agent=batch-worker`)
    const afterData = (await after.json()) as { events: Array<{ id: number }> }
    expect(afterData.events.length).toBe(1)
  })

  test('POST /events/ack with no agent filter drains other-agent register events (nudge-loop bug)', async () => {
    // Other agents' register events end up in pending (sensei's inbox) but
    // none resolve to sensei — ack with `{upToId}` and no agent filter must
    // still drain them.
    await clearPendingEvents()
    using _a = await connectAgent(WS_URL, 'drain-a')
    using _b = await connectAgent(WS_URL, 'drain-b')
    await Bun.sleep(100)

    const pending = (await (await fetch(`${BASE}/events`)).json()) as {
      events: Array<{ id: number; type: string; agent?: string }>
    }
    const registers = pending.events.filter(
      (e) => e.type === 'register' && (e.agent === 'drain-a' || e.agent === 'drain-b'),
    )
    expect(registers.length).toBe(2)
    const maxId = pending.events.at(-1)?.id ?? 0

    const ackRes = await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upToId: maxId }),
    })
    const ackData = (await ackRes.json()) as { acknowledged: number; remaining: number }
    expect(ackData.acknowledged).toBeGreaterThanOrEqual(2)
    expect(ackData.remaining).toBe(0)
  })

  test('events ordered FIFO', async () => {
    using agent = await connectAgent(WS_URL, 'fifo-worker')
    agent.ws.send(JSON.stringify({ type: 'reply', from: 'fifo-worker', text: 'first' }))
    await Bun.sleep(50)
    agent.ws.send(JSON.stringify({ type: 'reply', from: 'fifo-worker', text: 'second' }))
    await Bun.sleep(50)
    agent.ws.send(JSON.stringify({ type: 'reply', from: 'fifo-worker', text: 'third' }))
    await Bun.sleep(100)

    const res = await fetch(`${BASE}/events/pending?agent=fifo-worker`)
    const data = (await res.json()) as { events: Array<{ type: string; data: { text?: string } }> }
    const replies = data.events.filter((e) => e.type === 'reply')
    expect(replies[0]?.data.text).toBe('first')
    expect(replies[1]?.data.text).toBe('second')
    expect(replies[2]?.data.text).toBe('third')
  })
})

async function clearPendingEvents() {
  const res = await fetch(`${BASE}/events`)
  const data = (await res.json()) as { events: Array<{ id: number }> }
  if (data.events.length > 0) {
    const maxId = Math.max(...data.events.map((e) => e.id))
    await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upToId: maxId }),
    })
  }
}

/**
 * Drain, then CONFIRM the queue stayed empty — a plain drain doesn't establish
 * an empty queue.
 *
 * A previous test's `using` disposal closes its sockets, and the server records
 * the resulting `disconnect` events asynchronously: they can land in pending
 * AFTER a drain that ran before they arrived. The next test then nudges for
 * somebody else's leftover and reads it as its own unexpected deliver — a race
 * whose outcome is decided purely by suite pacing (it passed on one machine and
 * failed 3/3 on another, costing a merge cycle: task 001, 2026-07-25).
 *
 * Retrying until a settle window passes with nothing new makes the precondition
 * real. If it never settles we throw, so the failure names the actual problem
 * instead of surfacing as a mysterious extra nudge three assertions later.
 */
async function drainUntilQuiet(settleMs = 250, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    await clearPendingEvents()
    await Bun.sleep(settleMs)
    const res = await fetch(`${BASE}/events`)
    const { events } = (await res.json()) as { events: Array<{ id: number; type: string }> }
    if (events.length === 0) return
    if (Date.now() > deadline) {
      throw new Error(`pending never settled: ${events.map((e) => `${e.id}:${e.type}`).join(', ')}`)
    }
  }
}

describe('sensei nudge', () => {
  test('sensei receives nudge when idle + events pending', async () => {
    using sensei = await connectAgent(WS_URL, 'nudge-sensei', 'sensei')
    using worker = await connectAgent(WS_URL, 'nudge-worker')

    // Mark sensei idle
    await fetch(`${BASE}/agent-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'nudge-sensei' }),
    })

    // Worker sends reply — should trigger nudge to sensei
    worker.ws.send(JSON.stringify({ type: 'reply', from: 'nudge-worker', text: 'finished' }))
    await Bun.sleep(200)

    // Look for nudge after connect-time messages
    const postConnect = sensei.messages.slice(sensei.baselineCount)
    const nudge = postConnect.find(
      (m) => m.type === 'deliver' && m.from === 'infra' && m.text?.includes('Events pending'),
    )
    expect(nudge).toBeDefined()
  })

  test('worker event is queued even when sensei is busy', async () => {
    using _sensei = await connectAgent(WS_URL, 'busy-sensei', 'sensei')
    using worker = await connectAgent(WS_URL, 'busy-worker')

    // Worker sends reply
    worker.ws.send(JSON.stringify({ type: 'reply', from: 'busy-worker', text: 'done' }))
    await Bun.sleep(200)

    // Event should be queued regardless
    const res = await fetch(`${BASE}/events?agent=busy-worker`)
    const data = (await res.json()) as { events: Array<{ data: { text: string } }> }
    expect(data.events.some((e) => e.data?.text === 'done')).toBe(true)
  })

  test('sensei going idle does not create actionable event', async () => {
    // The claim is "the sensei's OWN idle post enqueues nothing and wakes
    // nobody", so an empty queue is the precondition, not an assumption: any
    // leftover event would legitimately nudge on the idle post below and be
    // indistinguishable from the bug this test exists to catch.
    await drainUntilQuiet()

    using sensei = await connectAgent(WS_URL, 'self-loop-sensei', 'sensei')

    // Mark sensei idle — should NOT create a pending event
    await fetch(`${BASE}/agent-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'self-loop-sensei' }),
    })
    await Bun.sleep(200)

    // No pending events for sensei
    const res = await fetch(`${BASE}/events?agent=self-loop-sensei`)
    const data = (await res.json()) as { events: Array<{ type: string }> }
    expect(data.events.length).toBe(0)

    // No new nudges after connect (only the connect nudge in baseline)
    const postConnect = sensei.messages.slice(sensei.baselineCount)
    const nudges = postConnect.filter((m) => m.type === 'deliver' && m.from === 'infra')
    expect(nudges.map((m) => (m as { text: string }).text)).toEqual([])

    // But the event IS in history (informational)
    const histRes = await fetch(`${BASE}/history`)
    const hist = (await histRes.json()) as { events: Array<{ type: string; agent: string }> }
    expect(hist.events.some((e) => e.type === 'agent-idle' && e.agent === 'self-loop-sensei')).toBe(true)
  })

  test('worker going idle records diagnostically but is NOT actionable (no pending)', async () => {
    using _worker = await connectAgent(WS_URL, 'idle-actionable-worker')

    await fetch(`${BASE}/agent-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'idle-actionable-worker' }),
    })

    // /events (pending) should not include the idle
    const pendingRes = await fetch(`${BASE}/events?agent=idle-actionable-worker`)
    const pending = (await pendingRes.json()) as { events: Array<{ type: string }> }
    expect(pending.events.some((e) => e.type === 'agent-idle')).toBe(false)

    // But /history does
    const histRes = await fetch(`${BASE}/history`)
    const hist = (await histRes.json()) as { events: Array<{ type: string; agent: string }> }
    expect(hist.events.some((e) => e.type === 'agent-idle' && e.agent === 'idle-actionable-worker')).toBe(true)
  })
})

describe('role-based routing', () => {
  test('register with role is acknowledged', async () => {
    using agent = await connectAgent(WS_URL, 'role-test', 'worker')
    const reg = agent.messages.find((m) => m.type === 'registered')
    expect(reg).toBeDefined()
    expect(reg?.role).toBe('worker')
  })

  test('reply from worker is queued, not directly delivered', async () => {
    using sensei = await connectAgent(WS_URL, 'routing-sensei', 'sensei')
    using worker = await connectAgent(WS_URL, 'routing-worker')

    // Sensei is NOT idle, so no nudge expected
    worker.ws.send(JSON.stringify({ type: 'reply', from: 'routing-worker', text: 'routed reply' }))
    await Bun.sleep(200)

    // Reply should be in the queue
    const res = await fetch(`${BASE}/events/pending?agent=routing-worker`)
    const data = (await res.json()) as { events: Array<{ type: string; data?: { text?: string } }> }
    expect(data.events.some((e) => e.data?.text === 'routed reply')).toBe(true)

    // Sensei should NOT have received it directly (it's not idle)
    const directDelivery = sensei.messages.find((m) => m.type === 'deliver' && m.text === 'routed reply')
    expect(directDelivery).toBeUndefined()
  })
})
