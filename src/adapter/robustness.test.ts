/**
 * The cases codex listed and E1 could not reach, closed at E3 (task 104).
 *
 * Four of them, and they have one thing in common: each is a path where the
 * adapter is asked to do something it cannot, and the question is whether it
 * says so or quietly pretends. An append that fails must not leave the
 * mailbox looking cleared. A frame that is not JSON must not take the socket
 * down. A second session under one name must be answered, whichever answer
 * the contract gives. A malformed ack pair must cost the well-formed ones
 * nothing.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { type AdapterHandle, createAdapterServer } from './server.ts'

const openServers: AdapterHandle[] = []
const openSockets: WebSocket[] = []
const openDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    openSockets.splice(0).map(
      (ws) =>
        new Promise<void>((done) => {
          if (ws.readyState === WebSocket.CLOSED) return done()
          ws.onclose = () => done()
          ws.close()
        }),
    ),
  )
  for (const server of openServers.splice(0)) await server.stop()
  for (const dir of openDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function boot(options: Parameters<typeof createAdapterServer>[0] = {}): Promise<AdapterHandle> {
  const server = await createAdapterServer(options)
  openServers.push(server)
  return server
}

const post = (server: AdapterHandle, path: string, body: unknown, agent?: string) =>
  fetch(`http://localhost:${server.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(agent !== undefined && { 'x-jean-agent': agent }) },
    body: JSON.stringify(body),
  })

const mailboxOf = async (server: AdapterHandle, agent: string) =>
  (await (await fetch(`http://localhost:${server.port}/events?agent=${agent}`)).json()) as {
    events: { id: number; code: string }[]
  }

/** Register over the socket, resolving on the server's own answer — which is
 *  `registered` or `refused`, and this file needs both. */
function register(server: AdapterHandle, frame: Record<string, unknown>) {
  return new Promise<{ ws: WebSocket; answer: Record<string, unknown> }>((done, fail) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`)
    openSockets.push(ws)
    const timer = setTimeout(() => fail(new Error('no answer to register')), 4_000)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'register', ...frame }))
    ws.onmessage = (ev) => {
      const answer = JSON.parse(String(ev.data)) as Record<string, unknown>
      if (answer.type !== 'registered' && answer.type !== 'refused') return
      clearTimeout(timer)
      done({ ws, answer })
    }
    ws.onerror = () => fail(new Error('socket error'))
  })
}

describe('an append that fails', () => {
  test('the ack says so, and NOTHING clears', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'jean-e3-append-'))
    openDirs.push(dir)
    const server = await boot({ dataDir: dir })
    server.attachSurface({ name: 'worker-a', role: 'worker', deliver: () => false })
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'one' })

    const before = await mailboxOf(server, 'worker-a')
    const pair = before.events[0]
    if (pair === undefined) throw new Error('fixture: nothing to ack')

    // The log becomes unwritable under the running server. Contrived, and
    // the shape is not: a full disk, a revoked permission, a filesystem gone
    // read-only are all this.
    chmodSync(resolve(dir, 'history.jsonl'), 0o444)
    const res = await post(server, '/ack', { pairs: [{ id: pair.id, code: pair.code }] }, 'worker-a')

    // THE APPEND IS WHAT CLEARS. `applyAck` decided, the append failed, and
    // because the decision's `next` is discarded — the fold applies the same
    // clearing from the record — the live mailbox never moved. A shell that
    // assigned `decision.next` first would be sitting here with mail cleared
    // and no event behind it: state ahead of its own log.
    expect(res.status).toBe(503)
    const after = await mailboxOf(server, 'worker-a')
    expect(after.events.map((e) => e.id)).toEqual(before.events.map((e) => e.id))

    chmodSync(resolve(dir, 'history.jsonl'), 0o644)
  })
})

describe('a frame that is not a message', () => {
  test('invalid JSON is dropped and the session keeps working', async () => {
    const server = await boot()
    const { ws } = await register(server, { agent: 'worker-a', role: 'worker' })

    // No `type` to refuse under, and closing the socket would punish a live
    // agent for one bad line — so it is dropped. What matters is what
    // happens NEXT.
    ws.send('{not json at all')
    ws.send(JSON.stringify({ type: 'task-comment', taskId: 'nope', text: 'x' }))
    await new Promise((r) => setTimeout(r, 60))
    expect(ws.readyState).toBe(WebSocket.OPEN)

    // And the session is still the registered one: a dropped frame must not
    // cost the seat.
    const agents = (await (await fetch(`http://localhost:${server.port}/agents`)).json()) as {
      agents: { name: string }[]
    }
    expect(agents.agents.map((a) => a.name)).toContain('worker-a')
  })
})

