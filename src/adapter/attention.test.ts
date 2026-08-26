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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`)
  const ready = new Promise<void>((done, fail) => {
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
  return { frames, ready, ws }
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

/**
 * THE HONEST-EVIDENCE HIERARCHY for a disconnected holder (ruled, task 115).
 *
 * Membership in the disconnected view is a BOARD fact — the agent holds
 * stalling work — and the floor under it is the best evidence available:
 * an observed act first, the newest readable claim next, and with neither the
 * row is skipped. Driven through boot replay because the case that matters
 * needs a claim whose `updatedAt` no clock produced, and this server's own
 * writer never makes one; a permanent log written by somebody else can.
 */
describe('a disconnected holder whose claim cannot be dated', () => {
  const seed = (dir: string, lines: unknown[]) =>
    writeFileSync(resolve(dir, 'history.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`)

  /** Who the server currently holds a session for. */
  async function liveNames(server: AdapterHandle): Promise<string[]> {
    const body = (await (await fetch(`http://localhost:${server.port}/agents`)).json()) as {
      agents: { name: string }[]
    }
    return body.agents.map((a) => a.name)
  }

  /** The composer's observed floor, as `/agents` reports it. */
  async function activityOf(server: AdapterHandle, name: string): Promise<number | undefined> {
    const body = (await (await fetch(`http://localhost:${server.port}/agents`)).json()) as {
      agents: { name: string; lastActivityAt?: number }[]
    }
    return body.agents.find((a) => a.name === name)?.lastActivityAt
  }

  /** Poll until the answer is there, or give up loudly rather than silently. */
  async function until<T>(what: string, read: () => Promise<T | undefined | false>): Promise<T> {
    let attemptsLeft = 120
    while (attemptsLeft-- > 0) {
      const got = await read()
      if (got !== undefined && got !== false) return got as T
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error(`waited 3s for ${what} and it never happened`)
  }
  test('is supervised on its OBSERVED activity, and skipped only when there is no evidence at all', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'jean-115-floor-'))
    openDirs.push(dir)
    const good = new Date(1_700_000_000_000).toISOString()
    // Two holders, one difference between them: one will act in this process
    // and the other never will. Both hold an assigned claim the board cannot
    // date, so neither has a floor from the board.
    seed(dir, [
      {
        id: 1,
        ts: good,
        type: 'register',
        stream: 'agent-orchestrator-o',
        data: { agent: 'orchestrator-o', role: 'sensei', idle: false },
      },
      {
        id: 2,
        ts: good,
        type: 'task-created',
        stream: 'task-900',
        data: { title: 'undatable', description: '', queue: 'worker-seen', actor: 'orchestrator-o' },
      },
      {
        id: 3,
        ts: 'no clock wrote this',
        type: 'task-status',
        stream: 'task-900',
        data: { from: 'todo', to: 'assigned', actor: 'orchestrator-o' },
      },
      // REGISTERED, deliberately: an unknown name is dropped at the role guard
      // before membership or the floor is ever consulted, which would make the
      // negative assertion below prove nothing about this rule.
      {
        id: 4,
        ts: good,
        type: 'register',
        stream: 'agent-worker-unseen',
        data: { agent: 'worker-unseen', role: 'worker', idle: false },
      },
      {
        id: 5,
        ts: good,
        type: 'task-created',
        stream: 'task-901',
        data: { title: 'undatable too', description: '', queue: 'worker-unseen', actor: 'orchestrator-o' },
      },
      {
        id: 6,
        ts: 'nor this',
        type: 'task-status',
        stream: 'task-901',
        data: { from: 'todo', to: 'assigned', actor: 'orchestrator-o' },
      },
    ])

    let clock = 2_000_000_000_000
    const server = await boot({
      dataDir: dir,
      ports: { now: () => clock },
      attention: { ...FAST, supervisor: { ...FAST.supervisor, stuckAfterMs: 1_000 } },
    })

    // THE ONE DIFFERENCE: worker-seen acts, and its act is what the composer
    // remembers. `register` deliberately is not an act (R15), so the reply is.
    const seen = connect(server, 'worker-seen')
    await seen.ready
    seen.ws.send(JSON.stringify({ type: 'reply', text: 'here, briefly' }))
    // WAIT ON THE FACT, not on a duration: the act is only observed once its
    // append has landed, and a fixed sleep here is a flake on a loaded machine.
    await until(
      'worker-seen’s reply to be observed as activity',
      async () => (await activityOf(server, 'worker-seen')) !== undefined,
    )
    await new Promise<void>((done) => {
      seen.ws.onclose = () => done()
      seen.ws.close()
    })
    // THE CLIENT'S CLOSE IS NOT THE SERVER'S. Waiting on the client event and
    // ticking immediately supervised a session the server still had open —
    // and one tick is all this test gets, so the report never came. Wait for
    // the fact the assertion depends on: the session is gone from the roster.
    await until(
      'the server to let go of the session',
      async () => (await liveNames(server)).includes('worker-seen') === false,
    )

    clock += 60 * 60_000 // an hour of silence, well past the bound

    const downs = await until('a down report to be emitted', async () => {
      server.tick()
      const seenEvents = (await (await fetch(`http://localhost:${server.port}/history?raw=true`)).json()) as {
        events: { type: string; data: { subject?: string } }[]
      }
      const reported = seenEvents.events.filter((e) => e.type === 'agent-down').map((e) => e.data.subject ?? '')
      return reported.length > 0 ? reported : undefined
    })

    // IN the view on observed evidence — the board could not date its claim,
    // and the composer did not need it to.
    expect(downs).toContain('worker-seen')
    // NOT in it with no evidence from either source: the corrupt-log corner,
    // and the only place silence is the safe answer.
    expect(downs).not.toContain('worker-unseen')
  })
})

