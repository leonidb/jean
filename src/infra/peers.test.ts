import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  clearLivenessCache,
  createPeerDeliver,
  identityFromConfig,
  loadPeers,
  type Peer,
  peerLiveness,
  savePeers,
} from './peers.ts'

describe('peers file I/O', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-peers-io-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('loadPeers returns empty registry when no file exists', () => {
    expect(loadPeers(tmp)).toEqual({ peers: {} })
  })

  test('loadPeers tolerates malformed file', () => {
    writeFileSync(resolve(tmp, 'peers.json'), 'not json {')
    expect(loadPeers(tmp)).toEqual({ peers: {} })
  })

  test('savePeers + loadPeers round-trip', () => {
    const peer: Peer = {
      origin: { type: 'local-path', path: '/path/to/other' },
      description: 'The other dojo',
      addedAt: '2026-04-23T12:00:00Z',
    }
    savePeers(tmp, { peers: { other: peer } })
    expect(loadPeers(tmp).peers.other).toEqual(peer)
  })
})

describe('identityFromConfig', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-peers-id-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('returns identity from jean.config.json when set', () => {
    const jeanDir = resolve(tmp, 'mydojo', '.jean')
    mkdirSync(jeanDir, { recursive: true })
    writeFileSync(resolve(jeanDir, 'jean.config.json'), JSON.stringify({ identity: 'the-dojo' }))
    expect(identityFromConfig(jeanDir)).toBe('the-dojo')
  })

  test('falls back to basename of dojo root when identity missing', () => {
    const jeanDir = resolve(tmp, 'mydojo', '.jean')
    mkdirSync(jeanDir, { recursive: true })
    writeFileSync(resolve(jeanDir, 'jean.config.json'), JSON.stringify({ port: 8800 }))
    expect(identityFromConfig(jeanDir)).toBe('mydojo')
  })

  test('falls back to basename when config is missing entirely', () => {
    const jeanDir = resolve(tmp, 'xyz', '.jean')
    mkdirSync(jeanDir, { recursive: true })
    expect(identityFromConfig(jeanDir)).toBe('xyz')
  })
})

describe('peerLiveness', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-peers-live-'))
    clearLivenessCache()
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    clearLivenessCache()
  })

  test('returns offline when peer has no .jean/', async () => {
    const peer: Peer = {
      origin: { type: 'local-path', path: resolve(tmp, 'missing') },
      description: 'x',
      addedAt: '',
    }
    expect(await peerLiveness(peer)).toBe('offline')
  })

  test('returns offline when infra.pid/port absent', async () => {
    const dojo = resolve(tmp, 'stopped')
    mkdirSync(resolve(dojo, '.jean'), { recursive: true })
    const peer: Peer = {
      origin: { type: 'local-path', path: dojo },
      description: 'x',
      addedAt: '',
    }
    expect(await peerLiveness(peer)).toBe('offline')
  })

  test('returns offline when pid is not alive', async () => {
    const dojo = resolve(tmp, 'dead')
    mkdirSync(resolve(dojo, '.jean'), { recursive: true })
    // PID 999999999 is virtually guaranteed not to exist
    writeFileSync(resolve(dojo, '.jean', 'infra.pid'), '999999999')
    writeFileSync(resolve(dojo, '.jean', 'infra.port'), '8801')
    const peer: Peer = {
      origin: { type: 'local-path', path: dojo },
      description: 'x',
      addedAt: '',
    }
    expect(await peerLiveness(peer)).toBe('offline')
  })

  test('caches result across rapid calls', async () => {
    const dojo = resolve(tmp, 'cached')
    mkdirSync(resolve(dojo, '.jean'), { recursive: true })
    const peer: Peer = {
      origin: { type: 'local-path', path: dojo },
      description: 'x',
      addedAt: '',
    }
    const first = await peerLiveness(peer)
    const second = await peerLiveness(peer)
    expect(first).toBe(second)
  })
})

describe('createPeerDeliver', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-peers-deliver-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('returns false when peer origin has no port file (offline)', () => {
    const dojo = resolve(tmp, 'offline')
    mkdirSync(resolve(dojo, '.jean'), { recursive: true })
    const peer: Peer = {
      origin: { type: 'local-path', path: dojo },
      description: 'x',
      addedAt: '',
    }
    const deliver = createPeerDeliver({ peer, myIdentity: 'mine' })
    expect(deliver({ from: 'mine', text: 'hello' })).toBe(false)
  })

  test('returns true when peer has a port file (does not wait for HTTP)', () => {
    const dojo = resolve(tmp, 'online')
    mkdirSync(resolve(dojo, '.jean'), { recursive: true })
    // Bogus port — the fetch will fail asynchronously, but deliver returns
    // true as soon as the POST is queued (fire-and-forget contract).
    writeFileSync(resolve(dojo, '.jean', 'infra.port'), '19999')
    const peer: Peer = {
      origin: { type: 'local-path', path: dojo },
      description: 'x',
      addedAt: '',
    }
    const deliver = createPeerDeliver({ peer, myIdentity: 'mine' })
    expect(deliver({ from: 'mine', text: 'hello' })).toBe(true)
  })
})
