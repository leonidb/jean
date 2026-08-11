/**
 * DELIVERY UNIFICATION — the mailbox is for everyone (Leonid's mandate, ruled
 * 2026-08-11; supersedes the 5.5b worker-wakes deferral).
 * LEVEL: wiring (the real in-process factory over HTTP/WS).
 *
 * THE RULING, verbatim: "this is must. The mailbox is for everyone. The
 * difference in behavior should be only based on the priority of events and
 * possibly a threshold. The message gets into the mailbox, and from there
 * notifications work the same for any agent."
 *
 * Concretely: (1) the notifier is driven per-agent — every registered dojo
 * agent's mailbox gets views/ticks/decides, worker threshold live; (2)
 * routeSend's direct-delivery fast path is RETIRED — delivery flows only from
 * mailbox decisions, provenance-blind; (3) sends to offline workers QUEUE and
 * announce on reconnect (long-quiet + waiting ⇒ immediate nudge, per H7).
 * Scope boundary: dojo agents only — the bridge and peers keep their own
 * delivery adapters.
 *
 * STATUS AT WRITING: RED BY ASSERTION. s01's own record states the gap these
 * tests close: "a worker has NO PUSH PATH — the bus subscription and both
 * timers call `notifier.tick(senseiView(...))`; no view is ever built for any
 * other agent, so `thresholdFor('worker')` decides nothing in production."
 *
 * ── H7 RIDES ALONG (ruled 2026-08-11) ──
 *
 * "Activity means a jean-visible call or frame originated BY the agent." The
 * automatic registration handshake is NOT activity, so a freshly-connected
 * agent with waiting events reads as long-quiet and is nudged immediately —
 * which is exactly what makes the offline-send queue announce on reconnect.
 * The two are one mechanism and are tested together here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { InfraPorts } from '../infra/ports.ts'
import { createInfraServer, type InfraHandle } from '../infra/server.ts'
import { type ConnectedAgent, connectAgent } from '../infra/test-helpers.ts'

const ROOT = '/tmp/jean-scenarios-unification'
const REGISTRY_PATH = resolve(ROOT, 'registry.json')
const SENSEI = 'sensei'
const WORKER = 'builder'

const noSpawn = (async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
  timedOut: false,
})) as unknown as InfraPorts['spawn']

let handle: InfraHandle
let base: string
let ws: string
let sensei: ConnectedAgent
let worker: ConnectedAgent
const savedRegistry = process.env.JEAN_REGISTRY_PATH

/** Wait long enough for a WS frame already sent by the server to arrive. */
const settle = (ms = 350) => new Promise((r) => setTimeout(r, ms))

/** Infra-originated deliveries in an agent's message log — the push shape. */
const infraPushes = (agent: ConnectedAgent) => agent.messages.filter((m) => m.type === 'deliver' && m.from === 'infra')

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  process.env.JEAN_REGISTRY_PATH = REGISTRY_PATH
  // Same dial shape as s01: the backoff sets a fast tick grid; the interval is
  // parked far away so an IMMEDIATE push can only be the unannounced arm or the
  // already-long-quiet clause — the two things under test — never a mid-test
  // interval expiry.
  process.env.JEAN_NUDGE_BACKOFF_MS = '250'
  process.env.JEAN_NUDGE_INTERVAL_MS = String(10 * 60_000)
  handle = await createInfraServer({
    dataDir: ROOT,
    port: 0,
    enforceSingleInstance: false,
    writeRuntimeFiles: false,
    ports: { spawn: noSpawn },
  })
  base = `http://127.0.0.1:${handle.port}`
  ws = `ws://127.0.0.1:${handle.port}/ws`
  sensei = await connectAgent(ws, SENSEI, 'sensei')
  worker = await connectAgent(ws, WORKER, 'worker')
})

afterAll(async () => {
  delete process.env.JEAN_NUDGE_BACKOFF_MS
  delete process.env.JEAN_NUDGE_INTERVAL_MS
  sensei?.ws.close()
  worker?.ws.close()
  await handle?.stop()
  if (savedRegistry === undefined) delete process.env.JEAN_REGISTRY_PATH
  else process.env.JEAN_REGISTRY_PATH = savedRegistry
})

