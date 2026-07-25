// Attention phase 4 — the machine-nudge re-nudge loop (goals dojo, event
// 10077: SIX re-nudges in ~25 s on ONE deliberately-held event). The loop was
// never timer-driven: every turn-end posts /agent-idle → nudgeSenseiIfIdle with
// zero suppression, so the sensei's own reply re-armed the interrupt that
// produced it and the nudge rate equalled the reply rate.
//
// The regression test is built from that trace: one held queued event + N rapid
// idle transitions must produce ONE nudge, not N — while new content and an
// elapsed backoff window still get through, so worker-reply latency stays at
// turn-end speed (the regression the goals review warned against).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'
import type { DeliverMsg, OutboundMsg } from './protocol.ts'
import { connectAgent } from './test-helpers.ts'

const TEST_PORT = 8823
const DATA_DIR = '/tmp/jean-test-attention-nudge-backoff'
const BACKOFF_MS = 900 // env-shrunk so an elapsed window is observable in-test
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
      JEAN_NUDGE_BACKOFF_MS: String(BACKOFF_MS),
      JEAN_STALL_NUDGE_MS: String(60_000), // park the watchdog — it is the backstop, not the subject
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

/** Machine nudges — the "Events pending" family (both the inbox-summary form
 *  and the contentless fallback). Excludes the watchdog ("Watchdog: …") and the
 *  blocking wake ("A human is waiting…"), which are separate paths. */
const isNudge = (m: OutboundMsg): m is DeliverMsg =>
  m.type === 'deliver' && m.from === 'infra' && m.text.startsWith('Events pending')

const nudgeCount = (msgs: OutboundMsg[]) => msgs.filter(isNudge).length

async function ackAll() {
  const events = (await (await fetch(`${BASE}/events`)).json()) as { events: Array<{ id: number }> }
  if (events.events.length === 0) return
  await fetch(`${BASE}/events/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upToId: Math.max(...events.events.map((e) => e.id)) }),
  })
}

/** `nudge` events in the log — the record that infra says it told the sensei
 *  something. A nudge whose delivery failed must not appear here. */
async function nudgeEventCount(): Promise<number> {
  const hist = (await (await fetch(`${BASE}/history?last=100`)).json()) as { events: Array<{ type: string }> }
  return hist.events.filter((e) => e.type === 'nudge').length
}

/** One turn-end: the Stop hook's POST. This is the call that used to re-nudge. */
async function postIdle(agent: string) {
  await fetch(`${BASE}/agent-idle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent }),
  })
}

