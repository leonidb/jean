/**
 * Hosting the non-socket surfaces — the bridge and the peers (task G1-WIRE).
 *
 * These two were the stop-the-switch finding: the new launcher started with
 * the human channel dark and every peer send reported undelivered, because
 * E3's seam existed and nothing called it. What is asserted here is exactly
 * that wiring — a configured bridge attaches and carries traffic both ways, a
 * registered peer receives its mail over HTTP, and `/status` tells the truth
 * about configuration rather than inferring it from live sessions.
 *
 * THE TRANSPORTS ARE REAL IN SHAPE, FAKE IN SUBSTANCE: the bridge is a
 * `Bridge` object satisfying the interface `selectBridge` returns, and the
 * peer is a stub HTTP server that answers `/send`. Neither Telegram nor Slack
 * is contacted; both seams are the ones production uses.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Bridge, BridgeHost, BridgeOutbound } from '../infra/bridge.ts'
import type { JeanConfig } from '../infra/config.ts'
import { loadPeers, peerReach as reachOf } from '../infra/peers.ts'
import { attachPeers, createHosting } from './hosting.ts'
import { type AdapterHandle, createAdapterServer } from './server.ts'

const openServers: AdapterHandle[] = []
const openDirs: string[] = []
const openStubs: { stop: () => void }[] = []

afterEach(async () => {
  for (const server of openServers.splice(0)) await server.stop()
  for (const stub of openStubs.splice(0)) stub.stop()
  for (const dir of openDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function dojo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'jean-g1-host-'))
  openDirs.push(dir)
  return dir
}

async function boot(dataDir: string, ports: Record<string, unknown> = {}): Promise<AdapterHandle> {
  const server = await createAdapterServer({ dataDir, ports })
  openServers.push(server)
  return server
}

/** A bridge in shape: what `selectBridge` returns, with the wire replaced. */
function fakeBridge() {
  const sent: BridgeOutbound[] = []
  let host: BridgeHost | undefined
  const bridge: Bridge = {
    kind: 'telegram',
    target: 'chat-777',
    start: async (h) => {
      host = h
      h.register('chat-777', (msg) => {
        sent.push(msg)
        return true
      })
    },
    connected: () => true,
    health: () => ({
      connected: true,
      lastPollAt: null,
      lastPollOkAt: null,
      consecutiveFailures: 0,
      lastInboundAt: null,
      lastInboundLagMs: null,
      maxInboundLagMs: null,
    }),
  }
  return {
    bridge,
    sent,
    inbound: (text: string, meta?: { sentAt?: number; sourceId?: string }) => host?.onInbound('chat-777', text, meta),
  }
}

