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

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { Bridge, BridgeHost, BridgeOutbound } from '../infra/bridge.ts'
import { loadPeers } from '../infra/peers.ts'
import { attachPeers } from './hosting.ts'
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

  test('the peer registry is read ONCE — enrichment and delivery cannot disagree', async () => {
    // `jean peer add` requires a stop and start; the registry is static
    // until then. A per-send re-read let the enrichment see a peer that
    // outbound routing had no session for (codex pass).
    const source = await Bun.file(resolve(import.meta.dir, 'server.ts')).text()
    const launcher = source.slice(source.indexOf('if (import.meta.main)'))
    expect(launcher.match(/loadPeers\(/g)?.length).toBe(1)
  })
})
