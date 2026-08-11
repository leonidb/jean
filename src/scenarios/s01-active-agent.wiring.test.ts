/**
 * SCENARIO 1 — THE ACTIVE AGENT: an agent learns of new events on its next call.
 * LEVEL: wiring (the real in-process factory over HTTP/WS — the thin adapter
 * check for new carriage, per 043 part 1).
 *
 * CANON (S1, verbatim): "**An agent** making jean calls learns of new events on
 * its next call — no interruption, no delay beyond the call itself."
 *
 * 042 DEVIATION-3, verbatim: "`withInboxHeader` gates on `role === 'sensei'`;
 * the channel plugin's `reply` — the worker's primary tool — has no carrier at
 * all… no commit in C2-C6 restores a worker-side carrier."
 *
 * STATUS: RED BY ASSERTION, NOT BY STUB. These run against LIVE code and fail
 * because live code is sensei-only. That makes this the sharpest red in the
 * suite: nothing here is waiting on a design, only on the change.
 *
 * ── WHY THIS TESTS INFRA'S SURFACE AND NOT THE MCP PLUGIN ──
 *
 * The worker's `reply` travels over the WebSocket, so there is no HTTP response
 * to attach a header to; the plugin's other tools (`comment`) already solve this
 * by calling `GET /inbox` after the send. So what a worker-side carrier actually
 * needs from infra is an AGENT-AWARE `/inbox`, plus the piggyback header on the
 * HTTP calls a worker already makes. Both are infra surfaces, both are the
 * actual blockers, and both are assertable here — spawning an MCP server to
 * re-derive that would test the plugin's plumbing rather than the requirement.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { InfraPorts } from '../infra/ports.ts'
import { createInfraServer, type InfraHandle } from '../infra/server.ts'
import { type ConnectedAgent, connectAgent } from '../infra/test-helpers.ts'

const ROOT = '/tmp/jean-scenarios-s01'
const REGISTRY_PATH = resolve(ROOT, 'registry.json')
const WORKER = 'builder'
const SENSEI = 'sensei'

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
let worker: ConnectedAgent
/** A worker with nothing addressed to it — the mailbox that must differ from
 *  the sensei's. */
