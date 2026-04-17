/**
 * Verifies autoNudge=false (the default) suppresses autonomous sensei wake-ups:
 * - nudgeSenseiIfIdle() doesn't deliver on pending events
 * - fireTrigger() skips delivery when the target is a sensei
 * Worker-targeting triggers and explicit sends still work.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'
import type { DeliverMsg, OutboundMsg } from './protocol.ts'

const TEST_PORT = 8795
const DATA_DIR = '/tmp/jean-test-auto-nudge'
let server: Subprocess

const WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`
const BASE = `http://127.0.0.1:${TEST_PORT}`
const isDeliver = (m: OutboundMsg): m is DeliverMsg => m.type === 'deliver'

beforeAll(async () => {
  try {
    rmSync(DATA_DIR, { recursive: true })
  } catch {}
  mkdirSync(DATA_DIR, { recursive: true })
  // Deliberately DO NOT set JEAN_AUTO_NUDGE — testing the default-off behavior.
  server = Bun.spawn(['bun', 'run', 'src/infra/server.ts'], {
    env: { ...process.env, JEAN_PORT: String(TEST_PORT), JEAN_DATA_DIR: DATA_DIR },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(`${BASE}/`)
      break
    } catch {
      await Bun.sleep(100)
    }
  }
})

afterAll(() => {
  server.kill()
})

function connectAgent(name: string, role: string): Promise<{ ws: WebSocket; messages: OutboundMsg[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const messages: OutboundMsg[] = []
    let resolved = false
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'register', agent: name, role }))
    }
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as OutboundMsg
      messages.push(msg)
      if (msg.type === 'registered' && !resolved) {
        resolved = true
        if (role === 'sensei') {
          // Small buffer to catch any stray connect-time delivery (welcome message is expected; nudges are not).
          setTimeout(() => resolve({ ws, messages }), 200)
        } else {
          resolve({ ws, messages })
        }
      }
    }
    ws.onerror = reject
    setTimeout(() => reject(new Error('timeout')), 3000)
  })
}

describe('autoNudge=false (default)', () => {
  test('sensei-idle + pending event → no nudge delivered', async () => {
    const { ws, messages } = await connectAgent('nudge-sensei', 'sensei')
    const baseline = messages.length

    // Create an event that would normally trigger a nudge.
    await fetch(`${BASE}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'should-not-nudge', description: '', queue: 'nobody' }),
    })
    await Bun.sleep(200)

    // Signal sensei idle — the classic nudge trigger.
    await fetch(`${BASE}/agent-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'nudge-sensei' }),
    })
    await Bun.sleep(300)

    const nudge = messages
      .slice(baseline)
      .find((m): m is DeliverMsg => isDeliver(m) && m.from === 'infra' && m.text.includes('Events pending'))
    expect(nudge).toBeUndefined()

    ws.close()
  })

  test('trigger targeting sensei → trigger-fired recorded, no delivery', async () => {
    const { ws, messages } = await connectAgent('trigger-sensei', 'sensei')
    const baseline = messages.length

    await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'test-sensei-trigger',
        cron: '0 0 1 1 *',
        agent: 'trigger-sensei',
        prompt: 'should not be delivered',
        actor: 'test',
      }),
    })
    await fetch(`${BASE}/triggers/test-sensei-trigger/fire`, { method: 'POST' })
    await Bun.sleep(250)

    // trigger-fired event should be in history, but no delivery to the sensei.
    const histRes = await fetch(`${BASE}/history?last=20`)
    const hist = (await histRes.json()) as { events: Array<{ type: string; data: Record<string, unknown> }> }
    expect(hist.events.some((e) => e.type === 'trigger-fired' && e.data?.triggerId === 'test-sensei-trigger')).toBe(
      true,
    )

    const delivered = messages
      .slice(baseline)
      .find((m): m is DeliverMsg => isDeliver(m) && m.text === 'should not be delivered')
    expect(delivered).toBeUndefined()

    // No send event either (we skip the record, not just the delivery).
    expect(hist.events.some((e) => e.type === 'send' && e.data?.text === 'should not be delivered')).toBe(false)

    ws.close()
  })

  test('trigger targeting worker → delivered normally (flag only affects sensei)', async () => {
    const { ws, messages } = await connectAgent('trigger-worker', 'worker')
    const baseline = messages.length

    await fetch(`${BASE}/triggers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'test-worker-trigger',
        cron: '0 0 1 1 *',
        agent: 'trigger-worker',
        prompt: 'worker do the thing',
        actor: 'test',
      }),
    })
    await fetch(`${BASE}/triggers/test-worker-trigger/fire`, { method: 'POST' })
    await Bun.sleep(250)

    const delivered = messages
      .slice(baseline)
      .find((m): m is DeliverMsg => isDeliver(m) && m.text === 'worker do the thing')
    expect(delivered).toBeDefined()
    expect(delivered?.from).toBe('trigger')

    ws.close()
  })

  test('explicit jean send sensei → still delivered (flag only blocks autonomous paths)', async () => {
    const { ws, messages } = await connectAgent('explicit-sensei', 'sensei')
    const baseline = messages.length

    await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'explicit-sensei', from: 'human', text: 'hey sensei' }),
    })
    await Bun.sleep(200)

    const delivered = messages.slice(baseline).find((m): m is DeliverMsg => isDeliver(m) && m.text === 'hey sensei')
    expect(delivered).toBeDefined()

    ws.close()
  })
})
