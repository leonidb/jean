/**
 * The attention wiring — timers, outbound listeners, the delivery ledger and
 * the piggyback, over a real server (task E3).
 *
 * ── WHAT THIS FILE ASSERTS ──
 *
 * Transport, wiring and executor laws. WHEN an agent is due, how the ladder
 * spaces repeats, which agent gets probed — all of that is the notifier's and
 * the supervisor's, pinned in their own conformance suites and not restated
 * here. What is here is the shell's half: that a decision's effects reach a
 * socket, that a refusal records nothing, that carriage is reported from the
 * two places that carry, that the evidence a push produced survives into the
 * ack record, and that the tick can be stopped.
 *
 * ── THE CADENCES ARE INJECTED, TINY ──
 *
 * Real defaults are a two-minute quiet clock and a ten-minute ladder. Every
 * server below is handed its own bounds, which is what makes this a suite
 * rather than a wait.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { NotifierExecutor } from '../domain/contracts/notifier.ts'
import type { AckData, StoredEvent } from '../domain/contracts/vocabulary.ts'
import { createAttention } from './attention.ts'
import { type AdapterHandle, createAdapterServer } from './server.ts'

/** Everything a test opened, torn down after it — sockets closed AND awaited
 *  (a socket still closing when the server stops holds the hook to its
 *  timeout, which reads as a product bug and is not one). */
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
  // AWAITED: `stop` finishes the appends this server already accepted. Not
  // awaiting it removes the temp directory out from under a write that is
  // still landing, and the ENOENT surfaces as a failure in whichever test
  // runs next (measured).
  for (const server of openServers.splice(0)) await server.stop()
  for (const dir of openDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Bounds small enough that "the quiet clock has passed" is true immediately
 *  and a rung is a few milliseconds. */
const FAST = {
  notifier: { nudgeIntervalMs: 1, backoffMs: [1, 1] },
  supervisor: {
    senseiReminderMs: 1,
    humanReminderMs: 1,
    dailyReminderMs: 1,
    idlePingAfterMs: 10_000_000,
    probeTimeoutMs: 10_000_000,
    stuckAfterMs: 10_000_000,
  },
  notifyTickMs: 20,
  superviseTickMs: 20,
}

async function boot(overrides: Parameters<typeof createAdapterServer>[0] = {}): Promise<AdapterHandle> {
  const server = await createAdapterServer({ attention: FAST, ...overrides })
  openServers.push(server)
  return server
}

function connect(server: AdapterHandle, agent: string, role = 'worker') {
  const frames: Record<string, unknown>[] = []
  const ready = new Promise<void>((done, fail) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`)
    openSockets.push(ws)
    const timer = setTimeout(() => fail(new Error(`register timed out for ${agent}`)), 4_000)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'register', agent, role }))
    ws.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data)) as Record<string, unknown>
      if (frame.type === 'registered') {
        clearTimeout(timer)
        done()
        return
      }
      frames.push(frame)
    }
    ws.onerror = () => fail(new Error('socket error'))
  })
  return { frames, ready }
}

const post = (server: AdapterHandle, path: string, body: unknown, agent?: string) =>
  fetch(`http://localhost:${server.port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(agent !== undefined && { 'x-jean-agent': agent }) },
    body: JSON.stringify(body),
  })

/** Poll rather than sleep: the delivery is a socket round trip. */
async function until<T>(get: () => T | undefined, ms = 1500): Promise<T | undefined> {
  for (let i = 0; i < ms / 25; i++) {
    const value = get()
    if (value !== undefined) return value
    await new Promise((r) => setTimeout(r, 25))
  }
  return undefined
}

describe('the outbound leg — a decision reaches a socket', () => {
  test('mail for a connected agent is announced to its session', async () => {
    const server = await boot()
    const worker = connect(server, 'worker-a')
    await worker.ready
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'start on 42' })

    server.tick()
    const wake = await until(() => worker.frames.find((f) => f.type === 'deliver' && f.from === 'infra'))
    expect(wake).toBeDefined()
    // The count is the domain's; the sentence is the adapter's, and this is
    // the only place either is asserted end to end.
    expect(String(wake?.text)).toContain('1 event')
  })

  test('a REFUSED announcement records nothing at all', async () => {
    // A surface whose transport says no — the disconnected-session case with
    // none of a socket's timing. The ladder must retry rather than advance,
    // and until it lands there is nothing true to write down.
    const dir = mkdtempSync(resolve(tmpdir(), 'jean-e3-refused-'))
    openDirs.push(dir)
    const server = await boot({ dataDir: dir })
    const detach = server.attachSurface({ name: 'worker-mute', role: 'worker', deliver: () => false })

    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-mute', text: 'anyone there' })
    for (let i = 0; i < 5; i++) server.tick()
    await new Promise((r) => setTimeout(r, 50))

    const log = (await Bun.file(resolve(dir, 'history.jsonl')).text())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredEvent)
    // FIVE refused attempts, ZERO nudges. Emitting on refusal writes a record
    // claiming a telling that did not happen — and because a refused wake
    // does not advance the episode, the agent is due again every tick, so it
    // writes one per tick forever. E1 shipped that; the count is the pin.
    expect(log.filter((e) => e.type === 'nudge').length).toBe(0)
    // And the mail is still pending: nothing about a refusal clears anything.
    const still = (await (await fetch(`http://localhost:${server.port}/events?agent=worker-mute`)).json()) as {
      events: unknown[]
    }
    expect(still.events.length).toBe(1)
    detach()
  })

  test('the ladder keeps trying a refused agent — silence is the failure it exists to prevent', async () => {
    const server = await boot()
    let attempts = 0
    server.attachSurface({
      name: 'worker-flaky',
      role: 'worker',
      deliver: () => {
        attempts++
        return false
      },
    })
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-flaky', text: 'still here?' })
    const before = attempts
    server.tick()
    server.tick()
    expect(attempts).toBeGreaterThan(before) // not silenced by its own failures
  })
})

