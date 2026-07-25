// Attention phase 4 — the minimal delivery ledger (docs/attention.md
// "Observability"). Two facts per event and no more: how it reached the agent
// (`deliveredVia`: wake | piggyback | heartbeat) and what cleared it
// (`clearedBy`: ack | auto-clear). Live on GET /events, materialized onto the
// `ack` event so the answer to "did this ever actually get delivered, and how"
// comes out of the event log instead of a day of watchdog archaeology.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'
import { connectAgent } from './test-helpers.ts'

const TEST_PORT = 8824
const DATA_DIR = '/tmp/jean-test-attention-ledger'
let server: Subprocess

beforeAll(async () => {
  try {
    rmSync(DATA_DIR, { recursive: true })
  } catch {}
  mkdirSync(DATA_DIR, { recursive: true })
  server = Bun.spawn(['bun', 'run', 'src/infra/server.ts'], {
    env: {
      ...process.env,
      JEAN_PORT: String(TEST_PORT),
      JEAN_DATA_DIR: DATA_DIR,
      JEAN_STALL_NUDGE_MS: String(60_000), // keep the heartbeat out of the way
    },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  for (let i = 0; i < 20; i++) {
    try {
      await fetch(`http://127.0.0.1:${TEST_PORT}/`)
      break
    } catch {
      await Bun.sleep(100)
    }
  }
})

afterAll(() => {
  server.kill()
})

const BASE = `http://127.0.0.1:${TEST_PORT}`
const WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`

type LedgerEntry = { deliveredVia?: string; clearedBy?: string }
type PendingEvent = { id: number; type: string; deliveredVia?: string; data: { text?: string; agent?: string } }

/** Read pending WITHOUT the sensei header — a headered read would itself stamp
 *  the piggyback (the header rides on the response, after the body is built). */
async function pending(): Promise<PendingEvent[]> {
  return ((await (await fetch(`${BASE}/events`)).json()) as { events: PendingEvent[] }).events
}

async function ackIds(ids: number[]) {
  await fetch(`${BASE}/events/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
}

/** The most recent `ack` event's ledger, from history. */
async function lastAck(): Promise<{ auto?: string; ledger?: Record<string, LedgerEntry> } | undefined> {
  const hist = (await (await fetch(`${BASE}/history?last=40`)).json()) as {
    events: Array<{ type: string; data: { auto?: string; ledger?: Record<string, LedgerEntry> } }>
  }
  return hist.events.filter((e) => e.type === 'ack').at(-1)?.data
}

async function drain() {
  const ids = (await pending()).map((e) => e.id)
  if (ids.length > 0) await ackIds(ids)
}

describe('attention phase 4 — delivery ledger', () => {
  test('wake: a nudged event is stamped deliveredVia:wake and acks with clearedBy:ack', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using worker = await connectAgent(WS_URL, 'led-w1', 'worker')
    void sensei
    await Bun.sleep(150) // let the register events land before draining
    await drain()
    await fetch(`${BASE}/agent-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'sensei' }),
    })

    worker.ws.send(JSON.stringify({ type: 'reply', from: 'led-w1', text: 'nudged into existence' }))
    await Bun.sleep(250)

    const event = (await pending()).find((e) => e.data?.text === 'nudged into existence')
    expect(event).toBeDefined()
    expect(event?.deliveredVia).toBe('wake') // the nudge carried it

    await ackIds([event?.id as number])
    const ack = await lastAck()
    expect(ack?.ledger?.[String(event?.id)]).toEqual({ deliveredVia: 'wake', clearedBy: 'ack' })
    await drain()
  })

  test('piggyback: an event that no wake carried is stamped when the sensei reads the inbox line — and first delivery wins', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using worker = await connectAgent(WS_URL, 'led-w2', 'worker')
    await Bun.sleep(150) // let the register events land before draining
    await drain()
    await fetch(`${BASE}/agent-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'sensei' }),
    })

    // First event nudges (and marks the sensei non-idle)…
    worker.ws.send(JSON.stringify({ type: 'reply', from: 'led-w2', text: 'woke it' }))
    await Bun.sleep(250)
    // …so the second arrives with the sensei mid-turn: queued, no wake.
    worker.ws.send(JSON.stringify({ type: 'reply', from: 'led-w2', text: 'arrived mid-turn' }))
    await Bun.sleep(200)
    expect((await pending()).find((e) => e.data?.text === 'arrived mid-turn')?.deliveredVia).toBeUndefined()

    // Any sensei infra call carries the inbox line — that IS its delivery.
    const res = await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': 'sensei' } })
    expect(res.headers.get('x-jean-inbox')).toBeTruthy()
    await Bun.sleep(50)

    const after = await pending()
    expect(after.find((e) => e.data?.text === 'arrived mid-turn')?.deliveredVia).toBe('piggyback')
    // First delivery wins: the woken event stays 'wake' despite riding along.
    expect(after.find((e) => e.data?.text === 'woke it')?.deliveredVia).toBe('wake')

    await ackIds(after.map((e) => e.id))
    const ack = await lastAck()
    const vias = Object.values(ack?.ledger ?? {}).map((l) => l.deliveredVia)
    expect(vias).toContain('wake')
    expect(vias).toContain('piggyback')
    expect(Object.values(ack?.ledger ?? {}).every((l) => l.clearedBy === 'ack')).toBe(true)
    await drain()
    void sensei
  })

  test('auto-clear: answering a human records clearedBy:auto-clear (and keeps the phase-3 auto:reply tag)', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using human = await connectAgent(WS_URL, 'led-human', 'user')
    void sensei
    await Bun.sleep(150) // let the register events land before draining
    await drain()

    human.ws.send(JSON.stringify({ type: 'reply', from: 'led-human', text: 'one question' }))
    await Bun.sleep(250)
    const event = (await pending()).find((e) => e.data?.text === 'one question')
    expect(event?.deliveredVia).toBe('wake') // blocking events wake regardless of idle

    await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'sensei', to: 'led-human', text: 'the answer' }),
    })
    await Bun.sleep(200)

    const ack = await lastAck()
    expect(ack?.auto).toBe('reply') // phase-3 field preserved
    expect(ack?.ledger?.[String(event?.id)]).toEqual({ deliveredVia: 'wake', clearedBy: 'auto-clear' })
    await drain()
  })

  test('CONCURRENT ACKS: twenty simultaneous acks for one id produce exactly ONE ack event, and it keeps deliveredVia', async () => {
    // Review finding [B], deterministic repro. The bulk-ack handler selects
    // pending ids and then records across an await, so N concurrent requests
    // used to write N ack events for the same id — and every one after the
    // first carried clearedBy with NO deliveredVia, because the first write had
    // already dropped the in-memory ledger entry. A reader taking the LATEST
    // ack for an event therefore concluded "delivery unknown" for an event that
    // was demonstrably woken. The race predates phase 4; the ledger gave it a
    // way to lie.
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using worker = await connectAgent(WS_URL, 'led-w3', 'worker')
    void sensei
    await Bun.sleep(150)
    await drain()
    await fetch(`${BASE}/agent-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'sensei' }),
    })

    worker.ws.send(JSON.stringify({ type: 'reply', from: 'led-w3', text: 'acked twenty ways' }))
    await Bun.sleep(250)
    const event = (await pending()).find((e) => e.data?.text === 'acked twenty ways')
    expect(event?.deliveredVia).toBe('wake')
    const id = event?.id as number

    // Twenty interleaved acks for the same id, fired without awaiting between.
    await Promise.all(Array.from({ length: 20 }, () => ackIds([id])))
    await Bun.sleep(200)

    const hist = (await (await fetch(`${BASE}/history?last=60`)).json()) as {
      events: Array<{ type: string; data: { eventIds?: number[]; ledger?: Record<string, LedgerEntry> } }>
    }
    const acksForId = hist.events.filter((e) => e.type === 'ack' && (e.data.eventIds ?? []).includes(id))
    expect(acksForId.length).toBe(1)
    // The single ack still carries the delivery fact — no "unknown" overwrite.
    expect(acksForId[0]?.data.ledger?.[String(id)]).toEqual({ deliveredVia: 'wake', clearedBy: 'ack' })
    // No empty acks were recorded by the nineteen that lost the race.
    expect(hist.events.some((e) => e.type === 'ack' && (e.data.eventIds ?? []).length === 0)).toBe(false)
    await drain()
  })

  // The 'heartbeat' path is asserted in stall-watchdog.test.ts, on the server
  // that already exercises the watchdog — same coverage, one fewer spawn.
})
