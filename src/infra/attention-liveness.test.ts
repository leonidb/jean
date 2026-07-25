// Attention phase 4 (docs/attention.md §3 + Migration step 4): liveness is
// INFERRED from observed traffic, and GET /agents stops conflating it with task
// state. `session` (active|quiet|offline) and `openTasks` (in-progress only)
// become separately-reported facts alongside an untouched `idle`; register no
// longer derives `idle` from the board (the looks-busy-when-free bug); /board
// surfaces per-task staleness so the in-progress signal stays truthful.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Subprocess } from 'bun'
import { connectAgent } from './test-helpers.ts'

const TEST_PORT = 8822
const DATA_DIR = '/tmp/jean-test-attention-liveness'
const QUIET_MS = 700 // env-shrunk worker quiet threshold (default 45 min)
const STALE_MS = 900 // env-shrunk task staleness window (default 24 h)
let server: Subprocess

beforeAll(async () => {
  try {
    rmSync(DATA_DIR, { recursive: true })
  } catch {}
  mkdirSync(DATA_DIR, { recursive: true })
  // A registered peer proves the peer shape is untouched by the split.
  writeFileSync(
    resolve(DATA_DIR, 'peers.json'),
    JSON.stringify({
      peers: {
        'peer-dojo': {
          origin: { type: 'local-path', path: '/tmp/jean-test-attention-liveness-peer' },
          description: 'a peer that is not running',
          addedAt: '2026-07-25T00:00:00Z',
        },
      },
    }),
  )
  server = Bun.spawn(['bun', 'run', 'src/infra/server.ts'], {
    env: {
      ...process.env,
      JEAN_PORT: String(TEST_PORT),
      JEAN_DATA_DIR: DATA_DIR,
      JEAN_QUIET_THRESHOLD_WORKER_MS: String(QUIET_MS),
      JEAN_STALE_TASK_MS: String(STALE_MS),
      JEAN_STALL_NUDGE_MS: String(60_000), // park the watchdog — not under test here
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

type AgentRow = {
  name: string
  role: string
  idle: boolean
  tags: string[]
  session?: string
  openTasks?: number
  lastActivityAt?: string
  liveness?: string
}

async function agentRow(name: string): Promise<AgentRow | undefined> {
  const data = (await (await fetch(`${BASE}/agents`)).json()) as { agents: AgentRow[] }
  return data.agents.find((a) => a.name === name)
}

type BoardTask = { id: string; status: string; lastEventAt?: string; stale?: boolean }

async function boardTask(id: string): Promise<BoardTask | undefined> {
  const board = (await (await fetch(`${BASE}/board`)).json()) as { tasks: BoardTask[] }
  return board.tasks.find((t) => t.id === id)
}

async function createTask(queue: string, title: string): Promise<string> {
  const res = await fetch(`${BASE}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, description: '', queue }),
  })
  return ((await res.json()) as { id: string }).id
}

async function setStatus(id: string, status: string) {
  await fetch(`${BASE}/tasks/${id}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  })
}

describe('attention phase 4 — GET /agents field split', () => {
  test('ADDITIVE: session + openTasks + lastActivityAt land alongside an unchanged idle/role/tags', async () => {
    using _w = await connectAgent(WS_URL, 'split-worker', 'worker')
    const row = await agentRow('split-worker')

    // The pre-phase-4 shape, byte-for-byte — dispatch logic keying on `idle`
    // must not break, so nothing here may move or change meaning.
    expect(row).toBeDefined()
    expect(row?.role).toBe('worker')
    expect(row?.idle).toBe(true)
    expect(row?.tags).toEqual([])
    // The new facts.
    expect(row?.session).toBe('active')
    expect(row?.openTasks).toBe(0)
    expect(typeof row?.lastActivityAt).toBe('string')
  })

  test('LOOKS-BUSY-WHEN-FREE IS DEAD: a worker holding an in-progress task registers idle:true, and openTasks carries the task state', async () => {
    // The task goes in-progress BEFORE the session exists — this is exactly the
    // state that used to register `idle: false` and suppress dispatch/nudges.
    const id = await createTask('busy-worker', 'held task')
    await fetch(`${BASE}/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'busy-worker' }),
    })
    await setStatus(id, 'in-progress')

    using _w = await connectAgent(WS_URL, 'busy-worker', 'worker')
    const row = await agentRow('busy-worker')
    expect(row?.idle).toBe(true) // session hint: no turn in flight
    expect(row?.openTasks).toBe(1) // task state: separately reported
    expect(row?.session).toBe('active')
  })

  test('openTasks counts IN-PROGRESS ONLY — a long-lived waiting task must not make a worker look permanently busy', async () => {
    const id = await createTask('waiting-worker', 'parked for a human answer')
    await fetch(`${BASE}/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'waiting-worker' }),
    })
    await setStatus(id, 'in-progress')
    using _w = await connectAgent(WS_URL, 'waiting-worker', 'worker')
    expect((await agentRow('waiting-worker'))?.openTasks).toBe(1)

    // Parked → the worker is dispatchable again, even though the task stays open
    // on the board indefinitely (the goals dojo has one open since April).
    await setStatus(id, 'waiting')
    const parked = await agentRow('waiting-worker')
    expect(parked?.openTasks).toBe(0)
    expect((await boardTask(id))?.status).toBe('waiting') // still open, just not busy
  })

  test('PEER SHAPE UNTOUCHED: peers keep `liveness` and gain no session/openTasks', async () => {
    const peer = await agentRow('peer-dojo')
    expect(peer).toBeDefined()
    expect(peer?.role).toBe('peer')
    expect(peer?.liveness).toBeDefined() // skip-if-silent pings key on this
    expect(peer?.session).toBeUndefined()
    expect(peer?.openTasks).toBeUndefined()
  })
})

describe('attention phase 4 — traffic-observed liveness', () => {
  test('a silent session goes quiet past its role threshold and returns to active on ANY inbound traffic', async () => {
    using worker = await connectAgent(WS_URL, 'quiet-worker', 'worker')
    expect((await agentRow('quiet-worker'))?.session).toBe('active')

    await Bun.sleep(QUIET_MS + 250) // silence past the (shrunk) worker threshold
    expect((await agentRow('quiet-worker'))?.session).toBe('quiet')

    // A WS frame is traffic.
    worker.ws.send(JSON.stringify({ type: 'reply', from: 'quiet-worker', text: 'still here' }))
    await Bun.sleep(100)
    expect((await agentRow('quiet-worker'))?.session).toBe('active')

    await Bun.sleep(QUIET_MS + 250)
    expect((await agentRow('quiet-worker'))?.session).toBe('quiet')

    // So is an HTTP call carrying x-jean-agent (a worker's `infra` tool read).
    await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': 'quiet-worker' } })
    expect((await agentRow('quiet-worker'))?.session).toBe('active')

    await Bun.sleep(QUIET_MS + 250)
    // …and so is the Stop hook, which now merely SHARPENS liveness.
    await fetch(`${BASE}/agent-idle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'quiet-worker' }),
    })
    expect((await agentRow('quiet-worker'))?.session).toBe('active')
  })

  test('FORGED x-jean-agent moves the hint and gates nothing (accepted risk, pinned)', async () => {
    // Review finding [E], ACCEPTED. The header is self-declared, so any local
    // process can move any agent's liveness. That is consistent with the
    // pre-existing trust model — infra binds 127.0.0.1 with no auth, and
    // /send, /events/ack and /agent-idle are equally self-declared while
    // actually changing state. This test pins the boundary of what a forger
    // gets: the hint moves, and nothing else does.
    using worker = await connectAgent(WS_URL, 'forge-target', 'worker')
    await Bun.sleep(QUIET_MS + 250)
    expect((await agentRow('forge-target'))?.session).toBe('quiet')

    const histBefore = (await (await fetch(`${BASE}/history?last=1`)).json()) as { events: Array<{ id: number }> }
    const idleBefore = (await agentRow('forge-target'))?.idle

    // A third party claims to be the worker.
    const res = await fetch(`${BASE}/board`, { headers: { 'x-jean-agent': 'forge-target' } })

    // What the forger CAN do: move the liveness hint.
    expect((await agentRow('forge-target'))?.session).toBe('active')
    // What it CANNOT do: no inbox leak (the piggyback is role-gated to the
    // sensei), no state change, no event, no effect on delivery.
    expect(res.headers.get('x-jean-inbox')).toBeNull()
    expect((await agentRow('forge-target'))?.idle).toBe(idleBefore)
    const histAfter = (await (await fetch(`${BASE}/history?last=1`)).json()) as { events: Array<{ id: number }> }
    expect(histAfter.events.at(-1)?.id).toBe(histBefore.events.at(-1)?.id as number)

    const sent = await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'api', to: 'forge-target', text: 'delivery is unaffected' }),
    })
    expect(((await sent.json()) as { delivered: boolean }).delivered).toBe(true)
    expect(worker.messages.some((m) => m.type === 'deliver' && m.text === 'delivery is unaffected')).toBe(true)
  })

  test('quiet is a HINT: a quiet agent still receives delivery', async () => {
    // The binding invariant (docs/attention.md §3) — session must never gate
    // anything. A worker past its quiet threshold takes messages exactly as
    // before; if this ever fails, the phase has reintroduced the stall class.
    using worker = await connectAgent(WS_URL, 'quiet-target', 'worker')
    await Bun.sleep(QUIET_MS + 250)
    expect((await agentRow('quiet-target'))?.session).toBe('quiet')

    const res = await fetch(`${BASE}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'api', to: 'quiet-target', text: 'work while quiet' }),
    })
    expect(((await res.json()) as { delivered: boolean }).delivered).toBe(true)
    expect(worker.messages.some((m) => m.type === 'deliver' && m.text === 'work while quiet')).toBe(true)
  })
})