describe('carriage — the two places the agent sees its own inbox', () => {
  test('a fetch carries, and the piggyback rides every other response', async () => {
    const server = await boot()
    const worker = connect(server, 'worker-a')
    await worker.ready
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'one' })

    // The piggyback: a response to a registered agent holding mail carries
    // the line. Any response — this one is a board read.
    const board = await fetch(`http://localhost:${server.port}/board`, { headers: { 'x-jean-agent': 'worker-a' } })
    const line = board.headers.get('x-jean-inbox')
    expect(line).toBeTruthy()
    expect(line).toContain('1 queued')
    // ASCII ONLY — a non-ASCII byte in a header value throws inside the fetch
    // handler and fails the whole request. Measured: an em-dash in this line
    // took down every response to an agent with mail.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is the byte range
    expect(/^[\x20-\x7e]*$/.test(line ?? '')).toBe(true)
  })

  test('the line IS the agent being told — a shown interrupt does not fire again', async () => {
    // The measurement that made this test exist: deleting the carriage
    // report from the piggyback changed nothing in any other test here.
    //
    // What carriage actually buys is the INTERRUPT. Blocking mail — a human
    // is waiting — bypasses the quiet clock and the ladder both, but only
    // for mail the episode has not already told the agent about; otherwise a
    // blocking mailbox re-announces on every tick forever. The line showing
    // the agent its inbox is that telling. Without the report the two
    // mechanisms contradict each other: the ledger records a handover while
    // the episode still considers the events unannounced.
    const server = await boot({
      attention: { ...FAST, notifier: { nudgeIntervalMs: 60_000, backoffMs: [60_000] } },
    })
    // A refusing transport, so nothing discharges by landing.
    let attempts = 0
    server.attachSurface({
      name: 'worker-mute',
      role: 'worker',
      deliver: () => {
        attempts++
        return false
      },
    })
    server.attachSurface({ name: 'chat-human', role: 'user', deliver: () => true })

    // One own act, so the quiet clock has NOT passed — the only thing that
    // can make this agent due is the blocking interrupt. (An empty mailbox
    // carries nothing, so this read reports no carriage.)
    await fetch(`http://localhost:${server.port}/events?agent=worker-mute`)

    await post(server, '/send', { from: 'chat-human', to: 'worker-mute', text: 'are you there?' })
    server.tick()
    expect(attempts).toBeGreaterThan(1) // the interrupt really does re-fire while untold

    const shown = await fetch(`http://localhost:${server.port}/board`, { headers: { 'x-jean-agent': 'worker-mute' } })
    expect(shown.headers.get('x-jean-inbox')).toContain('1 blocking') // it really was shown

    const settled = attempts
    server.tick()
    server.tick()
    expect(attempts).toBe(settled) // told by the line; back on the clock, not on every tick
  })

  test('an agent with an empty mailbox gets no line, and a stranger never gets one', async () => {
    const server = await boot()
    const worker = connect(server, 'worker-a')
    await worker.ready

    const quiet = await fetch(`http://localhost:${server.port}/board`, { headers: { 'x-jean-agent': 'worker-a' } })
    expect(quiet.headers.get('x-jean-inbox')).toBeNull() // the empty case says nothing

    const stranger = await fetch(`http://localhost:${server.port}/board`, { headers: { 'x-jean-agent': 'nobody' } })
    expect(stranger.headers.get('x-jean-inbox')).toBeNull() // no mailbox, no line
  })
})

