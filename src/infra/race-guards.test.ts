/**
 * THE RACE GUARDS — deterministic interleaving tests (refactor stage 3, phase A;
 * task 033, spec = task 029 D2 STAGE 3).
 *
 * ── SEVEN, THEN THREE: RETIREMENT, NOT EROSION (task 045) ──
 *
 * The transition retired guards 5, 6 and 7 by deleting the machinery each one
 * guarded — the idle gate, the ack claim, auto-clear-on-reply. Each retirement
 * is recorded in full at the foot of this file, with what replaced it where
 * anything did. Guard 1's case survives with an AMENDMENT (its property changed;
 * the note is at the assertion), guard 2 and scenario 6 survive on their own
 * terms with fixtures re-aimed at the new push threshold, and guard 4 — absent
 * here by measurement, see below — is now testable and IS tested, at the
 * integration level in `attention-nudge-backoff.test.ts`.
 *
 * A guard file that shrinks needs to say which of the two things happened, or
 * the next reader cannot tell coverage that was removed on purpose from coverage
 * that quietly rotted.
 *
 * WHY THIS FILE EXISTS, and why it landed BEFORE the extraction. server.ts held
 * seven documented guards against interleaving across `record()`'s await. Every
 * one was found by review or by a deterministic repro — none had a test. They
 * are precisely the class 029 D3 named as "what a green suite would NOT catch",
 * so a refactor that moves this logic is reviewed on assurance rather than
 * evidence unless they are pinned first. That reasoning is why the file outlived
 * the guards it was written for: the transition is a rewrite of exactly this
 * logic, and a rewrite reviewed on assurance is the thing 029 D3 warned about.
 *
 * ── THE TECHNIQUE: a gated store ──
 *
 * The surviving guards protect a window straddling `await store.append(...)`.
 * Stage 2 made `store` a port, so a test can inject one whose `append` PARKS on
 * a chosen event type until released. That turns "win a race" into "step the
 * machine": no sleeps, no timing tolerances, no flakes. The 20-way interleave
 * that originally found the ack race is replaced by two requests and a release.
 *
 * ── THE ONE THAT IS NOT HERE ──
 *
 * Guard 4 (`if (!landed) return`) is absent BY MEASUREMENT, not by omission. Its
 * precondition is a sensei that findSensei() still returns but whose deliver()
 * refuses — entry present, transport dead. Polling as fast as HTTP allows after
 * a client close, the server's close handler always wins and the entry is simply
 * GONE; there is no observable window from here. The guard is closure-scoped
 * behind a transport that cannot be made to fail on command — which is itself
 * the coupling stage 3 removes.
 *
 * IT IS REACHABLE ELSEWHERE, and that is where it now lives: a session that
 * registers as `sensei` and then re-registers on the SAME socket under a second
 * name moves `ws.data.agent`, so the close handler removes only the second name
 * and the `sensei` entry outlives its transport. `attention-nudge-backoff.test.ts`
 * builds exactly that and asserts the guard's three consequences — no `nudge`
 * event, no ledger stamp, and nothing marked announced.
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

/** Ack everything currently pending, so a test starts from a known-empty queue.
 *
 *  OLD: `{ids}`. That form is gone with `upToId` and for the same reason — an id
 *  is knowable from the cheap summary rung, a code is not, so only the pair form
 *  proves the queue was read (S5). The unaddressed fetch is deliberate: a test
 *  clearing the queue is an observer, and only an ADDRESSED read stamps the
 *  delivery ledger. */
