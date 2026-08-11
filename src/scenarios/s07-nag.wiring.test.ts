/**
 * SCENARIO 7 (the NAG half) — the wiring: the nag rides the mailbox end to end.
 * LEVEL: wiring (the real in-process factory over HTTP/WS).
 *
 * THE REGRESSION THIS FILE IS (task 050, ruled 2026-08-11). Observed live at
 * the Events-API commit: two waiting-task nags reached the sensei as bare channel pushes
 * from 'infra', and `GET /events` seconds later was EMPTY — no pending entry,
 * no code, no ack possible, no ledger trace of the delivery. The core suite
 * (s07-nag.core.test.ts) proves the supervisor now emits an addressed event;
 * this file proves the parts no core test can see: that the emission actually
 * enters pending through the reducer's admission gate, lands in the sensei's
 * mailbox WITH a code, is announced by the notifier (once — the announce leg,
 * not a parallel push path), and re-paces without duplicating until an ack
 * clears it.
 *
 * DIALS: reminderAfter is shrunk so a nag window fits in a test; the notifier
 * interval is small with a huge backoff rung, so exactly one announcement can
 * fire per arrival and a second one within a test window can only mean the
 * defect returned.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { InfraPorts } from '../infra/ports.ts'
import type { DeliverMsg } from '../infra/protocol.ts'
import { createInfraServer, type InfraHandle } from '../infra/server.ts'
import { type ConnectedAgent, connectAgent } from '../infra/test-helpers.ts'

const ROOT = '/tmp/jean-scenarios-s07-nag-wiring'
const REGISTRY_PATH = resolve(ROOT, 'registry.json')
const SENSEI = 'sensei'

/** The shrunk nag window. The supervise tick is `min(60s, reminderAfter,
 *  brokenAfter)`, so this also sets the tick grid. */
const REMINDER_AFTER_MS = 700

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
let taskId: string
const savedRegistry = process.env.JEAN_REGISTRY_PATH

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  process.env.JEAN_REGISTRY_PATH = REGISTRY_PATH
  process.env.JEAN_REMINDER_AFTER_MS = String(REMINDER_AFTER_MS)
  // Quiet clock small, backoff huge: the first announcement after an arrival
  // can fire fast, and any SECOND push inside a test window is a failure, not
  // a rung.
  process.env.JEAN_NUDGE_INTERVAL_MS = '400'
  process.env.JEAN_NUDGE_BACKOFF_MS = String(10 * 60_000)
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
})

afterAll(async () => {
  delete process.env.JEAN_REMINDER_AFTER_MS
  delete process.env.JEAN_NUDGE_INTERVAL_MS
  delete process.env.JEAN_NUDGE_BACKOFF_MS
  sensei?.ws.close()
  await handle?.stop()
  if (savedRegistry === undefined) delete process.env.JEAN_REGISTRY_PATH
  else process.env.JEAN_REGISTRY_PATH = savedRegistry
})

type WireEvent = { id: number; type: string; code?: string; data: Record<string, unknown> }

/** OBSERVER read — the whole pending queue, no identity, so looking never
 *  stamps a delivery or discharges an announcement mid-assertion. */
const observePending = async () =>
  ((await (await fetch(`${base}/events/pending`)).json()) as { events: WireEvent[] }).events

/** ADDRESSED read — the sensei's own mailbox, codes included. A delivery. */
const fetchMailbox = async () =>
  ((await (await fetch(`${base}/events`, { headers: { 'x-jean-agent': SENSEI } })).json()) as { events: WireEvent[] })
    .events

const nagsFor = (events: WireEvent[], id: string) =>
  events.filter((e) => e.type === 'task-reminder' && e.data.taskId === id)

const infraPushes = (agent: ConnectedAgent) =>
  agent.messages.filter((m): m is DeliverMsg => m.type === 'deliver' && m.from === 'infra')

async function until(pred: () => Promise<boolean> | boolean, budgetMs = 6_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await pred()) return true
    await Bun.sleep(60)
  }
  return pred()
}