describe('two sessions under one name', () => {
  test('a rival process is REFUSED and the incumbent keeps the seat', async () => {
    const server = await boot()
    const first = await register(server, { agent: 'worker-a', role: 'worker', sessionId: 'S1' })
    expect(first.answer.type).toBe('registered')

    const rival = await register(server, { agent: 'worker-a', role: 'worker', sessionId: 'S2' })
    expect(rival.answer).toMatchObject({ type: 'refused', reason: 'refuse-duplicate' })
    expect(first.ws.readyState).toBe(WebSocket.OPEN) // the incumbent is untouched
  })

  test('the SAME session reconnecting REPLACES, and the seat follows the new socket', async () => {
    const server = await boot()
    const first = await register(server, { agent: 'worker-a', role: 'worker', sessionId: 'S1' })
    expect(first.answer.type).toBe('registered')

    const again = await register(server, { agent: 'worker-a', role: 'worker', sessionId: 'S1' })
    expect(again.answer.type).toBe('registered')

    // THE OLD SOCKET IS HUNG UP ON, not merely forgotten. Left open it is
    // unreachable, and its eventual close would have deleted the map entry
    // belonging to the socket that replaced it — the new session would go
    // quiet with nothing anywhere failing.
    await new Promise((r) => setTimeout(r, 80))
    expect(first.ws.readyState).toBe(WebSocket.CLOSED)

    // And the survivor still holds the seat afterwards.
    const agents = (await (await fetch(`http://localhost:${server.port}/agents`)).json()) as {
      agents: { name: string }[]
    }
    expect(agents.agents.filter((a) => a.name === 'worker-a').length).toBe(1)
  })
})

describe('malformed ack pairs', () => {
  test('a bad pair costs the good ones nothing — fail-soft, per pair', async () => {
    const server = await boot()
    server.attachSurface({ name: 'worker-a', role: 'worker', deliver: () => false })
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'one' })
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'two' })

    const box = await mailboxOf(server, 'worker-a')
    expect(box.events.length).toBe(2)
    const [first, second] = box.events
    if (first === undefined || second === undefined) throw new Error('fixture')

    const res = await post(
      server,
      '/ack',
      {
        pairs: [
          { id: 'not-a-number', code: first.code }, // wrong type — dropped at the door
          { id: second.id }, // no code at all — dropped at the door
          { id: first.id, code: 'wrong-code' }, // well-formed, wrong: the mailbox's call
          { id: first.id, code: first.code }, // the one that should clear
        ],
      },
      'worker-a',
    )
    expect(res.status).toBe(200)
    expect((await res.json()) as { acknowledged: number }).toMatchObject({ acknowledged: 1 })

    const after = await mailboxOf(server, 'worker-a')
    expect(after.events.map((e) => e.id)).toEqual([second.id])
  })

  test('pairs that is not an array is the adapter’s own 400', async () => {
    const server = await boot()
    const res = await post(server, '/ack', { pairs: 'all of them' }, 'worker-a')
    expect(res.status).toBe(400)
  })
})

describe('a surface joins through the same door as a socket', () => {
  test('a reserved name is refused, loudly and at attach time', () => {
    // The first version wrote straight into the session map, so a surface
    // could take a name the system itself writes as an author (codex pass).
    // A bridge that cannot join must fail while someone is watching it start.
    return createAdapterServer().then(async (server) => {
      openServers.push(server)
      expect(() => server.attachSurface({ name: 'infra', role: 'user', deliver: () => true })).toThrow(
        /refuse-reserved/,
      )
    })
  })

  test('a second orchestrator is refused while one is connected', async () => {
    const server = await boot()
    await register(server, { agent: 'orchestrator-o', role: 'sensei' })
    expect(() => server.attachSurface({ name: 'orchestrator-two', role: 'sensei', deliver: () => true })).toThrow(
      /refuse-second-orchestrator/,
    )
  })

  test('the SAME bridge reconnecting replaces; a SECOND one claiming the name is refused', async () => {
    const server = await boot()
    const firstHeard: unknown[] = []
    const secondHeard: unknown[] = []
    server.attachSurface({
      name: 'chat-human',
      role: 'user',
      sessionId: 'bridge-1',
      deliver: (p) => {
        firstHeard.push(p)
        return true
      },
    })

    // A DIFFERENT process under the same name is a rival, exactly as it is
    // over a socket — one rule for both doors.
    expect(() =>
      server.attachSurface({ name: 'chat-human', role: 'user', sessionId: 'bridge-2', deliver: () => true }),
    ).toThrow(/refuse-duplicate/)

    // The same one reconnecting is a replacement.
    server.attachSurface({
      name: 'chat-human',
      role: 'user',
      sessionId: 'bridge-1',
      deliver: (p) => {
        secondHeard.push(p)
        return true
      },
    })
    await post(server, '/send', { from: 'orchestrator-o', to: 'chat-human', text: 'which one of you' })
    expect(firstHeard).toEqual([])
    expect(secondHeard.length).toBe(1)
  })
})