async function drain(h: Harness): Promise<void> {
  const { events } = (await (await fetch(`${h.base}/events`)).json()) as {
    events: { id: number; code: string }[]
  }
  if (events.length === 0) return
  await fetch(`${h.base}/events/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairs: events.map((e) => ({ id: e.id, code: e.code })) }),
  })
}

// (`senseiIdle` lived here — the Stop-hook post that re-armed nudging. Nothing
//  needs re-arming: `/agent-idle` reports activity and arms nothing, so every
//  call to it in this file was removed rather than kept as a no-op that reads
//  like setup.)

/** A human-origin (highest-priority) event: a `reply` whose sender is a user. */
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
 * instructions contain `ack({pairs: [{id, code}, ...]})`, so the last `}` in the
 * message is prose, not JSON. Walking the candidate closes backwards finds the
 * real end without depending on that sentence's wording — which is exactly what
 * let this helper survive the ack contract changing underneath it.
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

/** OLD: `t.startsWith('A human is waiting')`. The blocking wake was a separate
 *  path with its own text; there is one push path now and a human is simply the
 *  highest-priority sender, so the oracle is the push itself. */
const blockingPushes = (h: Harness) => h.senseiPushes().filter((t) => t.startsWith('Events pending'))
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

describe('race guard 1 + 3 — arrivals across record()s await', () => {
  test('each arrival is pushed exactly ONCE, and the last push carries both', async () => {
    // ── AMENDMENT TO THE CASUALTY LIST, AND THE ONE THAT MATTERED ──
    //
    // Task 043 part 3 put guards 1/2/3 in the MUST STAY GREEN column. Guard 2
    // did. This one could not, and the gap is a behaviour change rather than a
    // broken fixture, so it is recorded rather than adapted into agreement:
    //
    // OLD: both replies capture `hadBlockingBefore = false` across the append
    // await, so both call `onBlockingArrival(false)` — guard 1 preserved the
    // pre-append observation, and guard 3's 30s duplicate check then collapsed
    // the pair into ONE wake. The old wake was a fixed-text ALARM ("A human is
    // waiting"), and a second identical alarm 80ms later says nothing the first
    // did not, so coalescing was free.
    //
    // NEW: neither mechanism exists — no PublishContext to capture into, no
    // episode to de-duplicate within — and the count is 2, not 1. The reason is
    // structural and worth naming precisely: `record()` applies and publishes
    // one event at a time, so the decision triggered by the first reply sees a
    // mailbox containing only the first. It announces through what it can see;
    // the second is genuinely unannounced when its own publish comes round.
    //
    // Is that right? S3 says an event at or above the threshold is pushed
    // "ONCE, on arrival", per event — so two arrivals, two pushes, and each
    // push carries the mailbox as of ITS emission, which the second assertion
    // below pins. What the sources do NOT settle is VOLUME: nothing says what a
    // ten-message burst should cost in interrupts, and the old design's dedupe
    // is evidence somebody once thought it mattered. RAISED for ruling (task
    // 045). If coalescing is ruled back in, THIS COUNT is the line that moves.
    //
    // What the case still pins, either way, is the half a bookkeeping bug
    // breaks: exactly one push PER arrival. An `announcedThroughId` that failed
    // to advance would re-push both on the next tick, and the assertion is a
    // hard `=== 2` rather than a floor so that it can see that.
    const h = await harness('guard-1-3')
    await drain(h)
    const wakesBefore = blockingPushes(h).length

    // Park both replies before either applies to the projection.
    h.gated.gate('reply')
    humanSays(h, 'first question')
    humanSays(h, 'second question')
    expect(await until(() => h.gated.parkedCount() === 2)).toBe(true)

    h.gated.gate(null)
    expect(h.gated.release()).toBe(2)

    // Both land in pending...
    expect(await until(async () => (await pending(h)).filter((e) => e.type === 'reply').length === 2)).toBe(true)
    expect(await until(() => blockingPushes(h).length - wakesBefore === 2)).toBe(true)
    await Bun.sleep(150) // give a third (wrong) push time to show up
    expect(blockingPushes(h).length - wakesBefore).toBe(2)

    // OLD: `nudgeEvents` filtered on `data.blocking === true`. That field is
    // gone — priority is opaque to every agent-facing surface, and the event log
    // is the most durable one. What the record must still show is the queue as
    // of each telling (S6): the second push saw both replies, so a re-sent
    // stale count is visible here even though the push COUNT looks right.
    const nudges = await nudgeEvents(h)
    expect(nudges).toHaveLength(2)
    expect((nudges.at(-1)?.data as { pendingCount: number }).pendingCount).toBe(2)
  })
})

describe('race guard 2 — what has been announced is tracked by id, not by length', () => {
  test('an ack that shrinks the queue mid-append does not swallow the new events push', async () => {
    // The guard survives the transition with its name intact and its subject
    // moved one layer: `enteredPending` compared the queue before and after,
    // and `announcedThroughId` now carries the same burden — "is there anything
    // here I have not said yet?". A length-compare answers that wrongly in
    // exactly one situation, and this is it.
    //
    // WHAT MOVED IN THE FIXTURE: the events are human-origin rather than
    // `task-created`. A routine machine event is below the sensei's push
    // threshold (S3), so with tasks the arrival path is never entered and the
    // case would pass without touching the mechanism it names — a green test
    // measuring nothing, which in this file is the worst outcome available.
    const h = await harness('guard-2')
    await drain(h)

    // One event sits pending and has already been pushed, so
    // `announcedThroughId` is at its id — the "nothing has ever been announced"
    // arm is out of the way.
    humanSays(h, 'first')
    expect(await until(async () => (await pending(h)).length === 1)).toBe(true)
    expect(await until(() => blockingPushes(h).length > 0)).toBe(true)
    const first = (await pending(h))[0] as { id: number }
    const pushesBefore = blockingPushes(h).length

    // Now: a second event parks mid-append, and while it is parked the first is
    // acked. Queue length is 1 before and 1 after — a length-compare would
    // conclude "nothing entered" and skip the dispatch entirely.
    h.gated.gate('reply')
    humanSays(h, 'second')
    expect(await until(() => h.gated.parkedCount() === 1)).toBe(true)

    const { events } = (await (await fetch(`${h.base}/events`)).json()) as {
      events: { id: number; code: string }[]
    }
    const firstPair = events.find((e) => e.id === first.id)
    await fetch(`${h.base}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairs: [{ id: firstPair?.id, code: firstPair?.code }] }),
    })
    expect(await until(async () => (await pending(h)).length === 0)).toBe(true)

    h.gated.gate(null)
    h.gated.release()

    // The id check sees the new event unannounced and dispatches.
    expect(await until(() => blockingPushes(h).length > pushesBefore)).toBe(true)
    expect(await until(async () => (await pending(h)).length === 1)).toBe(true)
  })
})

