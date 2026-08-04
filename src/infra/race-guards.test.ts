/**
 * THE SEVEN RACE GUARDS — deterministic interleaving tests (refactor stage 3,
 * phase A; task 033, spec = task 029 D2 STAGE 3).
 *
 * WHY THIS FILE EXISTS, and why it lands BEFORE the extraction. server.ts holds
 * seven documented guards against interleaving across `record()`'s await. Every
 * one was found by review or by a deterministic repro — none had a test. They
 * are precisely the class 029 D3 named as "what a green suite would NOT catch",
 * so a refactor that moves this logic is reviewed on assurance rather than
 * evidence unless they are pinned first. These tests are written against
 * PRE-REFACTOR behaviour, go green against it, and must stay green through the
 * move.
 *
 * ── THE TECHNIQUE: a gated store ──
 *
 * Six of the seven guards protect a window straddling `await store.append(...)`.
 * Stage 2 made `store` a port, so a test can inject one whose `append` PARKS on
 * a chosen event type until released. That turns "win a race" into "step the
 * machine": no sleeps, no timing tolerances, no flakes. The 20-way interleave
 * that originally found the ack race is replaced by two requests and a release.
 *
 * ── THE ONE THAT IS NOT HERE ──
 *
 * Guard 4 (`if (!landed) return`, in all THREE push paths) is absent BY
 * MEASUREMENT, not by omission. Its precondition is a sensei that findSensei()
 * still returns but whose deliver() refuses — entry present, transport dead.
 * Polling as fast as HTTP allows after a client close, the server's close
 * handler always wins and the entry is simply GONE; there is no observable
 * window. No second route exists either: WS is the only sensei registration
 * path, the duplicate-session path clears ws.data.agent before closing so it
 * leaves no dead entry, and the bridge/peer paths register 'user'/'peer'. The
 * guard is closure-scoped behind a transport that cannot be made to fail on
 * command — which is itself the coupling stage 3 removes. It is covered in
 * phase B as a pure core test with a per-path mutation check (see the task).
 */

import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { createStore, type EventStore, jsonlBackend, type StoredEvent } from '../es/index.ts'
import type { Inbox } from './inbox.ts'
import type { InfraPorts } from './ports.ts'
import type { OutboundMsg } from './protocol.ts'
import { createInfraServer, type InfraHandle } from './server.ts'
import { type ConnectedAgent, connectAgent } from './test-helpers.ts'

const ROOT = '/tmp/jean-test-race-guards'

const neverSpawn = (async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
  timedOut: false,
})) as unknown as InfraPorts['spawn']

/**
 * A store whose appends of a chosen type park until released.
 *
 * `append` is the ONLY thing wrapped: the guards all straddle that one await,
 * and leaving reads untouched keeps the server's startup and projection replay
 * behaving exactly as they do in production.
 */
function gatedStore(inner: EventStore) {
  let gatedType: string | null = null
  const parked: (() => void)[] = []
  return {
    store: {
      ...inner,
      async append(input: Parameters<EventStore['append']>[0]): Promise<StoredEvent> {
        if (gatedType !== null && input.type === gatedType) {
          await new Promise<void>((release) => parked.push(release))
        }
        return inner.append(input)
      },
    } as EventStore,
    /** Park every subsequent append of `type` (null = park nothing). */
    gate(type: string | null) {
      gatedType = type
    },
    parkedCount: () => parked.length,
    /** Release everything currently parked. Returns how many. */
    release(): number {
      const n = parked.length
      for (const r of parked.splice(0)) r()
      return n
    },
  }
}

type Harness = {
  handle: InfraHandle
  base: string
  wsUrl: string
  gated: ReturnType<typeof gatedStore>
  /** Everything infra has pushed to the sensei since connect. */
  senseiPushes: () => string[]
  sensei: ConnectedAgent
  agents: ConnectedAgent[]
}

let live: Harness | null = null

