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

  test('CHARACTERIZATION — no interruption: learning on the next call costs no push', async () => {
    // S1's second clause, verbatim: "no interruption, no delay beyond the call
    // itself." The carrier rides an answer the agent asked for; if it ever
    // becomes a push, S1 has quietly become S2.
    const before = worker.messages.length
    await inboxHeader(WORKER)
    expect(worker.messages.length).toBe(before)
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