describe('the bridge, on the seam', () => {
  test('it attaches as a user session, carries outbound, and its inbound is the human speaking', async () => {
    const dir = dojo()
    const server = await boot(dir)
    const { bridge, sent, inbound } = fakeBridge()

    // The launcher's two calls, in the launcher's order.
    await bridge.start({
      register: (name, send) => {
        server.attachSurface({
          name,
          role: 'user',
          sessionId: 'bridge:telegram',
          deliver: (payload) => {
            const msg = payload as { from?: string; text?: string }
            return typeof msg.text === 'string' && send({ from: msg.from ?? 'infra', text: msg.text })
          },
        })
      },
      onInbound: (name, text, meta) => void server.postInbound(name, text, meta),
      saveAttachment: () => '/dev/null',
    })

    // OUTBOUND: a `user` is not a mailbox-holder, so routing hands it to the
    // adapter leg — the bridge's transport — rather than queueing it.
    const out = (await (
      await fetch(`http://localhost:${server.port}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'orchestrator-o', to: 'chat-777', text: 'the board is clear' }),
      })
    ).json()) as { delivered?: boolean }
    expect(out.delivered).toBe(true)
    expect(sent).toEqual([{ from: 'orchestrator-o', text: 'the board is clear' }])

    // INBOUND: recorded as the human's own `reply`, carrying the provenance
    // that keeps a burst in order.
    inbound('any news?', { sentAt: 1_700_000_000_000, sourceId: 'tg-42' })
    await new Promise((r) => setTimeout(r, 50))
    const history = (await (await fetch(`http://localhost:${server.port}/history?stream=agent-chat-777`)).json()) as {
      events: { type: string; data: { text?: string; sourceId?: string; sentAt?: number } }[]
    }
    const reply = history.events.find((e) => e.type === 'reply')
    expect(reply?.data).toMatchObject({ text: 'any news?', sourceId: 'tg-42', sentAt: 1_700_000_000_000 })
  })

  test('/status tells the truth about CONFIGURATION, not about who happens to be attached', async () => {
    const dir = dojo()
    // The port the launcher supplies. Before this, `/status` inferred
    // `configured` from whether a `user` session existed — so a configured
    // bridge that had died read exactly like a dojo that never had one.
    const server = await boot(dir, {
      bridgeStatus: () => ({ configured: true, kind: 'telegram', target: 'chat-777', connected: false }),
    })
    const status = (await (await fetch(`http://localhost:${server.port}/status`)).json()) as {
      bridge: { configured: boolean; kind?: string; connected?: boolean }
    }
    expect(status.bridge).toMatchObject({ configured: true, kind: 'telegram', connected: false })

    const bare = await boot(dojo())
    expect(
      ((await (await fetch(`http://localhost:${bare.port}/status`)).json()) as { bridge: unknown }).bridge,
    ).toEqual({
      configured: false,
    })
  })
})

describe('peers, on the same seam', () => {
  test('a registered peer receives a send over HTTP, and the sender is told when it fails', async () => {
    // The peer's end: another dojo's infra, which is just an HTTP server with
    // a `/send` and a `.jean/infra.port` file for discovery.
    const peerDir = dojo()
    mkdirSync(resolve(peerDir, '.jean'), { recursive: true })
    const received: Record<string, unknown>[] = []
    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        received.push((await req.json()) as Record<string, unknown>)
        return Response.json({ ok: true })
      },
    })
    openStubs.push({ stop: () => stub.stop(true) })
    writeFileSync(resolve(peerDir, '.jean', 'infra.port'), String(stub.port))

    const dir = dojo()
    writeFileSync(
      resolve(dir, 'peers.json'),
      JSON.stringify({
        peers: {
          'the-other-dojo': {
            origin: { type: 'local-path', path: peerDir },
            description: 'the demo dojo',
            addedAt: '2026-08-20',
          },
        },
      }),
    )
    const server = await boot(dir)
    attachPeers(server, loadPeers(dir).peers, () => {}, 'this-dojo')

    const out = (await (
      await fetch(`http://localhost:${server.port}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'orchestrator-o', to: 'the-other-dojo', text: 'have you seen this' }),
      })
    ).json()) as { delivered?: boolean }
    // DELIVERED, where before the switch this reported false: no session
    // existed for the peer at all, so routing handed it to a leg with nothing
    // on the end.
    expect(out.delivered).toBe(true)
    await new Promise((r) => setTimeout(r, 100))
    expect(received.length).toBe(1)
    expect(received[0]).toMatchObject({ from: 'this-dojo', to: 'sensei', text: 'have you seen this' })
  })

  test('a peer whose infra is not running answers FALSE rather than pretending', async () => {
    const dir = dojo()
    const nowhere = dojo() // no .jean/infra.port — the peer is down
    writeFileSync(
      resolve(dir, 'peers.json'),
      JSON.stringify({
        peers: {
          silent: {
            origin: { type: 'local-path', path: nowhere },
            description: 'a dojo that is off',
            addedAt: '2026-08-20',
          },
        },
      }),
    )
    const server = await boot(dir)
    attachPeers(server, loadPeers(dir).peers, () => {}, 'this-dojo')

    const out = (await (
      await fetch(`http://localhost:${server.port}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'orchestrator-o', to: 'silent', text: 'anyone home' }),
      })
    ).json()) as { delivered?: boolean; undelivered?: string }
    expect(out.delivered).toBe(false)
    // And the sender is TOLD, which is the honesty rule the routing contract
    // states: a failed adapter delivery must not look like a successful send.
    expect(typeof out.undelivered).toBe('string')
  })

  /**
   * THE COHERENCE LAW (task 129).
   *
   * `/agents` said `connected: true` about two dojos with no infra running,
   * while `send` refused them correctly. Both were "right": `connected` was
   * about the stub session attached at boot from `peers.json`, and delivery
   * asked whether a port resolves. Two questions, one word, and a sensei
   * reading the row plans against dojos it cannot reach.
   *
   * The fix is not a better question — it is the SAME question. So the test
   * that matters asserts the two surfaces agree, and it needs both arms: an
   * all-false test passes against a row hardcoded to unreachable.
   */
  test('a peer row and a send to that peer answer the SAME question — both arms', async () => {
    const dir = dojo()

    // ARM ONE: a real dojo directory, with a .jean, whose infra is not up —
    // the ordinary case of a registered peer that is not running, and NOT the same as a bad path.
    const stopped = dojo()
    mkdirSync(resolve(stopped, '.jean'), { recursive: true })

    // ARM TWO: a peer that is genuinely serving.
    const live = dojo()
    mkdirSync(resolve(live, '.jean'), { recursive: true })
    const stub = Bun.serve({ port: 0, fetch: async () => Response.json({ ok: true }) })
    openStubs.push({ stop: () => stub.stop(true) })
    writeFileSync(resolve(live, '.jean', 'infra.port'), String(stub.port))

    // ARM THREE: configured at a path with no dojo in it at all. This one is
    // about OUR config, never about them — 017 defect 2's whole lesson.
    const wrongPath = dojo()

    // ARM FOUR: a port file that exists and is USELESS. Written expecting NaN;
    // it is 0, because `Number('')` is zero — which is finite, so a first
    // attempt at this guard passed it and the arm caught that too. Both the row
    // and the deliver waved it through before: `reachable: true` off an
    // unusable number, and a POST to `http://127.0.0.1:0/send`.
    const halfWritten = dojo()
    mkdirSync(resolve(halfWritten, '.jean'), { recursive: true })
    writeFileSync(resolve(halfWritten, '.jean', 'infra.port'), '')

    // ARM FIVE: the same trap by the other road — garbage really is NaN.
    const garbled = dojo()
    mkdirSync(resolve(garbled, '.jean'), { recursive: true })
    writeFileSync(resolve(garbled, '.jean', 'infra.port'), 'not-a-port\n')

    writeFileSync(
      resolve(dir, 'peers.json'),
      JSON.stringify({
        peers: {
          stopped: { origin: { type: 'local-path', path: stopped }, description: 'off', addedAt: '2026-08-20' },
          live: { origin: { type: 'local-path', path: live }, description: 'up', addedAt: '2026-08-20' },
          misconfigured: { origin: { type: 'local-path', path: wrongPath }, description: '?', addedAt: '2026-08-20' },
          halfwritten: {
            origin: { type: 'local-path', path: halfWritten },
            description: 'mid-boot',
            addedAt: '2026-08-20',
          },
          garbled: { origin: { type: 'local-path', path: garbled }, description: 'corrupt', addedAt: '2026-08-20' },
        },
      }),
    )

    // Wired exactly as the launcher wires it — the point is that the row and
    // the deliver read the same files.
    const registry = loadPeers(dir).peers
    const server = await boot(dir, {
      peerReach: (name: string) => {
        const p = registry[name]
        return p === undefined ? undefined : reachOf(p)
      },
    })
    attachPeers(server, registry, () => {}, 'this-dojo')

    const body = (await (await fetch(`http://localhost:${server.port}/agents`)).json()) as {
      agents: { name: string; connected: boolean; peer?: { reachable: boolean; reason?: string } }[]
    }
    const row = (n: string) => body.agents.find((a) => a.name === n)

    const sendTo = async (to: string) =>
      (await (
        await fetch(`http://localhost:${server.port}/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: 'orchestrator-o', to, text: 'ping' }),
        })
      ).json()) as { delivered?: boolean }

    // THE LAW, both arms: the row's verdict IS the send's outcome.
    for (const name of ['stopped', 'live', 'misconfigured', 'halfwritten', 'garbled']) {
      const reachable = row(name)?.peer?.reachable
      expect(reachable, `no peer fact on row "${name}"`).toBeDefined()
      expect((await sendTo(name)).delivered, `row and send disagree about "${name}"`).toBe(reachable)
    }

    // …and the arms genuinely differ, so the loop above is not three falses.
    expect(row('live')?.peer?.reachable).toBe(true)
    expect(row('stopped')?.peer?.reachable).toBe(false)

    // THE TWO UNREACHABLE CASES ARE NOT THE SAME CASE. One is a statement
    // about them; the other is a statement about this dojo's own config, and
    // rendering it as a verdict on another dojo is how a sensei came to report
    // a live dojo as down (task 017 defect 2).
    expect(row('stopped')?.peer?.reason).toBe('no-infra-running')
    expect(row('misconfigured')?.peer?.reason).toBe('unresolved')

    // A port file that parses to NaN is no port. Asserted on the ROW because
    // the loop above only proves the two surfaces agree — and before this they
    // agreed on `true`, which is the failure mode a coherence test alone
    // cannot see.
    expect(row('halfwritten')?.peer?.reachable).toBe(false)
    expect(row('garbled')?.peer?.reachable).toBe(false)

    // The session fact is untouched and still says what it always said.
    expect(row('stopped')?.connected).toBe(true)

    // And the fact hangs on peers ONLY — a non-peer session must not grow one.
    server.attachSurface({ name: 'not-a-peer', role: 'user', sessionId: 'x', deliver: () => true })
    const after = (await (await fetch(`http://localhost:${server.port}/agents`)).json()) as {
      agents: { name: string; peer?: unknown }[]
    }
    expect(after.agents.find((a) => a.name === 'not-a-peer')?.peer).toBeUndefined()
  })
})

