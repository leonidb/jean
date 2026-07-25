import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'
import type { DeliverMsg, OutboundMsg } from './protocol.ts'
import { connectAgent } from './test-helpers.ts'

const TEST_PORT = 8800
const DATA_DIR = '/tmp/jean-test-stall-watchdog'
const STALL_MS = 500
/** Blocking re-wake schedule, shrunk so the blocking TICK (min(15s, schedule))
 *  is observable in-test, but kept several watchdog windows long and NOT a
 *  multiple of STALL_MS. Both matter for the second test: the watchdog must
 *  get a real chance to fire first after the sensei reconnects (it would, at
 *  ~500ms, against the blocking tick's ~3500ms), and aligned periods would
 *  make the two timers fire in the same event-loop batch — where the blocking
 *  tick, registered earlier, always wins and masks the bug being tested. */
const BLOCKING_BACKOFF_MS = 3500
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
      JEAN_STALL_NUDGE_MS: String(STALL_MS),
      JEAN_BLOCKING_BACKOFF_MS: String(BLOCKING_BACKOFF_MS),
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

const isWatchdogNudge = (m: OutboundMsg): m is DeliverMsg =>
  m.type === 'deliver' && m.from === 'infra' && m.text.startsWith('Watchdog:')

describe('stall watchdog', () => {
  test('force-nudges a sensei stuck non-idle, then goes quiet once pending drains', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using _worker = await connectAgent(WS_URL, 'w1', 'worker')

    // Precondition: the worker's register event entered pending and the normal
    // idle-gated nudge fired, marking the sensei non-idle. No agent-idle is
    // ever posted — this is exactly the stuck-Stop-hook state that stalls a
    // dojo. It must be established BEFORE the watchdog window elapses, or the
    // test wouldn't prove the nudge fired despite idle:false.
    let stuck = false
    for (let i = 0; i < 10 && !stuck; i++) {
      const s = (await (await fetch(`${BASE}/status`)).json()) as { sensei: { idle: boolean } }
      stuck = !s.sensei.idle
      if (!stuck) await Bun.sleep(25)
    }
    expect(stuck).toBe(true)
    // Nudges now carry the inbox summary (attention phase 1) instead of the
    // old contentless "Check the board." — assert the payload is present.
    expect(
      sensei.messages.some(
        (m) =>
          m.type === 'deliver' && m.text.startsWith('Events pending — inbox summary') && m.text.includes('"queued"'),
      ),
    ).toBe(true)
    expect(sensei.messages.filter(isWatchdogNudge).length).toBe(0)

    // An event arriving now can be carried by NOTHING but the watchdog: the
    // sensei is stuck non-idle (no nudge) and makes no infra calls (no
    // piggyback). Its ledger mark is how we tell the backstop's deliveries
    // apart from the other two paths (attention phase 4).
    _worker.ws.send(JSON.stringify({ type: 'reply', from: 'w1', text: 'watchdog fodder' }))

    // With pending non-empty and idle stuck false, the watchdog must still fire.
    let watchdog: DeliverMsg | undefined
    for (let i = 0; i < 40 && !watchdog; i++) {
      watchdog = sensei.messages.find(isWatchdogNudge)
      if (!watchdog) await Bun.sleep(50)
    }
    expect(watchdog).toBeDefined()
    expect(watchdog?.text).toContain('idle')

    const pending = (await (await fetch(`${BASE}/events`)).json()) as {
      events: Array<{ data: { text?: string }; deliveredVia?: string }>
    }
    expect(pending.events.find((e) => e.data?.text === 'watchdog fodder')?.deliveredVia).toBe('heartbeat')

    // Drain pending; the watchdog must go quiet (clock clears on empty).
    const ack = await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upToId: 999999 }),
    })
    const acked = (await ack.json()) as { remaining: number }
    expect(acked.remaining).toBe(0)

    // Absorb any watchdog tick already in flight, then measure silence.
    await Bun.sleep(STALL_MS)
    const countAfterDrain = sensei.messages.filter(isWatchdogNudge).length
    await Bun.sleep(STALL_MS * 3)
    expect(sensei.messages.filter(isWatchdogNudge).length).toBe(countAfterDrain)
  })

  test('STANDS DOWN while a human is waiting, even before that episode has fired its first wake', async () => {
    // Review finding [H]. The stand-down used to key on blockingWakeCount > 0,
    // which stopped covering the UNSTARTED case once failed deliveries stopped
    // advancing the counter: blocking pending against a dead/absent sensei sits
    // at count 0 while pendingSince ages past the watchdog window, so a sensei
    // reconnecting in the gap between the watchdog's check and the blocking
    // tick got a duplicate push — and the ledger credited 'heartbeat' for an
    // event the blocking path owned. The guard now keys on pendingness.
    //
    // Timing here is the discriminator: the watchdog window (500ms) is a
    // seventh of the blocking tick (3500ms), so on reconnect the watchdog is
    // FIRST to the sensei by a wide margin — repeatedly. Against the pre-fix
    // guard this test sees four watchdog pushes before the blocking path gets
    // its first word in (verified by reverting the guard).
    using human = await connectAgent(WS_URL, 'human', 'user')
    human.ws.send(JSON.stringify({ type: 'reply', from: 'human', text: 'anyone there?' }))
    await Bun.sleep(STALL_MS * 2) // blocking pending, no sensei to wake → episode stays unstarted, clock ages

    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    await Bun.sleep(STALL_MS * 2) // several watchdog windows elapse post-reconnect

    // The backstop is silent — the blocking path owns delivery here…
    expect(sensei.messages.filter(isWatchdogNudge).length).toBe(0)

    // …and it delivers: the unstarted episode self-heals on the next blocking
    // tick, well inside the watchdog's window. No starvation was traded for the
    // stand-down.
    let blockingWake: DeliverMsg | undefined
    for (let i = 0; i < 100 && !blockingWake; i++) {
      blockingWake = sensei.messages.find(
        (m): m is DeliverMsg => m.type === 'deliver' && m.text.startsWith('A human is waiting'),
      )
      if (!blockingWake) await Bun.sleep(50)
    }
    expect(blockingWake).toBeDefined()
    expect(blockingWake?.text).toContain('anyone there?')
    expect(sensei.messages.filter(isWatchdogNudge).length).toBe(0) // still silent after it fired

    // The ledger credits the path that actually delivered, not the backstop.
    const pending = (await (await fetch(`${BASE}/events`)).json()) as {
      events: Array<{ data: { text?: string }; deliveredVia?: string }>
    }
    expect(pending.events.find((e) => e.data?.text === 'anyone there?')?.deliveredVia).toBe('wake')

    // And once the human is handled, the machine-side belt is armed again:
    // this is the same server that force-nudged in the first test.
    await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upToId: 999999 }),
    })
  })
})