describe('scenario 6 — fresh counts: every push reflects the queue AT EMISSION', () => {
  test('counts rise with arrivals and FALL after acks — never a stored snapshot', async () => {
    const h = await harness('scenario-6')
    await drain(h)

    // WHAT MOVED: the events are human-origin rather than `task-created`, for
    // the same reason as guard 2 — a routine machine event does not reach the
    // sensei's push threshold (S3), so with tasks there would be no push to
    // carry a count and the case would assert nothing. Human messages group
    // under `blocking` in the rendered inbox rather than `queued`, which is a
    // rendering difference and not the subject: what is under test is that the
    // number in the payload is computed AT EMISSION.
    //
    // The old `senseiIdle(h)` calls between arrivals are gone with the gate they
    // re-armed; nothing needs to be re-armed for an arrival to push now.
    const blockingCount = () => latestInbox(h)?.blocking?.[0]?.count

    // One event → the push carries a queue of 1.
    humanSays(h, 'a')
    expect(await until(() => blockingCount() === 1)).toBe(true)

    // Two events → the NEXT push carries 2, not a re-sent 1.
    humanSays(h, 'b')
    expect(await until(() => blockingCount() === 2)).toBe(true)

    // The falling case is the one a cached snapshot gets wrong: drain to a
    // single event and the next push must say 1 again, not 2 or 3.
    await drain(h)
    humanSays(h, 'c')
    expect(await until(() => blockingCount() === 1)).toBe(true)
    // ...and it genuinely went 1 → 2 → 1 rather than only ever rising.
    expect(inboxPushes(h).map((i) => i.blocking?.[0]?.count)).toEqual([1, 2, 1])

    // And the recorded nudge agrees with what was delivered — the count is
    // computed once, at emission, for both surfaces.
    const nudges = await nudgeEvents(h)
    expect((nudges.at(-1)?.data as { pendingCount: number }).pendingCount).toBe(1)
  })
})

// ── THREE GUARDS RETIRED WITH THEIR QUESTIONS (task 045) ───────────────
//
// All three were PRE-DECLARED casualties (task 043 part 3). They are recorded
// here rather than deleted quietly because a guard file that shrinks silently is
// indistinguishable from a guard file that eroded — and the mutation harness
// header says the same thing in the same words.
//
// GUARD 5 — `the idle gate is checked BEFORE episode bookkeeping`. It pinned an
// ORDERING inside a suppression path: a nudge suppressed because the sensei was
// busy must not consume the content-changed signal, or the mid-turn event is
// never mentioned at turn-end. There is no idle gate to check before or after
// anything (canon E3), so there is no ordering left to get wrong. The property
// it ultimately protected — a new event is not silently marked as told — is
// guard 2's, above, and guard 2 survives.
//
// GUARD 6 — `recordAck claims ids synchronously, with no await in between`, and
// its WELD in `core/boundary.test.ts`. The claim machinery is deleted:
// fold-decides (task 041, ruled) has every ack append unconditionally, because
// the pending reducer's `filter` was already idempotent and the claim was a
// redundant second layer. `exactly ONE ack event` is now the NEGATION of the
// design — N concurrent acks write N events on purpose — and the replacement
// asserts that directly in `src/scenarios/ack-concurrency.wiring.test.ts`,
// including the half that mattered most: the FIRST ack in log order carries the
// ledger, so a later empty ack cannot overwrite a delivery that happened.
//
// GUARD 7 — `routeSend snapshots the auto-clear candidate at ENTRY`, and its
// WELD. Auto-clear-on-reply is deleted whole (S5: `{id, code}` pairs are the
// only clearing path), so a send has no candidate to snapshot at entry or
// anywhere else. NOTE, because it is the more interesting half: this case was
// still PASSING at the point the machinery was removed — nothing auto-clears, so
// "the question was not auto-cleared" is trivially true. A guard that cannot
// fail is worse than an absent one, since it reads as coverage.