/**
 * The sleep detector (task 121) — the tell `/status` structurally cannot be.
 *
 * A sleeping laptop skips its timers rather than stopping them, so every poll
 * counter reads "seconds ago" while the machine has been off for most of an
 * hour. On the night this was written, a remote service was diagnosed as
 * failing on exactly that evidence.
 */
describe('a tick that lands late says so', () => {
  const attentionAt = (clock: () => number, lines: string[]) =>
    createAttention({
      now: clock,
      log: (line) => lines.push(line),
      notifyView: (now) => ({ now, agents: [] }),
      supervisionView: (now) => ({ now, orchestrator: 'orchestrator-o', tasks: [], agents: [] }),
      notifierExecutor: { deliver: () => true, stamp: () => {}, emit: () => {} },
      supervisionExecutor: { emit: () => {} },
      config: FAST,
    })

  test('a gap larger than two intervals is reported once, in seconds, with the reason', () => {
    const lines: string[] = []
    let now = 1_000_000
    const attention = attentionAt(() => now, lines)

    attention.runSupervisor() // the first tick has nothing to compare against
    expect(lines).toEqual([])

    now += FAST.superviseTickMs // on time
    attention.runSupervisor()
    expect(lines).toEqual([])

    now += 45 * 60_000 // the machine slept
    attention.runSupervisor()
    expect(lines.join('')).toContain('clock jumped 2700s')
    expect(lines.join('')).toContain('machine likely slept')

    // ONCE, not once per tick afterwards. A detector that keeps firing about a
    // sleep that already ended is noise in the file someone reads to find the
    // one line that mattered.
    const after = lines.length
    now += FAST.superviseTickMs
    attention.runSupervisor()
    expect(lines.length).toBe(after)
  })

  test('an ordinary late tick is NOT a sleep — the bound is two intervals, not any lateness', () => {
    const lines: string[] = []
    let now = 1_000_000
    const attention = attentionAt(() => now, lines)
    attention.runSupervisor()
    // Late, but within what a loaded machine does to a timer. Reporting this
    // would make the line meaningless exactly when it is needed.
    now += FAST.superviseTickMs * 2
    attention.runSupervisor()
    expect(lines).toEqual([])
  })
})

