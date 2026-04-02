import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import type { Subprocess } from 'bun'
import { unlinkSync } from 'fs'

const TEST_PORT = 8798
const BOARD_PATH = '/tmp/jean-test-board-api.json'
const HISTORY_PATH = '/tmp/jean-test-history-api.jsonl'
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

describe('board CRUD', () => {
  test('POST /tasks creates a task with inbox status', async () => {
    const res = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Fix bug', description: 'It crashes', queue: 'scratch' }),
    })
    expect(res.status).toBe(201)
    const task = (await res.json()) as { id: string; status: string; title: string; queue: string; createdAt: string }
    expect(task.id).toBeDefined()
    expect(task.status).toBe('inbox')
    expect(task.title).toBe('Fix bug')
    expect(task.queue).toBe('scratch')
    expect(task.createdAt).toBeDefined()
  })

  test('POST /tasks rejects missing title', async () => {
    const res = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'no title', queue: 'scratch' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /tasks rejects missing queue', async () => {
    const res = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No queue', description: 'missing queue' }),
    })
    expect(res.status).toBe(400)
  })

  test('GET /tasks returns all tasks', async () => {
    const res = await fetch(`${BASE}/tasks`)
    const data = (await res.json()) as { tasks: Array<{ id: string }> }
    expect(data.tasks.length).toBeGreaterThanOrEqual(1)
  })

  test('GET /tasks?status=inbox filters by status', async () => {
    const res = await fetch(`${BASE}/tasks?status=inbox`)
    const data = (await res.json()) as { tasks: Array<{ status: string }> }
    for (const t of data.tasks) {
      expect(t.status).toBe('inbox')
    }
  })

  test('GET /tasks?queue=scratch filters by queue', async () => {
    const res = await fetch(`${BASE}/tasks?queue=scratch`)
    const data = (await res.json()) as { tasks: Array<{ queue: string }> }
    for (const t of data.tasks) {
      expect(t.queue).toBe('scratch')
    }
  })

  test('GET /tasks/:id returns single task', async () => {
    // Create a task first
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Specific task', description: 'find me', queue: 'review' }),
    })
    const created = (await createRes.json()) as { id: string }

    const res = await fetch(`${BASE}/tasks/${created.id}`)
    const task = (await res.json()) as { id: string; title: string }
    expect(task.id).toBe(created.id)
    expect(task.title).toBe('Specific task')
  })

  test('GET /tasks/:id returns 404 for unknown', async () => {
    const res = await fetch(`${BASE}/tasks/999`)
    expect(res.status).toBe(404)
  })

  test('PATCH /tasks/:id/status valid transition succeeds', async () => {
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Transition test', description: '', queue: 'scratch' }),
    })
    const created = (await createRes.json()) as { id: string }

    const res = await fetch(`${BASE}/tasks/${created.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as { status: string; updatedAt: string }
    expect(updated.status).toBe('active')
  })

  test('PATCH /tasks/:id/status invalid transition returns 400', async () => {
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Bad transition', description: '', queue: 'scratch' }),
    })
    const created = (await createRes.json()) as { id: string }

    const res = await fetch(`${BASE}/tasks/${created.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    expect(res.status).toBe(400)
  })

  test('PATCH /tasks/:id updates fields', async () => {
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Assign test', description: '', queue: 'scratch' }),
    })
    const created = (await createRes.json()) as { id: string }

    const res = await fetch(`${BASE}/tasks/${created.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'scratch' }),
    })
    const updated = (await res.json()) as { agent: string }
    expect(updated.agent).toBe('scratch')
  })

  test('PATCH /tasks/:id/status updates updatedAt', async () => {
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Timestamp test', description: '', queue: 'scratch' }),
    })
    const created = (await createRes.json()) as { id: string; updatedAt: string }

    await Bun.sleep(10) // ensure timestamp differs

    const res = await fetch(`${BASE}/tasks/${created.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    })
    const updated = (await res.json()) as { updatedAt: string }
    expect(updated.updatedAt).not.toBe(created.updatedAt)
  })
})
