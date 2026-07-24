// End-to-end test for the attention phase-1 piggyback (docs/attention.md §2):
// a sensei-identified HTTP request gets the compact inbox line as an
// `x-jean-inbox` response header; non-sensei callers don't; the empty case
// carries no header at all; GET /inbox serves the full object for WS-path tools.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'
import { connectAgent } from './test-helpers.ts'

const TEST_PORT = 8809
const DATA_DIR = '/tmp/jean-test-inbox-piggyback'
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

describe('inbox piggyback', () => {
  test('sensei request carries x-jean-inbox; others do not; empty omits; /inbox serves the object', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using human = await connectAgent(WS_URL, 'human', 'user')
    void sensei

    // A human (user-role) reply → a blocking inbox entry.
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'what about the wine?' }))
    await Bun.sleep(150)

    // Sensei-identified request → header present, classifies the human as blocking.
    const asSensei = await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': 'sensei' } })
    const line = asSensei.headers.get('x-jean-inbox')
    expect(line).not.toBeNull()
    expect(line).toContain('blocking (human')

    // No identity header → no piggyback. Unknown/non-sensei identity → none either.
    const anonymous = await fetch(`${BASE}/board`)
    expect(anonymous.headers.get('x-jean-inbox')).toBeNull()
    const asWorker = await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': 'human' } })
    expect(asWorker.headers.get('x-jean-inbox')).toBeNull()

    // GET /inbox — full object for the WS-path tools (reply/comment).
    const inboxRes = (await (await fetch(`${BASE}/inbox`)).json()) as {
      inbox: { blocking: Array<{ from: string; preview: string }> } | null
      line: string | null
    }
    expect(inboxRes.inbox?.blocking[0]?.from).toBe('human')
    expect(inboxRes.inbox?.blocking[0]?.preview).toBe('what about the wine?')
    expect(inboxRes.line).toContain('blocking')

    // SSE must NOT be rebuilt/decorated — the stream endpoint stays streamy.
    const sse = await fetch(`${BASE}/stream`, { headers: { 'x-jean-agent': 'sensei' } })
    expect(sse.headers.get('content-type') ?? '').toContain('text/event-stream')
    expect(sse.headers.get('x-jean-inbox')).toBeNull()
    await sse.body?.cancel()

    // Error responses still carry the piggyback (deliberate: cannot-not-know).
    const notFound = await fetch(`${BASE}/definitely-not-a-route`, { headers: { 'x-jean-agent': 'sensei' } })
    expect(notFound.status).toBe(404)
    expect(notFound.headers.get('x-jean-inbox')).toContain('blocking')

    // POST paths get the header too (the channel plugin's send/memorize ride this).
    const post = await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jean-agent': 'sensei' },
      body: JSON.stringify({ from: 'sensei', to: 'human', text: 'pong' }),
    })
    expect(post.headers.get('x-jean-inbox')).toContain('blocking')

    // Percent-encoded caller name decodes (non-ASCII names transit the header encoded).
    const encoded = await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': encodeURIComponent('sensei') } })
    expect(encoded.headers.get('x-jean-inbox')).not.toBeNull()

    // Drain: ack everything → inbox empty → header gone (empty case costs zero).
    const events = (await (await fetch(`${BASE}/events`)).json()) as { events: Array<{ id: number }> }
    const maxId = Math.max(...events.events.map((e) => e.id))
    await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upToId: maxId }),
    })
    const afterDrain = await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': 'sensei' } })
    expect(afterDrain.headers.get('x-jean-inbox')).toBeNull()
    const emptyInbox = (await (await fetch(`${BASE}/inbox`)).json()) as { inbox: null; line: null }
    expect(emptyInbox.inbox).toBeNull()
    expect(emptyInbox.line).toBeNull()
  })

  test("a DISCONNECTED human's pending messages stay blocking (persisted classification)", async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    void sensei
    {
      // Non-`chat-` user name (registry-prefix fallback can't rescue it) sends, then disconnects.
      using visitor = await connectAgent(WS_URL, 'visitor', 'user')
      visitor.ws.send(JSON.stringify({ type: 'reply', from: 'visitor', text: 'still there?' }))
      await Bun.sleep(150)
    } // ← `using` disposes: WS closes, visitor leaves the live registry
    await Bun.sleep(150)

    const res = await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': 'sensei' } })
    const line = res.headers.get('x-jean-inbox')
    // Must still classify as blocking via the persisted register record — a
    // briefly-offline human must never demote to machine (review finding).
    expect(line).toContain('blocking (visitor')
  })
})
