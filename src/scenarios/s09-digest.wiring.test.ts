/**
 * SCENARIO 9 — PARKED WORK STAYS VISIBLE (the DELIVERY half).
 * LEVEL: wiring (the real in-process factory — does the scheduled digest reach
 * the sensei, and does it arrive as a SCHEDULE rather than as an interrupt).
 *
 * CANON (S9, verbatim): "Externally-blocked tasks appear as a daily one-line
 * list with per-item age. They never interrupt and never silently vanish."
 *
 * O1 (039) settled the mechanism: calendar-like schedules ride the REGULAR
 * TRIGGER SCHEDULER — the same croner path that already runs the nightly
 * librarian — rather than a second clock inside attention. So the wiring claim
 * is narrow and checkable: a trigger exists, firing it delivers the digest to
 * the sensei, and nothing else does.
 *
 * 042 DEVIATION-5: the mechanism was settled and then no commit owned it. "A
 * settled mechanism with no owner is exactly how a scenario silently doesn't get
 * built" — which is why the delivery half gets its own file rather than being
 * assumed once `buildDigest` exists.
 *
 * STATUS: RED by assertion against live code — no digest trigger is registered,
 * so the first case fails on an empty list.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { Cron } from 'croner'
import type { InfraPorts } from '../infra/ports.ts'
import { createInfraServer, type InfraHandle } from '../infra/server.ts'
import { type ConnectedAgent, connectAgent } from '../infra/test-helpers.ts'

const ROOT = '/tmp/jean-scenarios-s09'
const REGISTRY_PATH = resolve(ROOT, 'registry.json')
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
const savedRegistry = process.env.JEAN_REGISTRY_PATH

type TriggerRow = { id: string; cron?: string; at?: string; agent: string; prompt: string; kind?: string }

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
  sensei = await connectAgent(`ws://127.0.0.1:${handle.port}/ws`, SENSEI, 'sensei')

  // One parked task, so the digest has something to say.
  const created = (await (
    await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'waiting on the vendor', description: '', queue: 'builder', actor: 'test' }),
    })
  ).json()) as { id: string }
  await fetch(`${base}/tasks/${created.id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'in-progress', actor: 'sensei' }),
  })
  await fetch(`${base}/tasks/${created.id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'waiting', actor: 'builder', blockedOn: 'external', blockedNote: 'vendor' }),
  })
})

afterAll(async () => {
  sensei?.ws.close()
  await handle?.stop()
  if (savedRegistry === undefined) delete process.env.JEAN_REGISTRY_PATH
  else process.env.JEAN_REGISTRY_PATH = savedRegistry
})

const triggers = async (): Promise<TriggerRow[]> =>
  ((await (await fetch(`${base}/triggers`)).json()) as { triggers: TriggerRow[] }).triggers

/** Gap between a cron's next two firings, in ms. Uses the scheduler's own
 *  parser rather than a regex over the expression, so `0 9 * * *` and
 *  `@daily` and anything else croner accepts are judged by what they DO. */
function cadenceMs(expr: string): number {
  const cron = new Cron(expr)
  const first = cron.nextRun()
  const second = first ? cron.nextRun(first) : null
  if (!first || !second) throw new Error(`cron never fires twice: ${expr}`)
  return second.getTime() - first.getTime()
}

/** Wait for `check` to hold, up to `budgetMs`. Replaces a fixed `Bun.sleep`:
 *  a sleep long enough to be safe is a slow suite, and one short enough to be
 *  fast is a flake. Codex's finding — the trigger path is fire-and-forget, so
 *  there is nothing to await, but there IS something to poll. */
async function until(check: () => boolean, budgetMs = 3000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
}

