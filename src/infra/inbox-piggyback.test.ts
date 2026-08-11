// End-to-end test for the attention piggyback (docs/attention.md §2): an
// AGENT-identified HTTP request gets the compact inbox line as an `x-jean-inbox`
// response header; unidentified and unregistered callers don't; the empty case
// carries no header at all; GET /inbox serves the full object for WS-path tools.
//
// ── WHAT THE TRANSITION CHANGED HERE (task 045) ──
//
// 1. THE PIGGYBACK IS AGENT-UNIFORM. It was sensei-only — 042's DEVIATION-3 —
//    which is why a worker-side carrier was never worth adding and why S1's
//    "an agent learns as a side effect of its own work" held for exactly one
//    agent. Canon S1 says "AN AGENT" and E6 says one mechanism for sensei and
//    worker, so the role gate is gone. The old case asserted `others do not`
//    with a worker identity; that half is now FALSE BY DESIGN, and what
//    replaces it is the line that still has to hold: the caller must be a
//    REGISTERED agent, because attaching a mailbox line to a response headed
//    somewhere with no mailbox is the same defect from the other side.
// 2. `GET /inbox` IS FOR THE CALLER. It was `senseiInboxNow()` and handed the
//    orchestrator's queue to whoever asked. It now needs the identity header
//    like everything else.
// 3. ANSWERING A HUMAN NO LONGER CLEARS THEIR MESSAGE. Auto-clear-on-reply is
//    deleted (S5: `{id, code}` pairs are THE only clearing path), so the
//    post-send assertion inverts.
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

    // No identity header → no piggyback. An identity nobody has registered →
    // none either.
    //
    // OLD: the second probe used a WORKER identity and asserted no header,
    // because the piggyback was sensei-only. That is false by design now, so the
    // probe moved to the boundary that still exists — a name with no registered
    // agent behind it. Both are "no mailbox to report on"; only one of them is
    // still a rule.
    const anonymous = await fetch(`${BASE}/board`)
    expect(anonymous.headers.get('x-jean-inbox')).toBeNull()
    const asStranger = await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': 'never-registered' } })
    expect(asStranger.headers.get('x-jean-inbox')).toBeNull()

    // GET /inbox — full object for the WS-path tools (reply/comment), FOR THE
    // CALLER. OLD: no header, and it served the sensei's queue to anyone.
    const inboxRes = (await (await fetch(`${BASE}/inbox`, { headers: { 'x-jean-agent': 'sensei' } })).json()) as {
      inbox: { blocking: Array<{ from: string; preview: string }> } | null
      line: string | null
    }
    expect(inboxRes.inbox?.blocking[0]?.from).toBe('human')
    expect(inboxRes.inbox?.blocking[0]?.preview).toBe('what about the wine?')
    expect(inboxRes.line).toContain('blocking')
    // …and unidentified now means empty rather than "the orchestrator's".
    const anonymousInbox = (await (await fetch(`${BASE}/inbox`)).json()) as { inbox: null; line: null }
    expect(anonymousInbox.inbox).toBeNull()

    // (A `GET /stream` case lived here until 2026-08: SSE was removed with zero
    // consumers, and with it the content-type skip this asserted.)

    // Error responses still carry the piggyback (deliberate: cannot-not-know).
    const notFound = await fetch(`${BASE}/definitely-not-a-route`, { headers: { 'x-jean-agent': 'sensei' } })
    expect(notFound.status).toBe(404)
    expect(notFound.headers.get('x-jean-inbox')).toContain('blocking')

    // POST paths get the header too (the channel plugin's send/memorize ride
    // this).
    //
    // OLD: this send answered the human's only pending message, auto-clear fired
    // during the request, and the assertion was `not.toContain('blocking')` —
    // "the reply WAS the ack". Auto-clear is deleted: answering a human is not
    // acking them, because deciding on the sensei's behalf that a reply meant
    // the question was handled is precisely what S5's read-before-ack exists to
    // stop. So the message is STILL waiting after the answer, and that
    // inversion is the assertion.
    const post = await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jean-agent': 'sensei' },
      body: JSON.stringify({ from: 'sensei', to: 'human', text: 'pong' }),
    })
    const postLine = post.headers.get('x-jean-inbox')
    expect(postLine).not.toBeNull()
    expect(postLine).toContain('blocking') // answering is not acking
    expect(postLine).toContain('queued')

    // Percent-encoded caller name decodes (non-ASCII names transit the header encoded).
    const encoded = await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': encodeURIComponent('sensei') } })
    expect(encoded.headers.get('x-jean-inbox')).not.toBeNull()

    // Drain: ack everything → inbox empty → header gone (empty case costs zero).
    // OLD: `{upToId: max(ids)}` (task 043's mechanical-rewrite list,
    // `inbox-piggyback.test.ts:104`).
    const events = (await (await fetch(`${BASE}/events`)).json()) as {
      events: Array<{ id: number; code: string }>
    }
    await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairs: events.events.map((e) => ({ id: e.id, code: e.code })) }),
    })
    const afterDrain = await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': 'sensei' } })
    expect(afterDrain.headers.get('x-jean-inbox')).toBeNull()
    const emptyInbox = (await (await fetch(`${BASE}/inbox`, { headers: { 'x-jean-agent': 'sensei' } })).json()) as {
      inbox: null
      line: null
    }
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
