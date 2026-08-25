/**
 * THE GREET, THROUGH THE DOOR THAT MINTS IT (task 133).
 *
 * ── WHY EVERY WALK HERE USES A SOCKET ──
 *
 * The previous attempt at this feature had three walks asserting "no greet"
 * through `attachSurface`, which appends a register record and never reaches
 * the mint at all. So they asserted the absence of something that could not
 * have happened: flipping the eligibility rule to greet EVERY role left that
 * file green, thirteen passing, including both walks named for the property.
 * A test that cannot reach the mechanism is not a weak test of it — it is a
 * test of something else that happens to be true.
 *
 * The mint hangs off the WS register handler. So the socket is the door, and
 * every walk below goes through it.
 *
 * ── AND THE POSITIVE CONTROL IS NOT OPTIONAL ──
 *
 * Three consecutive "nothing happened" assertions on one mechanism is
 * indistinguishable from a mechanism that stopped running. The first walk
 * asserts a sensei IS greeted; without it, everything after it passes for a
 * `greetOnRegistration` that returns `undefined` unconditionally.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../domain/contracts/vocabulary.ts'
import { type AdapterHandle, createAdapterServer } from './server.ts'

const openServers: AdapterHandle[] = []
const openSockets: WebSocket[] = []

afterEach(async () => {
  for (const ws of openSockets.splice(0)) ws.close()
  for (const server of openServers.splice(0)) await server.stop()
})

async function boot(): Promise<AdapterHandle> {
  const server = await createAdapterServer({})
  openServers.push(server)
  return server
}

/** Register over the socket — the door the mint actually hangs off. */
function connect(server: AdapterHandle, agent: string, role: string) {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`)
  openSockets.push(ws)
  return new Promise<WebSocket>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`register timed out for ${agent}`)), 4_000)
    ws.onopen = () => ws.send(JSON.stringify({ type: 'register', agent, role }))
    ws.onmessage = (ev) => {
      if ((JSON.parse(String(ev.data)) as { type?: string }).type === 'registered') {
        clearTimeout(timer)
        done(ws)
      }
    }
    ws.onerror = () => fail(new Error('socket error'))
  })
}

const greetsFor = async (server: AdapterHandle, agent: string): Promise<StoredEvent[]> => {
  const res = (await (await fetch(`http://localhost:${server.port}/history?stream=agent-${agent}`)).json()) as {
    events: StoredEvent[]
  }
  return res.events.filter((e) => e.type === 'greet')
}

const send = (server: AdapterHandle, to: string, text: string) =>
  fetch(`http://localhost:${server.port}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'api', to, text }),
  })

/** The mint rides the register append, which resolves after the `registered`
 *  frame — so a read immediately after `connect` can beat it. Poll. */
async function settle(read: () => Promise<StoredEvent[]>, want: number): Promise<StoredEvent[]> {
  for (let i = 0; i < 80; i++) {
    const got = await read()
    if (got.length >= want) return got
    await Bun.sleep(25)
  }
  return read()
}

describe('the greet — the zero case of the announcement', () => {
  test('POSITIVE CONTROL: a sensei registering into a quiet dojo IS greeted', async () => {
    // Everything below asserts an absence. This is the walk that makes those
    // absences mean something.
    const server = await boot()
    await connect(server, 'sensei', 'sensei')
    const greets = await settle(() => greetsFor(server, 'sensei'), 1)
    expect(greets.length, 'a sensei with an empty mailbox was not greeted').toBe(1)
    expect(greets[0]?.data).toMatchObject({ agent: 'sensei' })
  }, 20_000)

  test('...and it is ORDINARY MAIL — it lands in the mailbox, not on a private push path', async () => {
    // The old implementation was a raw `deliver` with no mailbox entry: told
    // and unrecorded, which is the shape task 053 exists to catch. If the
    // greet is mail then it is fetchable, ackable and repeatable by the
    // machinery that carries everything else, and nothing here is special.
    const server = await boot()
    await connect(server, 'sensei', 'sensei')
    await settle(() => greetsFor(server, 'sensei'), 1)
    const box = (await (await fetch(`http://localhost:${server.port}/events?agent=sensei`)).json()) as {
      events: { type: string; code?: string }[]
    }
    const greet = box.events.find((e) => e.type === 'greet')
    expect(greet, 'the greet never reached the mailbox — it is a push, not mail').toBeDefined()
    expect(typeof greet?.code, 'no ack code, so it cannot be cleared like mail').toBe('string')
  }, 20_000)

  test('a WORKER is never greeted, empty mailbox or not', async () => {
    // Not an omission — a positive design statement (ruled 2026-08-25): a
    // worker connecting with nothing waiting is SUPPOSED to sit idle, and if
    // it should be doing something, saying so is the sensei's job rather than
    // infra's. The row stays `no` even if the greet were free.
    const server = await boot()
    await connect(server, 'worker-a', 'worker')
    await Bun.sleep(300)
    expect(await greetsFor(server, 'worker-a')).toEqual([])
  }, 20_000)

  test('MAIL WAITING MEANS NO GREET — one evaluation, one outcome, never both', async () => {
    // The whole shape. The greet cannot race the mail because it is minted
    // only in the mail's absence, which is why there is no timer here and
    // nothing to reconcile.
    const server = await boot()
    // Register once so the name is a dojo agent routing will queue for, then
    // leave, take mail, and come back to a non-empty mailbox.
    const first = await connect(server, 'sensei', 'sensei')
    await settle(() => greetsFor(server, 'sensei'), 1)
    first.close()
    await Bun.sleep(50)
    await send(server, 'sensei', 'this was waiting')
    await Bun.sleep(50)

    await connect(server, 'sensei', 'sensei')
    await Bun.sleep(300)
    expect(await greetsFor(server, 'sensei'), 'a second greet was minted on top of waiting mail').toHaveLength(1)
  }, 20_000)

  test('SELF-LIMITING: an unacked greet is mail, so a reconnect mints nothing', async () => {
    // greet → disconnect without acking → reconnect. The first greet is still
    // pending, so the mailbox is not empty, so nothing is minted. No agent can
    // ever hold two. Written down because a single greet across many
    // reconnects reads like a bug otherwise — it follows from read-before-
    // clear rather than sitting beside it.
    const server = await boot()
    const first = await connect(server, 'sensei', 'sensei')
    await settle(() => greetsFor(server, 'sensei'), 1)
    first.close()
    await Bun.sleep(50)

    await connect(server, 'sensei', 'sensei')
    await Bun.sleep(300)
    expect(await greetsFor(server, 'sensei'), 'a flapping sensei accumulated greets').toHaveLength(1)
  }, 20_000)
})