describe('the waiting-task nag rides the mailbox (task 050)', () => {
  test('a parked task’s nag ENTERS PENDING, addressed and queued — and the sensei is announced once, by the notifier', async () => {
    // Park a task on the sensei, through the public API.
    const created = (await (
      await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'nag regression', description: '', queue: 'builder', actor: 'test' }),
      })
    ).json()) as { id: string }
    taskId = created.id
    await fetch(`${base}/tasks/${taskId}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in-progress' }),
    })
    await fetch(`${base}/tasks/${taskId}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'waiting', blockedOn: 'sensei' }),
    })

    // Clean slate: the sensei reads its mailbox and acks everything already
    // there (the task-created event, mostly). This is also sensei ACTIVITY —
    // the announcement asserted below can then only be caused by the nag's own
    // arrival on a re-quieted clock, not by leftover announce state.
    const before = await fetchMailbox()
    if (before.length > 0) {
      await fetch(`${base}/events/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairs: before.map((e) => ({ id: e.id, code: e.code })) }),
      })
    }
    const pushBaseline = infraPushes(sensei).length

    // THE FIX, half one: within a reminder window the nag is IN PENDING — the
    // exact read that came back empty when the defect was observed live.
    expect(await until(async () => nagsFor(await observePending(), taskId).length > 0)).toBe(true)
    const [nag] = nagsFor(await observePending(), taskId)
    expect(nag?.data).toMatchObject({ taskId, to: SENSEI, queued: true })
    expect(String(nag?.data.text)).toContain('is waiting on sensei')

    // THE FIX, half two: the sensei is told by the NOTIFIER — an announce push
    // arrives…
    expect(await until(() => infraPushes(sensei).length > pushBaseline)).toBe(true)
    const announces = infraPushes(sensei).slice(pushBaseline)
    // …and it is the announce leg, not the old parallel path: no frame carries
    // the raw nag sentence as its whole payload.
    expect(announces.some((m) => m.text === String(nag?.data.text))).toBe(false)

    // ONCE. The backoff rung is 10 minutes; a second push in this window is
    // the defect class returning (or whole-queue re-announcement).
    await Bun.sleep(3 * REMINDER_AFTER_MS)
    expect(infraPushes(sensei).length).toBe(pushBaseline + 1)
  }, 15_000)

  test('an unacked nag RE-PACES without duplicating — one pending entry however many windows pass', async () => {
    // Decision (a), at the wiring level: reminderAfter has elapsed several
    // times over by now; the supervisor must not have re-emitted while the
    // first nag sits unacked. The notifier re-announces; the mailbox holds ONE.
    await Bun.sleep(3 * REMINDER_AFTER_MS)
    expect(nagsFor(await observePending(), taskId)).toHaveLength(1)
  }, 15_000)

  test('the ack clears it — and a still-parked task earns a FRESH nag a full window later', async () => {
    // The addressed fetch is the delivery that yields the code (S5)…
    const box = await fetchMailbox()
    const [nag] = nagsFor(box, taskId)
    expect(nag?.code).toBeTruthy()
    const ack = (await (
      await fetch(`${base}/events/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairs: [{ id: nag?.id, code: nag?.code }] }),
      })
    ).json()) as { acknowledged: number }
    expect(ack.acknowledged).toBe(1)
    expect(nagsFor(await observePending(), taskId)).toHaveLength(0)

    // …and the task is STILL parked, so the cycle restarts: a new nag (a new
    // id — a fresh fact, not a resurrection) lands after another full window.
    expect(
      await until(async () => {
        const nags = nagsFor(await observePending(), taskId)
        return nags.length === 1 && nags[0]?.id !== nag?.id
      }),
    ).toBe(true)
  }, 15_000)

  test('a nag emitted while the holder is OFFLINE queues — announced and fetchable on reconnect', async () => {
    // THE DROP-VS-DEFER HALF of the defect (raised by the architect's sweep,
    // task 053): the old arm gated on `deliverable` with no queue behind it,
    // so an offline holder's nag was silently DROPPED — not deferred, and
    // nothing recorded that it ever fired. The emission needs no transport:
    // the mailbox OWNER outlives the connection (task 040's split — holder
    // resolution falls back to the last registered sensei name), the event
    // enters durable pending, and H7 makes the reconnect announce itself (a
    // fresh session with a waiting mailbox reads as long-quiet).
    //
    // Drain first — the previous case left a nag unacked, and a mid-ladder
    // episode would gate the reconnect announcement on a 10-minute rung. A
    // drained mailbox ends the spell (core/notify.ts), so the announcement
    // below can only be the reconnect doing its job.
    const leftovers = await fetchMailbox()
    if (leftovers.length > 0) {
      await fetch(`${base}/events/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairs: leftovers.map((e) => ({ id: e.id, code: e.code })) }),
      })
    }
    sensei.ws.close()
    await Bun.sleep(300)

    const created = (await (
      await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'offline nag', description: '', queue: 'builder', actor: 'test' }),
      })
    ).json()) as { id: string }
    const offlineTask = created.id
    await fetch(`${base}/tasks/${offlineTask}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in-progress' }),
    })
    await fetch(`${base}/tasks/${offlineTask}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'waiting', blockedOn: 'sensei' }),
    })

    // The nag fires with NOBODY connected — and it is in pending, addressed
    // to the disconnected owner. This is the read that was empty live.
    expect(await until(async () => nagsFor(await observePending(), offlineTask).length > 0)).toBe(true)
    const [queued] = nagsFor(await observePending(), offlineTask)
    expect(queued?.data).toMatchObject({ taskId: offlineTask, to: SENSEI, queued: true })

    // Reconnect. The register sweep announces the waiting mailbox (H7)…
    sensei = await connectAgent(ws, SENSEI, 'sensei')
    expect(await until(() => infraPushes(sensei).some((m) => !m.text.startsWith('You just connected')))).toBe(true)

    // …and the nag is STILL THERE, fetchable with a code — deferred, never
    // dropped.
    const box = await fetchMailbox()
    const [nag] = nagsFor(box, offlineTask)
    expect(nag?.id).toBe(queued?.id as number)
    expect(nag?.code).toBeTruthy()
  }, 15_000)

  test('a HUMAN-parked task nags the bridge surface directly — and the event is still the record (S8)', async () => {
    // The production path for the bridge-holder leg, end to end, through the
    // public API — added after the Codex adversarial pass argued the leg was
    // only pinned by core tests that fabricate holders. Parking ON the human
    // is one legal PATCH (`in-progress → waiting {blockedOn: 'human'}`), so
    // the leg is reachable without the (yet route-less) task-blocked handoff:
    // holder resolves to the CONNECTED user surface, the push carries the raw
    // nag sentence on the human's own protocol (Leonid's ruling: a foreign
    // protocol with no mailbox — direct push is the correct shape), and the
    // emitted event enters pending, claimable from the sensei's mailbox.
    using human = await connectAgent(ws, 'chat-human', 'user')

    const created = (await (
      await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'human parked', description: '', queue: 'builder', actor: 'test' }),
      })
    ).json()) as { id: string }
    const humanTask = created.id
    await fetch(`${base}/tasks/${humanTask}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in-progress' }),
    })
    await fetch(`${base}/tasks/${humanTask}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'waiting', blockedOn: 'human' }),
    })

    // The human's surface receives the nag ITSELF — raw sentence, its own
    // protocol, no mailbox involved.
    expect(
      await until(() =>
        human.messages.some(
          (m): m is DeliverMsg => m.type === 'deliver' && m.from === 'infra' && /is waiting on human/.test(m.text),
        ),
      ),
    ).toBe(true)

    // And the report of record exists regardless of the push: in pending,
    // addressed to the bridge, claimable (with a code) from the sensei's
    // universal mailbox — the ruling's one hard condition.
    const [record] = nagsFor(await observePending(), humanTask)
    expect(record?.data).toMatchObject({ taskId: humanTask, to: 'chat-human', queued: true })
    const senseiCopy = nagsFor(await fetchMailbox(), humanTask)
    expect(senseiCopy).toHaveLength(1)
    expect(senseiCopy[0]?.code).toBeTruthy()
  }, 15_000)
})
