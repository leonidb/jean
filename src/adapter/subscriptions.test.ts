/**
 * The A-SUB forward half, and R14's composition laws over it (task E2).
 *
 * A subscription is a ROUTING RULE RECORDED AS DATA. The rule is stated once
 * — `tasks.autoSubscriptionsFor` — and used twice: the fold applies it on
 * replay (which IS the migration for old logs), and the shell APPENDS it
 * going forward so the log carries the subscription rather than leaving a
 * later reader to re-derive it. R14 makes the second half law: "(2)
 * auto-subscription events append AFTER their trigger, through the same
 * ingest path."
 *
 * ── WHY THIS FILE READS THE LOG FILE ──
 *
 * Nothing over the wire can see the difference. `subscribersOf` returns the
 * same set whether the shell appended or not, because the fold derives it
 * either way — so a test that only asks the API would stay green with the
 * append deleted. The log is the thing that changes, and the log is a file,
 * so this suite runs against a `dataDir` and reads it.
 *
 * ── AND WHY IT RESTARTS ──
 *
 * The mirror hazard: replay must NOT re-append what the fold already derives,
 * or every boot grows the log by one event per task, forever. That is
 * invisible to any single-process test. One restart over the same log, and a
 * before/after count, is the whole of it.
 *
 * ── NO SOCKETS HERE, DELIBERATELY ──
 *
 * The roster arrives as SEEDED `register` events rather than live sessions.
 * The first version of this file connected three agents, and closing them to
 * restart the server raced its own `disconnect` appends: the log length moved
 * under the assertion, and a pending append landed after the temp dir was
 * removed. Counting a log across a restart wants a log nothing else is
 * writing to.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { agents } from '../domain/agents/index.ts'
import type { TaskSubscribedData } from '../domain/contracts/vocabulary.ts'
import { tasks } from '../domain/tasks/index.ts'
import type { StoredEvent } from '../es/index.ts'
import { type AdapterHandle, createAdapterServer, replayInto } from './server.ts'

let dir: string
let server: AdapterHandle
let base: string

/** The dojo's roster, as history — the shape a real log holds. */
const SEED: StoredEvent[] = [
  {
    id: 1,
    ts: '2026-08-18T09:00:00.000Z',
    type: 'register',
    stream: 'agent-orchestrator-o',
    data: { agent: 'orchestrator-o', role: 'sensei', idle: true },
  },
  {
    id: 2,
    ts: '2026-08-18T09:00:01.000Z',
    type: 'register',
    stream: 'agent-worker-a',
    data: { agent: 'worker-a', role: 'worker', idle: true },
  },
  {
    id: 3,
    ts: '2026-08-18T09:00:02.000Z',
    type: 'register',
    stream: 'agent-worker-b',
    data: { agent: 'worker-b', role: 'worker', idle: true },
  },
]