/**
 * ── THE PREMISE IS ASSERTED, NOT ASSUMED (task 134) ──
 *
 * This walk holds R13's loud-failure property at the adapter: an emission
 * that cannot be appended is SAID, not swallowed. For eleven days it held it
 * about half the time, and the other half it asserted the property against a
 * setup that had never produced an emission to lose.
 *
 * The chain it depends on is: tick → decide → announce → `emit` → append →
 * append fails → the catch says so. It asserted the last link and assumed the
 * first, and the first is the one that broke. Two races, both fixed here and
 * both worth naming because they are different mistakes:
 *
 * RACE ONE, the cause of ~45% (measured 18/20 on one run of twenty). The
 * `/send` has ALREADY announced by the time its POST returns — the arrival
 * hook runs the notifier on every live append, which is the design and not an
 * accident. So the episode is discharged and the next repeat is due a rung
 * later; the rung here is 1ms, and `Date.now()` cannot see inside a
 * millisecond. A `chmod` and a `tick()` on the next two lines land in the
 * SAME millisecond as that discharge, `decide` correctly withholds, and there
 * is no emission, no append, no rejection and nothing to log. The poll then
 * spends its whole budget waiting for an event that was never coming.
 *
 * RACE TWO, quieter, ~1 in 20. The arrival hook's own `nudge` append is
 * fire-and-forget (`void record(...)`), so it can still be in flight when the
 * `chmod` lands, and which side of the permission change it falls on is
 * undetermined. Not the cause of the failures above — every one of those
 * decided nothing at all — but a walk that raced its own fixture would have
 * kept flaking after the first race was fixed, inside a test everyone had
 * been told was repaired.
 *
 * AND THE BUDGET IS NOT THE FIX, which is the part worth carrying away. It
 * was raised twice, because the visible symptom was a poll
 * running out — and a poll that runs out points at the poll. Swept across a
 * 10x range on the code as it stands, the failure rate does not move: 1s
 * 10/20, 3s 11/20, 10s 7/20. A 2ms advance with the budget untouched gives
 * 0/20. Do not raise it a third time.
 */
describe('an emission that cannot be appended', () => {
  test('is said out loud rather than lost in silence', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'jean-e3-emit-'))
    openDirs.push(dir)
    const lines: string[] = []
    // COUNTED, because it is the only observation that distinguishes "the
    // property is broken" from "the setup produced nothing" — and without it
    // those two produce an identical red, on a walk whose whole subject is a
    // failure that must not be silent.
    let announced = 0
    const server = await createAdapterServer({
      dataDir: dir,
      attention: { notifier: { nudgeIntervalMs: 1, backoffMs: [1] }, notifyTickMs: 20, superviseTickMs: 20 },
      ports: { log: (line) => lines.push(line) },
    })
    openServers.push(server)
    server.attachSurface({
      name: 'worker-a',
      role: 'worker',
      deliver: () => {
        announced++
        return true
      },
    })
    const log = resolve(dir, 'history.jsonl')
    const lineCount = async () => (await Bun.file(log).text()).split('\n').filter(Boolean).length

    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'hello' })

    // RACE TWO CLOSED: wait for the announcement the POST already triggered to
    // be fully written, so the `chmod` cannot land mid-append. Polled on the
    // log's own length rather than slept for — the append is asynchronous and
    // a fixed wait is the race in a different costume.
    const settled = await lineCount()
    for (let i = 0; i < 120 && (await lineCount()) === settled; i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    const before = announced

    chmodSync(log, 0o444)

    // RACE ONE CLOSED: past the 1ms rung, so the tick below has something to
    // decide. Slept for deliberately, and it is the one shape of sleep this
    // repo trusts — the property is "the rung has elapsed", and load can only
    // ever make it MORE true.
    await new Promise((r) => setTimeout(r, 2))
    server.tick()

    // THE PREMISE, ASSERTED. If this fails the walk below proves nothing, and
    // it should say which of the two it is rather than making a reader guess.
    expect(announced, 'no announcement was decided — the premise failed, not the property').toBeGreaterThan(before)

    // POLLED, not slept for: the append is asynchronous and its rejection
    // lands a microtask later. Three seconds is generous rather than
    // marginal — and, per the header, generosity was never what this walk
    // was short of.
    for (let i = 0; i < 120 && !lines.join('').includes('LOST EMISSION'); i++) {
      await new Promise((r) => setTimeout(r, 25))
    }
    chmodSync(log, 0o644)

    // Both units advance their state as they DECIDE, so an append that fails
    // here is an emission the unit believes it made. The notifier can be told
    // otherwise through its outcome channel; the supervisor has none, so a
    // lost reminder is simply lost. Nothing in the adapter can fix that — but
    // it can refuse to lose it quietly.
    expect(lines.join('')).toContain('LOST EMISSION')
  })
})