describe('a restart starts a fresh quiet clock (ruled, task 140)', () => {
  /** Close and WAIT: the register that follows must see the seat vacated,
   *  or it is a duplicate, not a new session. */
  const closed = (ws: WebSocket) =>
    new Promise<void>((done) => {
      ws.onclose = () => done()
      ws.close()
    })
  type Row = { name: string; connected: boolean; pending: number; lastActivityAt?: number }
  const rowOf = async (server: AdapterHandle, name: string): Promise<Row | undefined> => {
    const body = (await (await fetch(`http://localhost:${server.port}/agents`)).json()) as { agents: Row[] }
    return body.agents.find((a) => a.name === name)
  }
  /** `until` over an async read — `/agents` is a round trip, not a lookup. */
  async function poll<T>(get: () => Promise<T | undefined>, ms = 1500): Promise<T | undefined> {
    for (let i = 0; i < ms / 25; i++) {
      const value = await get()
      if (value !== undefined) return value
      await new Promise((r) => setTimeout(r, 25))
    }
    return undefined
  }

  test('a seat that acted, vanished and re-registered INSIDE the quiet interval is announced at once — not on its predecessor’s clock', async () => {
    // THE QUIET CLOCK IS LONG, deliberately. The inherited clock must never
    // come due inside this test, so the only way the second session hears
    // anything is the drop on register. Pre-fix this walk goes red at the
    // final `until`: the live defect (2026-08-25) was a sensei
    // that reconnected 31s after its predecessor's last act and heard
    // nothing for 89s — neither greeted (mail waiting, task 133's rule) nor
    // announced (clock inherited).
    //
    // AND THE TICK TIMER IS OFF. Every announcement below can only come from
    // an arrival hook, so the final one is made by the register's OWN
    // observe — which pins the order in the register handler: the drop must
    // land BEFORE the record, or that decision reads the inherited clock and
    // a build with the order wrong passes only because a timer came by.
    const server = await boot({
      attention: {
        ...FAST,
        notifier: { nudgeIntervalMs: 600_000, backoffMs: [600_000] },
        notifyTickMs: 10_000_000,
      },
    })
    const first = connect(server, 'sensei-s', 'sensei')
    await first.ready
    // The greet is minted and announced at once — never acted reads absent.
    expect(await until(() => first.frames.find((f) => f.type === 'deliver' && f.from === 'infra'))).toBeDefined()

    // THE SEAT ACTS, in its own voice, so its clock is now real and recent.
    first.ws.send(JSON.stringify({ type: 'reply', text: 'on it' }))
    expect(await poll(() => rowOf(server, 'sensei-s').then((r) => r?.lastActivityAt))).toBeDefined()

    // …and vanishes. The seat outlives the socket; so does its mailbox.
    // (`/agents` lists sessions and holders, so a vanished seat holding no
    // task is simply not a row.)
    await closed(first.ws)
    expect(
      await poll(() => rowOf(server, 'sensei-s').then((r) => (r === undefined || !r.connected ? true : undefined))),
    ).toBe(true)

    // MACHINE MAIL arrives while it is away — a worker's reply resolves to
    // the seat, and nothing about it interrupts. (Human mail would announce
    // at once regardless and prove nothing.)
    const worker = connect(server, 'worker-w')
    await worker.ready
    worker.ws.send(JSON.stringify({ type: 'reply', text: 'half done' }))
    const landed = await poll(async () => {
      const res = (await (await fetch(`http://localhost:${server.port}/history?stream=agent-worker-w`)).json()) as {
        events: StoredEvent[]
      }
      return res.events.some((e) => e.type === 'reply') ? true : undefined
    })
    expect(landed).toBe(true)

    // A NEW SESSION registers, well inside the quiet interval of the act.
    const second = connect(server, 'sensei-s', 'sensei')
    await second.ready
    const row = await rowOf(server, 'sensei-s')
    // R8 for a returning seat: the row reads quiet until THIS session acts…
    expect(row?.lastActivityAt).toBeUndefined()
    // …with its mail still held: the greet, the worker's register (its
    // fleet's arrival is its mail, task 139) and the reply — and NOT its own
    // disconnect, which since 139 is not.
    expect(row?.pending ?? 0).toBe(3)
    // …and it is TOLD AT ONCE. This is the assertion the fix exists for.
    const wake = await until(() => second.frames.find((f) => f.type === 'deliver' && f.from === 'infra'))
    expect(wake).toBeDefined()
    expect(String(wake?.text)).toContain(`${row?.pending} event`)

    // The 133 invariant held: mail was waiting, so no second greet was
    // minted — the announcement was the seat's only way to a turn.
    const log = (await (await fetch(`http://localhost:${server.port}/history?stream=agent-sensei-s`)).json()) as {
      events: StoredEvent[]
    }
    expect(log.events.filter((e) => e.type === 'greet').length).toBe(1)
  })

  test('…and through the surface door: a re-attached surface is told by its own register (codex, task 140)', async () => {
    // THE SECOND DOOR. `attachSurface` has its own register code, so the walk
    // above pins nothing about it — this one does: same shape, no socket,
    // and the same two bounds (long quiet clock, timer off) so the only
    // thing that can announce is the register's own arrival hook.
    const server = await boot({
      attention: {
        ...FAST,
        notifier: { nudgeIntervalMs: 600_000, backoffMs: [600_000] },
        notifyTickMs: 10_000_000,
      },
    })
    const delivered: Record<string, unknown>[] = []
    const attach = () =>
      server.attachSurface({
        name: 'bridge-b',
        role: 'worker',
        deliver: (payload) => {
          delivered.push(payload as Record<string, unknown>)
          return true
        },
      })
    const detach = attach()

    // THE SURFACE ACTS — an inbound message is its own voice.
    await server.postInbound('bridge-b', 'hello')
    expect((await rowOf(server, 'bridge-b'))?.lastActivityAt).toBeDefined()

    // …and leaves. Machine mail arrives while it is away; nothing reaches a
    // detached surface, and the inherited clock is not due for ten minutes.
    detach()
    await post(server, '/send', { from: 'orchestrator-o', to: 'bridge-b', text: 'while away' })
    expect(delivered.filter((p) => p.type === 'deliver').length).toBe(0)

    // RE-ATTACH: told at once, by the register's own observe.
    attach()
    const wake = await until(() => delivered.find((p) => p.type === 'deliver' && p.from === 'infra'))
    expect(wake).toBeDefined()
    expect(String(wake?.text)).toContain('event')
    // R8 for the returning surface: no act on file until THIS session acts.
    expect((await rowOf(server, 'bridge-b'))?.lastActivityAt).toBeUndefined()
  })
})

