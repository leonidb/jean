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

/**
 * What `/agents` may honestly say about a peer row (task 129).
 *
 * ── WHY THIS IS NOT `peerLiveness` ──
 *
 * `peerLiveness` probes over HTTP, so it is async and distinguishes `online`
 * from `stale`. That distinction is knowledge the DELIVERY path does not have
 * either: `createPeerDeliver` resolves a port and posts, and a peer whose infra
 * is up but wedged fails asynchronously through `onUndelivered`. A display that
 * claims to know more than the sender can know is how the two come to disagree,
 * which is the whole of 129. So this asks exactly the question the deliver
 * asks, synchronously, off the same files.
 *
 * WHAT THAT DOES AND DOES NOT BUY: the two cannot disagree about the same
 * INSTANT. They are still two reads at two times, so a peer that starts or
 * stops between a row and a send will have been described correctly by both
 * and still surprise the reader. That is a snapshot being a snapshot, not the
 * defect this closes.
 *
 * DELIBERATELY NOT STRONGER THAN THE DELIVER. An earlier draft also checked
 * the peer's pid with `isProcessAlive`, which sounds better and re-creates the
 * bug: the deliver refuses on `port === null` alone, so a stale port file would
 * have shown `reachable: false` beside a send that was still attempted. Worse,
 * had the DELIVER adopted the pid check to match, a recycled or stale pid would
 * start refusing sends that work — trading a doomed attempt, which the sender
 * is already told about, for a refused message, which is a new way to lose one.
 *
 * ── WHY `unresolved` IS NOT `offline` (task 017 defect 2's lesson) ──
 *
 * A configured path with no `.jean` in it is a fact about THIS dojo's config,
 * not about the other dojo. Rendering it as "they are offline" is how a sensei
 * comes to report, with justified confidence, that a dojo which was serving
 * the whole time was down. `reachable: false` is honest either way; the reason
 * is what stops it being read as a verdict on someone else.
 */
export type PeerReach = {
  /** It is in `peers.json`. Always true for an attached peer. */
  configured: true
  /** Would a send be ATTEMPTED right now — the deliver's own predicate. */
  reachable: boolean
  /** Present only when not reachable, and phrased as what THIS dojo found. */
  reason?: 'unresolved' | 'no-infra-running'
}

/**
 * The deliver's question, asked without sending anything.
 *
 * Reads only the peer's runtime files, so it costs a stat and needs no cache —
 * the 5s cache on `peerLiveness` exists for its HTTP probe, which this does
 * not do.
 */
/**
 * A port we could actually post to — the one predicate `peerReach` and
 * `createPeerDeliver` share, so neither can be laxer than the other.
 *
 * NOT `=== null`, which is what both used before. `readRuntimeFiles` returns
 * `Number(contents.trim())`, and that has two traps rather than one: garbage
 * gives `NaN`, but an EMPTY file gives `0` — `Number('')` is zero, not NaN, so
 * a half-written `infra.port` produced a perfectly finite port number. Both
 * callers waved it through, agreeing with each other and both wrong: the row
 * claimed `reachable: true` off an unusable number, and the deliver posted to
 * `http://127.0.0.1:0/send`. Measured while writing this file's own test,
 * which asserted NaN and got 0.
 */
function usablePort(port: number | null): boolean {
  return port !== null && Number.isInteger(port) && port > 0 && port < 65_536
}

export function peerReach(peer: Peer): PeerReach {
  if (peer.origin.type !== 'local-path') return { configured: true, reachable: false, reason: 'unresolved' }
  const jeanDir = resolve(peer.origin.path, '.jean')
  // Nothing of theirs at the path we hold: our configuration is what is wrong.
  if (!existsSync(jeanDir)) return { configured: true, reachable: false, reason: 'unresolved' }
  const { port } = readRuntimeFiles(jeanDir)
  // We found them; their infra left no usable port. This one IS about them,
  // and it is the exact state the deliver refuses on.
  if (!usablePort(port)) return { configured: true, reachable: false, reason: 'no-infra-running' }
  return { configured: true, reachable: true }
}

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

/** Cross-dojo convention: peers deliver to the peer's sensei. */
const PEER_TARGET_AGENT = 'sensei'

/**
 * Returns a deliver function for AgentEntry.deliver. Matches wsDeliver's
 * sync-return contract: returns true once the POST is queued, false if we can't
 * even find the peer's port (peer clearly offline). The POST itself is async, so
 * a mid-flight failure (peer's infra up but /send errors, or the port is stale)
 * can't flip that synchronous boolean — instead it's surfaced via `onUndelivered`,
 * which lets the infra push a failure notice back to the *sender* so a peer hop
 * that silently drops is visible rather than reported as sent.
 */
export function createPeerDeliver(args: {
  peer: Peer
  myIdentity: string
  /** The peer's identity — used only in the failure message. */
  peerName?: string
  /** Called (with the original sender + a reason) when the async POST fails, so
   *  the infra can tell the sender their message didn't get through. */
  onUndelivered?: (sender: string, reason: string) => void
}): (msg: { from: string; text: string; taskId?: string }) => boolean {
  const { peer, myIdentity, peerName, onUndelivered } = args
  const label = peerName ?? 'the peer'
  return (msg) => {
    if (peer.origin.type !== 'local-path') return false
    const { port } = readRuntimeFiles(resolve(peer.origin.path, '.jean'))
    // THE SAME PREDICATE `peerReach` REPORTS — see `usablePort`. `=== null`
    // let a half-written port file through and posted to port 0.
    if (!usablePort(port)) return false
    void fetch(`http://127.0.0.1:${port}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        from: myIdentity,
        to: PEER_TARGET_AGENT,
        text: msg.text,
        taskId: msg.taskId,
      }),
    })
      .then((res) => {
        if (!res.ok) onUndelivered?.(msg.from, `${label}'s infra returned HTTP ${res.status}`)
      })
      .catch((e) => onUndelivered?.(msg.from, `couldn't reach ${label} (${e})`))
    return true
  }
}