describe('the launcher’s ordering', () => {
  test('peers attach BEFORE the port file appears — the readiness signal must not outrun the truth', async () => {
    // The port file's appearance is what tells the CLI the dojo is up, so a
    // send arriving the instant after it must already find its peer session.
    // There is no behavioural handle on this — the gap is a race — so the
    // pin reads the launcher's own order. It catches a reordering, which is
    // the way this regresses; it cannot catch a peer attach that throws.
    const source = await Bun.file(resolve(import.meta.dir, 'server.ts')).text()
    const launcher = source.slice(source.indexOf('if (import.meta.main)'))
    const peersAt = launcher.indexOf('attachPeers(')
    const portFileAt = launcher.indexOf("'infra.port'")
    const bridgeAt = launcher.indexOf('createHosting(')
    expect(peersAt).toBeGreaterThan(-1)
    expect(portFileAt).toBeGreaterThan(peersAt)
    // And the BRIDGE after it, for the opposite reason: its start is a
    // network round trip, and a dojo must be discoverable while its chat
    // surface is still shaking hands.
    expect(bridgeAt).toBeGreaterThan(portFileAt)
  })

  test('READINESS DOES NOT WAIT ON A SPAWN — the property the pin above states one way (task 131)', async () => {
    // THE MIRROR NOBODY ASKED FOR. The walk above is named "the readiness
    // signal must not outrun the truth" and reads the launcher's source
    // order, because — its own comment — "there is no behavioural handle on
    // this; the gap is a race". True of the direction it pins. The opposite
    // direction, the truth outrunning the READINESS SIGNAL, has a handle,
    // and on 2026-08-24 it had an incident: `catchUpOnBoot` was awaited
    // inside `createAdapterServer`, so a seven-minute wiki consolidation held
    // up every runtime file, both attention clocks, the bridge, peer attach
    // and the registry upsert. The dojo was live and had no door — and its
    // errors pointed in a circle: `agent start` said "start infra first",
    // `infra start` said "already running".
    //
    // Stated as a PROPERTY rather than as line order, which is the thing
    // source indices cannot express: nothing between the bind and the
    // publication of readiness may wait on a process, a spawn, or a network
    // round trip.
    //
    // The handle is a spawn that never finishes. Under the old ordering this
    // hangs forever; under the ruling it returns at once.
    const dir = mkdtempSync(resolve(tmpdir(), 'jean-131-'))
    mkdirSync(resolve(dir, '.jean'), { recursive: true })
    const longAgo = new Date(Date.now() - 3 * 86_400_000).toISOString()
    // A cron that last fired three days ago is overdue by any reading, so the
    // catch-up has something to run.
    const history = [
      {
        id: 1,
        ts: longAgo,
        type: 'trigger-created',
        stream: 'triggers',
        data: { id: 'nightly', cron: '0 3 * * *', agent: 'librarian', prompt: 'run', actor: 'init', kind: 'headless' },
      },
      {
        id: 2,
        ts: longAgo,
        type: 'trigger-fired',
        stream: 'triggers',
        data: { triggerId: 'nightly', agent: 'librarian', prompt: 'run', kind: 'headless' },
      },
    ]
    writeFileSync(resolve(dir, '.jean', 'history.jsonl'), `${history.map((e) => JSON.stringify(e)).join('\n')}\n`)

    let spawned = false
    const server = await Promise.race([
      createAdapterServer({
        dataDir: resolve(dir, '.jean'),
        ports: {
          // NEVER RESOLVES. A real consolidation is minutes; this is the same
          // shape with the clock taken out.
          runHeadless: () => {
            spawned = true
            return new Promise<void>(() => {})
          },
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('createAdapterServer waited on the catch-up')), 4_000),
      ),
    ])

    // IT RETURNED — and the catch-up really did start. Without that second
    // assertion this passes on a boot that found nothing overdue, which is
    // the vacuity that makes a "nothing bad happened" walk worthless.
    expect(server.port).toBeGreaterThan(0)
    for (let i = 0; i < 100 && !spawned; i++) await Bun.sleep(20)
    expect(spawned, 'the catch-up never ran, so this proved nothing').toBe(true)

    // AND STOP IS NOT HOSTAGE EITHER — the same problem at the other end of
    // the lifecycle, and half the reported one. Ruled: kill it.
    await Promise.race([
      server.stop(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stop waited on the run')), 4_000)),
    ])
    rmSync(dir, { recursive: true, force: true })
  }, 20_000)

  test('STOP KILLS THE BACKLOG — the other half of the ruling, which nothing held (task 131)', async () => {
    // THE WALK ABOVE PASSES WITHOUT ANY ABORT AT ALL, and that is why this
    // one exists. Its "stop is not hostage either" half asserts that `stop()`
    // RETURNS — and `stop()` returns promptly whether or not it kills
    // anything, because nothing awaits the run any more. Measured on the
    // commit that introduced the abort: removing `catchUp.abort()` from
    // `Scheduler.stop`, removing the loop's `signal.aborted` check, and
    // removing the guard before `record` each left the adapter suite at
    // 156 pass / 0 fail. The ruling is "fire-and-forget on start, KILL on
    // stop"; only the first half was held.
    //
    // The observable that cannot pass vacuously: the catch-up is SEQUENTIAL,
    // so with two overdue triggers a kill during the first must mean the
    // second never runs. A stop that merely returns leaves the loop walking.
    const dir = mkdtempSync(resolve(tmpdir(), 'jean-131-kill-'))
    mkdirSync(resolve(dir, '.jean'), { recursive: true })
    const longAgo = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const cron = (id: string) => [
      {
        id: 0,
        ts: longAgo,
        type: 'trigger-created',
        stream: 'triggers',
        data: { id, cron: '0 3 * * *', agent: 'librarian', prompt: 'run', actor: 'init', kind: 'headless' },
      },
      {
        id: 0,
        ts: longAgo,
        type: 'trigger-fired',
        stream: 'triggers',
        data: { triggerId: id, agent: 'librarian', prompt: 'run', kind: 'headless' },
      },
    ]
    const history = [...cron('nightly-a'), ...cron('nightly-b')].map((e, i) => ({ ...e, id: i + 1 }))
    writeFileSync(resolve(dir, '.jean', 'history.jsonl'), `${history.map((e) => JSON.stringify(e)).join('\n')}\n`)

    const started: string[] = []
    let releaseFirst: (() => void) | undefined
    const server = await createAdapterServer({
      dataDir: resolve(dir, '.jean'),
      ports: {
        // The first run hangs until this walk lets it go; the second must
        // never be reached at all.
        runHeadless: (trigger) => {
          started.push(trigger.id)
          return new Promise<void>((done) => {
            releaseFirst = done
          })
        },
      },
    })

    for (let i = 0; i < 100 && started.length === 0; i++) await Bun.sleep(20)
    expect(started.length, 'the catch-up never started, so this would prove nothing').toBe(1)

    await server.stop()
    releaseFirst?.()
    // Generous, and one-directional: the failure this catches is the loop
    // CONTINUING, and continuing takes no longer than not continuing.
    await Bun.sleep(300)

    expect(started, 'the killed backlog went on to the next overdue trigger').toEqual(['nightly-a'])
    rmSync(dir, { recursive: true, force: true })
  }, 20_000)

  test('THE PORT FORWARDS THE KILL SWITCH TO THE SPAWNER — a wiring law, and it was absent (task 131)', async () => {
    // THE HOP THAT WAS NEVER WRITTEN, and the walk that would have caught it.
    // `opts.signal` is the ONLY channel into `proc.kill()` for a caller, so a
    // port that drops it makes the whole abort chain inert: `stop()` aborts,
    // the walk stops its bookkeeping, and the subprocess keeps writing to
    // `.jean/.consolidator` after the port is freed and the next
    // `jean infra start` has succeeded.
    //
    // WHY THIS SHAPE. The alternatives considered were making `signal`
    // required — eight test call sites forced to write `signal: undefined` —
    // or reading `hosting.ts`'s source, which couples a test to formatting.
    // Neither was needed: this is a wiring law, which is what adapter tests
    // are for, and it reads no source, inspects no formatting, and is
    // red-without/green-with by construction.
    const seen: { signal?: AbortSignal }[] = []
    mock.module('../infra/librarian.ts', () => ({
      spawnHeadless: async (opts: { signal?: AbortSignal }) => {
        seen.push(opts)
        return { exitCode: 0, durationMs: 1, timedOut: false, stdout: '', stderr: '' }
      },
    }))
    const { headlessPorts: freshPorts } = await import('./hosting.ts')

    const dir = mkdtempSync(resolve(tmpdir(), 'jean-131-hop-'))
    const controller = new AbortController()
    const ports = freshPorts({
      dataDir: resolve(dir, '.jean'),
      now: () => Date.now(),
      log: () => {},
      record: async () => undefined,
      recordConsolidated: async () => undefined,
    })
    await ports.spawn({
      role: 'librarian',
      prompt: 'unused',
      streamSinkPath: 'sink.jsonl',
      timeoutMs: 30_000,
      signal: controller.signal,
    })
    expect(seen.length, 'the port never reached the spawner').toBe(1)
    expect(seen[0]?.signal, 'the port dropped the kill switch on the floor').toBe(controller.signal)
    rmSync(dir, { recursive: true, force: true })
  }, 20_000)

  test('the peer registry is read ONCE — enrichment and delivery cannot disagree', async () => {
    // `jean peer add` requires a stop and start; the registry is static
    // until then. A per-send re-read let the enrichment see a peer that
    // outbound routing had no session for (codex pass).
    const source = await Bun.file(resolve(import.meta.dir, 'server.ts')).text()
    const launcher = source.slice(source.indexOf('if (import.meta.main)'))
    expect(launcher.match(/loadPeers\(/g)?.length).toBe(1)
  })
})

/**
 * Transport health on the bridge's own row (task 121).
 *
 * `/status` has carried the full health block since task 006, and it is what
 * diagnosed the 2026-08-21 outage. What it does not do is put the numbers
 * where the orchestrator looks: `/agents` is the roster read, and a bridge
 * lagging nine minutes reads there exactly like a bridge that is fine.
 */
describe('the bridge’s row carries its transport', () => {
  test('health hangs on the bridge and on nobody else, under its own key', async () => {
    const dir = dojo()
    const health = {
      connected: false,
      lastPollAt: 1_700_000_100_000,
      lastPollOkAt: 1_700_000_000_000,
      consecutiveFailures: 6,
      lastInboundAt: 1_700_000_000_000,
      lastInboundLagMs: 989_209,
      maxInboundLagMs: 3_601_144,
    }
    const server = await boot(dir, {
      // The host answers for ONE name — the identity the bridge registered
      // under. Everyone else gets undefined, which is the whole guard.
      bridgeTransport: (agent: string) => (agent === 'chat-777' ? health : undefined),
    })
    server.attachSurface({ name: 'chat-777', role: 'user', sessionId: 'bridge:telegram', deliver: () => true })
    server.attachSurface({ name: 'someone-else', role: 'user', sessionId: 'other', deliver: () => true })

    const body = (await (await fetch(`http://localhost:${server.port}/agents`)).json()) as {
      agents: { name: string; connected: boolean; transport?: Record<string, unknown> }[]
    }
    const bridgeRow = body.agents.find((a) => a.name === 'chat-777')
    expect(bridgeRow?.transport).toMatchObject({ lastPollOkAt: 1_700_000_000_000, consecutiveFailures: 6 })

    // NESTED, not spread: the row's own `connected` means the SESSION is live,
    // and the transport's means the wire is. Both are true facts and they
    // disagree here — which is precisely the state an operator needs to read.
    expect(bridgeRow?.connected).toBe(true)
    expect(bridgeRow?.transport?.connected).toBe(false)

    // AND NOT ON A SECOND user-role surface. Keying on the role instead of the
    // registered identity would report a Telegram connection's poll counters
    // against a person, which is the trap the cancelled 007 branch pinned.
    expect(body.agents.find((a) => a.name === 'someone-else')?.transport).toBeUndefined()
  })
})

describe('the host learns which session is the bridge', () => {
  test('transportFor answers for the attached name and for nothing else — through createHosting itself', async () => {
    const dir = dojo()
    const server = await boot(dir)
    const { bridge } = fakeBridge()
    const hosting = createHosting(server, {} as JeanConfig, dir, () => {}, bridge)

    // BEFORE THE ATTACH it answers for nobody, including the name it is about
    // to learn. The identity comes from the transport at register time; there
    // is nothing to match against until then.
    expect(hosting.transportFor('chat-777')).toBeUndefined()

    await hosting.start()

    expect(hosting.transportFor('chat-777')).toMatchObject({ connected: true })
    // The negative is the one that matters: this is the guard standing between
    // a Telegram connection's poll counters and a human's row.
    expect(hosting.transportFor('someone-else')).toBeUndefined()
    expect(hosting.transportFor('orchestrator-o')).toBeUndefined()
  })

  test('a dojo with no bridge configured answers for nobody at all', async () => {
    const dir = dojo()
    const server = await boot(dir)
    const hosting = createHosting(server, {} as JeanConfig, dir, () => {}, null)
    await hosting.start()
    expect(hosting.transportFor('chat-777')).toBeUndefined()
    expect(hosting.bridgeStatus()).toEqual({ configured: false })
  })
})