beforeAll(async () => {
  dir = mkdtempSync(resolve(tmpdir(), 'jean-e2-subs-'))
  writeFileSync(resolve(dir, 'history.jsonl'), `${SEED.map((e) => JSON.stringify(e)).join('\n')}\n`)
  server = await createAdapterServer({ dataDir: dir })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function logged(): Promise<StoredEvent[]> {
  const text = await Bun.file(resolve(dir, 'history.jsonl')).text()
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StoredEvent)
}

const send = async (method: string, path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-jean-agent': 'orchestrator-o' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, never> }
}

/**
 * What the rule itself says should follow this event, computed the way the
 * shell must compute it: over the state INCLUDING the event (R14 law 1 — the
 * derivation reads the post-fold states of the same event).
 *
 * The expectation comes from the domain function rather than from a list of
 * names on purpose. A hard-coded "the queue and the orchestrator" would be
 * this file restating a domain rule — which is not the adapter suite's to
 * assert, and would need editing the day the automatic surface changes.
 */
function expectedFor(events: StoredEvent[], trigger: StoredEvent): string[] {
  const upto = events.slice(0, events.findIndex((e) => e.id === trigger.id) + 1)
  const state = replayInto(upto)
  return (
    tasks.autoSubscriptionsFor?.(
      trigger,
      (name) => agents.isDojoAgent(state.agents, name),
      agents.orchestratorOf(state.agents),
    ) ?? []
  ).map((s) => s.data.agent)
}

let taskId: string

describe('the automatic surface is written into the log, not left to be re-derived', () => {
  test('creation appends exactly the subscriptions the rule names, right after its trigger', async () => {
    const created = await send('POST', '/tasks', { title: 'wire the surfaces', queue: 'worker-a' })
    expect(created.status).toBe(201)
    taskId = (created.body as unknown as { id: string }).id

    const events = await logged()
    const trigger = events.find((e) => e.type === 'task-created')
    if (trigger === undefined) throw new Error('fixture: no task-created in the log')

    const written = events.filter((e) => e.type === 'task-subscribed')
    expect(written.map((e) => (e.data as TaskSubscribedData).agent).sort()).toEqual(expectedFor(events, trigger).sort())
    expect(written.length).toBeGreaterThan(0) // anti-vacuity: the rule named someone

    // LAW 2, the "AFTER" half: every one of them sits later in the log than
    // the event that implied it. A subscription written first would resolve
    // its own trigger differently on replay than it did live.
    for (const sub of written) expect(sub.id).toBeGreaterThan(trigger.id)

    // Subscriptions are always DATA and the log says who wrote them.
    for (const sub of written) expect((sub.data as TaskSubscribedData).actor).toBe('infra')
  })

  test('LAW 1: the creation itself reaches the subscribers its own derivation just created', async () => {
    // This is the fold-order law made observable. Resolve BEFORE folding the
    // task and the subscriber set is still empty at that instant, so a
    // `task-created` addresses nobody and every task in the dojo silently
    // starts life undelivered.
    const res = await fetch(`${base}/events?agent=worker-a`)
    const mail = (await res.json()) as { events: { type: string; stream: string }[] }
    expect(mail.events.some((e) => e.type === 'task-created' && e.stream === `task-${taskId}`)).toBe(true)
  })

  test('a reassignment appends the new owner’s subscription; a description edit appends nothing', async () => {
    const before = (await logged()).filter((e) => e.type === 'task-subscribed').length

    const edit = await send('PATCH', `/tasks/${taskId}`, { description: 'now with more detail' })
    expect(edit.status).toBe(200)
    expect((await logged()).filter((e) => e.type === 'task-subscribed').length).toBe(before)

    const moved = await send('PATCH', `/tasks/${taskId}`, { agent: 'worker-b' })
    expect(moved.status).toBe(200)
    const after = await logged()
    const reassign = after.find((e) => e.type === 'task-updated' && (e.data as { agent?: string }).agent === 'worker-b')
    if (reassign === undefined) throw new Error('fixture: no reassigning task-updated in the log')

    const fresh = after.filter((e) => e.type === 'task-subscribed' && e.id > reassign.id)
    expect(fresh.map((e) => (e.data as TaskSubscribedData).agent)).toEqual(expectedFor(after, reassign))
    expect(fresh.length).toBe(1)
  })
})

describe('replay does not re-append what the fold already derives', () => {
  test('a restart over the same log leaves it exactly as long as it was', async () => {
    const before = await logged()
    server.stop()

    // Same directory, same log, new process-lifetime.
    const second = await createAdapterServer({ dataDir: dir })
    const afterBoot = await logged()

    // The boot replay goes through `absorb`, not `record`. Through `record`
    // it would re-append every automatic subscription on every boot — the log
    // growing by one event per task per restart, forever, with nothing
    // failing and every projection still correct.
    expect(afterBoot.length).toBe(before.length)

    // And the derivation SURVIVED the replay rather than merely not
    // duplicating: the task's subscribers are unchanged across the restart,
    // which is the migration half of the one rule doing its job.
    const res = await fetch(`http://127.0.0.1:${second.port}/tasks/${taskId}/unsubscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jean-agent': 'orchestrator-o' },
      body: JSON.stringify({ agent: 'worker-a' }),
    })
    expect(res.status).toBe(200) // a 409 `not-subscribed` would mean the set came back empty
    second.stop()

    // Restore the server this file's afterAll stops.
    server = await createAdapterServer({ dataDir: dir })
    base = `http://127.0.0.1:${server.port}`
  })
})
