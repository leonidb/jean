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

    // Get the event FROM THE FETCH RUNG — the only place a code exists (S5).
    const res = await fetch(`${BASE}/events?agent=ack-worker`)
    const data = (await res.json()) as { events: Array<{ id: number; code: string }> }
    const event = data.events[0]
    if (!event) throw new Error('expected pending event for ack-worker')

    // A CODE IS REQUIRED HERE TOO. This endpoint used to clear on the id alone,
    // which was a hole straight through read-before-ack: an id is knowable from
    // the cheap summary rung, so a queue could be drained one call at a time
    // without ever being read. Asserted in both directions, because "the happy
    // path works" would also pass against an endpoint that ignored the code.
    const wrongCode = await fetch(`${BASE}/events/${event.id}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'not-the-code' }),
    })
    expect(((await wrongCode.json()) as { ok: boolean }).ok).toBe(false)

    const ackRes = await fetch(`${BASE}/events/${event.id}/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: event.code }),
    })
    const ackData = (await ackRes.json()) as { ok: boolean }
    expect(ackData.ok).toBe(true)

    // Verify it's gone
    const after = await fetch(`${BASE}/events/pending?agent=ack-worker`)
    const afterData = (await after.json()) as { events: Array<{ id: number }> }
    expect(afterData.events.find((e) => e.id === event.id)).toBeUndefined()
  })

  test('POST /events/ack clears exactly the pairs it was given, and leaves the rest', async () => {
    // ── CASUALTY, PRE-DECLARED (task 043 part 3, `queue.test.ts:136`) ──
    //
    // OLD: `POST /events/ack batch acks up to ID` — `{agent, upToId}`, asserting
    // that acking up to the second reply also swept the earlier `register`.
    // `upToId` is DELETED, and the sweep is precisely why: it let an agent clear
    // a queue it had never read, and "progress is defined only by ack" (E4) is
    // worth nothing if an ack can be issued without reading. The old assertion's
    // most valuable line was its comment — "acking up to secondId ALSO clears
    // register" — which is the collateral clearing stated as a feature.
    //
    // NEW: the property worth keeping from it — a batch ack is still a batch,
    // and it clears WHAT IT NAMED and nothing adjacent. Same three replies, same
    // partial drain, no range.
    using agent = await connectAgent(WS_URL, 'batch-worker')
    agent.ws.send(JSON.stringify({ type: 'reply', from: 'batch-worker', text: 'msg 1' }))
    await Bun.sleep(50)
    agent.ws.send(JSON.stringify({ type: 'reply', from: 'batch-worker', text: 'msg 2' }))
    await Bun.sleep(50)
    agent.ws.send(JSON.stringify({ type: 'reply', from: 'batch-worker', text: 'msg 3' }))
    await Bun.sleep(100)

    // The FETCH rung — the only place a code exists (S5).
    const res = await fetch(`${BASE}/events?agent=batch-worker`)
    const data = (await res.json()) as { events: Array<{ id: number; type: string; code: string }> }
    const replies = data.events.filter((e) => e.type === 'reply')
    expect(replies.length).toBe(3)

    const ackRes = await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairs: replies.slice(0, 2).map((e) => ({ id: e.id, code: e.code })) }),
    })
    const ackData = (await ackRes.json()) as { acknowledged: number }
    expect(ackData.acknowledged).toBe(2)

    // The third reply survives — and so does the `register` that sat BEFORE all
    // three, which under `upToId` would have gone with them. That is the whole
    // behavioural difference between the two forms, so it is asserted rather
    // than described.
    const after = await fetch(`${BASE}/events/pending?agent=batch-worker`)
    const afterData = (await after.json()) as { events: Array<{ id: number; type: string }> }
    expect(afterData.events.map((e) => e.type).sort()).toEqual(['register', 'reply'])
  })

  test('POST /events/ack with no agent filter drains other-agent register events (nudge-loop bug)', async () => {
    // Other agents' register events end up in pending (the sensei's inbox) but
    // none resolve to sensei — an ack with no agent filter must still drain
    // them. OLD: `{upToId: maxId}`. Mechanical rewrite to pairs (task 043's
    // mechanical-rewrite list, `queue.test.ts:170`): the subject is the ABSENCE
    // of an agent filter, and that survives the ack-form change untouched.
    await clearPendingEvents()
    using _a = await connectAgent(WS_URL, 'drain-a')
    using _b = await connectAgent(WS_URL, 'drain-b')
    await Bun.sleep(100)

    const pending = (await (await fetch(`${BASE}/events`)).json()) as {
      events: Array<{ id: number; type: string; agent?: string; code: string }>
    }
    const registers = pending.events.filter(
      (e) => e.type === 'register' && (e.agent === 'drain-a' || e.agent === 'drain-b'),
    )
    expect(registers.length).toBe(2)

    const ackRes = await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairs: pending.events.map((e) => ({ id: e.id, code: e.code })) }),
    })
    const ackData = (await ackRes.json()) as { acknowledged: number }
    expect(ackData.acknowledged).toBeGreaterThanOrEqual(2)
    // "Everything drained" used to be read off the response's own `remaining`
    // field. That field is gone (task 059 — it reported the GLOBAL count to a
    // caller asking about itself), so the drain is asserted where it is
    // actually true: the pending queue, read back.
    const left = (await (await fetch(`${BASE}/events/pending`)).json()) as { events: unknown[] }
    expect(left.events.length).toBe(0)
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