async function harness(name: string, opts: { withUser?: boolean } = {}): Promise<Harness> {
  const dataDir = resolve(ROOT, name)
  rmSync(dataDir, { recursive: true, force: true })
  mkdirSync(dataDir, { recursive: true })

  const gated = gatedStore(createStore(jsonlBackend(resolve(dataDir, 'history.jsonl'))))
  const handle = await createInfraServer({
    dataDir,
    port: 0,
    enforceSingleInstance: false,
    writeRuntimeFiles: false,
    ports: { spawn: neverSpawn, log: () => {}, store: gated.store },
  })
  const base = `http://127.0.0.1:${handle.port}`
  const wsUrl = `ws://127.0.0.1:${handle.port}/ws`

  const sensei = await connectAgent(wsUrl, 'sensei', 'sensei')
  const agents: ConnectedAgent[] = [sensei]
  if (opts.withUser) agents.push(await connectAgent(wsUrl, 'chat-human', 'user'))

  const h: Harness = {
    handle,
    base,
    wsUrl,
    gated,
    sensei,
    agents,
    senseiPushes: () =>
      sensei.messages
        .filter((m): m is OutboundMsg & { type: 'deliver'; from: string; text: string } => m.type === 'deliver')
        .filter((m) => m.from === 'infra')
        .map((m) => m.text),
  }
  live = h
  return h
}

afterEach(async () => {
  if (!live) return
  for (const a of live.agents) a.ws.close()
  live.gated.gate(null)
  live.gated.release()
  await live.handle.stop()
  live = null
})

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})

// ── small helpers over the HTTP surface ──────────────────────────

async function pending(h: Harness): Promise<{ id: number; type: string }[]> {
  const r = await fetch(`${h.base}/events/pending`)
  return ((await r.json()) as { events: { id: number; type: string }[] }).events
}

async function history(h: Harness): Promise<{ type: string; data: Record<string, unknown> }[]> {
  const r = await fetch(`${h.base}/history`)
  return ((await r.json()) as { events: { type: string; data: Record<string, unknown> }[] }).events
}

/** Ack everything currently pending, so a test starts from a known-empty queue. */
async function drain(h: Harness): Promise<void> {
  const ids = (await pending(h)).map((e) => e.id)
  if (ids.length === 0) return
  await fetch(`${h.base}/events/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
}

/** Mark the sensei idle again (the Stop-hook post). Also re-arms nudging. */
async function senseiIdle(h: Harness): Promise<void> {
  await fetch(`${h.base}/agent-idle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'sensei' }),
  })
}

/** A human-origin (BLOCKING) event: a `reply` whose sender is a user. */
function humanSays(h: Harness, text: string, from = 'chat-human'): void {
  h.sensei.ws.send(JSON.stringify({ type: 'reply', from, text }))
}

/** Wait until `pred` holds, polling the event loop. Never a fixed sleep: every
 *  wait here is for an observable, so a slow machine costs time, not a flake. */
async function until(pred: () => boolean | Promise<boolean>, budgetMs = 3000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await pred()) return true
    await Bun.sleep(5)
  }
  return pred()
}

/**
 * The inbox JSON that renderInboxWake embeds in every push.
 *
 * Note the retry loop rather than first-`{`-to-last-`}`: the wake's trailing
 * instructions contain `ack({upToId: ...})` and `ack({ids: [...]})`, so the last
 * `}` in the message is prose, not JSON. Walking the candidate closes backwards
 * finds the real end without depending on that sentence's wording.
 */
function inboxOf(pushText: string): Inbox | null {
  const start = pushText.indexOf('{')
  if (start === -1) return null
  for (let end = pushText.lastIndexOf('}'); end > start; end = pushText.lastIndexOf('}', end - 1)) {
    try {
      const parsed = JSON.parse(pushText.slice(start, end + 1)) as Inbox
      if (parsed && typeof parsed === 'object' && 'queued' in parsed) return parsed
    } catch {
      // keep walking back
    }
  }
  return null
}

const blockingPushes = (h: Harness) => h.senseiPushes().filter((t) => t.startsWith('A human is waiting'))
const nudgeEvents = async (h: Harness) => (await history(h)).filter((e) => e.type === 'nudge')

/** Pushes that actually CARRY an inbox. Deliberately not `senseiPushes().at(-1)`:
 *  the sensei's connect greeting is also an infra push and carries no inbox, so
 *  taking the last push outright reads `undefined` and the assertion below would
 *  be measuring the greeting rather than a wake. */
const inboxPushes = (h: Harness): Inbox[] =>
  h
    .senseiPushes()
    .map(inboxOf)
    .filter((i): i is Inbox => i !== null)

const latestInbox = (h: Harness): Inbox | undefined => inboxPushes(h).at(-1)

// ── the guards ───────────────────────────────────────────────────

