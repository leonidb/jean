/**
 * THE MULTI-AGENT CLASS — the adapter layer, through a live server.
 * LEVEL: wiring (real in-process infra, three connected agents, real HTTP).
 *
 * AUTHORITY: `docs/guarantees.md`. Same rule as the core files — assert what
 * the spec requires, let the divergences be red (task 064).
 *
 * ── WHY THESE CASES CANNOT LIVE IN CORE, WHICH IS ITSELF A FINDING ──
 *
 * §5 claims the requirements are fixture-testable. These are the ones that are
 * not, each for a reason worth recording rather than routing around:
 *
 *  - RESPONSE SHAPE. Task 059 — the only defect of this class we have actually
 *    shipped — lived in the ack response body, and no core decision produces
 *    that body. A suite aimed exclusively at core decisions would have missed
 *    it exactly as the existing 870-test suite did.
 *  - THE `x-jean-inbox` HEADER. Attachment depends on the LIVE REGISTRY
 *    (`withInboxHeader` bails on `!agents.has(caller)`), not on anything in the
 *    pending list, so a disconnected agent makes the comparison null on both
 *    sides and the case passes having tested nothing. Every header case below
 *    therefore asserts the header is PRESENT before comparing it.
 *  - AUTHORIZATION. P5's second half is about the CALLER, and the caller does
 *    not exist as a concept below the HTTP boundary: `applyAck(pending, pairs)`
 *    has no parameter for who is acking.
 *  - SELECTOR PARSING. `?ids=`/`?from=`/`?type=`, their 400s and the `missing`
 *    array are adapter behaviour with no core counterpart.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { InfraPorts } from '../infra/ports.ts'
import { createInfraServer, type InfraHandle } from '../infra/server.ts'
import { type ConnectedAgent, connectAgent } from '../infra/test-helpers.ts'

const ROOT = '/tmp/jean-scenarios-multi-agent'
const REGISTRY_PATH = resolve(ROOT, 'registry.json')

const SENSEI = 'sensei'
const A = 'worker-a'
const B = 'worker-b'

const noSpawn = (async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
  timedOut: false,
})) as unknown as InfraPorts['spawn']

let handle: InfraHandle
let base: string
let sensei: ConnectedAgent
let workerA: ConnectedAgent
let workerB: ConnectedAgent
const savedRegistry = process.env.JEAN_REGISTRY_PATH

type FetchedEvent = { id: number; code?: string; message?: string; data?: Record<string, unknown> }

/** Read one agent's mailbox as that agent. `?for=` is the addressed read. */
async function mailbox(agent: string): Promise<FetchedEvent[]> {
  const res = await fetch(`${base}/events?for=${agent}`)
  return ((await res.json()) as { events: FetchedEvent[] }).events
}

/** The whole queue, read by nobody in particular — the OBSERVER path. */
async function observedQueue(): Promise<FetchedEvent[]> {
  const res = await fetch(`${base}/events`)
  return ((await res.json()) as { events: FetchedEvent[] }).events
}

async function createTask(title: string, queue: string): Promise<string> {
  const res = await fetch(`${base}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, description: '', queue, actor: SENSEI }),
  })
  return ((await res.json()) as { id: string }).id
}

/** A dispatch from the orchestrator to a worker — the one shape that lands in
 *  a worker's mailbox and NOT in the orchestrator's, since the orchestrator
 *  authored it. The fixture needs these: without them the orchestrator's
 *  universal mailbox equals the whole queue, and §5's "no agent's answer
 *  coincides with the dojo-wide total" cannot be arranged at all. */
async function dispatch(to: string, text: string): Promise<void> {
  await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to, text, from: SENSEI }),
  })
}

/** Fresh mail addressed to `queue`, returned as it appears in `reader`'s
 *  mailbox. Every consuming case makes its own rather than sharing the
 *  fixture's: a case that acks something another case depends on turns a suite
 *  into an ordering puzzle, and this file is meant to be read red. */
async function freshFor(queue: string, reader: string, title: string): Promise<Required<FetchedEvent>> {
  await createTask(title, queue)
  const box = await mailbox(reader)
  const found = box.find((e) => (e.data as { title?: string })?.title === title)
  if (!found) throw new Error(`"${title}" never reached ${reader}'s mailbox`)
  if (!found.code) throw new Error(`no ack code on event ${found.id}`)
  return found as Required<FetchedEvent>
}

async function ackAs(agent: string | undefined, pairs: { id: number; code: string }[]) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (agent) headers['x-jean-agent'] = agent
  const res = await fetch(`${base}/events/ack`, { method: 'POST', headers, body: JSON.stringify({ pairs }) })
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, headers: res.headers }
}