describe('the delivery ledger — evidence of what this process handed over', () => {
  test('a push marks the event, and the mark survives into the ack record', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'jean-e3-ledger-'))
    openDirs.push(dir)
    const server = await boot({ dataDir: dir })
    const worker = connect(server, 'worker-a')
    await worker.ready
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'read me' })

    server.tick()
    expect(await until(() => worker.frames.find((f) => f.type === 'deliver'))).toBeDefined()

    const fetched = (await (await fetch(`http://localhost:${server.port}/events?agent=worker-a`)).json()) as {
      events: { id: number; code: string }[]
    }
    const first = fetched.events[0]
    if (first === undefined) throw new Error('fixture: nothing to ack')
    await post(server, '/ack', { pairs: [{ id: first.id, code: first.code }] }, 'worker-a')

    const log = (await Bun.file(resolve(dir, 'history.jsonl')).text())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredEvent)
    const ack = log.filter((e) => e.type === 'ack').pop()
    const cleared = (ack?.data as AckData).cleared ?? []
    // FIRST WRITE WINS: the wake reached the agent before the fetch did, and
    // the record says so. Without the ledger this reads `undefined`, which
    // means "unknown" — true but weaker, and it is knowable.
    expect(cleared).toEqual([{ eventId: first.id, deliveredVia: 'wake' }])
  })

  test('an event nobody pushed is acked with no mark — absent means unknown, never “not delivered”', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'jean-e3-nomark-'))
    openDirs.push(dir)
    const server = await boot({ dataDir: dir })
    // A worker whose transport never accepts anything, and no tick — so no
    // push can land and the agent's own read is the first handover there is.
    server.attachSurface({ name: 'worker-a', role: 'worker', deliver: () => false })
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'unpushed' })
    const fetched = (await (await fetch(`http://localhost:${server.port}/events?agent=worker-a`)).json()) as {
      events: { id: number; code: string }[]
    }
    const first = fetched.events[0]
    if (first === undefined) throw new Error('fixture: nothing to ack')
    await post(server, '/ack', { pairs: [{ id: first.id, code: first.code }] }, 'worker-a')

    const log = (await Bun.file(resolve(dir, 'history.jsonl')).text())
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredEvent)
    const ack = log.filter((e) => e.type === 'ack').pop()
    // The FETCH is a handover this process performed, so it is marked —
    // `worker-a` has no session, and reading is still reaching.
    expect((ack?.data as AckData).cleared).toEqual([{ eventId: first.id, deliveredVia: 'fetch' }])
  })
})

