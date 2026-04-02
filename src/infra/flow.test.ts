import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import type { Subprocess } from 'bun'
import { unlinkSync } from 'fs'

const TEST_PORT = 8796
const BOARD_PATH = '/tmp/jean-test-board-flow.json'
const HISTORY_PATH = '/tmp/jean-test-history-flow.jsonl'
let server: Subprocess

beforeAll(async () => {
  try { unlinkSync(BOARD_PATH) } catch {}
  try { unlinkSync(HISTORY_PATH) } catch {}
  server = Bun.spawn(['bun', 'run', 'src/infra/server.ts'], {
    env: { ...process.env, JEAN_PORT: String(TEST_PORT), JEAN_BOARD: BOARD_PATH, JEAN_HISTORY: HISTORY_PATH },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  for (let i = 0; i < 20; i++) {
    try { await fetch(`http://127.0.0.1:${TEST_PORT}/`); break }
    catch { await Bun.sleep(100) }
  }
})

afterAll(() => { server.kill() })

const BASE = `http://127.0.0.1:${TEST_PORT}`
const WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`

function connectAgent(name: string, role: string): Promise<{ ws: WebSocket; messages: any[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const messages: any[] = []
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'register', agent: name, role }))
    }
    ws.onmessage = (e) => {
      messages.push(JSON.parse(String(e.data)))
      if (messages.at(-1).type === 'registered') resolve({ ws, messages })
    }
    ws.onerror = reject
    setTimeout(() => reject(new Error('timeout')), 3000)
  })
}

function waitForMessage(messages: any[], predicate: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
  const found = messages.find(predicate)
  if (found) return Promise.resolve(found)
  return new Promise((resolve, reject) => {
    const start = messages.length
    const interval = setInterval(() => {
      for (let i = start; i < messages.length; i++) {
        if (predicate(messages[i])) {
          clearInterval(interval)
          resolve(messages[i])
          return
        }
      }
    }, 50)
    setTimeout(() => { clearInterval(interval); reject(new Error('timeout waiting for message')) }, timeoutMs)
  })
}

describe('full lifecycle', () => {
  test('task creation → assignment → work → completion', async () => {
    // 1. Connect sensei and worker
    const { ws: senseiWs, messages: senseiMsgs } = await connectAgent('flow-sensei', 'sensei')
    const { ws: workerWs, messages: workerMsgs } = await connectAgent('flow-worker', 'worker')

    // 2. Create a task
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Flow test task', description: 'End-to-end lifecycle', queue: 'flow-worker' }),
    })
    expect(createRes.status).toBe(201)
    const task = (await createRes.json()) as { id: string; status: string }
    expect(task.status).toBe('inbox')

    // 3. Verify task-created event is queued
    await Bun.sleep(100)
    const pendingRes = await fetch(`${BASE}/events/pending?agent=flow-worker`)
    const pending = (await pendingRes.json()) as { events: Array<{ type: string }> }
    expect(pending.events.some(e => e.type === 'task-created')).toBe(true)

    // 4. Signal sensei idle → nudge arrives
    await fetch(`${BASE}/agent-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'flow-sensei' }),
    })
    const nudge = await waitForMessage(senseiMsgs, m => m.type === 'deliver' && m.from === 'infra')
    expect(nudge.text).toContain('Events pending')

    // 5. Assign task to worker and mark active
    await fetch(`${BASE}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'flow-worker' }),
    })
    const activateRes = await fetch(`${BASE}/tasks/${task.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
    const activeTask = (await activateRes.json()) as { status: string; agent: string }
    expect(activeTask.status).toBe('active')
    expect(activeTask.agent).toBe('flow-worker')

    // 6. Send task to worker via /send → worker receives it
    await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'flow-worker', from: 'flow-sensei', text: 'Work on this task', taskId: task.id }),
    })
    const delivery = await waitForMessage(workerMsgs, m => m.type === 'deliver' && m.text === 'Work on this task')
    expect(delivery.from).toBe('flow-sensei')
    expect(delivery.taskId).toBe(task.id)

    // 7. Worker sends reply
    workerWs.send(JSON.stringify({ type: 'reply', from: 'flow-worker', text: 'Task complete. All good.' }))
    await Bun.sleep(100)

    // 8. Verify reply is queued
    const replyPending = await fetch(`${BASE}/events/pending?agent=flow-worker`)
    const replyEvents = (await replyPending.json()) as { events: Array<{ type: string; data: { text: string } }> }
    expect(replyEvents.events.some(e => e.type === 'reply' && e.data.text === 'Task complete. All good.')).toBe(true)

    // 9. Worker goes idle
    await fetch(`${BASE}/agent-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'flow-worker' }),
    })
    await Bun.sleep(100)
    const idlePending = await fetch(`${BASE}/events/pending?agent=flow-worker`)
    const idleEvents = (await idlePending.json()) as { events: Array<{ type: string }> }
    expect(idleEvents.events.some(e => e.type === 'agent-idle')).toBe(true)

    // 10. Signal sensei idle → gets nudged again
    // Reset sensei messages to track new nudge
    const senseiMsgsBefore = senseiMsgs.length
    await fetch(`${BASE}/agent-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'flow-sensei' }),
    })
    await Bun.sleep(200)
    const newNudge = senseiMsgs.slice(senseiMsgsBefore).find(m => m.type === 'deliver' && m.from === 'infra')
    expect(newNudge).toBeDefined()

    // 11. Mark task done
    const doneRes = await fetch(`${BASE}/tasks/${task.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'review' }),
    })
    expect((await doneRes.json() as { status: string }).status).toBe('review')
    const finalRes = await fetch(`${BASE}/tasks/${task.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    expect((await finalRes.json() as { status: string }).status).toBe('done')

    // 12. Ack all events, verify queue empty
    const allPending = await fetch(`${BASE}/events/pending`)
    const allEvents = (await allPending.json()) as { events: Array<{ id: number }> }
    const maxId = Math.max(...allEvents.events.map(e => e.id))
    await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upToId: maxId }),
    })

    const finalPending = await fetch(`${BASE}/events/pending`)
    const finalEvents = (await finalPending.json()) as { events: Array<any> }
    expect(finalEvents.events.length).toBe(0)

    // Verify board reflects the full lifecycle
    const boardRes = await fetch(`${BASE}/board`)
    const board = (await boardRes.json()) as { tasks: Array<{ id: string; status: string }> }
    const finalTask = board.tasks.find(t => t.id === task.id)
    expect(finalTask?.status).toBe('done')

    senseiWs.close()
    workerWs.close()
  })
})