describe('race guard 1 + 3 — burst coalescing across record()s await', () => {
  test('two blocking arrivals that BOTH capture hadBlockingBefore=false produce exactly ONE wake', async () => {
    const h = await harness('guard-1-3')
    await drain(h)
    const wakesBefore = blockingPushes(h).length

    // Park both replies before either applies to the projection, so both
    // observe an empty blocking queue and both call onBlockingArrival(false).
    // This is the interleave guard 1 captures and guard 3 then de-duplicates.
    h.gated.gate('reply')
    humanSays(h, 'first question')
    humanSays(h, 'second question')
    expect(await until(() => h.gated.parkedCount() === 2)).toBe(true)

    h.gated.gate(null)
    expect(h.gated.release()).toBe(2)

    // Both land in pending...
    expect(await until(async () => (await pending(h)).filter((e) => e.type === 'reply').length === 2)).toBe(true)
    // ...but the episode fired ONE wake, not two. Without guard 3's 30s
    // duplicate check the second arrival would wake again immediately.
    expect(await until(() => blockingPushes(h).length > wakesBefore)).toBe(true)
    await Bun.sleep(150) // give a second (wrong) wake time to show up
    expect(blockingPushes(h).length - wakesBefore).toBe(1)

    const blockingNudges = (await nudgeEvents(h)).filter((e) => e.data.blocking === true)
    expect(blockingNudges).toHaveLength(1)
  })
})

describe('race guard 2 — enteredPending is checked by id, not by length', () => {
  test('an ack that shrinks the queue mid-append does not swallow the new events nudge', async () => {
    const h = await harness('guard-2')
    await drain(h)

    // One machine event sits pending, and the sensei has already been nudged
    // for it (so nudgeCount > 0 and the "first nudge always fires" arm is out).
    await fetch(`${h.base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'first', queue: 'builder' }),
    })
    expect(await until(async () => (await pending(h)).length === 1)).toBe(true)
    const first = (await pending(h))[0] as { id: number }
    await senseiIdle(h)
    const nudgesBefore = (await nudgeEvents(h)).length

    // Now: a second event parks mid-append, and while it is parked the first is
    // acked. Queue length is 1 before and 1 after — a length-compare would
    // conclude "nothing entered" and skip the dispatch entirely.
    h.gated.gate('task-created')
    const post = fetch(`${h.base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'second', queue: 'builder' }),
    })
    expect(await until(() => h.gated.parkedCount() === 1)).toBe(true)

    await fetch(`${h.base}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [first.id] }),
    })
    expect(await until(async () => (await pending(h)).length === 0)).toBe(true)

    h.gated.gate(null)
    h.gated.release()
    await post

    // The id check sees the new event in pending and dispatches.
    expect(await until(async () => (await nudgeEvents(h)).length > nudgesBefore)).toBe(true)
    expect(await until(async () => (await pending(h)).length === 1)).toBe(true)
  })
})

describe('race guard 5 — the idle gate is checked BEFORE episode bookkeeping', () => {
  test('a nudge suppressed because the sensei is busy does not consume the content-changed signal', async () => {
    const h = await harness('guard-5')
    await drain(h)

    // Nudge #1: establishes nudgeCount > 0 and sets maxNudgedPendingId, and
    // leaves the sensei busy (every landed push sets idle = false).
    await fetch(`${h.base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'one', queue: 'builder' }),
    })
    expect(await until(async () => (await nudgeEvents(h)).length >= 1)).toBe(true)
    const afterFirst = (await nudgeEvents(h)).length

    // A second event arrives while the sensei is BUSY. nudgeSenseiIfIdle returns
    // at the idle gate. If that early return sat AFTER the bookkeeping,
    // maxNudgedPendingId would advance to this event and its arrival would never
    // be announced — the mid-turn event that is never mentioned at turn-end.
    await fetch(`${h.base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'two', queue: 'builder' }),
    })
    expect(await until(async () => (await pending(h)).length === 2)).toBe(true)
    expect((await nudgeEvents(h)).length).toBe(afterFirst) // suppressed, as designed

    // Turn end. The backoff window has NOT elapsed, so the only thing that can
    // produce a nudge here is the content-changed signal surviving the suppression.
    await senseiIdle(h)
    expect(await until(async () => (await nudgeEvents(h)).length > afterFirst)).toBe(true)
  })
})

describe('race guard 6 — recordAck claims ids synchronously, with no await in between', () => {
  test('two concurrent acks for the same id produce exactly ONE ack event', async () => {
    const h = await harness('guard-6')
    await drain(h)

    await fetch(`${h.base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'contended', queue: 'builder' }),
    })
    expect(await until(async () => (await pending(h)).length === 1)).toBe(true)
    const target = (await pending(h))[0] as { id: number }

    const ackBody = JSON.stringify({ ids: [target.id] })
    const ackOnce = () =>
      fetch(`${h.base}/events/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: ackBody,
      }).then((r) => r.json() as Promise<{ acknowledged: number }>)

    // Park the first ack's append, so the second arrives while the first is
    // mid-write — the exact window that produced 20 ack events for one id.
    h.gated.gate('ack')
    const a = ackOnce()
    expect(await until(() => h.gated.parkedCount() === 1)).toBe(true)
    const b = ackOnce()
    // The second must drop out on the in-flight reservation, WITHOUT parking:
    // it never reaches the append at all.
    await Bun.sleep(100)
    expect(h.gated.parkedCount()).toBe(1)

    h.gated.gate(null)
    h.gated.release()
    const [ra, rb] = await Promise.all([a, b])

    // Exactly one writer owned the id; the other cleared nothing.
    expect(ra.acknowledged + rb.acknowledged).toBe(1)
    const acks = (await history(h)).filter((e) => e.type === 'ack')
    expect(acks).toHaveLength(1)
    expect((acks[0]?.data as { eventIds: number[] }).eventIds).toEqual([target.id])
  })
})

describe('race guard 7 — routeSend snapshots the auto-clear candidate at ENTRY', () => {
  test('a human message that arrives mid-send is never auto-cleared by that send', async () => {
    const h = await harness('guard-7', { withUser: true })
    await drain(h)

    // Sensei sends to the human with NOTHING blocking pending, so the entry
    // snapshot is null. Park the send's own append.
    h.gated.gate('send')
    const send = fetch(`${h.base}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'sensei', to: 'chat-human', text: 'proactive ping' }),
    })
    expect(await until(() => h.gated.parkedCount() === 1)).toBe(true)

    // The human asks something WHILE that send is in flight. It was never
    // visible to the sender, so answering it is not an acknowledgement of it.
    h.gated.gate(null)
    humanSays(h, 'a question the sensei has not seen')
    expect(await until(async () => (await pending(h)).some((e) => e.type === 'reply'))).toBe(true)

    h.gated.release()
    await send

    // Computed at the TAIL instead of at entry, the send would have found
    // exactly one blocking event and auto-cleared a question nobody read.
    await Bun.sleep(150)
    const stillPending = (await pending(h)).filter((e) => e.type === 'reply')
    expect(stillPending).toHaveLength(1)
    const autoClears = (await history(h)).filter((e) => e.type === 'ack' && e.data.auto === 'reply')
    expect(autoClears).toHaveLength(0)
  })
})