const send = async (to: string, text: string, from = 'api') =>
  (await (
    await fetch(`${base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, text }),
    })
  ).json()) as { queued?: boolean; delivered?: boolean }

const mailboxOf = async (agent: string) =>
  (await (await fetch(`${base}/events?for=${agent}`)).json()) as {
    events: Array<{ id: number; type: string; code: string; data: { text?: string; from?: string } }>
  }

describe('the notifier is driven per-agent — the wake path is for everyone', () => {
  test('a CONNECTED worker with a waiting mailbox is pushed — thresholdFor("worker") decides in production', async () => {
    // The event enters the worker's mailbox via the task queue (resolveAgent),
    // exactly like s01's seed. Worker threshold is 1, the event is routine
    // priority 1 — at threshold, so the arrival itself must push. Today no view
    // is ever built for a worker, so nothing pushes, ever.
    const before = infraPushes(worker).length
    const res = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'work for the worker', description: '', queue: WORKER, actor: 'test' }),
    })
    expect(res.status).toBe(201)
    await settle()
    expect(infraPushes(worker).length).toBeGreaterThan(before)
  })

  test('GUARD — a worker with an EMPTY mailbox is not pushed on connect or by the ticks', async () => {
    // The other half of per-agent driving: sweeping every agent must not mean
    // nudging every agent. An empty mailbox decides nothing.
    using quiet = await connectAgent(ws, 'quiet-one', 'worker')
    await settle(600) // several 250ms tick grids
    expect(infraPushes(quiet).length).toBe(0)
  })
})

describe('routeSend’s direct-delivery fast path is retired — delivery flows from mailbox decisions', () => {
  test('a send to a CONNECTED worker arrives promptly, via the notifier’s push — and the content via fetch', async () => {
    // Keep the worker's quiet clock fresh so the push can only be the
    // threshold arm — "same latency, one mechanism", not a lucky interval.
    await fetch(`${base}/board`, { headers: { 'x-jean-agent': WORKER } })

    const before = worker.messages.length
    const res = await send(WORKER, 'do the thing')

    // The mailbox is truth: the response says QUEUED, not "delivered" — the
    // ledger is the delivery record now, and it cannot be known at record time.
    expect(res.queued).toBe(true)

    await settle()
    const after = worker.messages.slice(before).filter((m) => m.type === 'deliver')

    // ── THE RETIREMENT, both directions ──
    // 1. The raw message frame does NOT arrive: nothing delivered carries the
    //    sender's own text. Content reaches the worker through its mailbox.
    expect(after.some((m) => m.text === 'do the thing')).toBe(false)
    // 2. A push DID arrive promptly, from infra — the notifier's immediate
    //    push for an at-threshold arrival.
    expect(after.some((m) => m.from === 'infra')).toBe(true)

    // The content is in the mailbox, with an ack code, and the pair clears it.
    const box = await mailboxOf(WORKER)
    const queued = box.events.find((e) => e.type === 'send' && e.data.text === 'do the thing')
    expect(queued).toBeDefined()
    expect(queued?.code).toBeTruthy()
    const ack = (await (
      await fetch(`${base}/events/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairs: [{ id: queued?.id, code: queued?.code }] }),
      })
    ).json()) as { acknowledged: number }
    expect(ack.acknowledged).toBe(1)
    const boxAfter = await mailboxOf(WORKER)
    expect(boxAfter.events.some((e) => e.id === queued?.id)).toBe(false)
  })

  test('a send to an OFFLINE ever-registered worker QUEUES — the 003 class closes structurally', async () => {
    // Register mason so infra knows the name, then take the session down.
    const mason = await connectAgent(ws, 'mason', 'worker')
    mason.ws.close()
    await settle()

    const res = await send('mason', 'while you were out')
    expect(res.queued).toBe(true)

    // Nothing vanished: the send sits in mason's mailbox, fetchable.
    const box = await mailboxOf('mason')
    expect(box.events.some((e) => e.type === 'send' && e.data.text === 'while you were out')).toBe(true)
  })

  test('…and the queued send ANNOUNCES on reconnect — long-quiet + waiting ⇒ immediate nudge (H7)', async () => {
    // H7's confirmed consequence, verbatim from the ruling: "a freshly-connected
    // agent with waiting events therefore reads as long-quiet and gets nudged
    // immediately, which is the desired behavior." The registration handshake
    // is not activity, so nothing shields the fresh session from its mailbox.
    const mason = await connectAgent(ws, 'mason', 'worker')
    try {
      await settle(600)
      expect(infraPushes(mason).length).toBeGreaterThan(0)
    } finally {
      mason.ws.close()
    }
  })

  test('GUARD — a send to a NEVER-registered name does not queue, and the sender is told', async () => {
    // The offline-queue must not swallow typos: a name with no register history
    // anywhere is a caller bug, not an empty mailbox. The event must NOT enter
    // pending — an event in nobody's mailbox can never be fetched, so it could
    // never be acked (the A2 invariant from the casualty round).
    const before = sensei.messages.length
    const res = await send('nobodyy', 'hello?', SENSEI)
    expect(res.queued ?? false).toBe(false)

    const pending = (await (await fetch(`${base}/events/pending`)).json()) as {
      events: Array<{ type: string; data: { text?: string } }>
    }
    expect(pending.events.some((e) => e.type === 'send' && e.data.text === 'hello?')).toBe(false)

    // The sender hears about it on its own session — same notice as today.
    await settle()
    const notices = sensei.messages
      .slice(before)
      .filter((m) => m.type === 'deliver' && m.text?.includes('NOT delivered'))
    expect(notices.length).toBeGreaterThan(0)
  })
})
