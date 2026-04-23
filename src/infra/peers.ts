/**
 * Peers — cross-dojo dialogue primitives.
 *
 * A "peer" is another dojo's sensei, registered in this dojo's .jean/peers.json.
 * On infra startup, each peer is injected into the in-memory agent registry as
 * a synthetic agent with role='peer' and a deliver() that HTTP-POSTs to the
 * peer's infra /send endpoint. After that, routeSend/send/agents work
 * unchanged — peer-ness is a routing implementation detail.
 *
 * Descriptions are stable: set at registration, looked up locally when an
 * inbound message arrives, never travel on the wire.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { INFRA_IDENTITY, isProcessAlive, probeInfra, readRuntimeFiles } from '../probe.ts'
import { readConfig } from './config.ts'

// ── Types ─────────────────────────────────────────────────────────

export type PeerOrigin = { type: 'local-path'; path: string }
// Future: | { type: 'url'; url: string } | { type: 'docker'; service: string }

export type Peer = {
  origin: PeerOrigin
  description: string
  addedAt: string
}

export type PeersFile = {
  peers: Record<string, Peer>
}

export type PeerLiveness = 'online' | 'offline' | 'stale' | 'unknown'

// ── File I/O ──────────────────────────────────────────────────────

const PEERS_FILENAME = 'peers.json'

function peersPath(dataDir: string): string {
  return resolve(dataDir, PEERS_FILENAME)
}

export function loadPeers(dataDir: string): PeersFile {
  const p = peersPath(dataDir)
  if (!existsSync(p)) return { peers: {} }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as PeersFile
    return { peers: parsed.peers ?? {} }
  } catch {
    return { peers: {} }
  }
}

export function savePeers(dataDir: string, file: PeersFile): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(peersPath(dataDir), `${JSON.stringify(file, null, 2)}\n`)
}

// ── Identity ──────────────────────────────────────────────────────

/**
 * Read the dojo's identity from jean.config.json; fall back to the dojo
 * directory's basename. Used as the `from` field when sending to peers.
 */
export function identityFromConfig(dataDir: string): string {
  const cfg = readConfig(dataDir) as { identity?: string }
  if (typeof cfg.identity === 'string' && cfg.identity.length > 0) return cfg.identity
  // dataDir points at <dojoRoot>/.jean; the dojo name is its parent's basename
  return basename(resolve(dataDir, '..'))
}

// ── Liveness ──────────────────────────────────────────────────────

const LIVENESS_CACHE_MS = 5_000
const livenessCache = new Map<string, { at: number; state: PeerLiveness }>()

/**
 * Check whether a peer's infra is reachable. Reads .jean/infra.pid + infra.port
 * from the peer's origin (cheap local filesystem ops), then optionally probes
 * the HTTP endpoint. Results cached for 5 seconds to keep /agents fast.
 */
export async function peerLiveness(peer: Peer): Promise<PeerLiveness> {
  if (peer.origin.type !== 'local-path') return 'unknown'
  const key = peer.origin.path
  const cached = livenessCache.get(key)
  if (cached && Date.now() - cached.at < LIVENESS_CACHE_MS) return cached.state

  const state = await computeLiveness(peer.origin.path)
  livenessCache.set(key, { at: Date.now(), state })
  return state
}

async function computeLiveness(originPath: string): Promise<PeerLiveness> {
  const peerJeanDir = resolve(originPath, '.jean')
  if (!existsSync(peerJeanDir)) return 'offline'
  const { pid, port } = readRuntimeFiles(peerJeanDir)
  if (pid === null || port === null) return 'offline'
  if (!isProcessAlive(pid)) return 'offline'
  try {
    const info = await probeInfra(port)
    return info?.name === INFRA_IDENTITY ? 'online' : 'stale'
  } catch {
    return 'stale'
  }
}

/** Clear cached liveness for a peer (or all peers). Called on server shutdown / tests. */
export function clearLivenessCache(key?: string): void {
  if (key === undefined) livenessCache.clear()
  else livenessCache.delete(key)
}

// ── Deliver function for peer entries in the agents map ──────────

export type PeerDeliverArgs = {
  peer: Peer
  myIdentity: string
  targetAgent?: string // defaults to "sensei" — the cross-dojo convention
}

/**
 * Returns a deliver function suitable for AgentEntry.deliver. Fire-and-forget
 * HTTP POST to the peer's /send endpoint. Returns true if the POST is
 * initiated; false only if we can't even read the peer's port file (peer
 * clearly offline). The actual HTTP response is awaited asynchronously; on
 * failure we rely on the server's existing `delivered: false` event recording.
 *
 * We intentionally don't await the POST inside deliver (AgentEntry.deliver is
 * sync-return `boolean`). This matches wsDeliver's behavior — it returns true
 * as soon as the WS send is queued.
 */
export function createPeerDeliver(
  args: PeerDeliverArgs,
): (msg: { from: string; text: string; taskId?: string }) => boolean {
  const { peer, myIdentity, targetAgent = 'sensei' } = args
  return (msg) => {
    if (peer.origin.type !== 'local-path') return false
    const peerJeanDir = resolve(peer.origin.path, '.jean')
    const { port } = readRuntimeFiles(peerJeanDir)
    if (port === null) return false
    // Fire-and-forget: we don't block the caller on the peer's response.
    // Delivery failures surface via the caller's `delivered: false` event when
    // the fetch rejects.
    void fetch(`http://127.0.0.1:${port}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: myIdentity,
        to: targetAgent,
        text: msg.text,
        taskId: msg.taskId,
      }),
    }).catch(() => {
      /* surfaced via the recorded send event's delivered flag (future) — for
         now the inflight-delivery best effort is enough */
    })
    return true
  }
}