describe('an agent joining is mail, as its leaving is — over a real socket (task 139)', () => {
  type Box = { events: { id: number; code: string; type: string; data: Record<string, unknown> }[] }
  const boxOf = async (server: AdapterHandle, agent: string): Promise<Box['events']> =>
    ((await (await fetch(`http://localhost:${server.port}/events?agent=${agent}`)).json()) as Box).events
  const ackAll = async (server: AdapterHandle, agent: string) => {
    const pairs = (await boxOf(server, agent)).map((e) => ({ id: e.id, code: e.code }))
    await post(server, '/ack', { pairs }, agent)
  }
  const registerWith = (server: AdapterHandle, frame: Record<string, unknown>) =>
    new Promise<WebSocket>((done, fail) => {
      const ws = new WebSocket(`ws://localhost:${server.port}/ws`)
      openSockets.push(ws)
      const timer = setTimeout(() => fail(new Error('no answer to register')), 4_000)
      ws.onopen = () => ws.send(JSON.stringify({ type: 'register', ...frame }))
      ws.onmessage = (ev) => {
        const answer = JSON.parse(String(ev.data)) as Record<string, unknown>
        if (answer.type !== 'registered') return
        clearTimeout(timer)
        done(ws)
      }
      ws.onerror = () => fail(new Error('socket error'))
    })

  test('a worker’s register lands in the seat’s mailbox flagged and is announced; the seat’s own is not; a same-session reconnect (replace) adds nothing', async () => {
    const server = await boot()
    const sensei = connect(server, 'sensei-s', 'sensei')
    await sensei.ready
    // THE SEAT'S OWN REGISTER IS NOT ITS MAIL: the resting mailbox is the
    // greet alone (133) — which is only possible because the row excludes
    // its subject; the record itself IS flagged (admitted at this door).
    expect(await until(() => sensei.frames.find((f) => f.type === 'deliver' && f.from === 'infra'))).toBeDefined()
    expect((await boxOf(server, 'sensei-s')).map((e) => e.type)).toEqual(['greet'])
    const own = (await (await fetch(`http://localhost:${server.port}/history?stream=agent-sensei-s`)).json()) as {
      events: StoredEvent[]
    }
    const ownRegister = own.events.find((e) => e.type === 'register')
    expect((ownRegister?.data as { queued?: unknown })?.queued).toBe(true)
    await ackAll(server, 'sensei-s')
    sensei.frames.length = 0

    // A WORKER ARRIVES. Its register is the seat's mail — flagged, addressed
    // by seat, naming the arrival — and the ladder announces it. The wake is
    // awaited BEFORE the mailbox is read: a fetch carries, so reading first
    // would be the seat being told and the push need never come.
    const worker = await registerWith(server, { agent: 'worker-w', role: 'worker', sessionId: 'S1' })
    const wake = await until(() => sensei.frames.find((f) => f.type === 'deliver' && f.from === 'infra'))
    expect(wake).toBeDefined()
    expect(String(wake?.text)).toContain('1 event')
    const box = await boxOf(server, 'sensei-s')
    expect(box.map((e) => e.type)).toEqual(['register'])
    expect(box[0]?.data).toMatchObject({ agent: 'worker-w', role: 'worker', queued: true })
    // The worker holds nothing: a register mails the seat, not its subject.
    expect(await boxOf(server, 'worker-w')).toEqual([])

    // THE SAME SESSION RECONNECTS — a `replace`: the seat never changed
    // hands and no disconnect preceded it, so the record is unflagged and
    // the mailbox does not move. (Nor does the replaced socket's close
    // write a disconnect: it no longer owns the seat.)
    await registerWith(server, { agent: 'worker-w', role: 'worker', sessionId: 'S1' })
    await until(() => (worker.readyState === WebSocket.CLOSED ? true : undefined))
    const log = (await (await fetch(`http://localhost:${server.port}/history?stream=agent-worker-w`)).json()) as {
      events: StoredEvent[]
    }
    const registers = log.events.filter((e) => e.type === 'register')
    expect(registers.length).toBe(2)
    expect((registers[1]?.data as { queued?: unknown })?.queued).toBeUndefined()
    expect(log.events.filter((e) => e.type === 'disconnect').length).toBe(0)
    expect((await boxOf(server, 'sensei-s')).map((e) => e.type)).toEqual(['register'])
  })

  test('…and through the surface door: a surface attaching is the seat’s mail, flagged at its own register', async () => {
    const server = await boot()
    const sensei = connect(server, 'sensei-s', 'sensei')
    await sensei.ready
    await until(() => sensei.frames.find((f) => f.type === 'deliver' && f.from === 'infra'))
    await ackAll(server, 'sensei-s')

    server.attachSurface({ name: 'bridge-b', role: 'user', deliver: () => true })
    const box = await until(async () => {
      const b = await boxOf(server, 'sensei-s')
      return b.length > 0 ? b : undefined
    })
    expect(box?.map((e) => e.type)).toEqual(['register'])
    expect(box?.[0]?.data).toMatchObject({ agent: 'bridge-b', role: 'user', queued: true })
  })

  test('…and a SOCKET incumbent replaced through the surface door writes no disconnect either (codex round, task 139)', async () => {
    // The surface door's `replace` hangs up on a socket whose close handler
    // fires synchronously; seated after the hang-up, the socket still owned
    // the seat and a departure was written for an agent that never left —
    // the same ordering the socket door had. The existing surface-replace
    // walk (robustness) uses a SURFACE incumbent, whose close cannot write a
    // disconnect, so it could not see this.
    const server = await boot()
    const sensei = connect(server, 'sensei-s', 'sensei')
    await sensei.ready
    await until(() => sensei.frames.find((f) => f.type === 'deliver' && f.from === 'infra'))
    const socket = await registerWith(server, { agent: 'bridge-b', role: 'user', sessionId: 'B1' })
    await until(async () => ((await boxOf(server, 'sensei-s')).length === 2 ? true : undefined))
    await ackAll(server, 'sensei-s')

    // THE SAME SESSION RE-ATTACHES AS A SURFACE: a replace.
    server.attachSurface({ name: 'bridge-b', role: 'user', sessionId: 'B1', deliver: () => true })
    await until(() => (socket.readyState === WebSocket.CLOSED ? true : undefined))
    const log = (await (await fetch(`http://localhost:${server.port}/history?stream=agent-bridge-b`)).json()) as {
      events: StoredEvent[]
    }
    expect(log.events.filter((e) => e.type === 'disconnect').length).toBe(0)
    expect(log.events.filter((e) => e.type === 'register').length).toBe(2)
    expect((log.events[1]?.data as { queued?: unknown })?.queued).toBeUndefined()
    expect(await boxOf(server, 'sensei-s')).toEqual([])
  })

  test('the pair resolves alike: a worker’s disconnect is the seat’s mail, the seat’s own is not (ruled, task 139)', async () => {
    const server = await boot()
    const sensei = connect(server, 'sensei-s', 'sensei')
    await sensei.ready
    await until(() => sensei.frames.find((f) => f.type === 'deliver' && f.from === 'infra'))
    const worker = connect(server, 'worker-w')
    await worker.ready
    await until(async () => ((await boxOf(server, 'sensei-s')).length === 2 ? true : undefined))
    await ackAll(server, 'sensei-s')

    // THE WORKER LEAVES: mail.
    await new Promise<void>((done) => {
      worker.ws.onclose = () => done()
      worker.ws.close()
    })
    const box = await until(async () => {
      const b = await boxOf(server, 'sensei-s')
      return b.length > 0 ? b : undefined
    })
    expect(box?.map((e) => e.type)).toEqual(['disconnect'])
    expect(box?.[0]?.data).toMatchObject({ agent: 'worker-w' })
    await ackAll(server, 'sensei-s')

    // THE SEAT LEAVES AND RETURNS: its own disconnect is recorded but is not
    // its mail, so the next session is GREETED — the resting mailbox is the
    // greet, not a departure to ack (the noise task 050 flagged).
    await new Promise<void>((done) => {
      sensei.ws.onclose = () => done()
      sensei.ws.close()
    })
    const recorded = await until(async () => {
      const log = (await (await fetch(`http://localhost:${server.port}/history?stream=agent-sensei-s`)).json()) as {
        events: StoredEvent[]
      }
      return log.events.some((e) => e.type === 'disconnect') ? true : undefined
    })
    expect(recorded).toBe(true)
    const second = connect(server, 'sensei-s', 'sensei')
    await second.ready
    expect((await boxOf(server, 'sensei-s')).map((e) => e.type)).toEqual(['greet'])
  })
})