/** The inbox line the response carries for one agent, as a parsed object. */
async function inboxHeaderFor(agent: string): Promise<string | null> {
  const res = await fetch(`${base}/agents`, { headers: { 'x-jean-agent': agent } })
  await res.json()
  return res.headers.get('x-jean-inbox')
}

function ackEventsInLog(): { data: Record<string, unknown> }[] {
  const path = resolve(ROOT, 'history.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> })
    .filter((e) => e.type === 'ack')
}

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  process.env.JEAN_REGISTRY_PATH = REGISTRY_PATH
  handle = await createInfraServer({
    dataDir: ROOT,
    port: 0,
    enforceSingleInstance: false,
    writeRuntimeFiles: false,
    ports: { spawn: noSpawn },
  })
  base = `http://127.0.0.1:${handle.port}`
  const ws = `ws://127.0.0.1:${handle.port}/ws`
  sensei = await connectAgent(ws, SENSEI, 'sensei')
  workerA = await connectAgent(ws, A, 'worker')
  workerB = await connectAgent(ws, B, 'worker')

  // ── THE FIXTURE (§5) ──
  //
  // Built so no two mailboxes can hold the same number of events and none
  // holds the whole queue. THE NON-COINCIDENCE IS ASSERTED in the first test
  // below rather than trusted here.
  await createTask('alpha for A', A)
  await createTask('beta for A', A)
  await createTask('gamma for B', B)
  // Orchestrator-authored mail, so its own mailbox is smaller than the queue.
  await dispatch(A, 'start on alpha')
  await dispatch(B, 'start on gamma')
})

afterAll(async () => {
  sensei?.ws.close()
  workerA?.ws.close()
  workerB?.ws.close()
  await handle?.stop()
  if (savedRegistry === undefined) delete process.env.JEAN_REGISTRY_PATH
  else process.env.JEAN_REGISTRY_PATH = savedRegistry
})

// ── §5 — THE FIXTURE, THROUGH THE REAL SURFACES ──────────────────

describe('§5 — the live fixture is a discriminator', () => {
  test('no two agents’ mailboxes coincide, and none is the whole queue', async () => {
    const [sa, wa, wb, all] = await Promise.all([mailbox(SENSEI), mailbox(A), mailbox(B), observedQueue()])
    expect(all.length, 'anti-vacuity: the queue must be non-empty').toBeGreaterThan(0)
    expect(sa.length, 'anti-vacuity: the orchestrator must hold something').toBeGreaterThan(0)
    expect(wa.length, 'anti-vacuity: A must hold something').toBeGreaterThan(0)
    const sizes = [sa.length, wa.length, wb.length]
    expect(new Set(sizes).size, `mailbox sizes must be pairwise distinct, got ${sizes}`).toBe(sizes.length)
    for (const n of sizes) expect(n, 'nobody holds the whole queue').toBeLessThan(all.length)
  })
})

// ── P10 / TASK 059 — THE RESPONSE SHAPE ──────────────────────────

