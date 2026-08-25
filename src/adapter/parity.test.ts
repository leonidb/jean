/**
 * Parity for the surfaces every live caller depends on (task E4).
 *
 * PARITY MEANS THE CALLER CANNOT TELL. So where a caller's request shape can
 * be IMPORTED rather than retyped, it is: `probeInfra` really probes this
 * server, and the channel plugin's own `resolveInboxCall` really produces the
 * paths these tests fetch. A hand-copied URL passes while the consumer sends
 * something else; the consumer's own code cannot.
 *
 * Where the request is a shell one-liner in a generated settings hook (the
 * stop hook, the permission hook) the body is transcribed from the generator
 * with the line quoted beside it, because there is nothing importable to
 * point at.
 *
 * The test boundary is unchanged: transport and wiring only. That a summary
 * groups the way it does is the mailbox's; that the key it prints is the key
 * the fetch selector accepts is WIRING, and that is the assertion here.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { resolveInboxCall } from '../channel/tools.ts'
import { probeInfra } from '../probe.ts'
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

async function boot(): Promise<AdapterHandle> {
  const server = await createAdapterServer()
  openServers.push(server)
  return server
}

const base = (server: AdapterHandle) => `http://localhost:${server.port}`
const get = async (server: AdapterHandle, path: string, agent?: string) => {
  const res = await fetch(`${base(server)}${path}`, {
    headers: agent === undefined ? {} : { 'x-jean-agent': agent },
  })
  return { status: res.status, body: (await res.json()) as Record<string, never> }
}
const post = async (server: AdapterHandle, path: string, body: unknown, agent?: string) => {
  const res = await fetch(`${base(server)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(agent !== undefined && { 'x-jean-agent': agent }) },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, never> }
}

function connect(server: AdapterHandle, agent: string, role = 'worker', sessionId?: string) {
  return new Promise<WebSocket>((done, fail) => {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`)
    openSockets.push(ws)
    const timer = setTimeout(() => fail(new Error(`register timed out for ${agent}`)), 4_000)
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: 'register', agent, role, ...(sessionId !== undefined && { sessionId }) }))
    ws.onmessage = (ev) => {
      if ((JSON.parse(String(ev.data)) as { type?: string }).type !== 'registered') return
      clearTimeout(timer)
      done(ws)
    }
    ws.onerror = () => fail(new Error('socket error'))
  })
}

describe('GET / — the identity probe', () => {
  test('the REAL `probeInfra` finds this server', async () => {
    // Not on the inventory's blocker list, and found while grepping for the
    // others: every CLI command discovers infra through this probe. Answer
    // 404 and the operator is told nothing is running while the server
    // serves every other route perfectly.
    const server = await boot()
    const info = await probeInfra(server.port)
    expect(info).not.toBeNull()
    expect(info?.name).toBe('jean-infra') // what `probeInfra`'s callers compare against
    expect(info?.port).toBe(server.port)
    expect(info?.pid).toBe(process.pid)
  })
})

describe('GET /status — the operator’s first command', () => {
  test('`jean status` gets the two things it parses: the agent names, and recent events', async () => {
    const server = await boot()
    await connect(server, 'orchestrator-o', 'sensei')
    await connect(server, 'worker-a')
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'hello' })

    // `cmdStatus` reads `info.agents.map(a => a.name)`…
    const status = (await get(server, '/status')).body as unknown as {
      name: string
      agents: { name: string; role?: string }[]
      sensei: { connected: boolean }
      pendingEvents: number
      activeTriggers: number
    }
    expect(status.agents.map((a) => a.name).sort()).toEqual(['orchestrator-o', 'worker-a'])
    expect(status.sensei.connected).toBe(true)
    // TWO: the send to worker-a, and the sensei's own greet (task 133) — a
    // sensei registering into a quiet dojo is greeted, and this walk connects
    // one. The number is not the subject here; that `cmdStatus` can parse the
    // shape is. Left as a literal rather than derived, because a count this
    // walk computes for itself would agree with the server by construction.
    expect(status.pendingEvents).toBe(2)
    expect(status.activeTriggers).toBe(0)

    // …and then `/events` with NO identity at all. E1 answered that 400.
    const observed = (await get(server, '/events')).body as unknown as {
      events: { ts: string; type: string; agent?: string }[]
    }
    // TWO NOW — the greet and the send (task 133). What `cmdStatus` parses is
    // each row's SHAPE, so this asserts the shape of the row it names rather
    // than the length of the list, which was never its subject and which the
    // greet changed underneath it.
    expect(observed.events.length).toBe(2)
    const send = observed.events.find((e) => e.type === 'send')
    expect(send, 'the send is not in the recent-events list the CLI prints').toBeDefined()
    expect(typeof send?.ts).toBe('string')
    expect(send?.agent).toBe('worker-a') // the display column the CLI prints
  })

  test('the observer read stamps NOTHING — a dashboard is not a delivery', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'jean-e4-observer-'))
    openDirs.push(dir)
    const server = await createAdapterServer({ dataDir: dir })
    openServers.push(server)
    // A refusing transport, so no WAKE can stamp first and hide the question.
    server.attachSurface({ name: 'worker-a', role: 'worker', deliver: () => false })
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'unread' })

    // The observer looks — and takes a code with it, exactly as the old
    // surface handed one out. That is no new authority: `applyAck` clears
    // only pairs the CALLER holds, so a code is useless to anyone who could
    // not have fetched it addressed.
    const observed = (await get(server, '/events')).body as unknown as { events: { id: number; code: string }[] }
    const seen = observed.events[0]
    if (seen === undefined) throw new Error('fixture: nothing pending')

    await post(server, '/ack', { pairs: [{ id: seen.id, code: seen.code }] }, 'worker-a')
    const log = (await Bun.file(resolve(dir, 'history.jsonl')).text())
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { type: string; data: { cleared?: { eventId: number; deliveredVia?: string }[] } },
      )
    const ack = log.filter((e) => e.type === 'ack').pop()
    // Stamping here would record a delivery to NOBODY — and first-write-wins
    // would make whichever dashboard looked first the recorded carrier of
    // everyone's mail. Absent is the honest answer: unknown, never
    // "not delivered".
    expect(ack?.data.cleared).toEqual([{ eventId: seen.id }])
  })
})

describe('the inbox ladder — the plugin’s own paths', () => {
  test('all four views resolve and answer, using the paths `resolveInboxCall` produces', async () => {
    const server = await boot()
    await connect(server, 'worker-a')
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'one' })

    // THE PLUGIN'S OWN MAPPER. If it ever repoints a view, this test follows
    // it rather than pinning a URL the plugin no longer sends.
    const paths = (['counts', 'summary', 'grouped', 'fetch'] as const).map((view) => {
      const resolved = resolveInboxCall({ view })
      if ('error' in resolved) throw new Error(`fixture: the plugin refused view ${view}`)
      return resolved.path
    })
    expect(paths).toEqual(['/events/counts', '/events/summary', '/inbox', '/events'])

    const counts = (await get(server, paths[0] as string, 'worker-a')).body as unknown as {
      counts: { total: number }
    }
    expect(counts.counts.total).toBe(1)

    const summary = (await get(server, paths[1] as string, 'worker-a')).body as unknown as {
      summary: { id: number; group: unknown; preview: string }[]
    }
    expect(summary.summary.length).toBe(1)
    expect(summary.summary[0]?.preview).toContain('one')

    const grouped = (await get(server, paths[2] as string, 'worker-a')).body as unknown as {
      inbox: { queued: { count: number; byType: Record<string, number> } } | null
      line: string | null
    }
    expect(grouped.inbox?.queued.count).toBe(1)
    expect(grouped.inbox?.queued.byType.send).toBe(1)
    expect(grouped.line).toContain('1 queued')

    const fetched = (await get(server, paths[3] as string, 'worker-a')).body as unknown as {
      events: { code: string }[]
    }
    // The fetch rung is the ONLY one carrying codes — a code on a cheap rung
    // would make the cheap rung sufficient to clear.
    expect(typeof fetched.events[0]?.code).toBe('string')
    for (const line of summary.summary) expect(line).not.toHaveProperty('code')
  })

  test('a `byType` key read off the grouped view selects with it VERBATIM — one classification, three renderings', async () => {
    const server = await boot()
    await connect(server, 'worker-a')
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'a message' })
    await post(server, '/tasks', { title: 'a task', queue: 'worker-a' }, 'orchestrator-o')

    const grouped = (await get(server, '/inbox', 'worker-a')).body as unknown as {
      inbox: { queued: { byType: Record<string, number> } }
    }
    const keys = Object.keys(grouped.inbox.queued.byType)
    expect(keys.length).toBeGreaterThan(1) // anti-vacuity: there is something to narrow

    let narrowed = 0
    for (const key of keys) {
      // THE PLUGIN'S OWN SELECTOR MAPPING, again — `?type=` is what it sends.
      const resolved = resolveInboxCall({ view: 'fetch', type: key })
      if ('error' in resolved) throw new Error('fixture: the plugin refused a type selector')
      const events = ((await get(server, resolved.path, 'worker-a')).body as unknown as { events: { type: string }[] })
        .events
      expect(events.length).toBe(grouped.inbox.queued.byType[key] ?? 0)
      for (const event of events) expect(event.type).toBe(key)
      narrowed++
    }
    expect(narrowed).toBe(keys.length)

    // E1 read only `?ids=`, so `?type=` and `?from=` were IGNORED and the
    // caller got its whole mailbox back — a wrong answer that looks like a
    // right one.
    const all = ((await get(server, '/events', 'worker-a')).body as unknown as { events: unknown[] }).events
    expect(all.length).toBeGreaterThan(1)
  })

  test('ambiguous and malformed selections refuse rather than pick one', async () => {
    const server = await boot()
    await connect(server, 'worker-a')
    expect((await get(server, '/events?ids=1&type=send', 'worker-a')).status).toBe(400)
    expect((await get(server, '/events?type=', 'worker-a')).status).toBe(400)
    expect((await get(server, '/events?from=', 'worker-a')).status).toBe(400)
    // A stray comma is a malformed list, not a list to quietly normalize.
    expect((await get(server, '/events?ids=1,,2', 'worker-a')).status).toBe(400)
    expect((await get(server, '/events?ids=1,')).status).toBe(400) // a selector with no reader
  })
})

describe('who is asking — the header the plugin actually sends', () => {
  test('a percent-encoded agent name is DECODED — the plugin encodes and says infra decodes', async () => {
    // HTTP headers are Latin-1 only, so the plugin percent-encodes the name;
    // a raw non-ASCII one makes `fetch` throw on every call. Read undecoded,
    // an agent called `chat 42` asks after `chat%2042`'s mailbox — which
    // nobody registered. An empty inbox, forever, with nothing failing
    // (codex pass).
    const server = await boot()
    // A WORKER, so the send queues into a mailbox rather than being handed
    // to a live adapter session — the read is the point, not the routing.
    await connect(server, 'worker 42')
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker 42', text: 'hello' })

    const res = await fetch(`${base(server)}/events`, {
      headers: { 'x-jean-agent': encodeURIComponent('worker 42') }, // exactly what the plugin builds
    })
    const box = (await res.json()) as { events: unknown[] }
    expect(box.events.length).toBe(1)
  })

  test('`?for=` outranks the header — the plugin attaches one to EVERY call', async () => {
    const server = await boot()
    await connect(server, 'worker-a')
    await connect(server, 'worker-b')
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-b', text: 'for b only' })

    // worker-a asking about worker-b's mailbox, carrying its own header —
    // which is what a cross-agent read looks like from the plugin. A header
    // that won would answer with worker-a's (empty) mailbox and never say so.
    const counts = (await get(server, '/events/counts?for=worker-b', 'worker-a')).body as unknown as {
      counts: { total: number }
    }
    expect(counts.counts.total).toBe(1)

    const own = (await get(server, '/events/counts', 'worker-a')).body as unknown as { counts: { total: number } }
    expect(own.counts.total).toBe(0) // anti-vacuity: the two really do differ
  })
})

describe('POST /events/ack — the plugin’s ack path', () => {
  test('the compat path and the adapter’s own name are ONE handler', async () => {
    const server = await boot()
    await connect(server, 'worker-a')
    await post(server, '/send', { from: 'orchestrator-o', to: 'worker-a', text: 'ack me' })
    const fetched = (await get(server, '/events', 'worker-a')).body as unknown as {
      events: { id: number; code: string }[]
    }
    const pair = fetched.events[0]
    if (pair === undefined) throw new Error('fixture: nothing to ack')

    // The plugin POSTs `/events/ack` and reads `{acknowledged}`.
    const acked = await post(server, '/events/ack', { pairs: [{ id: pair.id, code: pair.code }] }, 'worker-a')
    expect(acked.status).toBe(200)
    expect((acked.body as unknown as { acknowledged: number }).acknowledged).toBe(1)
    expect(((await get(server, '/events', 'worker-a')).body as unknown as { events: unknown[] }).events).toEqual([])
  })

  test('an empty or all-malformed batch is LOUD — a success-shaped no-op is how a model believes it acked', async () => {
    const server = await boot()
    await connect(server, 'worker-a')
    expect((await post(server, '/events/ack', { pairs: [] }, 'worker-a')).status).toBe(400)
    expect((await post(server, '/events/ack', { pairs: [{ id: 'x' }] }, 'worker-a')).status).toBe(400)
    expect((await post(server, '/ack', { pairs: 'all' }, 'worker-a')).status).toBe(400)
  })
})

describe('GET /history — `jean task log`', () => {
  test('the CLI’s exact request returns the fields it prints', async () => {
    const server = await boot()
    await connect(server, 'orchestrator-o', 'sensei')
    const task = (await post(server, '/tasks', { title: 'log me', queue: 'worker-a' }, 'orchestrator-o'))
      .body as unknown as { id: string }
    await fetch(`${base(server)}/tasks/${task.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-jean-agent': 'orchestrator-o' },
      body: JSON.stringify({ status: 'in-progress' }),
    })

    // Transcribed from `cmdTaskLog`: `/history?taskId=<id>&diagnostics=true`.
    const history = (await get(server, `/history?taskId=${task.id}&diagnostics=true`)).body as unknown as {
      events: { id: number; type: string; ts: string; agent?: string; data: Record<string, unknown> }[]
    }
    const kinds = history.events.map((e) => e.type)
    expect(kinds).toContain('task-created')
    expect(kinds).toContain('task-status')
    const status = history.events.find((e) => e.type === 'task-status')
    // The CLI prints `${data.from} → ${data.to}` and `by ${data.actor}`.
    expect(status?.data).toMatchObject({ from: 'todo', to: 'in-progress', actor: 'orchestrator-o' })
    expect(typeof status?.ts).toBe('string')
  })

  test('permission requests are hidden unless asked for — a log that drowns in diagnostics is not read', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'jean-e4-diag-'))
    openDirs.push(dir)
    writeFileSync(
      resolve(dir, 'history.jsonl'),
      `${JSON.stringify({
        id: 1,
        ts: '2026-08-18T09:00:00.000Z',
        type: 'permission-request',
        stream: 'agent-worker-a',
        data: { agent: 'worker-a', tool: 'Bash', input: { command: 'ls' } },
      })}\n`,
    )
    const server = await createAdapterServer({ dataDir: dir })
    openServers.push(server)
    const quiet = (await get(server, '/history')).body as unknown as { events: { type: string }[] }
    expect(quiet.events.some((e) => e.type === 'permission-request')).toBe(false)
    const loud = (await get(server, '/history?diagnostics=true')).body as unknown as { events: { type: string }[] }
    expect(loud.events.some((e) => e.type === 'permission-request')).toBe(true)
  })

  test('`?last=` takes the tail and `?raw=true` returns the envelope', async () => {
    const server = await boot()
    for (const text of ['one', 'two', 'three']) {
      await post(server, '/send', { from: 'orchestrator-o', to: 'someone', text })
    }
    const tail = (await get(server, '/history?last=2')).body as unknown as { events: unknown[] }
    expect(tail.events.length).toBe(2)
    const raw = (await get(server, '/history?last=1&raw=true')).body as unknown as { events: { stream: string }[] }
    expect(typeof raw.events[0]?.stream).toBe('string') // the envelope, untouched
    expect((await get(server, '/history?last=nope')).status).toBe(400)
  })
})

describe('GET /permissions — the historical reader', () => {
  test('`jean permissions` reads the aggregate it parses, out of requests already in the log', async () => {
    // RULED (task 109): the hooks that POSTed here are retired with the old
    // server, so this surface no longer has a writer — and `jean permissions`
    // still has months of requests to read. The fixture is therefore a
    // SEEDED LOG, which is also the honest shape of the thing being tested.
    const dir = mkdtempSync(resolve(tmpdir(), 'jean-e4-perms-'))
    openDirs.push(dir)
    const seeded = [
      { agent: 'worker-a', tool: 'Bash', input: { command: 'ls' } },
      { agent: 'worker-a', tool: 'Bash', input: { command: 'git status' } },
      { agent: 'worker-b', tool: 'Write', input: { path: 'x.ts' } },
    ].map((data, i) => ({
      id: i + 1,
      ts: `2026-08-18T09:0${i}:00.000Z`,
      type: 'permission-request',
      stream: `agent-${data.agent}`,
      data,
    }))
    writeFileSync(resolve(dir, 'history.jsonl'), `${seeded.map((e) => JSON.stringify(e)).join('\n')}\n`)
    const server = await createAdapterServer({ dataDir: dir })
    openServers.push(server)

    // `cmdPermissions` parses Record<agent, Record<tool, {count, samples}>>.
    const all = (await get(server, '/permissions')).body as unknown as {
      permissions: Record<string, Record<string, { count: number; samples: unknown[] }>>
    }
    expect(all.permissions['worker-a']?.Bash?.count).toBe(2)
    expect(all.permissions['worker-a']?.Bash?.samples).toEqual([{ command: 'ls' }, { command: 'git status' }])
    expect(all.permissions['worker-b']?.Write?.count).toBe(1)

    // `jean permissions <agent>` narrows with `?agent=`.
    const one = (await get(server, '/permissions?agent=worker-b')).body as unknown as {
      permissions: Record<string, unknown>
    }
    expect(Object.keys(one.permissions)).toEqual(['worker-b'])

    // And there is no writer any more: the POST is gone with the hooks.
    expect((await post(server, '/permissions', { agent: 'worker-a', tool: 'Bash' })).status).toBe(404)
  })
})