describe('scenario 6 — fresh counts: every nudge reflects the queue AT EMISSION', () => {
  test('counts rise with arrivals and FALL after acks — never a stored snapshot', async () => {
    const h = await harness('scenario-6')
    await drain(h)
    // Connecting the sensei queues its own `register`, which nudges — and every
    // landed nudge sets idle=false. Without this the first assertion below would
    // be measuring the idle gate, not the counts.
    await senseiIdle(h)

    const newTask = (title: string) =>
      fetch(`${h.base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, queue: 'builder' }),
      })

    // One event → the wake carries a queue of 1.
    await newTask('a')
    expect(await until(() => latestInbox(h)?.queued.count === 1)).toBe(true)

    // Two events → the NEXT wake carries 2, not a re-sent 1.
    await senseiIdle(h)
    await newTask('b')
    expect(await until(() => latestInbox(h)?.queued.count === 2)).toBe(true)

    // The falling case is the one a cached snapshot gets wrong: drain to a
    // single event and the next wake must say 1 again, not 2 or 3.
    await drain(h)
    await senseiIdle(h)
    await newTask('c')
    expect(await until(() => latestInbox(h)?.queued.count === 1)).toBe(true)
    // ...and it genuinely went 1 → 2 → 1 rather than only ever rising.
    expect(inboxPushes(h).map((i) => i.queued.count)).toEqual([1, 2, 1])

    // And the recorded nudge agrees with what was delivered — the count is
    // computed once, at emission, for both surfaces.
    const nudges = await nudgeEvents(h)
    expect((nudges.at(-1)?.data as { pendingCount: number }).pendingCount).toBe(1)
  })
})