describe('attention phase 4 — board staleness (surfacing only)', () => {
  test('every task carries lastEventAt; an in-progress task quiet past the window is flagged stale — and is NOT demoted', async () => {
    const id = await createTask('stale-worker', 'forgotten task')
    await fetch(`${BASE}/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'stale-worker' }),
    })
    await setStatus(id, 'in-progress')

    const fresh = await boardTask(id)
    expect(fresh?.lastEventAt).toBeDefined()
    expect(fresh?.stale).toBeUndefined() // just moved — nothing to flag

    await Bun.sleep(STALE_MS + 300)
    const stale = await boardTask(id)
    expect(stale?.stale).toBe(true)
    // NO AUTO-DEMOTION: statuses stay sensei-owned, single-writer. Infra informs.
    expect(stale?.status).toBe('in-progress')

    // Any activity on the task's stream clears the flag — a comment counts.
    using worker = await connectAgent(WS_URL, 'stale-worker', 'worker')
    worker.ws.send(JSON.stringify({ type: 'task-comment', from: 'stale-worker', taskId: id, text: 'still on it' }))
    await Bun.sleep(200)
    const refreshed = await boardTask(id)
    expect(refreshed?.stale).toBeUndefined()
    expect(Date.parse(refreshed?.lastEventAt ?? '')).toBeGreaterThan(Date.parse(stale?.lastEventAt ?? ''))
  })

  test('a waiting task is never flagged stale, however long it sits', async () => {
    const id = await createTask('parked-worker', 'waiting on a human since forever')
    await fetch(`${BASE}/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'parked-worker' }),
    })
    await setStatus(id, 'in-progress')
    await setStatus(id, 'waiting')

    await Bun.sleep(STALE_MS + 300)
    const parked = await boardTask(id)
    expect(parked?.status).toBe('waiting')
    expect(parked?.stale).toBeUndefined() // parked IS the housekeeping outcome
    expect(parked?.lastEventAt).toBeDefined()
  })
})