describe('S9 — the digest rides the regular trigger scheduler (O1)', () => {
  test('a DAILY digest trigger exists, addressed to the sensei', async () => {
    // The whole of DEVIATION-5 in one assertion: the mechanism was chosen and
    // nothing was ever registered on it.
    const rows = await triggers()
    const digest = rows.find((t) => /digest|parked/i.test(t.id) || /parked|blocked/i.test(t.prompt))
    expect(digest).toBeDefined()
    expect(digest?.agent).toBe(SENSEI)

    // DAILY IS ASSERTED, NOT JUST "SCHEDULED". Codex's finding: `cron` being
    // truthy admits hourly and monthly alike, and both break the requirement in
    // opposite directions — hourly is the interruption S9 forbids, monthly is
    // the silence it forbids. Judged by the gap between two firings rather than
    // by the expression's text, so any spelling croner accepts is fair.
    expect(digest?.cron).toBeTruthy()
    expect(cadenceMs(digest?.cron as string)).toBe(24 * 60 * 60_000)
  })

  test('firing it delivers the parked list to the sensei', async () => {
    const rows = await triggers()
    const digest = rows.find((t) => /digest|parked/i.test(t.id) || /parked|blocked/i.test(t.prompt))
    expect(digest).toBeDefined()

    const before = sensei.messages.length
    const fired = await fetch(`${base}/triggers/${digest?.id}/fire`, { method: 'POST' })
    expect(fired.status).toBe(200)

    // The delivery is the scheduler's normal one — no new transport, no second
    // clock. Polled rather than slept on: the trigger path is fire-and-forget,
    // so there is nothing to await, but a fixed sleep is either slow or flaky.
    await until(() => sensei.messages.length > before)
    const arrived = sensei.messages.slice(before)
    expect(arrived.length).toBeGreaterThan(0)
    expect(JSON.stringify(arrived)).toMatch(/waiting on the vendor/)
  })

  test('CHARACTERIZATION — never interrupts: parking a task pushes nothing on its own', async () => {
    // The requirement's other half. If parking a task produced a push, the
    // digest would be redundant and the "never interrupt" clause would already
    // be violated by the time it ran.
    const before = sensei.messages.length
    const created = (await (
      await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'also parked', description: '', queue: 'builder', actor: 'test' }),
      })
    ).json()) as { id: string }
    await fetch(`${base}/tasks/${created.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in-progress', actor: 'sensei' }),
    })
    await fetch(`${base}/tasks/${created.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'waiting', actor: 'builder', blockedOn: 'external', blockedNote: 'also vendor' }),
    })
    // A FIXED WAIT SURVIVES HERE, and only here: this asserts an ABSENCE, and
    // polling cannot establish one — `until` would return the instant the
    // condition it is waiting for stays false, which is immediately. The
    // trade-off is the honest one for a negative: a window long enough that a
    // push would have arrived within it, at the cost of 200ms.
    await Bun.sleep(200)
    const arrived = sensei.messages.slice(before)
    expect(JSON.stringify(arrived)).not.toMatch(/also parked/)
  })

  test('H3 (ruled 2026-08-11) — parking on time records the resume date, and unparking clears it', async () => {
    // The adapter half of the resume-date model: the date is accepted AT PARK
    // TIME on the same PATCH that parks, lands on the task, and leaves with
    // the park like blockedOn/blockedSince do — a stale date on a resumed
    // task would re-hide it on its next time-park.
    const created = (await (
      await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'september work', description: '', queue: 'builder', actor: 'test' }),
      })
    ).json()) as { id: string }
    await fetch(`${base}/tasks/${created.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in-progress', actor: 'sensei' }),
    })
    const resumeAt = '2026-09-01T09:00:00.000Z'
    const parked = (await (
      await fetch(`${base}/tasks/${created.id}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'waiting', actor: 'builder', blockedOn: 'time', resumeAt }),
      })
    ).json()) as { resumeAt?: string }
    expect(parked.resumeAt).toBe(resumeAt)

    const resumed = (await (
      await fetch(`${base}/tasks/${created.id}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'in-progress', actor: 'sensei' }),
      })
    ).json()) as { resumeAt?: string }
    expect(resumed.resumeAt).toBeUndefined()
  })

  test('the board records the park the digest reads from', async () => {
    // The seam between this file and `s09-digest.projection.test.ts`: the pure
    // side proves the list is right given board state, and this proves the
    // adapter actually produces that state. Neither alone would catch a
    // `blockedOn` that the API accepts and drops.
    const board = (await (await fetch(`${base}/board`)).json()) as {
      tasks: { title: string; status: string; blockedOn?: string }[]
    }
    const parked = board.tasks.find((t) => t.title === 'waiting on the vendor')
    expect(parked?.status).toBe('waiting')
    expect(parked?.blockedOn).toBe('external')
  })
})
