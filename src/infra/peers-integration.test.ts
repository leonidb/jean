import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Subprocess } from 'bun'
import type { StoredEvent } from '../es/index.ts'
import type { PeersFile } from './peers.ts'
import type { SendData } from './reducers.ts'

/**
 * End-to-end test of the peer dialogue path:
 *  A's infra + B's infra running locally, each with the other registered
 *  as a peer. POST /send on A targeting B's identity should land on B as a
 *  `send` event with senderRole='peer' and peerDescription enriched from
 *  B's own peers.json.
 */

const PORT_A = 8791
const PORT_B = 8792
const DATA_A = '/tmp/jean-test-peers-A/.jean'
const DATA_B = '/tmp/jean-test-peers-B/.jean'

let serverA: Subprocess
let serverB: Subprocess

async function waitReady(port: number) {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (res.ok) return
    } catch {}
    await Bun.sleep(100)
  }
  throw new Error(`Infra on port ${port} never came up`)
}

function seedDojo(dataDir: string, identity: string, port: number, peers: PeersFile) {
  try {
    rmSync(resolve(dataDir, '..'), { recursive: true })
  } catch {}
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(resolve(dataDir, 'jean.config.json'), JSON.stringify({ identity, port }))
  writeFileSync(resolve(dataDir, 'peers.json'), JSON.stringify(peers, null, 2))
}

beforeAll(async () => {
  seedDojo(DATA_A, 'A', PORT_A, {
    peers: {
      B: {
        origin: { type: 'local-path', path: resolve(DATA_B, '..') },
        description: 'B is the peer receiver',
        addedAt: '2026-04-23T00:00:00Z',
      },
    },
  })
  seedDojo(DATA_B, 'B', PORT_B, {
    peers: {
      A: {
        origin: { type: 'local-path', path: resolve(DATA_A, '..') },
        description: 'A is the command-center speaking to B',
        addedAt: '2026-04-23T00:00:00Z',
      },
    },
  })

  serverA = Bun.spawn(['bun', 'run', 'src/infra/server.ts'], {
    env: { ...process.env, JEAN_DATA_DIR: DATA_A },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  serverB = Bun.spawn(['bun', 'run', 'src/infra/server.ts'], {
    env: { ...process.env, JEAN_DATA_DIR: DATA_B },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  await Promise.all([waitReady(PORT_A), waitReady(PORT_B)])
})

afterAll(() => {
  serverA?.kill()
  serverB?.kill()
})

describe('cross-dojo send via peer registration', () => {
  test('/agents on A includes B as a peer with liveness=online', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT_A}/agents`)
    const data = (await res.json()) as { agents: Array<{ name: string; role: string; liveness?: string }> }
    const bEntry = data.agents.find((a) => a.name === 'B')
    expect(bEntry).toBeDefined()
    expect(bEntry?.role).toBe('peer')
    expect(bEntry?.liveness).toBe('online')
  })

  test('POST /send on A (to=B) reaches B as an enriched send event', async () => {
    // A sends to its peer "B". A's routeSend finds B in the agents map (as a
    // peer entry) and its deliver() does HTTP POST to B's /send endpoint with
    // `from: "A"`. B's /send sees from="A", which matches its peers.json,
    // enriches the recorded event.
    const res = await fetch(`http://127.0.0.1:${PORT_A}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'cli', to: 'B', text: 'hello from A' }),
    })
    expect(res.ok).toBe(true)

    // Give the async HTTP POST from A to B a moment to land + be recorded.
    await Bun.sleep(500)

    // Read B's history.jsonl directly. A `send` event should exist where
    // `from === "A"`, `senderRole === "peer"`, and peerDescription is the
    // one from B's own peers.json (not A's wire assertion).
    const history = readFileSync(resolve(DATA_B, 'history.jsonl'), 'utf8')
    const events = history
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredEvent<SendData>)

    const peerSend = events.find(
      (e): e is StoredEvent<SendData> =>
        e.type === 'send' && (e.data as SendData).from === 'A' && (e.data as SendData).senderRole === 'peer',
    )
    expect(peerSend).toBeDefined()
    expect(peerSend?.data.peerDescription).toBe('A is the command-center speaking to B')
    expect(peerSend?.data.text).toBe('hello from A')
  })
})