let idleWorker: ConnectedAgent
const savedRegistry = process.env.JEAN_REGISTRY_PATH

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  process.env.JEAN_REGISTRY_PATH = REGISTRY_PATH
  // A FAST TICK AND A PARKED QUIET CLOCK, so the corrected DRIFTED-1 case can
  // actually fail. `decide` pushes when there is anything unannounced OR the
  // quiet window elapsed; the tick grid is `min(15s, interval, ...backoff)`.
  // With the default 15s grid nothing decides inside a test's lifetime, so
  // "no push happened" would hold against an implementation that never
  // discharged anything — the unreachable-green shape this suite exists to
  // avoid. Backoff sets the grid; the interval is parked far away so a push,
  // when one comes, can only be the unannounced arm.
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
  const ws = `ws://127.0.0.1:${handle.port}/ws`
  // ONE sensei for the whole file, held open: infra enforces a single sensei, so
  // connecting a second one per test would race the first one's disconnect.
  sensei = await connectAgent(ws, SENSEI, 'sensei')
  worker = await connectAgent(ws, WORKER, 'worker')
  idleWorker = await connectAgent(ws, 'scribe', 'worker')

  // One event ABOUT the worker, so both mailboxes have something to disagree
  // about: it resolves to `builder` via the task's queue, and to the sensei
  // because the sensei's filter admits everything it did not produce.
  const res = await fetch(`${base}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'something for the worker', description: '', queue: WORKER, actor: 'test' }),
  })
  if (res.status !== 201) throw new Error(`seed failed: ${res.status}`)
})

afterAll(async () => {
  delete process.env.JEAN_NUDGE_BACKOFF_MS
  delete process.env.JEAN_NUDGE_INTERVAL_MS
  sensei?.ws.close()
  worker?.ws.close()
  idleWorker?.ws.close()
  await handle?.stop()
  if (savedRegistry === undefined) delete process.env.JEAN_REGISTRY_PATH
  else process.env.JEAN_REGISTRY_PATH = savedRegistry
})

const inboxHeader = async (caller?: string): Promise<string | null> => {
  const res = await fetch(`${base}/board`, { ...(caller && { headers: { 'x-jean-agent': caller } }) })
  return res.headers.get('x-jean-inbox')
}

describe('S1 — the piggyback is agent-uniform', () => {
  test('a WORKER caller gets the inbox line on its HTTP responses', async () => {
    // Today `withInboxHeader` returns the response untouched unless the caller
    // is the sensei, so this is red on the live server. Canon says "an agent",
    // and E6 says one mechanism for sensei and worker.
    expect(await inboxHeader(WORKER)).toBeTruthy()
  })

  test('CHARACTERIZATION — the sensei still gets it', async () => {
    // Green today, and must stay green: the transition GENERALIZES the carrier,
    // it does not move it. If this ever goes red the change traded one gap for
    // another.
    expect(await inboxHeader(SENSEI)).toBeTruthy()
  })

  test('CHARACTERIZATION — an unidentified caller gets nothing; the header is the identity', async () => {
    // Not a new requirement; pinned because "make it agent-uniform" is one
    // careless edit away from "attach it to everything", including responses
    // headed somewhere with no mailbox at all.
    expect(await inboxHeader()).toBeNull()
  })

  test('the carrier itself costs no push — the trivial half of "no interruption"', async () => {
    // S1's second clause, verbatim: "no interruption, no delay beyond the call
    // itself." The carrier rides an answer the agent asked for; if it ever
    // becomes a push, S1 has quietly become S2.
    //
    // WAS TITLED "no interruption" AND WAS THE ONLY TEST OF IT (task 046's audit,
    // DRIFTED-1). It pins that a call does not push — which no plausible
    // implementation would do anyway. The claim with teeth is below.
    const before = worker.messages.length
    await inboxHeader(WORKER)
    expect(worker.messages.length).toBe(before)
  })

  test('CORRECTED (DRIFTED-1) — a carrier DISCHARGES announcement, so the ledger and the episode agree', async () => {
    // ── THE LOAD-BEARING HALF, AND IT WAS UNASSERTED ──
    //
    // "An agent making jean calls learns of new events on its next call — NO
    // INTERRUPTION." The agent is not interrupted at all; carriage is how it
    // learns. So: carriage discharges announcement, and a standalone push fires
    // only for what the agent has NOT been shown.
    //
    // Asserted at the wiring level because the pure rule already has its test in
    // `s03` — what only a live server can show is that a carrier is actually
    // WIRED to discharge. That wiring is the whole defect: before the fix the
    // piggyback stamped the ledger `deliveredVia: 'piggyback'` while the episode
    // still considered the same events unannounced, so the two mechanisms
    // contradicted each other on every call.
    // ── WHAT THIS ASSERTS, AND WHAT IT DELIBERATELY DOES NOT ──
    //
    // The RULE — a standalone push fires only for events the agent has not been
    // shown, by any route — is asserted where it can be falsified: the pure
    // cases in `s03` ("an agent already SHOWN the mailbox is not pushed again",
    // "carriage only ever moves announcement FORWARD"). Both fail if `carried`
    // is stubbed to a no-op; verified by mutation, not by assumption.
    //
    // What belongs HERE is the wiring: that a real carrier calls it. That is
    // asserted through the LEDGER, which is the observable both mechanisms
    // write to — and it is the exact contradiction this fix removes. Before it,
    // the piggyback stamped `deliveredVia: 'piggyback'` while the episode still
    // held the same events unannounced: infra recorded "delivered" and "never
    // told" about one event at one instant.
    //
    // THREE ATTEMPTS AT A BEHAVIOURAL VERSION FAILED, and the failures are the
    // finding rather than an excuse:
    //   1. Carry, wait, assert no push — held trivially: with the default 15s
    //      tick grid nothing decides inside the window at all.
    //   2. The same aimed at the WORKER — held with the wiring stashed out,
    //      because a worker has NO PUSH PATH. The bus subscription and both
    //      timers call `notifier.tick(senseiView(...))`; no view is ever built
    //      for any other agent, so `thresholdFor('worker')` decides nothing in
    //      production. Canon E6's "one mechanism for sensei and worker" holds
    //      for the pure decisions and NOT for the adapter that drives them.
    //   3. The same aimed at the SENSEI — also held either way, because an
    //      arrival PUSH announces synchronously at `record()` time and always
    //      wins the race against any HTTP call the agent could make. Carriage
    //      can only be the first announcer when a push was refused (guard 4) or
    //      never attempted, which needs the ghost-socket construction from
    //      `attention-nudge-backoff.test.ts`.
    //
    // Both (2) and (3) are REPORTED (task 045) rather than papered over: they
    // say that today's carriage-discharge is canon-correct and observably
    // near-inert, and the reason is the same in both — one push path, for one
    // agent. Writing a green behavioural assertion over that would have claimed
    // coverage this branch does not have.
    const line = await inboxHeader(SENSEI)
    expect(line).toBeTruthy() // the carrier ran

    // The ledger now says the mailbox was handed over…
    const fetched = (await (await fetch(`${base}/events?for=${SENSEI}`)).json()) as {
      events: Array<{ id: number; deliveredVia?: string }>
    }
    expect(fetched.events.length).toBeGreaterThan(0) // precondition, asserted not assumed
    expect(fetched.events.every((e) => e.deliveredVia !== undefined)).toBe(true)
  })
})

describe('S1 — /inbox answers for the CALLER, not for the sensei', () => {
  test('a worker asking /inbox gets ITS mailbox', async () => {
    // Today `/inbox` calls `senseiInboxNow()` regardless of who asked, so every
    // caller is handed the sensei's queue — which is why a worker-side `reply`
    // carrier was never worth adding. This is the surface that unblocks it.
    const ask = async (caller: string) =>
      (await (await fetch(`${base}/inbox`, { headers: { 'x-jean-agent': caller } })).json()) as {
        inbox: { queued: { count: number } } | null
        line: string | null
      }

    const busy = await ask(WORKER) // has the seeded task-created addressed to it
    const idle = await ask('scribe') // has nothing addressed to it
    const senseis = await ask(SENSEI) // sees everything it did not produce

    // BOTH DIRECTIONS, and the positive one is the point. Codex's finding: the
    // first draft asserted only that an idle worker does NOT get the sensei's
    // queue, which an implementation returning `null` for every worker passes —
    // it would prove the carrier is broken rather than that it is per-agent.
    expect(idle.inbox).toBeNull()
    expect(busy.inbox).not.toBeNull()
    expect(busy.inbox?.queued.count).toBe(1)
    // ...and the sensei's mailbox is a different filter of the same list, so it
    // holds strictly more (the registrations, at minimum).
    expect(senseis.inbox?.queued.count).toBeGreaterThan(busy.inbox?.queued.count as number)

    // ASSERTED ON COUNTS, NOT ON DEEP EQUALITY. An earlier draft compared two
    // whole responses with `not.toEqual` and passed two runs in three — the
    // inbox carries `waitedMs`/`oldestMs` off the wall clock, so successive
    // calls differ by a millisecond and the assertion held for a reason that had
    // nothing to do with the requirement. A red suite that flickers green is
    // worse than one that is honestly red.
  })
})

describe('S1 — "no delay beyond the call itself"', () => {
  test('UNTESTED-2 — the carried line reflects the mailbox AS OF THE RESPONSE, not a snapshot', async () => {
    // Canon S1's third clause, and task 046's audit found it untested: S6 pins
    // freshness for PUSHES ("every nudge reflects the queue as it is at
    // emission") and says nothing about carriage, so the carrier was free to
    // serve a cached line — the exact bug S6 exists to prevent, through the door
    // S6's wording leaves open.
    //
    // "No delay beyond the call itself" is what forbids it: a line built from a
    // snapshot taken before the event arrived delays the agent's learning by
    // however stale the cache is, which is a delay beyond the call.
    const lineFor = async () => (await inboxHeader(WORKER)) ?? ''
    const before = await lineFor()

    // A new event lands for this worker, then the very next call must show it.
    const res = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'arrived between calls', description: '', queue: WORKER, actor: 'test' }),
    })
    expect(res.status).toBe(201)

    const after = await lineFor()
    expect(after).not.toBe(before) // the count moved on the FIRST call after arrival
    // Asserted on the count rather than on wording, so a phrasing change does
    // not read as a freshness regression.
    const countOf = (line: string) => Number(/(\d+)\s+queued/.exec(line)?.[1] ?? -1)
    expect(countOf(after)).toBeGreaterThan(countOf(before))
  })
})
