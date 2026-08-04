/**
 * In-process smoke test for `createInfraServer()` — the mandatory half of
 * refactor stage 1 (task 030; spec = task 029 deliverable 2, STAGE 1).
 *
 * WHY THIS EXISTS. All 16 spawn-based server tests exercise the ENTRYPOINT.
 * They say nothing about the factory's non-default options — `port: 0`,
 * `enforceSingleInstance: false`, `writeRuntimeFiles: false`, an injected
 * `spawnHeadless`, and `stop()` itself would otherwise be dead code that breaks
 * silently the moment stage 2 leans on it. The plan's words: without this,
 * stage 1 is a loaded gun.
 *
 * WHAT IT ASSERTS, and how. `bun test` runs every file in ONE process, so a
 * leak here destabilises every file that follows. Bun stubs
 * `process.getActiveResourcesInfo()` and `process._getActiveHandles()` to `[]`
 * (verified on 1.3.11), so there is no runtime handle census to read. Each
 * class of handle is therefore pinned by the strongest evidence available:
 *   - intervals   → globals instrumented for the create→stop window; net zero
 *   - cron jobs   → BEHAVIOURAL: a trigger due after stop() never fires
 *   - fs.watch    → BEHAVIOURAL: a playbook written after stop() is not seen
 *   - the socket  → the port refuses connections after stop()
 *   - listeners   → process.listenerCount() is flat across all three cycles
 *
 * This file must never spawn a real process. `spawnHeadless` is injected in
 * every case, and the catch-up test deliberately seeds a stale headless trigger
 * to prove the injection is what stands between a fixture and a real `claude`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SpawnHeadlessResult } from './librarian.ts'
import { createInfraServer, type InfraHandle } from './server.ts'
import { connectAgent } from './test-helpers.ts'

const ROOT = '/tmp/jean-test-factory'
const REGISTRY_PATH = resolve(ROOT, 'registry.json')

/** Records every headless spawn the server attempts, and performs none. A
 *  successful-looking result keeps the startup catch-up path moving (it waits
 *  on the `headless-completed` event the caller records from this). */
function fakeSpawner() {
  const calls: { role: string; prompt: string }[] = []
  const spawn = async (opts: { role: string; prompt: string }): Promise<SpawnHeadlessResult> => {
    calls.push({ role: opts.role, prompt: opts.prompt })
    return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false }
  }
  return { calls, spawn: spawn as unknown as NonNullable<Parameters<typeof createInfraServer>[0]>['spawnHeadless'] }
}

/** Count intervals created-and-not-cleared inside a window. server.ts calls the
 *  bare globals, so patching `globalThis` catches them; croner and Bun's own
 *  internals use timeouts rather than intervals, which keeps this signal
 *  clean. */
function trackIntervals() {
  const live = new Set<unknown>()
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const id = realSet(...args)
    live.add(id)
    return id
  }) as typeof setInterval
  globalThis.clearInterval = ((id?: Parameters<typeof clearInterval>[0]) => {
    live.delete(id)
    return realClear(id)
  }) as typeof clearInterval
  return {
    liveCount: () => live.size,
    restore: () => {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
    },
  }
}

