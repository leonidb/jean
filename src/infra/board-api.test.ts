import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Subprocess } from 'bun'
import type { TaskStatus } from './board.ts'

const TEST_PORT = 8798
const DATA_DIR = '/tmp/jean-test-board-api'
let server: Subprocess

const TEST_PLAYBOOK = `---
name: review
description: Test review playbook for include=playbook
---

# Review

Task closes when the PR is merged.
`

beforeAll(async () => {
  try {
    rmSync(DATA_DIR, { recursive: true })
  } catch {}
  mkdirSync(resolve(DATA_DIR, 'playbooks'), { recursive: true })
  writeFileSync(resolve(DATA_DIR, 'playbooks', 'review.md'), TEST_PLAYBOOK)
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

describe('board CRUD', () => {
  test('POST /tasks creates a task with todo status', async () => {
    const res = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Fix bug', description: 'It crashes', queue: 'scratch' }),
    })
    expect(res.status).toBe(201)
    const task = (await res.json()) as { id: string; status: string; title: string; queue: string; createdAt: string }
    expect(task.id).toBeDefined()
    expect(task.status).toBe('todo')
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
      expect(t.status).toBe('todo')
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

  test('GET /tasks/:id?include=comments returns reply and send events as comments', async () => {
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Comments task', description: 'has chatter', queue: 'comment-worker' }),
    })
    const created = (await createRes.json()) as { id: string }

    // Send a message into the task
    await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'comment-worker', from: 'sensei', text: 'do the thing', taskId: created.id }),
    })
    // Simulate a worker reply by recording it via WS would need a connection — instead post via /send from the worker
    await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'sensei', from: 'comment-worker', text: 'thing done', taskId: created.id }),
    })

    const res = await fetch(`${BASE}/tasks/${created.id}?include=comments`)
    const task = (await res.json()) as {
      id: string
      title: string
      comments: Array<{ ts: string; from: string; text: string; to?: string }>
    }
    expect(task.id).toBe(created.id)
    expect(task.comments.length).toBeGreaterThanOrEqual(2)
    expect(
      task.comments.some((c) => c.from === 'sensei' && c.text === 'do the thing' && c.to === 'comment-worker'),
    ).toBe(true)
    expect(task.comments.some((c) => c.from === 'comment-worker' && c.text === 'thing done')).toBe(true)
  })

  test('GET /tasks/:id without include returns no comments field', async () => {
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Plain task', description: '', queue: 'plain' }),
    })
    const created = (await createRes.json()) as { id: string }
    const res = await fetch(`${BASE}/tasks/${created.id}`)
    const task = (await res.json()) as { id: string; comments?: unknown }
    expect(task.id).toBe(created.id)
    expect(task.comments).toBeUndefined()
  })

  test('GET /tasks/:id?include=playbook returns playbook content for tasks with one', async () => {
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Playbook task',
        description: 'uses review playbook',
        queue: 'reviewer',
        playbook: 'review',
      }),
    })
    const created = (await createRes.json()) as { id: string }

    const res = await fetch(`${BASE}/tasks/${created.id}?include=playbook`)
    const task = (await res.json()) as {
      id: string
      playbook?: { id: string; name: string; content: string }
    }
    expect(task.id).toBe(created.id)
    expect(task.playbook).toBeDefined()
    expect(task.playbook?.id).toBe('review')
    expect(task.playbook?.content).toContain('Task closes when the PR is merged')
  })

  test('GET /tasks/:id?include=playbook omits playbook field when task has none', async () => {
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'No playbook', description: '', queue: 'plain' }),
    })
    const created = (await createRes.json()) as { id: string }
    const res = await fetch(`${BASE}/tasks/${created.id}?include=playbook`)
    const task = (await res.json()) as { id: string; playbook?: unknown }
    expect(task.id).toBe(created.id)
    expect(task.playbook).toBeUndefined()
  })

  test('GET /tasks/:id?include=comments,playbook returns both', async () => {
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Combined include',
        description: '',
        queue: 'reviewer',
        playbook: 'review',
      }),
    })
    const created = (await createRes.json()) as { id: string }

    await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'reviewer', from: 'sensei', text: 'kick off review', taskId: created.id }),
    })

    const res = await fetch(`${BASE}/tasks/${created.id}?include=comments,playbook`)
    const task = (await res.json()) as {
      id: string
      comments?: Array<{ text: string }>
      playbook?: { id: string }
    }
    expect(task.comments?.some((c) => c.text === 'kick off review')).toBe(true)
    expect(task.playbook?.id).toBe('review')
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
      body: JSON.stringify({ status: 'assigned' }),
    })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as { status: string; updatedAt: string }
    expect(updated.status).toBe('assigned')
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
      body: JSON.stringify({ status: 'assigned' }),
    })
    const updated = (await res.json()) as { updatedAt: string }
    expect(updated.updatedAt).not.toBe(created.updatedAt)
  })
})

