/**
 * E1's e2e smoke — register, send, fetch, ack over the NEW server, on a real
 * socket. Not a unit test of anything: the point is that the wiring exists and
 * that a message survives the whole round trip through the domain modules.
 *
 * Deliberately end-to-end and deliberately small. The modules are already
 * conformance-tested; what is unproven until now is that the adapter composes
 * their facts correctly and that nothing in the five-step pattern drops a
 * value on the floor.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type AdapterHandle, createAdapterServer } from './server.ts'

let server: AdapterHandle
let base: string
/** Every socket this file opens. Teardown closes them and WAITS: `ws.close()`
 *  only requests a close, and a socket still closing when the server is
 *  stopped holds the hook open until its timeout — which is a hanging suite
 *  that looks like a product bug and is not one. */
const opened: WebSocket[] = []

beforeAll(async () => {
  server = await createAdapterServer()
  base = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
  await Promise.all(
    opened.map(
      (ws) =>
        new Promise<void>((done) => {
          if (ws.readyState === WebSocket.CLOSED) return done()
          ws.onclose = () => done()
          ws.close()
        }),
    ),
  )
  server.stop()
})

/** Register over the socket and resolve once the server confirms — the
 *  handshake is a real WS exchange, not a mock. */
function connect(agent: string, role = 'worker'): Promise<{ ws: WebSocket; inbox: unknown[] }> {
  return new Promise((done, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
    opened.push(ws)
    const inbox: unknown[] = []
    const timer = setTimeout(() => fail(new Error(`register timed out for ${agent}`)), 4_000)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'register', agent, role }))
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as { type?: string }
      if (msg.type === 'registered') {
        clearTimeout(timer)
        done({ ws, inbox })
        return
      }
      inbox.push(msg)
    }
    ws.onerror = () => fail(new Error('socket error'))
  })
}

