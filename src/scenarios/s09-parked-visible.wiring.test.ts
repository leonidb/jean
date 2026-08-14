/**
 * SCENARIO 9 — PARKED WORK STAYS VISIBLE (the ADAPTER half).
 * LEVEL: wiring (the real in-process factory — does parking a task actually
 * produce the state and the reminders the core half reasons about).
 *
 * CANON (S9, verbatim): "Externally-blocked tasks appear as a daily one-line
 * list with per-item age. They never interrupt and never silently vanish."
 *
 * ── O1'S MECHANISM IS GONE, AND ITS ABSENCE IS THE FIRST ASSERTION ──
 *
 * 039's O1 settled that the digest rides the regular trigger scheduler, and
 * infra seeded a `parked-digest` cron on every boot. Deleted 2026-08-14: a
 * scheduled job fires whether or not anything is parked, and measurably did —
 * three mornings out of three, producing nothing each time. Leonid: "Ideally,
 * this one also should not fire if there are no waiting events. It should not
 * fire at all."
 *
 * Parked work is now carried by per-task reminder events on the blocker's own
 * clock, so the wake cannot exist unless something is parked. The first case
 * below therefore asserts the trigger is NOT there — an inversion of what this
 * file used to open with, and the cheapest place for a resurrected seeding
 * block to be caught.
 *
 * The clocks are shortened by env for this file, so a "daily" reminder is
 * observable in a test rather than a day away.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
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
  // The three reminder clocks, compressed so this file can watch them elapse.
  process.env.JEAN_SENSEI_REMINDER_MS = '60'
  process.env.JEAN_HUMAN_REMINDER_MS = '80'
  process.env.JEAN_DAILY_REMINDER_MS = '100'
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
  delete process.env.JEAN_SENSEI_REMINDER_MS
  delete process.env.JEAN_HUMAN_REMINDER_MS
  delete process.env.JEAN_DAILY_REMINDER_MS
})

const triggers = async (): Promise<TriggerRow[]> =>
  ((await (await fetch(`${base}/triggers`)).json()) as { triggers: TriggerRow[] }).triggers

/** Wait for `check` to hold, up to `budgetMs`. Replaces a fixed `Bun.sleep`:
 *  a sleep long enough to be safe is a slow suite, and one short enough to be
 *  fast is a flake. Codex's finding — the trigger path is fire-and-forget, so
 *  there is nothing to await, but there IS something to poll. */
async function until(check: () => boolean | Promise<boolean>, budgetMs = 3000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(10)
}

/** The reminder events in the sensei's mailbox — the replacement mechanism's
 *  whole observable surface. */
const reminders = async (): Promise<Array<{ data: { to?: string; queued?: boolean; taskId?: string } }>> => {
  const body = (await (await fetch(`${base}/events/pending`)).json()) as {
    events: Array<{ type: string; data: { to?: string; queued?: boolean; taskId?: string } }>
  }
  return body.events.filter((e) => e.type === 'task-reminder')
}

describe('S9 — no scheduled job, and no parked task left silent', () => {
  test('NO built-in digest trigger is seeded — the inversion of what this file used to assert', async () => {
    // `parked-digest` was created at every boot, keyed by id so a deliberate
    // removal survived restarts. The seeding block is deleted; this is where a
    // resurrected one gets caught, and it is cheap enough to be worth pinning.
    const rows = await triggers()
    expect(rows.find((t) => /digest|parked/i.test(t.id))).toBeUndefined()
  })

  test('a parked task produces a REMINDER EVENT addressed to the sensei — no push, no schedule', async () => {
    // The replacement mechanism, end to end through the adapter: the board
    // records the park, the supervisor's clock elapses, and the reminder enters
    // the sensei's mailbox as an ordinary event with a code.
    await until(async () => (await reminders()).length > 0)
    const rows = await reminders()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]?.data.to).toBe(SENSEI)
    expect(rows[0]?.data.queued).toBe(true)
  })

  test('CHARACTERIZATION — never interrupts: parking a task pushes nothing on its own', async () => {
    // The requirement's other half. If parking produced a push, "never
    // interrupt" would already be violated by the time anything reminded.
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
    // polling cannot establish one. The trade-off is the honest one for a
    // negative — a window long enough that a push would have arrived.
    await Bun.sleep(200)
    const arrived = sensei.messages.slice(before)
    expect(JSON.stringify(arrived)).not.toMatch(/also parked/)
  })
})

describe('S9 — the park is a contract the adapter enforces', () => {
  test('A TASK CANNOT BE PARKED ON NOBODY — waiting without a blocker is refused', async () => {
    // Ruled 2026-08-14. `blockedOn` was optional and an absent value fell back
    // to nagging the sensei, which invented an answer to "who is this waiting
    // on?" and put the task where the human could never see it.
    const created = (await (
      await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'parked on nobody', description: '', queue: 'builder', actor: 'test' }),
      })
    ).json()) as { id: string }
    await fetch(`${base}/tasks/${created.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in-progress', actor: 'sensei' }),
    })
    const refused = await fetch(`${base}/tasks/${created.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'waiting', actor: 'sensei' }),
    })
    expect(refused.status).toBe(400)
    // …and the task did not move. A refusal that half-applied would be worse
    // than none: the caller would believe it parked.
    const after = (await (await fetch(`${base}/tasks/${created.id}`)).json()) as { status: string }
    expect(after.status).toBe('in-progress')
  })

  test('THE SNOOZE rides any blocker, and unparking clears it', async () => {
    // `resumeAt` used to be rejected unless `blockedOn === 'time'`, which forced
    // a conversion that lost who the task was actually waiting on — and made
    // the auto-restore expensive. It is a cadence modifier now, valid anywhere.
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
        body: JSON.stringify({ status: 'waiting', actor: 'builder', blockedOn: 'human', resumeAt }),
      })
    ).json()) as { resumeAt?: string; blockedOn?: string }
    // The blocker SURVIVES the snooze — that is what makes the restore free.
    expect(parked.resumeAt).toBe(resumeAt)
    expect(parked.blockedOn).toBe('human')

    const resumed = (await (
      await fetch(`${base}/tasks/${created.id}/status`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'in-progress', actor: 'sensei' }),
      })
    ).json()) as { resumeAt?: string }
    expect(resumed.resumeAt).toBeUndefined()
  })

  test('an unparseable snooze date is refused rather than silently kept', async () => {
    const created = (await (
      await fetch(`${base}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'bad date', description: '', queue: 'builder', actor: 'test' }),
      })
    ).json()) as { id: string }
    await fetch(`${base}/tasks/${created.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in-progress', actor: 'sensei' }),
    })
    const refused = await fetch(`${base}/tasks/${created.id}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'waiting', actor: 'sensei', blockedOn: 'human', resumeAt: 'next tuesday' }),
    })
    expect(refused.status).toBe(400)
  })

  test('the board records the park the reminders read from', async () => {
    // The seam between this file and the core half: the pure side proves the
    // clocks are right given board state, and this proves the adapter actually
    // produces that state. Neither alone would catch a `blockedOn` that the API
    // accepts and drops.
    const board = (await (await fetch(`${base}/board`)).json()) as {
      tasks: { title: string; status: string; blockedOn?: string }[]
    }
    const parked = board.tasks.find((t) => t.title === 'waiting on the vendor')
    expect(parked?.status).toBe('waiting')
    expect(parked?.blockedOn).toBe('external')
  })
})