describe('attention phase 4 — machine-nudge episode backoff', () => {
  test('THE 10077 REGRESSION: one held event + six rapid turn-ends = exactly ONE nudge', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using worker = await connectAgent(WS_URL, 'w1', 'worker')

    // Clean slate: drain everything the connects queued, which also ends the
    // episode (a drained queue means the next arrival is genuinely new news).
    await Bun.sleep(150) // let the register events land before draining
    await ackAll()
    await postIdle('sensei')
    await Bun.sleep(150)
    const before = nudgeCount(sensei.messages)

    // ONE held event — the deliberately-deferred worker reply from the trace.
    worker.ws.send(JSON.stringify({ type: 'reply', from: 'w1', text: 'the one held event' }))
    await Bun.sleep(200)
    expect(nudgeCount(sensei.messages)).toBe(before + 1) // arrival nudge

    // Six turn-ends in ~300ms — the shape that produced six re-nudges in 25s.
    for (let i = 0; i < 6; i++) {
      await postIdle('sensei')
      await Bun.sleep(50)
    }
    await Bun.sleep(150)
    expect(nudgeCount(sensei.messages)).toBe(before + 1) // still ONE. The loop is dead.

    // The event was never dropped — suppression is silence, not loss.
    const pending = (await (await fetch(`${BASE}/events`)).json()) as {
      events: Array<{ data: { text?: string } }>
    }
    expect(pending.events.some((e) => e.data?.text === 'the one held event')).toBe(true)
  })

  test('CONTENT CHANGED: a new event mid-episode nudges once more (worker-reply latency stays at turn-end speed)', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using worker = await connectAgent(WS_URL, 'w2', 'worker')
    await Bun.sleep(150) // let the register events land before draining
    await ackAll()
    await postIdle('sensei')
    await Bun.sleep(150)
    const before = nudgeCount(sensei.messages)

    worker.ws.send(JSON.stringify({ type: 'reply', from: 'w2', text: 'first' }))
    await Bun.sleep(200)
    await postIdle('sensei') // suppressed — nothing new to say
    await Bun.sleep(150)
    expect(nudgeCount(sensei.messages)).toBe(before + 1)

    // A genuinely new event: fresh news, delivered immediately, no backoff wait.
    worker.ws.send(JSON.stringify({ type: 'reply', from: 'w2', text: 'second' }))
    await Bun.sleep(250)
    expect(nudgeCount(sensei.messages)).toBe(before + 2)
    // …and the re-nudge carries BOTH replies, so the deferred one isn't lost.
    expect(sensei.messages.filter(isNudge).at(-1)?.text).toContain('"worker:reply": 2')
  })

  test('BACKOFF ELAPSED: the same held queue earns one reminder per window, and a drain resets the episode', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using worker = await connectAgent(WS_URL, 'w3', 'worker')
    await Bun.sleep(150) // let the register events land before draining
    await ackAll()
    await postIdle('sensei')
    await Bun.sleep(150)
    const before = nudgeCount(sensei.messages)

    worker.ws.send(JSON.stringify({ type: 'reply', from: 'w3', text: 'held across a window' }))
    await Bun.sleep(200)
    expect(nudgeCount(sensei.messages)).toBe(before + 1)

    await postIdle('sensei') // inside the window — silent
    await Bun.sleep(100)
    expect(nudgeCount(sensei.messages)).toBe(before + 1)

    await Bun.sleep(BACKOFF_MS + 200) // window elapses…
    await postIdle('sensei') // …so this turn-end earns the reminder
    await Bun.sleep(150)
    expect(nudgeCount(sensei.messages)).toBe(before + 2)

    // Drain: the episode ends, so the NEXT arrival nudges immediately rather
    // than inheriting the escalated backoff.
    await ackAll()
    await postIdle('sensei')
    await Bun.sleep(150)
    const afterDrain = nudgeCount(sensei.messages)

    worker.ws.send(JSON.stringify({ type: 'reply', from: 'w3', text: 'fresh episode' }))
    await Bun.sleep(250)
    expect(nudgeCount(sensei.messages)).toBe(afterDrain + 1)
    await ackAll()
  })

  test('FAILED DELIVERY DOES NOT CONSUME THE EPISODE: an undelivered nudge leaves the queue re-announceable at the next turn-end', async () => {
    // Review finding [A]. Reaching a live registry entry whose transport is
    // dead takes a specific (real) shape: a session registers as `sensei`, then
    // re-registers on the SAME socket under a second name, which moves
    // ws.data.agent — so when that socket closes, the close handler removes
    // only the second name and the `sensei` entry outlives its transport.
    // Every deliver() to it now returns false, which is exactly the state a
    // half-dead socket produces in production.
    using ghost = await connectAgent(WS_URL, 'sensei', 'sensei')
    ghost.ws.send(JSON.stringify({ type: 'register', agent: 'ghost-holder', role: 'worker' }))
    await Bun.sleep(200)
    ghost.ws.close()
    await Bun.sleep(250)

    // The registry still holds a `sensei` whose socket is gone.
    const status = (await (await fetch(`${BASE}/status`)).json()) as { sensei: { connected: boolean } }
    expect(status.sensei.connected).toBe(true)

    using worker = await connectAgent(WS_URL, 'w4', 'worker')
    await Bun.sleep(150)
    await ackAll() // clean slate: empty queue, episode reset
    await postIdle('sensei') // the orphan reads idle — nudges will be ATTEMPTED

    const nudgeEventsBefore = await nudgeEventCount()
    worker.ws.send(JSON.stringify({ type: 'reply', from: 'w4', text: 'shouted into the void' }))
    await Bun.sleep(300)

    // Nothing that didn't happen gets recorded: the attempted nudge left no
    // `nudge` event, and the event is still pending.
    expect(await nudgeEventCount()).toBe(nudgeEventsBefore)
    const stillPending = (await (await fetch(`${BASE}/events`)).json()) as {
      events: Array<{ data: { text?: string }; deliveredVia?: string }>
    }
    const held = stillPending.events.find((e) => e.data?.text === 'shouted into the void')
    expect(held).toBeDefined()
    expect(held?.deliveredVia).toBeUndefined() // and the ledger doesn't claim a delivery

    // THE REGRESSION: a real sensei arrives (replacing the dead entry) and ends
    // its turn. Pre-fix the failed nudge had consumed the episode, so this
    // turn-end was suppressed for a full backoff window and the held event sat
    // silent. It must nudge immediately.
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    const before = nudgeCount(sensei.messages)
    await postIdle('sensei')
    await Bun.sleep(250)
    expect(nudgeCount(sensei.messages)).toBe(before + 1)
    await ackAll()
  })

  test('an idle post with an empty queue never nudges', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    await Bun.sleep(150) // let the register events land before draining
    await ackAll()
    const before = nudgeCount(sensei.messages)
    for (let i = 0; i < 3; i++) {
      await postIdle('sensei')
      await Bun.sleep(50)
    }
    await Bun.sleep(150)
    expect(nudgeCount(sensei.messages)).toBe(before)
  })
})