const get = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<Record<string, never>>
const patch = async (path: string, body: unknown) =>
  (
    await fetch(`${base}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json() as Promise<Record<string, never>>
const post = async (path: string, body: unknown, agent?: string) =>
  (
    await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(agent !== undefined && { 'x-jean-agent': agent }) },
      body: JSON.stringify(body),
    })
  ).json() as Promise<Record<string, never>>

describe('E1 smoke — the round trip over a real socket', () => {
  test('register → send → fetch → ack, with the mailbox emptying exactly once', async () => {
    const sensei = await connect('orchestrator-o', 'sensei')
    const worker = await connect('worker-a', 'worker')

    // SEND: the orchestrator writes to a registered worker. Both are dojo
    // agents, so routing queues it — the mailbox is truth, not the push.
    const sent = (await post('/send', { to: 'worker-a', text: 'start on 42' }, 'orchestrator-o')) as {
      ok?: boolean
      queued?: boolean
    }
    expect(sent.ok).toBe(true)
    expect(sent.queued).toBe(true)

    // FETCH: the worker sees exactly its own mail, with a code per event —
    // the only rung that carries them.
    const fetched = (await get('/events?agent=worker-a')) as unknown as {
      events: { id: number; code: string; type: string }[]
    }
    expect(fetched.events.length).toBe(1)
    expect(fetched.events[0]?.type).toBe('send')
    expect(typeof fetched.events[0]?.code).toBe('string')

    // And nobody else's: the orchestrator authored it, so it is not its mail.
    // ASSERTED ON THE SEND, not on emptiness (task 133): a sensei registering
    // with an empty mailbox is now greeted, so "the orchestrator's box is
    // empty" stopped being an incidental truth this walk could lean on. What
    // it is actually about is that the send it authored did not come back to
    // it, and that is what it now says.
    const senseiBox = (await get('/events?agent=orchestrator-o')) as unknown as {
      events: { type: string }[]
    }
    expect(senseiBox.events.filter((e) => e.type === 'send')).toEqual([])

    // ACK: the code from the fetch clears the pair, and only that pair.
    const first = fetched.events[0]
    if (first === undefined) throw new Error('unreachable')
    const acked = (await post('/ack', { pairs: [{ id: first.id, code: first.code }] }, 'worker-a')) as {
      acknowledged?: number
      remaining?: number
    }
    expect(acked.acknowledged).toBe(1)
    expect(acked.remaining).toBe(0)

    // Acking twice clears nothing more — the pair is gone, not the code.
    const again = (await post('/ack', { pairs: [{ id: first.id, code: first.code }] }, 'worker-a')) as {
      acknowledged?: number
    }
    expect(again.acknowledged).toBe(0)

    sensei.ws.close()
    worker.ws.close()
  })

  test('R8: a freshly registered session reports NO lastActivityAt — the handshake is not an act', async () => {
    const fresh = await connect('worker-fresh', 'worker')
    const before = (await get('/agents')) as unknown as { agents: { name: string; lastActivityAt?: number }[] }
    const seen = before.agents.find((a) => a.name === 'worker-fresh')
    expect(seen).toBeDefined()
    expect(seen?.lastActivityAt).toBeUndefined() // the old server would have shown connect time here

    // One own act, and it appears.
    await get('/events?agent=worker-fresh')
    const after = (await get('/agents')) as unknown as { agents: { name: string; lastActivityAt?: number }[] }
    expect(after.agents.find((a) => a.name === 'worker-fresh')?.lastActivityAt).toBeDefined()
    fresh.ws.close()
  })

  test('an unknown target goes to the adapter path and says so — never a silent success', async () => {
    const orch = await connect('orchestrator-two', 'sensei')
    const out = (await post('/send', { to: 'nobody-ever', text: 'hello?' }, 'orchestrator-two')) as {
      delivered?: boolean
      undelivered?: string
    }
    expect(out.delivered).toBe(false)
    expect(typeof out.undelivered).toBe('string') // the reason, for the adapter to compose
    orch.ws.close()
  })

  test('malformed bodies are the adapter’s own 400 — grammar, not policy', async () => {
    const res = await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 42 }),
    })
    expect(res.status).toBe(400)
  })

  test('a malformed id REFUSES rather than answering an empty selection', async () => {
    // `?ids=a` filtered to nothing and got an honest "found nothing" — a right
    // answer to a question nobody asked. Grammar belongs in the parse step.
    const res = await fetch(`${base}/events?agent=worker-a&ids=a,2`)
    expect(res.status).toBe(400)
  })

  test('an invalid role in a register frame is REFUSED — a live role outranks the record', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
    opened.push(ws)
    // Resolved on the CLOSE, not the message: the server refuses and then
    // closes, and waiting for the close is what leaves no half-open socket
    // behind — one of those held this file's teardown at its timeout until it
    // was awaited rather than requested.
    const reason = await new Promise<string>((done, fail) => {
      let seen = ''
      const timer = setTimeout(() => fail(new Error('no answer')), 4_000)
      ws.onopen = () => ws.send(JSON.stringify({ type: 'register', agent: 'w-bad', role: 'sideways' }))
      ws.onmessage = (ev) => {
        seen = (JSON.parse(String(ev.data)) as { reason?: string }).reason ?? ''
      }
      ws.onclose = () => {
        clearTimeout(timer)
        done(seen)
      }
    })
    expect(reason).toBe('invalid-role')
  })
})

/**
 * THE RECORDING RULE (ruled task 116) — where an agent's speech lands.
 *
 * Driven over the real socket, because the rule governs what the WRITER does
 * with a frame and the frame is the input. The pins are about the STREAM
 * only: WHO receives a reply is resolution's business, pinned in its own
 * conformance and unchanged by any of this.
 */
describe('an untagged reply is the agent’s own record', () => {
  /** The reply landed and was folded — polled, because the frame is fire-and
   *  -forget and its append resolves a microtask later. */
  const repliesOn = async (stream: string, want: number) => {
    for (let i = 0; i < 120; i++) {
      const seen = (await get(`/history?raw=true&stream=${stream}`)) as unknown as {
        events: { type: string; data: { text?: string; sourceId?: string } }[]
      }
      const replies = seen.events.filter((e) => e.type === 'reply')
      if (replies.length >= want) return replies
      await new Promise((r) => setTimeout(r, 25))
    }
    return []
  }

  test('it stays on the agent stream while the agent holds an in-progress task, and an explicit taskId is still honoured', async () => {
    const worker = await connect('worker-rec', 'worker')
    const created = (await post('/tasks', {
      title: 'held while replying',
      description: '',
      queue: 'worker-rec',
      actor: 'orchestrator-o',
    })) as unknown as { id: string }
    await patch(`/tasks/${created.id}/status`, { status: 'in-progress', actor: 'orchestrator-o' })

    // THE FIXTURE'S OWN PRECONDITION, asserted rather than assumed: without an
    // engaged task this test passes against the removed inference too, since
    // it was the HOLDING that used to capture the reply.
    const held = (await get(`/tasks/${created.id}`)) as unknown as { status: string }
    expect(held.status).toBe('in-progress')

    worker.ws.send(JSON.stringify({ type: 'reply', text: 'untagged while holding' }))
    worker.ws.send(JSON.stringify({ type: 'reply', taskId: created.id, text: 'tagged on purpose' }))

    expect((await repliesOn('agent-worker-rec', 1)).map((e) => e.data.text)).toEqual(['untagged while holding'])
    expect((await repliesOn(`task-${created.id}`, 1)).map((e) => e.data.text)).toEqual(['tagged on purpose'])
  })

  test('bridge inbound never task-files — a human’s message is not a claim on a task', async () => {
    server.attachSurface({ name: 'chat-human', role: 'user', deliver: () => true })
    const created = (await post('/tasks', {
      title: 'queued to the human',
      description: '',
      queue: 'chat-human',
      actor: 'orchestrator-o',
    })) as unknown as { id: string }
    await patch(`/tasks/${created.id}/status`, { status: 'in-progress', actor: 'orchestrator-o' })
    // Same precondition as the socket test, and for the same reason: with the
    // task not actually engaged, the deleted inference would land on the agent
    // stream too and this assertion would prove nothing.
    expect(((await get(`/tasks/${created.id}`)) as unknown as { status: string }).status).toBe('in-progress')

    await server.postInbound('chat-human', 'is anyone there', { sentAt: 1_700_000_000_000, sourceId: 'tg-7' })

    const onAgent = await repliesOn('agent-chat-human', 1)
    expect(onAgent[0]?.data).toMatchObject({ text: 'is anyone there', sourceId: 'tg-7' })
    const onTask = (await get(`/history?raw=true&stream=task-${created.id}`)) as unknown as {
      events: { type: string }[]
    }
    expect(onTask.events.some((e) => e.type === 'reply')).toBe(false)
  })
})