describe('P10 — a response tells the caller about the CALLER’s queue', () => {
  test('the ack response body carries no global count (059, fixed — the regression guard)', async () => {
    const target = await freshFor(B, B, 'ack-response-shape')
    const mine = await mailbox(B)
    const all = await observedQueue()
    expect(all.length, 'the global queue must exceed B’s mailbox or this proves nothing').toBeGreaterThan(mine.length)

    const { body } = await ackAs(B, [{ id: target.id, code: target.code }])
    expect(body).not.toHaveProperty('remaining')
    // Whatever numeric fields survive, none may be the global total: that is
    // exactly the shape 059 had, and the fixture guarantees the two numbers
    // differ so the check can actually fail.
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'number') {
        expect(value, `response field "${key}" is the global pending count`).not.toBe(all.length)
      }
    }
  })

  test('the x-jean-inbox header reports the caller’s own mailbox, and differs per agent', async () => {
    const [forA, forSensei] = await Promise.all([inboxHeaderFor(A), inboxHeaderFor(SENSEI)])
    // ATTACHMENT DEPENDS ON THE LIVE REGISTRY, so assert presence before
    // comparing — two nulls would "differ" from nothing and pass vacuously.
    expect(forA, 'A is connected, so the header must be attached').not.toBeNull()
    expect(forSensei, 'the orchestrator is connected, so the header must be attached').not.toBeNull()
    expect(forA).not.toEqual(forSensei)
  })

  test('the falling case: the header after an ack describes the post-ack queue', async () => {
    const target = await freshFor(A, A, 'falling-case')
    const before = await mailbox(A)
    const res = await fetch(`${base}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jean-agent': A },
      body: JSON.stringify({ pairs: [{ id: target.id, code: target.code }] }),
    })
    await res.json()
    const after = await mailbox(A)
    expect(
      after.map((e) => e.id),
      'the acked event is gone from A’s own mailbox',
    ).not.toContain(target.id)
    const header = res.headers.get('x-jean-inbox')
    if (header !== null) {
      // If a line rode the response, it must describe the queue this ack made —
      // never one assembled before it.
      const stale = before.length
      expect(header, `the header still reports ${stale}, the pre-ack count`).not.toContain(`${stale} queued`)
    }
  })
})

// ── P2 — ONE MEMBERSHIP FUNCTION, ACROSS THE HTTP SURFACES ───────

describe('P2 — the inspection surfaces and the mailbox must not be able to disagree', () => {
  test('REGISTER ROW 5: /events/pending?agent= and /events?for= answer different questions', async () => {
    const box = await mailbox(SENSEI)
    const res = await fetch(`${base}/events/pending?agent=${SENSEI}`)
    const inspection = ((await res.json()) as { events: { id: number }[] }).events
    expect(box.length, 'anti-vacuity: the orchestrator’s mailbox is non-empty').toBeGreaterThan(0)
    expect(
      inspection.map((e) => e.id).sort((x, y) => x - y),
      'P2: one membership function, so these are the same set',
    ).toEqual(box.map((e) => e.id).sort((x, y) => x - y))
  })

  test('REGISTER ROW 5: /events/agents disagrees with the mailboxes it summarises', async () => {
    const res = await fetch(`${base}/events/agents`)
    const counts = ((await res.json()) as { agents: Record<string, number> }).agents
    const box = await mailbox(SENSEI)
    expect(box.length, 'anti-vacuity').toBeGreaterThan(0)
    expect(counts[SENSEI] ?? 0, 'the summary must agree with the orchestrator’s mailbox').toBe(box.length)
  })
})

// ── P5 — AUTHORIZATION, WHICH ONLY EXISTS AT THIS BOUNDARY ───────

describe('P5 — an ack clears only when the caller is a recipient', () => {
  test('an observer read hands out codes for every pending event, including other agents’ mail', async () => {
    // Not a defect on its own — P5 says explicitly that recomputing a code is
    // harmless because "recomputing a code does not make the reader a
    // recipient". It is the PRECONDITION for the next test, asserted here so
    // that test's setup is not mistaken for the finding.
    const all = await observedQueue()
    expect(all.length).toBeGreaterThan(0)
    for (const e of all) expect(typeof e.code, `event ${e.id} came with a code`).toBe('string')
  })

  test('REGISTER ROW 3: a non-recipient with a valid code must clear nothing', async () => {
    const target = await freshFor(B, B, 'not-A-s-mail')
    const aBox = await mailbox(A)
    expect(
      aBox.map((e) => e.id),
      'precondition: the target is not in A’s mailbox',
    ).not.toContain(target.id)

    // A acks B's mail, identifying itself honestly as A.
    await ackAs(A, [{ id: target.id, code: target.code }])
    const after = await mailbox(B)
    expect(
      after.map((e) => e.id),
      'A is not a recipient of this event and must not be able to clear it (P5)',
    ).toContain(target.id)
  })
})

// ── P6 — ACCOUNTABLE CLEARING, IN THE DURABLE RECORD ─────────────

describe('P6 — the clearing record names the agent that cleared each pair', () => {
  test('REGISTER ROW 2: no ack event in the log names its caller', async () => {
    const acks = ackEventsInLog()
    expect(acks.length, 'anti-vacuity: acks have been written by earlier cases').toBeGreaterThan(0)
    const namesAnAgent = (data: Record<string, unknown>) => {
      const json = JSON.stringify(data)
      return [SENSEI, A, B].some((n) => json.includes(`"${n}"`))
    }
    const unattributed = acks.filter((e) => !namesAnAgent(e.data))
    expect(
      unattributed.length,
      `${unattributed.length} of ${acks.length} ack events name no clearer — ` +
        'every diagnosis of a vanished event has to hand-correlate two sessions’ timestamps',
    ).toBe(0)
  })
})

// ── §2 / P3 — INDEPENDENT ACKNOWLEDGEMENT, END TO END ────────────

describe('§2 + P3 — one agent’s ack must not consume another’s mail', () => {
  test('REGISTER ROW 1: a task event held by both worker and orchestrator survives one ack', async () => {
    const id = await createTask('jointly held', A)
    const aBox = await mailbox(A)
    const sBox = await mailbox(SENSEI)
    const inA = aBox.find((e) => (e.data as { title?: string })?.title === 'jointly held')
    const inS = sBox.find((e) => (e.data as { title?: string })?.title === 'jointly held')
    expect(inA, `task ${id}'s creation must be in A's mailbox`).toBeDefined()
    expect(inS, `task ${id}'s creation must be in the orchestrator's mailbox`).toBeDefined()

    // A reads and clears its own pair.
    await ackAs(A, [{ id: (inA as Required<FetchedEvent>).id, code: (inA as Required<FetchedEvent>).code }])
    const sAfter = await mailbox(SENSEI)
    expect(
      sAfter.map((e) => e.id),
      'the orchestrator never acknowledged this; A’s ack must not have consumed it (§2, P3)',
    ).toContain((inS as FetchedEvent).id)
  })
})

// ── SELECTORS — ADAPTER-ONLY BEHAVIOUR ───────────────────────────

describe('selector parsing — no silently-ignored parameter (task 018’s lesson)', () => {
  test('two selectors at once is a 400, not a guess', async () => {
    const res = await fetch(`${base}/events?for=${SENSEI}&ids=1&type=reply`)
    expect(res.status).toBe(400)
  })

  test('a selector without a reader is a 400 — a selector reads ONE mailbox', async () => {
    const res = await fetch(`${base}/events?ids=1`)
    expect(res.status).toBe(400)
  })

  test('well-formed ids outside the reader’s mailbox come back as `missing`, not as a disclosure', async () => {
    const other = (await freshFor(B, B, 'selector-miss')).id
    const res = await fetch(`${base}/events?for=${A}&ids=${other}`)
    const body = (await res.json()) as { events: FetchedEvent[]; missing?: number[] }
    expect(
      body.events.map((e) => e.id),
      'B’s event must not be handed to A',
    ).not.toContain(other)
    expect(body.missing ?? [], 'and the miss is reported explicitly').toContain(other)
  })
})