describe('the timers', () => {
  test('start/stop is real — a stopped server stops announcing', async () => {
    const server = await boot({ startTimers: true })
    let delivered = 0
    server.attachSurface({
      name: 'worker-counter',
      role: 'worker',
      deliver: () => {
        delivered++
        return false // refused, so the ladder keeps trying and the count keeps rising
      },
    })
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-counter', text: 'tick me' })
    await until(() => (delivered > 1 ? true : undefined))
    expect(delivered).toBeGreaterThan(1)

    await server.stop()
    openServers.length = 0 // stopped by hand; do not stop it twice in teardown
    const settled = delivered
    await new Promise((r) => setTimeout(r, 120))
    expect(delivered).toBe(settled)
  })

  test('a shrinking ladder is refused at composition, not carried into a running dojo', async () => {
    // P8 says the ladder never shrinks. A shrinking one violates it silently
    // and forever; the last moment it can be caught is before the first tick.
    await expect(
      createAdapterServer({ attention: { ...FAST, notifier: { nudgeIntervalMs: 1, backoffMs: [500, 100] } } }),
    ).rejects.toThrow(/shrinking/)
  })
})

describe('supervision reaches the orchestrator', () => {
  test('a parked task reminds the seat, through the ordinary mail path', async () => {
    const server = await boot()
    const orchestrator = connect(server, 'orchestrator-o', 'sensei')
    await orchestrator.ready
    const worker = connect(server, 'worker-a')
    await worker.ready

    const created = (await (
      await post(server, '/tasks', { title: 'park me', queue: 'worker-a' }, 'orchestrator-o')
    ).json()) as { id: string }
    await fetch(`http://localhost:${server.port}/tasks/${created.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-jean-agent': 'orchestrator-o' },
      body: JSON.stringify({ status: 'in-progress' }),
    })
    await fetch(`http://localhost:${server.port}/tasks/${created.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-jean-agent': 'orchestrator-o' },
      body: JSON.stringify({ status: 'waiting', blockedOn: 'human' }),
    })

    // The reminder is an EVENT that resolves to the orchestrator — no direct
    // push, no second record. Which is why the assertion is on the mailbox
    // and not on the socket: the delivery half is the ordinary one.
    let reminder: { data: { taskId?: string } } | undefined
    for (let i = 0; i < 20 && reminder === undefined; i++) {
      server.tick()
      const box = (await (await fetch(`http://localhost:${server.port}/events?agent=orchestrator-o`)).json()) as {
        events: { type: string; data: { taskId?: string } }[]
      }
      reminder = box.events.find((e) => e.type === 'task-reminder')
      if (reminder === undefined) await new Promise((r) => setTimeout(r, 25))
    }
    expect(reminder).toBeDefined()
    expect(reminder?.data.taskId).toBe(created.id)
  })
})

