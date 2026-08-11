/**
 * The re-notification loop, and the two ways it used to lie (goals doja event
 * 10077; review finding [A]).
 *
 * ── THE INCIDENT, WHICH IS WHY THIS FILE STILL EXISTS ──
 *
 * SIX re-nudges in ~25s on ONE deliberately-held event. The loop was never
 * timer-driven: every turn-end posted `/agent-idle` → `nudgeSenseiIfIdle` with
 * zero suppression, so the sensei's own reply re-armed the interrupt that
 * produced it and the nudge rate equalled the reply rate.
 *
 * ── WHAT THE TRANSITION DID TO IT (task 045) ──
 *
 * The mechanism that produced 10077 is gone at the root rather than damped:
 * `/agent-idle` no longer arms anything (canon E3 — "nothing ever asks whether
 * an agent is busy"), and a push needs a REASON that an activity signal cannot
 * manufacture — either an unannounced event at or above the threshold, or an
 * elapsed quiet window. So the regression case below keeps its exact shape (one
 * held event, six rapid turn-ends) and its assertion gets STRONGER: not "one
 * nudge instead of six" but "no push at all, because there is nothing to say".
 *
 * Two cases here are retired rather than adapted — see the foot of the file.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import type { Subprocess } from 'bun'
import type { DeliverMsg, OutboundMsg } from './protocol.ts'
import { connectAgent } from './test-helpers.ts'

const TEST_PORT = 8823
const DATA_DIR = '/tmp/jean-test-attention-nudge-backoff'
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
      // The quiet clock is parked FAR away on purpose: every case here is about
      // what an ARRIVAL or an activity signal does, and a background reminder
      // firing mid-case would supply a push the assertions must not credit.
      // (OLD: `JEAN_NUDGE_BACKOFF_MS` shrunk to 900 and `JEAN_STALL_NUDGE_MS`
      // parking a watchdog that no longer exists.)
      JEAN_NUDGE_INTERVAL_MS: String(600_000),
      JEAN_REMINDER_AFTER_MS: String(600_000),
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

/** Infra's pushes. One family now — the blocking wake and the watchdog were
 *  separate paths and are not separate any more. */
const isNudge = (m: OutboundMsg): m is DeliverMsg =>
  m.type === 'deliver' && m.from === 'infra' && m.text.startsWith('Events pending')

const nudgeCount = (msgs: OutboundMsg[]) => msgs.filter(isNudge).length

/** Drain, in the one ack form S5 leaves. Unaddressed on purpose — a test
 *  clearing the queue is an observer, and only an ADDRESSED read stamps. */
