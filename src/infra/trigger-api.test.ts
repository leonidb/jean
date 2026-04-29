import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'

const TEST_PORT = 8797
const DATA_DIR = '/tmp/jean-test-trigger'
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
const json = { 'content-type': 'application/json' }

describe('trigger CRUD', () => {
  test('POST /triggers creates a cron trigger', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ id: 'morning', cron: '0 8 * * 1-5', agent: 'sensei', prompt: 'Run brief', actor: 'cli' }),
    })
    expect(res.status).toBe(201)
    const trigger = (await res.json()) as { id: string; status: string; cron: string; createdAt: string }
    expect(trigger.id).toBe('morning')
    expect(trigger.status).toBe('active')
    expect(trigger.cron).toBe('0 8 * * 1-5')
    expect(trigger.createdAt).toBeDefined()
  })

  test('POST /triggers creates a one-off trigger', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ id: 'reminder', at: '2026-12-01T10:00:00Z', agent: 'sensei', prompt: 'Check PR' }),
    })
    expect(res.status).toBe(201)
    const trigger = (await res.json()) as { id: string; at: string }
    expect(trigger.id).toBe('reminder')
    expect(trigger.at).toBe('2026-12-01T10:00:00Z')
  })

  test('POST /triggers auto-generates ID if not provided', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ cron: '0 9 * * *', agent: 'sensei', prompt: 'Auto ID test' }),
    })
    expect(res.status).toBe(201)
    const trigger = (await res.json()) as { id: string }
    expect(trigger.id).toBeDefined()
    expect(trigger.id.length).toBe(8)
  })

  test('POST /triggers rejects missing agent', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ cron: '0 8 * * *', prompt: 'no agent' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /triggers rejects missing prompt', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ cron: '0 8 * * *', agent: 'sensei' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /triggers rejects missing cron and at', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ agent: 'sensei', prompt: 'no schedule' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /triggers rejects both cron and at', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ cron: '0 8 * * *', at: '2026-12-01T10:00:00Z', agent: 'sensei', prompt: 'both' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /triggers rejects invalid cron', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ cron: 'not a cron', agent: 'sensei', prompt: 'bad cron' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /triggers rejects invalid datetime', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ at: 'not a date', agent: 'sensei', prompt: 'bad date' }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /triggers rejects duplicate ID', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ id: 'morning', cron: '0 9 * * *', agent: 'sensei', prompt: 'dup' }),
    })
    expect(res.status).toBe(409)
  })

  test('GET /triggers lists all triggers', async () => {
    const res = await fetch(`${BASE}/triggers`)
    const data = (await res.json()) as { triggers: Array<{ id: string }> }
    expect(data.triggers.length).toBeGreaterThanOrEqual(2)
  })

  test('GET /triggers?status=active filters', async () => {
    const res = await fetch(`${BASE}/triggers?status=active`)
    const data = (await res.json()) as { triggers: Array<{ status: string }> }
    for (const t of data.triggers) {
      expect(t.status).toBe('active')
    }
  })

  test('GET /triggers?agent=sensei filters', async () => {
    const res = await fetch(`${BASE}/triggers?agent=sensei`)
    const data = (await res.json()) as { triggers: Array<{ agent: string }> }
    for (const t of data.triggers) {
      expect(t.agent).toBe('sensei')
    }
  })

  test('GET /triggers/:id returns single trigger', async () => {
    const res = await fetch(`${BASE}/triggers/morning`)
    const trigger = (await res.json()) as { id: string; cron: string }
    expect(trigger.id).toBe('morning')
    expect(trigger.cron).toBe('0 8 * * 1-5')
  })

  test('GET /triggers/:id returns 404 for unknown', async () => {
    const res = await fetch(`${BASE}/triggers/nonexistent`)
    expect(res.status).toBe(404)
  })

  test('PATCH /triggers/:id updates fields', async () => {
    const res = await fetch(`${BASE}/triggers/morning`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ prompt: 'Run morning brief and post to Slack' }),
    })
    expect(res.status).toBe(200)
    const trigger = (await res.json()) as { prompt: string; cron: string }
    expect(trigger.prompt).toBe('Run morning brief and post to Slack')
    expect(trigger.cron).toBe('0 8 * * 1-5') // unchanged
  })

  test('PATCH /triggers/:id can disable', async () => {
    const res = await fetch(`${BASE}/triggers/reminder`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ status: 'disabled' }),
    })
    const trigger = (await res.json()) as { status: string }
    expect(trigger.status).toBe('disabled')
  })

  test('PATCH /triggers/:id rejects schedule changes', async () => {
    const cronRes = await fetch(`${BASE}/triggers/morning`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ cron: '* * * * *' }),
    })
    expect(cronRes.status).toBe(400)
    const atRes = await fetch(`${BASE}/triggers/morning`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ at: '2099-01-01T00:00:00Z' }),
    })
    expect(atRes.status).toBe(400)
  })

  test('PATCH /triggers/:id rejects unknown fields', async () => {
    const res = await fetch(`${BASE}/triggers/morning`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ junk: 'x', prompt: 'valid' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('junk')
  })

  test('PATCH /triggers/:id rejects wrong types', async () => {
    const res = await fetch(`${BASE}/triggers/morning`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ agent: 123 }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('agent')
  })

  test('PATCH /triggers/:id returns 404 for unknown', async () => {
    const res = await fetch(`${BASE}/triggers/nonexistent`, {
      method: 'PATCH',
      headers: json,
      body: JSON.stringify({ prompt: 'nope' }),
    })
    expect(res.status).toBe(404)
  })

  test('DELETE /triggers/:id removes trigger', async () => {
    // Create one to delete
    await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ id: 'to-delete', cron: '0 12 * * *', agent: 'sensei', prompt: 'deleteme' }),
    })

    const res = await fetch(`${BASE}/triggers/to-delete`, { method: 'DELETE' })
    expect(res.status).toBe(200)

    const check = await fetch(`${BASE}/triggers/to-delete`)
    expect(check.status).toBe(404)
  })

  test('DELETE /triggers/:id returns 404 for unknown', async () => {
    const res = await fetch(`${BASE}/triggers/nonexistent`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  test('status endpoint includes activeTriggers count', async () => {
    const res = await fetch(`${BASE}/status`)
    const info = (await res.json()) as { activeTriggers: number }
    expect(info.activeTriggers).toBeGreaterThanOrEqual(1)
  })

  test('default kind is "agent" when omitted (backwards-compatible)', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        id: 'kind-default',
        cron: '0 0 * * *',
        agent: 'sensei',
        prompt: 'x',
      }),
    })
    expect(res.status).toBe(201)
    const trigger = (await res.json()) as { kind: string }
    expect(trigger.kind).toBe('agent')
  })

  test('headless trigger requires agent to be a valid role name', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        id: 'headless-bad-role',
        cron: '0 3 * * *',
        agent: 'not-a-role',
        prompt: 'x',
        kind: 'headless',
      }),
    })
    expect(res.status).toBe(400)
    const err = (await res.json()) as { error: string }
    expect(err.error).toContain('valid role')
  })

  test('headless trigger with valid role is accepted', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        id: 'headless-librarian',
        cron: '0 3 * * *',
        agent: 'librarian',
        prompt: 'consolidate the wiki',
        kind: 'headless',
      }),
    })
    expect(res.status).toBe(201)
    const trigger = (await res.json()) as { id: string; kind: string; agent: string }
    expect(trigger.kind).toBe('headless')
    expect(trigger.agent).toBe('librarian')
  })

  test('invalid kind returns 400', async () => {
    const res = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        id: 'kind-bogus',
        cron: '0 0 * * *',
        agent: 'sensei',
        prompt: 'x',
        kind: 'bogus',
      }),
    })
    expect(res.status).toBe(400)
  })

  test('headless trigger fire records headless-completed event when role dir missing', async () => {
    // Create a headless trigger that fires once (in the very near future).
    // Role dir doesn't exist in our test DATA_DIR — we expect spawn to fail
    // gracefully and emit a headless-completed event with exitCode -1.
    const at = new Date(Date.now() + 500).toISOString()
    const createRes = await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        id: 'headless-spawn-fail',
        at,
        agent: 'librarian',
        prompt: 'unused',
        kind: 'headless',
      }),
    })
    expect(createRes.status).toBe(201)

    // Wait for the trigger to fire and the spawn-fail event to be recorded.
    let completed: { type: string; data: { triggerId: string; exitCode: number } } | undefined
    for (let i = 0; i < 30; i++) {
      await Bun.sleep(150)
      const histRes = await fetch(`${BASE}/history?stream=triggers`)
      const hist = (await histRes.json()) as { events: Array<typeof completed> }
      completed = hist.events.find(
        (e) => e?.type === 'headless-completed' && e?.data.triggerId === 'headless-spawn-fail',
      )
      if (completed) break
    }
    expect(completed).toBeDefined()
    expect(completed?.data.exitCode).toBe(-1) // spawn-failed sentinel
  })
})
