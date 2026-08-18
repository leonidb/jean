/**
 * THE TWO TIMING INVARIANTS — behavioural halves (task 074).
 * LEVEL: wiring (real in-process server; invariant 2 injects the deliver port).
 *
 * Companions to `core/timing-welds.test.ts`, and the division of labour is the
 * point: the welds pin the SOURCE SHAPE (no async boundary in the window),
 * because a microtask-sized break preserves ordering under bun's scheduler
 * almost always and no behavioural test can reliably see it. These cases pin
 * the OBSERVABLE CONTRACT — what the welds are FOR — so that a rewrite which
 * respects the letter of the welds but re-plumbs the mechanism (a different
 * append path, announcement moved to a timer) still goes red.
 *
 * Together with the welds, either failure mode of task 073's extraction is
 * loud: sever a link structurally and the welds catch it; preserve the links
 * but change what they carry and these catch it.
 *
 * INVARIANT 1 — the delivery ledger survives contended acknowledgement.
 * `deliveredViaFor` (the PRODUCTION reading rule: first ack in log order) must
 * answer with the delivery mark for an event that was demonstrably delivered,
 * even when two callers ack it concurrently — the take-order/append-order
 * pairing is exactly what makes the authoritative ack the one carrying the
 * mark. `ack-concurrency.wiring.test.ts` pins one contended pair by array
 * index; this file reads the log through the production reader over several
 * contended events, so a break shows up as the reader's own wrong answer —
 * "delivery unknown" for a delivered event.
 *
 * INVARIANT 2 — announcement rides the record, not a later clock.
 * A queued addressed event's wake is pushed to its recipient DURING the
 * `record()` call that admits it — before the HTTP request that caused it gets
 * its response, and therefore before any subsequent request (a sensei draining
 * its mailbox) can run. That ordering is the probe's whole survivability: the
 * subject is woken before anyone else can clear the jointly-held payload out
 * from under it. The deliver port is injected here, so the push is observed at
 * the port — the same seam the decoupling will preserve.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { StoredEvent } from '../es/index.ts'
import type { InfraPorts } from '../infra/ports.ts'
import { createInfraServer, type InfraHandle } from '../infra/server.ts'
import { deliveredViaFor } from '../infra/target/codes.ts'
import { type ConnectedAgent, connectAgent } from '../infra/test-helpers.ts'

const SENSEI = 'sensei'
const WORKER = 'worker-a'

const noSpawn = (async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
  timedOut: false,
})) as unknown as InfraPorts['spawn']

const savedRegistry = process.env.JEAN_REGISTRY_PATH

// ── INVARIANT 1 — the ledger under contended acknowledgement ─────

describe('invariant 1 — deliveredViaFor answers for every delivered event, contention or not', () => {
  const ROOT = '/tmp/jean-scenarios-timing-ledger'
  let handle: InfraHandle
  let base: string
  let sensei: ConnectedAgent

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(ROOT, { recursive: true })
    process.env.JEAN_REGISTRY_PATH = resolve(ROOT, 'registry.json')
    handle = await createInfraServer({
      dataDir: ROOT,
      port: 0,
      enforceSingleInstance: false,
      writeRuntimeFiles: false,
      ports: { spawn: noSpawn },
    })
    base = `http://127.0.0.1:${handle.port}`
    sensei = await connectAgent(`ws://127.0.0.1:${handle.port}/ws`, SENSEI, 'sensei')
  })

  afterAll(async () => {
    sensei?.ws.close()
    await handle?.stop()
    if (savedRegistry === undefined) delete process.env.JEAN_REGISTRY_PATH
    else process.env.JEAN_REGISTRY_PATH = savedRegistry
  })

  /** Seed one pending event and return the `{id, code}` that clears it. The
   *  ADDRESSED fetch is what stamps the delivery mark the ledger must carry —
   *  the same discipline as ack-concurrency's seed, for the same reason. */
  async function seed(title: string): Promise<{ id: number; code: string }> {
    await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, description: '', queue: 'builder', actor: 'test' }),
    })
    const fetched = (await (await fetch(`${base}/events?for=${SENSEI}`)).json()) as {
      events: { id: number; code?: string; data: { title?: string } }[]
    }
    const found = fetched.events.find((e) => e.data?.title === title)
    if (!found?.code) throw new Error(`seed ${title} did not reach pending with a code`)
    return { id: found.id, code: found.code }
  }

  const ack = (pairs: { id: number; code: string }[]) =>
    fetch(`${base}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairs }),
    }).then((r) => r.json())

  function log(): StoredEvent[] {
    const path = resolve(ROOT, 'history.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as StoredEvent)
  }

  test('three delivered events, each acked by two concurrent callers — the reader never answers "unknown"', async () => {
    const pairs = [await seed('ledger-a'), await seed('ledger-b'), await seed('ledger-c')]
    for (const pair of pairs) {
      await Promise.all([ack([pair]), ack([pair])])
    }

    const events = log()
    for (const pair of pairs) {
      // ANTI-VACUITY FIRST: the contention must have really happened — two ack
      // events per id (append-unconditionally, fold decides). One means the
      // second caller saw post-append state and the case degenerates to the
      // uncontended path, which asserts nothing about the pairing.
      const acks = events.filter(
        (e) =>
          e.type === 'ack' &&
          ((e.data as { eventIds?: number[] }).eventIds?.includes(pair.id) ||
            (e.data as { pairs?: { id: number }[] }).pairs?.some((p) => p.id === pair.id)),
      )
      expect(acks.length, `event ${pair.id}: both concurrent acks must have appended`).toBe(2)

      // The take-once property, per event: the SECOND ack's ledger entry for
      // this id carries no mark — takeFor deleted the in-memory entry when the
      // first caller took it. Both marked would mean the take stopped being
      // destructive; neither marked is the weld broken from the other side.
      const second = acks[1] as StoredEvent
      const secondEntry = (second.data as { ledger?: Record<string, { deliveredVia?: string }> }).ledger?.[
        String(pair.id)
      ]
      expect(secondEntry?.deliveredVia, `event ${pair.id}: the losing ack must carry no mark`).toBeUndefined()

      // THE CONTRACT, through the production reader: the first-in-log ack is
      // the authoritative one, and it must be the one carrying the mark —
      // which is only true while take order and append order are the same
      // thing. "undefined" here is the reader saying "delivery unknown" about
      // an event this very test watched being delivered. WHICH via won is a
      // delivery race (the notifier's wake and the addressed fetch both stamp;
      // first-delivery-wins) and deliberately not pinned — the weld is about
      // the mark being on the authoritative ack, not about who delivered.
      expect(
        deliveredViaFor(events, pair.id),
        `event ${pair.id} was demonstrably delivered, yet the authoritative ack carries no mark — ` +
          'the take/append pairing has come apart (weld 1)',
      ).toBeTruthy()
    }
  })

  test('the uncontended path reads identically — one ack, marked, authoritative', async () => {
    const pair = await seed('ledger-lone')
    await ack([pair])
    expect(deliveredViaFor(log(), pair.id)).toBeTruthy()
  })
})

// ── INVARIANT 2 — announcement rides the record ──────────────────

describe('invariant 2 — the wake is pushed during record(), before anything else can run', () => {
  const ROOT = '/tmp/jean-scenarios-timing-announce'
  let handle: InfraHandle
  let base: string
  let sensei: ConnectedAgent
  let worker: ConnectedAgent
  /** Every push, in port-call order: `deliver→<agent>`. The injected port IS
   *  the observation point — the same seam production wakes leave through. */
  const trace: string[] = []

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(ROOT, { recursive: true })
    process.env.JEAN_REGISTRY_PATH = resolve(ROOT, 'registry.json')
    handle = await createInfraServer({
      dataDir: ROOT,
      port: 0,
      enforceSingleInstance: false,
      writeRuntimeFiles: false,
      ports: {
        spawn: noSpawn,
        // Always lands. Recording replaces transport: WS clients see nothing,
        // the trace sees everything, and landing=true keeps the notifier's
        // commit-iff-landed path on its ordinary branch.
        deliver: (agent) => {
          trace.push(`deliver→${agent}`)
          return true
        },
      },
    })
    base = `http://127.0.0.1:${handle.port}`
    const ws = `ws://127.0.0.1:${handle.port}/ws`
    // The sensei's connect greeting rides the deliver port now, so the helper's
    // greeting wait resolves by its timer — slower, not wrong.
    sensei = await connectAgent(ws, SENSEI, 'sensei')
    worker = await connectAgent(ws, WORKER, 'worker')
  })

  afterAll(async () => {
    sensei?.ws.close()
    worker?.ws.close()
    await handle?.stop()
    if (savedRegistry === undefined) delete process.env.JEAN_REGISTRY_PATH
    else process.env.JEAN_REGISTRY_PATH = savedRegistry
  })

  test('an event addressed to the worker wakes the worker within the request that recorded it', async () => {
    const before = trace.length
    // task-created for the worker's queue: enters pending, resolves to the
    // worker, and sits at the worker's push threshold — the same
    // queued-addressed shape as the probe, reachable without a 24h clock.
    await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'wake rides the record', description: '', queue: WORKER, actor: 'test' }),
    })
    // BY THE TIME THE RESPONSE EXISTS, the wake has left through the port.
    // record() is awaited inside the handler and the publish→sweep→deliver
    // chain is synchronous inside record(), so the push cannot lag the
    // response. If announcement moved to the notify timer (its floor is
    // seconds), this slice is empty and the test is red — that regression is
    // invisible to the structural welds, which is why this case exists.
    expect(
      trace.slice(before),
      'the worker was not pushed during the recording request — announcement no longer rides record()',
    ).toContain(`deliver→${WORKER}`)
  })

  test('the probe scenario: the subject is woken before a draining sensei can clear the payload', async () => {
    const before = trace.length
    await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'jointly held payload', description: '', queue: WORKER, actor: 'test' }),
    })
    // The jointly-held shape: in the worker's mailbox (queue owner) AND the
    // sensei's universal one — like the probe, either holder can destroy it
    // today (register row 1). Survivability = the subject's wake precedes any
    // chance the other holder gets to act.
    const wokeAt = trace.indexOf(`deliver→${WORKER}`, before)
    expect(wokeAt, 'precondition: the subject was woken at all').toBeGreaterThanOrEqual(before)

    // NOW the sensei drains — fetch-with-codes, ack everything. This is the
    // exact motion the supervision comment warns about.
    const drainedFrom = trace.length
    const fetched = (await (await fetch(`${base}/events?for=${SENSEI}`)).json()) as {
      events: { id: number; code: string }[]
    }
    expect(fetched.events.length, 'anti-vacuity: the drain must have something to destroy').toBeGreaterThan(0)
    await fetch(`${base}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairs: fetched.events.map((e) => ({ id: e.id, code: e.code })) }),
    })

    // The ordering that keeps the probe honest: the subject's wake is in the
    // trace BEFORE the drain began. Not "eventually delivered" — delivered
    // first. An async announcement makes this a race the subject can lose;
    // today it cannot lose it, and that is the behaviour under pin.
    expect(
      wokeAt,
      'the drain ran before the subject was woken — a probed agent can now be reported down for missing a question it was never asked',
    ).toBeLessThan(drainedFrom)
  })
})