/** Drain everything pending. OLD: `{upToId: max(ids)}`. The unaddressed fetch is
 *  deliberate — this is a test clearing the whole queue, not an agent reading
 *  its mailbox, and only the ADDRESSED read stamps the delivery ledger. */
async function clearPendingEvents() {
  const res = await fetch(`${BASE}/events`)
  const data = (await res.json()) as { events: Array<{ id: number; code: string }> }
  if (data.events.length > 0) {
    await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairs: data.events.map((e) => ({ id: e.id, code: e.code })) }),
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
  test('PRIORITY, not idleness, decides an interrupt: a human pushes, a worker reply does not', async () => {
    // ── CASUALTY, PRE-DECLARED (task 043 part 3: the idle-gate-dependent cases) ──
    //
    // OLD: `sensei receives nudge when idle + events pending` — post
    // `/agent-idle`, send a worker reply, expect an `Events pending` deliver.
    // Both halves of that premise are gone. `/agent-idle` no longer arms
    // anything (canon E3: "nothing ever asks whether an agent is busy"), and a
    // worker's routine reply does not outrank the sensei's push threshold (S3),
    // so the arrival it used as the trigger is now the textbook case of an event
    // that must NOT interrupt.
    //
    // NEW: the same question — "when does infra interrupt the sensei?" — asked
    // of the mechanism that answers it now. Kept at this level because the pure
    // tests can prove what `decide` returns but not that the adapter hands it a
    // real priority; that mapping is only exercised over a live socket.
    using sensei = await connectAgent(WS_URL, 'nudge-sensei', 'sensei')
    using worker = await connectAgent(WS_URL, 'nudge-worker')
    using human = await connectAgent(WS_URL, 'nudge-human', 'user')

    const pushes = () =>
      sensei.messages.filter((m) => m.type === 'deliver' && m.from === 'infra' && m.text?.includes('Events pending'))
        .length

    // Settle first and take the mark AFTER the connects. The human's own
    // `register` is an external-sender event and therefore pushes on arrival —
    // correct under the heuristic (it looks at the sender, not the verb) and
    // nothing to do with the arrival under test, but it lands inside
    // `baselineCount` and would make the first assertion measure a connect.
    await Bun.sleep(300)
    const mark = pushes()

    // BELOW THE THRESHOLD: queued, and silent.
    worker.ws.send(JSON.stringify({ type: 'reply', from: 'nudge-worker', text: 'finished' }))
    await Bun.sleep(250)
    expect(pushes()).toBe(mark)

    // AT THE THRESHOLD: the same queue, the same sensei, one external message —
    // and it lands. Asserted as a pair on purpose: either half alone passes
    // against an implementation that pushes for everything or for nothing.
    human.ws.send(JSON.stringify({ type: 'reply', from: 'nudge-human', text: 'are you there?' }))
    let landed = mark
    for (let i = 0; i < 20 && landed === mark; i++) {
      landed = pushes()
      if (landed === mark) await Bun.sleep(50)
    }
    expect(landed).toBe(mark + 1)
    // …and the worker's reply rode along in that push rather than being lost:
    // the threshold decides whether to INTERRUPT, never what the mailbox holds.
    // (The wake summarises by type rather than quoting bodies — that is the
    // cheap rung doing its job — so the reply shows up as its kind, not its
    // text.)
    const last = sensei.messages.filter((m) => m.type === 'deliver' && m.from === 'infra').at(-1)
    expect((last as { text: string }).text).toContain('worker:reply')
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