describe('the bridge seam', () => {
  test('a surface joins as an agent, receives its mail, and speaks in its own voice', async () => {
    const server = await boot()
    // A seat has to exist for a reply to resolve to anyone: §4 addresses a
    // reply to the orchestrator, and a dojo with no orchestrator on record
    // resolves it to nobody. That is the table working, not a gap.
    const orchestrator = connect(server, 'orchestrator-o', 'sensei')
    await orchestrator.ready
    const heard: unknown[] = []
    const detach = server.attachSurface({
      name: 'chat-human',
      role: 'user',
      deliver: (payload) => {
        heard.push(payload)
        return true
      },
    })

    // OUTBOUND: a `user` is not a mailbox-holder, so routing hands it to the
    // adapter synchronously — the same decision a peer or a bridge gets.
    const sent = (await (
      await post(server, '/send', { from: 'orchestrator-o', to: 'chat-human', text: 'hello out there' })
    ).json()) as { delivered?: boolean }
    expect(sent.delivered).toBe(true)
    expect(heard).toEqual([{ type: 'deliver', from: 'orchestrator-o', text: 'hello out there' }])

    // INBOUND: the same path a WS `reply` frame takes. A bridge does not get
    // a private one.
    await server.postInbound('chat-human', 'hello back', { sentAt: 1_700_000_000_000, sourceId: 'slack-42' })
    const orchestratorBox = (await (
      await fetch(`http://localhost:${server.port}/events?agent=orchestrator-o`)
    ).json()) as { events: { type: string; data: { agent?: string; text?: string; sourceId?: string } }[] }
    const reply = orchestratorBox.events.find((e) => e.type === 'reply')
    expect(reply?.data).toMatchObject({ agent: 'chat-human', text: 'hello back', sourceId: 'slack-42' })

    detach()
    const after = (await (
      await post(server, '/send', { from: 'orchestrator-o', to: 'chat-human', text: 'still there?' })
    ).json()) as { delivered?: boolean }
    // Detached, the surface is a name the dojo remembers and cannot reach.
    expect(after.delivered).toBe(false)
  })
})

describe('the re-entrancy guard', () => {
  test('a run cannot re-enter itself — termination is structural, not a coincidence of async', async () => {
    // `decide` deliberately does not suppress on an in-flight announcement
    // (ruled: silence is the worse failure), and a run's own `emit` appends
    // an event, and every append feeds the arrival hook, which runs the
    // notifier. Today the append is asynchronous so the outcome lands first
    // — but that is a property of the STORE, and this loop must not depend
    // on it. Here `emit` re-enters synchronously, which is what a synchronous
    // backend would do.
    let delivers = 0
    let emits = 0
    let attention: ReturnType<typeof createAttention> | undefined
    const executor: NotifierExecutor = {
      deliver: () => {
        delivers++
        return true
      },
      stamp: () => {},
      emit: () => {
        emits++
        attention?.runNotifier() // the recursion, made synchronous
      },
    }
    attention = createAttention({
      now: () => 1_000_000,
      log: () => {},
      notifyView: () => ({
        now: 1_000_000,
        agents: [{ name: 'worker-a', pendingIds: [1], hasBlocking: true }],
      }),
      supervisionView: () => ({ now: 1_000_000, orchestrator: 'orchestrator-o', tasks: [], agents: [] }),
      notifierExecutor: executor,
      supervisionExecutor: { emit: () => {} },
      config: { ...FAST, notifier: { nudgeIntervalMs: 1, backoffMs: [1] } },
    })

    attention.runNotifier()
    // Once each. Without the guard this is a stack overflow, and the mailbox
    // it is announcing never empties, so nothing else would stop it.
    expect(delivers).toBe(1)
    expect(emits).toBe(1)
  })
})

describe('the unconsolidated slice', () => {
  test('/context/recent returns what the librarian has not folded in yet', async () => {
    const server = await boot()
    await post(server, '/context/memorize', { agent: 'worker-a', role: 'worker', text: 'the relay rotates keys' })
    const recent = (await (await fetch(`http://localhost:${server.port}/context/recent`)).json()) as {
      cursor: { lastEventId: number }
      events: { id: number; text: string }[]
    }
    expect(recent.cursor.lastEventId).toBe(0) // no consolidator has ever run here
    expect(recent.events.map((e) => e.text)).toEqual(['the relay rotates keys'])

    // `?limit=` takes the NEW end — the interesting end of an unconsolidated
    // slice is the recent one.
    await post(server, '/context/memorize', { agent: 'worker-a', role: 'worker', text: 'and the token is short-lived' })
    const limited = (await (await fetch(`http://localhost:${server.port}/context/recent?limit=1`)).json()) as {
      events: { text: string }[]
    }
    expect(limited.events.map((e) => e.text)).toEqual(['and the token is short-lived'])

    const bad = await fetch(`http://localhost:${server.port}/context/recent?limit=lots`)
    expect(bad.status).toBe(400)
  })
})