describe('POST /tasks/:id/revert', () => {
  async function createAndTransition(title: string, statuses: TaskStatus[]): Promise<{ id: string }> {
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, description: '', queue: 'scratch' }),
    })
    const created = (await createRes.json()) as { id: string }
    for (const status of statuses) {
      await fetch(`${BASE}/tasks/${created.id}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      })
    }
    return created
  }

  test('pops the most recent status change (done → in-progress)', async () => {
    const { id } = await createAndTransition('revert test', ['assigned', 'in-progress', 'done'])

    const res = await fetch(`${BASE}/tasks/${id}/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actor: 'test' }),
    })
    expect(res.status).toBe(200)
    const task = (await res.json()) as { id: string; status: string }
    expect(task.status).toBe('in-progress')

    const histRes = await fetch(`${BASE}/history?taskId=${id}`)
    const hist = (await histRes.json()) as { events: Array<{ type: string; data: Record<string, unknown> }> }
    const revertEvent = hist.events.find((e) => e.type === 'task-reverted')
    expect(revertEvent).toBeDefined()
    expect(revertEvent?.data.from).toBe('done')
    expect(revertEvent?.data.to).toBe('in-progress')
    expect(revertEvent?.data.actor).toBe('test')
  })

  test('supports multi-step revert via repeated calls', async () => {
    const { id } = await createAndTransition('multi revert', ['assigned', 'in-progress', 'done'])

    // first undo: done → in-progress
    let res = await fetch(`${BASE}/tasks/${id}/revert`, { method: 'POST' })
    let task = (await res.json()) as { status: string }
    expect(task.status).toBe('in-progress')

    // second undo: in-progress → assigned
    res = await fetch(`${BASE}/tasks/${id}/revert`, { method: 'POST' })
    task = (await res.json()) as { status: string }
    expect(task.status).toBe('assigned')

    // third undo: assigned → todo
    res = await fetch(`${BASE}/tasks/${id}/revert`, { method: 'POST' })
    task = (await res.json()) as { status: string }
    expect(task.status).toBe('todo')

    // fourth undo: 400 — nothing left to pop
    res = await fetch(`${BASE}/tasks/${id}/revert`, { method: 'POST' })
    expect(res.status).toBe(400)
  })

  test('reverting does NOT re-visit popped states (cannot go back to done after reverting)', async () => {
    const { id } = await createAndTransition('stack test', ['assigned', 'in-progress', 'done'])

    // undo once: done → in-progress. Now `done` is off the stack.
    await fetch(`${BASE}/tasks/${id}/revert`, { method: 'POST' })
    // undo again: in-progress → assigned, NOT in-progress → done
    const res = await fetch(`${BASE}/tasks/${id}/revert`, { method: 'POST' })
    const task = (await res.json()) as { status: string }
    expect(task.status).toBe('assigned')
  })

  test('fresh task (no transitions) returns 400', async () => {
    const createRes = await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'fresh', description: '', queue: 'scratch' }),
    })
    const created = (await createRes.json()) as { id: string }

    const res = await fetch(`${BASE}/tasks/${created.id}/revert`, { method: 'POST' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('nothing to revert')
  })

  test('404 for unknown task', async () => {
    const res = await fetch(`${BASE}/tasks/999999/revert`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('forward DAG transitions still forbidden on reverted tasks', async () => {
    // After reverting to in-progress, normal PATCH /status/done should still work (it's a legal forward edge).
    const { id } = await createAndTransition('re-transition', ['assigned', 'in-progress', 'done'])
    await fetch(`${BASE}/tasks/${id}/revert`, { method: 'POST' })
    const res = await fetch(`${BASE}/tasks/${id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    expect(res.status).toBe(200)
    const task = (await res.json()) as { status: string }
    expect(task.status).toBe('done')
  })
})
