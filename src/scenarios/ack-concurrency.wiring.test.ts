/**
 * FOLD-DECIDES ACKS, AT THE WRITE SITE — the assertion no fold test can make.
 * LEVEL: wiring (two concurrent acks through the real in-process server).
 *
 * The EIGHTEENTH file, and it exists because of a defect in this suite's own
 * first draft. 041's handoff named three genuinely-new ack assertions, and
 * `ledger-rule.projection.test.ts` claimed the first of them ("two ack events
 * for ONE id both land in the log") while BUILDING the two-ack log by hand. It
 * passed on arrival. A projection test cannot make this claim: whether a second
 * ack event is ever written is a property of `recordAck`, not of the fold.
 *
 * ── WHAT DIES HERE, AND THE OLD→NEW JUSTIFICATION ──
 *
 * OLD (main, at the wiring-guard ordering commit): `recordAck` claims ids synchronously against
 * `ackInFlight` (race guard 6) and returns `[]` if another writer owns them, so
 * ONE ack event exists and the losing caller is told `acknowledged: 0`. The
 * guard-6 integration test asserts exactly that.
 *
 * NEW: append unconditionally, let the fold decide (041, ruled). TWO ack events
 * exist, and BOTH callers are told the ids are cleared — Leonid's second
 * correction, verbatim: "Ack is idempotent, you should just know the message is
 * acked." No claim machinery, no per-caller attribution, no hook on `record()`.
 * The ledger rides the FIRST event in log order (ruling 3), which is also the
 * one whose `takeFor` found the delivery mark.
 *
 * ── WHY NO GATED STORE IS NEEDED TO MAKE THIS DETERMINISTIC ──
 *
 * The claim is taken SYNCHRONOUSLY, before `recordAck`'s first await — that is
 * the weld `core/boundary.test.ts` asserts structurally. So whichever way two
 * concurrent requests interleave, the second one loses today: either it sees the
 * id in `ackInFlight`, or it sees the id already gone from pending. Both paths
 * return `[]` and write nothing. The test is therefore red for one reason, not
 * flaky between two.
 *
 * STATUS: RED by assertion against live code.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { InfraPorts } from '../infra/ports.ts'
import { createInfraServer, type InfraHandle } from '../infra/server.ts'
import { type ConnectedAgent, connectAgent } from '../infra/test-helpers.ts'

const ROOT = '/tmp/jean-scenarios-ack'
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

type AckEvent = { type: string; data: { eventIds?: number[]; ledger?: Record<string, { deliveredVia?: string }> } }

function ackEvents(): AckEvent[] {
  const path = resolve(ROOT, 'history.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as AckEvent)
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
  sensei = await connectAgent(`ws://127.0.0.1:${handle.port}/ws`, SENSEI, 'sensei')
})

afterAll(async () => {
  sensei?.ws.close()
  await handle?.stop()
  if (savedRegistry === undefined) delete process.env.JEAN_REGISTRY_PATH
  else process.env.JEAN_REGISTRY_PATH = savedRegistry
})

/** Put one event in pending and return its id. */
async function seed(title: string): Promise<number> {
  await fetch(`${base}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, description: '', queue: 'builder', actor: 'test' }),
  })
  const pending = (await (await fetch(`${base}/events`)).json()) as {
    events: { id: number; data: { title?: string } }[]
  }
  const found = pending.events.find((e) => e.data?.title === title)
  if (!found) throw new Error(`seed ${title} did not reach pending`)
  return found.id
}

const ack = async (ids: number[]) =>
  (await (
    await fetch(`${base}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
  ).json()) as { acknowledged: number }

describe('two concurrent acks for one id', () => {
  test('BOTH callers are told the id is cleared — idempotent responses', async () => {
    // Today the loser gets `acknowledged: 0`, because the claim machinery
    // decided the question "who cleared it?" — a distinction Leonid's second
    // correction deleted as one nobody needs.
    const id = await seed('idempotent-responses')
    const [a, b] = await Promise.all([ack([id]), ack([id])])
    expect(a.acknowledged).toBe(1)
    expect(b.acknowledged).toBe(1)
  })

  test('TWO ack events land in the log — append unconditionally', async () => {
    // The assertion the projection level cannot make, and the direct inverse of
    // the guard-6 integration test's "exactly one ack event exists".
    const id = await seed('two-events-in-the-log')
    await Promise.all([ack([id]), ack([id])])
    const mine = ackEvents().filter((e) => e.data.eventIds?.includes(id))
    expect(mine).toHaveLength(2)
  })

  test('the FIRST ack in log order carries the ledger (ruling 3)', async () => {
    // The carrier and the authority coincide by construction: the first writer's
    // `takeFor` found the in-memory delivery mark, the second's found nothing.
    // A reader taking the LATEST would report "delivery unknown" for an event
    // that was demonstrably delivered — guard 6's founding failure, arriving
    // back through the reading direction.
    const id = await seed('first-in-log-carries-the-ledger')
    await Promise.all([ack([id]), ack([id])])
    const mine = ackEvents().filter((e) => e.data.eventIds?.includes(id))
    expect(mine).toHaveLength(2)
    expect(mine[0]?.data.ledger?.[String(id)]?.deliveredVia).toBeTruthy()
    expect(mine[1]?.data.ledger?.[String(id)]?.deliveredVia).toBeUndefined()
  })

  test('CHARACTERIZATION — the queue is unharmed either way; the second ack is a no-op', async () => {
    const id = await seed('queue-unharmed')
    await Promise.all([ack([id]), ack([id])])
    const pending = (await (await fetch(`${base}/events`)).json()) as { events: { id: number }[] }
    expect(pending.events.map((e) => e.id)).not.toContain(id)
  })

  test('CHARACTERIZATION — a lone ack still reports one and writes one event', async () => {
    // The uncontended path must not change. Everything above is about what
    // happens when two writers collide; if the ordinary case moved too, the
    // change was bigger than it was ruled to be.
    const id = await seed('lone-ack')
    expect((await ack([id])).acknowledged).toBe(1)
    expect(ackEvents().filter((e) => e.data.eventIds?.includes(id))).toHaveLength(1)
  })
})