function freshDir(name: string): string {
  const dir = resolve(ROOT, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The options every case shares: never touch the machine-global registry,
 *  never bind a fixed port, never spawn anything. */
function baseOpts(dataDir: string) {
  return { dataDir, port: 0, enforceSingleInstance: false, writeRuntimeFiles: false } as const
}

/** True when nothing is listening on `port` any more. */
async function portRefusesConnections(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`)
    return false
  } catch {
    return true
  }
}

function historyEvents(dataDir: string): { type: string; data: Record<string, unknown> }[] {
  const path = resolve(dataDir, 'history.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> })
}

/** Env this file must control rather than inherit. The bridge vars matter most:
 *  `resolveConfig` folds the TELEGRAM_ and SLACK_ vars into the config it
 *  returns, so a developer who exports a real bot token would have these
 *  in-process servers open a real long-poll — and `stop()` cannot close one
 *  (see InfraHandle.stop).
 *  The spawn suite is insulated by passing an explicit `env`; an in-process test
 *  runs in whatever environment `bun test` was launched with. */
const CONTROLLED_ENV = [
  'JEAN_REGISTRY_PATH',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'SLACK_APP_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_CHANNEL',
] as const

const savedEnv = new Map<string, string | undefined>()

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  for (const key of CONTROLLED_ENV) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  // Belt and braces: writeRuntimeFiles:false already means upsertDojo is never
  // called, and this test asserts the file stays absent. registry.ts reads the
  // env at CALL time, so pointing it here also protects the real registry if
  // that assertion ever regresses.
  process.env.JEAN_REGISTRY_PATH = REGISTRY_PATH
})

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('createInfraServer', () => {
  test('create → HTTP round-trip → WS register → stop, three times in one process', async () => {
    const listenersBefore = {
      exit: process.listenerCount('exit'),
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    }

    const ports: number[] = []

    for (let cycle = 1; cycle <= 3; cycle++) {
      const dataDir = freshDir(`cycle-${cycle}`)
      const timers = trackIntervals()
      const spawner = fakeSpawner()
      let handle: InfraHandle | undefined

      try {
        handle = await createInfraServer({ ...baseOpts(dataDir), spawnHeadless: spawner.spawn })

        // port: 0 resolved to a real, bound, reported port.
        expect(handle.port).toBeGreaterThan(0)
        expect(handle.dataDir).toBe(dataDir)
        ports.push(handle.port)

        // One HTTP round-trip. `/` reports the bound port, not the requested 0.
        const res = await fetch(`http://127.0.0.1:${handle.port}/`)
        expect(res.status).toBe(200)
        const identity = (await res.json()) as { name: string; port: number; dataDir: string }
        expect(identity.name).toBe('jean-infra')
        expect(identity.port).toBe(handle.port)
        expect(identity.dataDir).toBe(dataDir)

        // One WS register, and the event it produces is really in this
        // instance's store — proving the closure state is per-instance.
        const agent = await connectAgent(`ws://127.0.0.1:${handle.port}/ws`, `smoke-${cycle}`)
        try {
          const agentsRes = await fetch(`http://127.0.0.1:${handle.port}/agents`)
          const body = (await agentsRes.json()) as { agents: { name: string }[] }
          expect(body.agents.map((a) => a.name)).toEqual([`smoke-${cycle}`])
        } finally {
          agent.ws.close()
        }

        // writeRuntimeFiles:false honoured — no pid/port files, no registry.
        expect(existsSync(resolve(dataDir, 'infra.port'))).toBe(false)
        expect(existsSync(resolve(dataDir, 'infra.pid'))).toBe(false)
        expect(existsSync(REGISTRY_PATH)).toBe(false)

        // The two intervals (blocking backoff + stall watchdog) are live.
        expect(timers.liveCount()).toBe(2)
      } finally {
        await handle?.stop()
        // Read, then RESTORE, then assert. Asserting before restoring would
        // leave globalThis.setInterval patched for the remaining 43 files in
        // this process the moment the assertion ever fails.
        const leakedIntervals = timers.liveCount()
        timers.restore()
        expect(leakedIntervals).toBe(0)
      }

      // The socket is released: the port no longer accepts connections.
      expect(await portRefusesConnections(handle?.port as number)).toBe(true)

      // Nothing spawned, in any cycle.
      expect(spawner.calls).toEqual([])
    }

    // Every cycle bound a real port. Distinctness is deliberately NOT asserted:
    // the OS is free to hand back a just-released ephemeral port, so that would
    // be a flake rather than a stronger claim. What actually proves the three
    // instances were independent is the per-cycle `/agents` check above — each
    // one saw only its own agent, which cross-instance state leakage would break.
    expect(ports).toHaveLength(3)
    expect(ports.every((p) => p > 0)).toBe(true)

    // NO LISTENER ACCUMULATION. This is the assertion that pins
    // "signal handlers live in the entrypoint, never the factory".
    expect(process.listenerCount('exit')).toBe(listenersBefore.exit)
    expect(process.listenerCount('SIGINT')).toBe(listenersBefore.sigint)
    expect(process.listenerCount('SIGTERM')).toBe(listenersBefore.sigterm)
  })

  test('stop() is idempotent', async () => {
    const dataDir = freshDir('idempotent')
    const handle = await createInfraServer({ ...baseOpts(dataDir), spawnHeadless: fakeSpawner().spawn })
    await handle.stop()
    await handle.stop()
    expect(await portRefusesConnections(handle.port)).toBe(true)
  })

  test('stop() releases the cron scheduler — a trigger due after stop never fires', async () => {
    const dataDir = freshDir('cron')
    const handle = await createInfraServer({ ...baseOpts(dataDir), spawnHeadless: fakeSpawner().spawn })

    // One-off trigger due comfortably after we stop.
    const dueAt = new Date(Date.now() + 2000).toISOString()
    const res = await fetch(`http://127.0.0.1:${handle.port}/triggers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'late', at: dueAt, agent: 'nobody', prompt: 'should never fire', actor: 'test' }),
    })
    expect(res.status).toBe(201)

    await handle.stop()
    // Guard the guard: if this trips, the trigger fired BEFORE stop() and the
    // window below proves nothing — that is a slow machine, not a leak.
    expect(historyEvents(dataDir).some((e) => e.type === 'trigger-fired')).toBe(false)

    await Bun.sleep(2600) // well past dueAt

    expect(historyEvents(dataDir).some((e) => e.type === 'trigger-fired')).toBe(false)
  })

  test('stop() releases the playbook watcher — a file written after stop is not seen', async () => {
    const dataDir = freshDir('watcher')
    const handle = await createInfraServer({ ...baseOpts(dataDir), spawnHeadless: fakeSpawner().spawn })
    const playbooks = resolve(dataDir, 'playbooks')

    // While running, the watcher works — otherwise the negative below proves
    // nothing (a watcher that never worked also never fires).
    writeFileSync(resolve(playbooks, 'alive.md'), '# alive\n')
    await Bun.sleep(600)
    expect(historyEvents(dataDir).some((e) => e.data.id === 'alive')).toBe(true)

    await handle.stop()

    writeFileSync(resolve(playbooks, 'after-stop.md'), '# after stop\n')
    await Bun.sleep(600)
    expect(historyEvents(dataDir).some((e) => e.data.id === 'after-stop')).toBe(false)
  })

  test('injected spawnHeadless intercepts startup trigger catch-up — no real process', async () => {
    const dataDir = freshDir('catchup')
    // A history fixture holding an overdue headless cron trigger: hourly, last
    // fired two days ago. shouldCatchUp() says yes, so the startup block fires
    // it before createInfraServer() even resolves. Without the injection this
    // reaches Bun.spawn of the `claude` binary.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString()
    const events = [
      {
        id: 1,
        stream: 'triggers',
        type: 'trigger-created',
        ts: twoDaysAgo,
        data: {
          id: 'overdue',
          cron: '0 * * * *',
          agent: 'architect',
          prompt: 'catch me up',
          actor: 'test',
          kind: 'headless',
        },
      },
      {
        id: 2,
        stream: 'triggers',
        type: 'trigger-fired',
        ts: twoDaysAgo,
        data: { triggerId: 'overdue', agent: 'architect', prompt: 'catch me up', kind: 'headless' },
      },
    ]
    writeFileSync(resolve(dataDir, 'history.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`)

    const spawner = fakeSpawner()
    const handle = await createInfraServer({ ...baseOpts(dataDir), spawnHeadless: spawner.spawn })
    try {
      // The catch-up path ran and was intercepted.
      expect(spawner.calls).toEqual([{ role: 'architect', prompt: 'catch me up' }])
      // And it was recorded as a completed headless run, not a failure.
      const completed = historyEvents(dataDir).filter((e) => e.type === 'headless-completed')
      expect(completed).toHaveLength(1)
      expect(completed[0]?.data.exitCode).toBe(0)
    } finally {
      await handle.stop()
    }
  })
})