describe('history', () => {
  test('task-scoped history via GET /history?taskId', async () => {
    // The full lifecycle test already ran — check history for that task
    const boardRes = await fetch(`${BASE}/board`)
    const board = (await boardRes.json()) as { tasks: Array<{ id: string; status: string }> }
    const doneTask = board.tasks.find(t => t.status === 'done')
    expect(doneTask).toBeDefined()

    const res = await fetch(`${BASE}/history?taskId=${doneTask!.id}`)
    const data = (await res.json()) as { events: Array<{ type: string; taskId: string }> }

    // Should have task-created, task-status changes, send, reply, agent-idle, ack
    expect(data.events.length).toBeGreaterThanOrEqual(3)
    expect(data.events.every(e => e.taskId === doneTask!.id)).toBe(true)
    expect(data.events.some(e => e.type === 'task-created')).toBe(true)
    expect(data.events.some(e => e.type === 'task-status')).toBe(true)
  })

  test('worker reply gets taskId inferred from board', async () => {
    // Create a task, assign agent, make active, then send a reply
    const { ws } = await connectAgent('infer-worker', 'worker')

    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Inference test', description: '', queue: 'infer-worker' }),
    })
    const task = (await createRes.json()) as { id: string }

    // Assign and activate
    await fetch(`${BASE}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'infer-worker' }),
    })
    await fetch(`${BASE}/tasks/${task.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })

    // Worker replies — taskId should be inferred
    ws.send(JSON.stringify({ type: 'reply', from: 'infer-worker', text: 'inferred reply' }))
    await Bun.sleep(200)

    // Check pending events — the reply should have the taskId
    const res = await fetch(`${BASE}/events?agent=infer-worker`)
    const data = (await res.json()) as { events: Array<{ type: string; taskId?: string; text: string }> }
    const reply = data.events.find(e => e.type === 'reply' && (e.data as any)?.text === 'inferred reply')
    expect(reply).toBeDefined()
    expect(reply!.taskId).toBe(task.id)

    ws.close()
  })

  test('ack events appear in history', async () => {
    const { ws } = await connectAgent('ack-hist-worker', 'worker')
    ws.send(JSON.stringify({ type: 'reply', from: 'ack-hist-worker', text: 'ack me' }))
    await Bun.sleep(100)

    // Get the event and ack it
    const pending = await fetch(`${BASE}/events?agent=ack-hist-worker`)
    const events = (await pending.json()) as { events: Array<{ id: number }> }
    const eventId = events.events[0]!.id
    await fetch(`${BASE}/events/${eventId}/ack`, { method: 'POST' })
    await Bun.sleep(100)

    // Check history for ack event
    const res = await fetch(`${BASE}/history`)
    const data = (await res.json()) as { events: Array<{ type: string; text?: string }> }
    const ackEvent = data.events.find(e => e.type === 'ack' && (e.data as any)?.eventIds?.includes(eventId))
    expect(ackEvent).toBeDefined()

    ws.close()
  })

  test('GET /history?last=N returns only last N events', async () => {
    const allRes = await fetch(`${BASE}/history`)
    const allData = (await allRes.json()) as { events: Array<{ id: number }> }
    const total = allData.events.length

    const lastRes = await fetch(`${BASE}/history?last=3`)
    const lastData = (await lastRes.json()) as { events: Array<{ id: number }> }
    expect(lastData.events.length).toBe(3)
    // Should be the last 3 from the full list
    expect(lastData.events[0]!.id).toBe(allData.events[total - 3]!.id)
  })

  test('event IDs are sequential', async () => {
    const res = await fetch(`${BASE}/history`)
    const data = (await res.json()) as { events: Array<{ id: number }> }
    for (let i = 1; i < data.events.length; i++) {
      expect(data.events[i]!.id).toBeGreaterThan(data.events[i - 1]!.id)
    }
  })
})

describe('board persistence', () => {
  test('tasks are persisted in event history', async () => {
    // Create a task
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Persist me', description: 'survive restart', queue: 'test' }),
    })
    const task = (await createRes.json()) as { id: string }

    // Verify it's in the event history (source of truth)
    const histRes = await fetch(`${BASE}/history?taskId=${task.id}`)
    const hist = (await histRes.json()) as { events: Array<{ type: string; data: { title?: string } }> }
    expect(hist.events.some(e => e.type === 'task-created' && e.data.title === 'Persist me')).toBe(true)

    // Verify it's on the board (derived projection)
    const boardRes = await fetch(`${BASE}/board`)
    const board = (await boardRes.json()) as { tasks: Array<{ id: string; title: string }> }
    expect(board.tasks.some(t => t.id === task.id && t.title === 'Persist me')).toBe(true)
  })
})