async function ackAll() {
  const { events } = (await (await fetch(`${BASE}/events`)).json()) as {
    events: Array<{ id: number; code: string }>
  }
  if (events.length === 0) return
  await fetch(`${BASE}/events/ack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairs: events.map((e) => ({ id: e.id, code: e.code })) }),
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

describe('re-notification', () => {
  test('THE 10077 REGRESSION: one held event + six rapid turn-ends = no push at all', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    using worker = await connectAgent(WS_URL, 'w1', 'worker')

    // Clean slate: drain everything the connects queued, which also ends the
    // spell (a drained mailbox means the next arrival is genuinely new news).
    await Bun.sleep(150)
    await ackAll()
    await postIdle('sensei')
    // START THE SENSEI'S QUIET CLOCK (H7, ruled 2026-08-11): registering is
    // not activity and neither is the Stop-hook post above, so a sensei that
    // never acted reads as long-quiet and the arrival below would nudge at
    // once — desired behavior, but not this case's subject, which is the
    // turn-end re-nudge loop. One identity-carrying call is the agent's act.
    await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': 'sensei' } })
    await Bun.sleep(150)
    const before = nudgeCount(sensei.messages)

    // ONE held event — the deliberately-deferred worker reply from the trace.
    // OLD: this line was followed by `expect(... ).toBe(before + 1)`, the
    // "arrival nudge". A worker's routine reply does not outrank the sensei's
    // push threshold (S3), so the arrival is now silent by design — and this is
    // the same event that six turn-ends then failed to shake loose.
    worker.ws.send(JSON.stringify({ type: 'reply', from: 'w1', text: 'the one held event' }))
    await Bun.sleep(200)
    expect(nudgeCount(sensei.messages)).toBe(before)

    // Six turn-ends in ~300ms — the exact shape that produced six re-nudges in
    // 25s. The loop is not damped; the edge it rode does not exist.
    for (let i = 0; i < 6; i++) {
      await postIdle('sensei')
      await Bun.sleep(50)
    }
    await Bun.sleep(150)
    expect(nudgeCount(sensei.messages)).toBe(before)

    // The event was never dropped — silence is suppression, not loss. This is
    // the assertion that keeps the case honest: without it, "no push" would also
    // be satisfied by an infra that lost the event entirely.
    const pending = (await (await fetch(`${BASE}/events`)).json()) as {
      events: Array<{ data: { text?: string } }>
    }
    expect(pending.events.some((e) => e.data?.text === 'the one held event')).toBe(true)
  })

  test('FAILED DELIVERY DOES NOT CONSUME THE EPISODE: an undelivered push leaves the queue re-announceable', async () => {
    // ── RACE GUARD 4, AND THIS IS THE ONLY PLACE IT CAN BE TESTED ──
    //
    // `race-guards.test.ts` says so in its own header: guard 4's precondition is
    // a sensei that the registry still returns but whose transport refuses, and
    // it could not be reached there. It is reachable here, and the shape is
    // real: a session registers as `sensei`, then re-registers on the SAME
    // socket under a second name, which moves `ws.data.agent` — so when that
    // socket closes, the close handler removes only the second name and the
    // `sensei` entry outlives its transport. Every deliver() to it now returns
    // false, exactly as a half-dead socket does in production.
    using ghost = await connectAgent(WS_URL, 'sensei', 'sensei')
    ghost.ws.send(JSON.stringify({ type: 'register', agent: 'ghost-holder', role: 'worker' }))
    await Bun.sleep(200)
    ghost.ws.close()
    await Bun.sleep(250)

    // The registry still holds a `sensei` whose socket is gone.
    const status = (await (await fetch(`${BASE}/status`)).json()) as { sensei: { connected: boolean } }
    expect(status.sensei.connected).toBe(true)

    // OLD: a worker's reply provoked the attempted push, because any pending
    // event nudged an idle sensei. The provocation must now outrank the
    // threshold, so it is a human's — the mechanism under test (what happens
    // when a push does NOT land) is untouched by which sender triggered it.
    using human = await connectAgent(WS_URL, 'void-human', 'user')
    await Bun.sleep(150)
    await ackAll() // clean slate

    const nudgeEventsBefore = await nudgeEventCount()
    human.ws.send(JSON.stringify({ type: 'reply', from: 'void-human', text: 'shouted into the void' }))
    await Bun.sleep(300)

    // Nothing that didn't happen gets recorded: the attempted push left no
    // `nudge` event, and the event is still pending with no delivery claimed.
    expect(await nudgeEventCount()).toBe(nudgeEventsBefore)
    const stillPending = (await (await fetch(`${BASE}/events`)).json()) as {
      events: Array<{ data: { text?: string }; deliveredVia?: string }>
    }
    const held = stillPending.events.find((e) => e.data?.text === 'shouted into the void')
    expect(held).toBeDefined()
    expect(held?.deliveredVia).toBeUndefined() // and the ledger doesn't claim a delivery

    // THE REGRESSION: a real sensei arrives (replacing the dead entry). Because
    // the failed push never advanced `announcedThroughId`, the message is still
    // unannounced and goes out at once. Pre-fix the failed nudge had consumed
    // the episode and the held event sat silent for a full backoff window.
    //
    // Asserted on the PAYLOAD rather than on a count delta: the push can land
    // during `connectAgent`'s own greeting wait, so any baseline taken after the
    // connect returns has already raced it. What the case actually claims is
    // that THIS message was re-announced, and the payload says so directly.
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    let announced = false
    for (let i = 0; i < 40 && !announced; i++) {
      announced = sensei.messages.filter(isNudge).some((m) => m.text.includes('shouted into the void'))
      if (!announced) await Bun.sleep(50)
    }
    expect(announced).toBe(true)
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

// ── RETIRED HERE, RECORDED HERE (task 045) ─────────────────────────────
//
// Both were PRE-DECLARED casualties (task 043 part 3: "idle-gated suppression
// cases"), and both were about the shape of suppression WITHIN an episode — a
// notion that only means something when a push can be suppressed for a reason
// other than having nothing to say.
//
// `CONTENT CHANGED: a new event mid-episode nudges once more (worker-reply
// latency stays at turn-end speed)` — its premise was that the first worker
// reply nudges and the second, arriving mid-turn, is suppressed until the
// content-changed signal survives it. Neither reply pushes now (S3), so there is
// no suppression to survive. The question it protected — "does a genuinely new
// event get through promptly, or does it wait out a window?" — is asserted in
// `attention-wake.test.ts` on the sender that does push.
//
// `BACKOFF ELAPSED: the same held queue earns one reminder per window, and a
// drain resets the episode` — the ladder and the drain-reset, both of which
// survive intact. They moved to `attention-wake.test.ts` rather than being
// duplicated here: that file already holds the burst and the arrival path, so
// the ladder is asserted once, on one spawned server, next to the arrivals it
// is the backstop for.
