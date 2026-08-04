/**
 * Proves each injected port is actually HONOURED, not merely accepted
 * (refactor stage 2; spec = task 029 deliverable 2, STAGE 2).
 *
 * WHY, in stage 1's own words: an injection point nothing exercises is dead code
 * that breaks silently the moment a later stage leans on it. After stage 2 every
 * OTHER test in the suite runs the ambient path, so `now` and `store` are
 * exercised only through their defaults — a typo'd `??`, or a call site the
 * substitution missed, would keep the whole suite green and surface in stage 3
 * as a fake clock that mysteriously does nothing.
 *
 * Each test overrides ONE port and asserts an observable that could not be
 * produced any other way. Two ports are covered elsewhere or not at all:
 * `spawn` is proven by server-factory.test.ts on the path that matters (startup
 * trigger catch-up), and `log` is deliberately unproven — see the note below.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { createStore, jsonlBackend, type StoredEvent } from '../es/index.ts'
import type { SpawnHeadlessResult } from './librarian.ts'
import type { InfraPorts } from './ports.ts'
import { createInfraServer } from './server.ts'
import { connectAgent } from './test-helpers.ts'

const ROOT = '/tmp/jean-test-ports'
const REGISTRY_PATH = resolve(ROOT, 'registry.json')

/** A fixed, recognisable instant — 2026-01-02T03:04:05.678Z. Nothing in the
 *  server can produce this by accident, which is what makes it evidence. */
const FIXED_NOW = Date.UTC(2026, 0, 2, 3, 4, 5, 678)

/** Never spawns. Every server in this file gets it — the catch-up path must not
 *  be able to reach a real `claude` binary from any fixture. */
const neverSpawn = (async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
  timedOut: false,
})) as unknown as InfraPorts['spawn']

function freshDir(name: string): string {
  const dir = resolve(ROOT, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

function baseOpts(dataDir: string) {
  return { dataDir, port: 0, enforceSingleInstance: false, writeRuntimeFiles: false } as const
}

/** Poll until `check` passes or the budget runs out. Several observables here
 *  arrive via `void record(...)`, which is fire-and-forget by design — polling
 *  is honest about that where a fixed sleep would just be a guess. */
async function eventually(check: () => boolean, budgetMs = 2000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (check()) return true
    await Bun.sleep(25)
  }
  return check()
}

let savedRegistryPath: string | undefined

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  savedRegistryPath = process.env.JEAN_REGISTRY_PATH
  process.env.JEAN_REGISTRY_PATH = REGISTRY_PATH
})

afterAll(() => {
  if (savedRegistryPath === undefined) delete process.env.JEAN_REGISTRY_PATH
  else process.env.JEAN_REGISTRY_PATH = savedRegistryPath
})

describe('injected ports are honoured', () => {
  test('now — the server reads the injected clock, not the wall clock', async () => {
    const dataDir = freshDir('now')
    const handle = await createInfraServer({
      ...baseOpts(dataDir),
      ports: { spawn: neverSpawn, now: () => FIXED_NOW },
    })
    try {
      // Registering IS traffic: the register handler stamps lastActivityAt from
      // ports.now(), and GET /agents renders it as an ISO string.
      const agent = await connectAgent(`ws://127.0.0.1:${handle.port}/ws`, 'clock-probe')
      try {
        const res = await fetch(`http://127.0.0.1:${handle.port}/agents`)
        const body = (await res.json()) as { agents: { name: string; lastActivityAt?: string }[] }
        const probe = body.agents.find((a) => a.name === 'clock-probe')
        expect(probe?.lastActivityAt).toBe(new Date(FIXED_NOW).toISOString())
      } finally {
        agent.ws.close()
      }
    } finally {
      await handle.stop()
    }
  })

  // DELIBERATELY NOT TESTED: `log`. Leonid's ruling, 2026-08-04 — logging is not
  // logic. It is never relied on, it carries no contract, and nothing branches on
  // it, so an assertion here would pin an implementation detail rather than a
  // behaviour. The port stays threaded (harmless, and it lets a caller capture
  // output if it ever wants to); it just needs no proof. `log` is not one of the
  // core's four effects — see ports.ts for how that set was arrived at.

  test('store — events land in the injected store, and the default path is never written', async () => {
    const dataDir = freshDir('store')
    const elsewhere = resolve(ROOT, 'store', 'elsewhere.jsonl')
    const handle = await createInfraServer({
      ...baseOpts(dataDir),
      ports: { spawn: neverSpawn, store: createStore(jsonlBackend(elsewhere)) },
    })
    try {
      expect(
        await eventually(() => existsSync(elsewhere) && readFileSync(elsewhere, 'utf8').includes('"type":"start"')),
      ).toBe(true)
      // The dojo's own history.jsonl — the default the port replaced — was
      // never touched. Without this the test would pass even if `?? ` fell
      // through to the default and the injected store were merely ignored.
      expect(existsSync(resolve(dataDir, 'history.jsonl'))).toBe(false)
    } finally {
      await handle.stop()
    }
  })

  test('omitted ports keep their ambient defaults — {} and "not passed" are the same server', async () => {
    const dataDir = freshDir('defaults')
    const handle = await createInfraServer({ ...baseOpts(dataDir), ports: { spawn: neverSpawn } })
    try {
      // Real clock: the `start` event's ts is within a minute of now, which the
      // FIXED_NOW of 2026-01-02 would fail by months.
      const historyPath = resolve(dataDir, 'history.jsonl')
      expect(await eventually(() => existsSync(historyPath))).toBe(true)
      const first = JSON.parse(readFileSync(historyPath, 'utf8').split('\n')[0] as string) as StoredEvent
      expect(Math.abs(new Date(first.ts).getTime() - Date.now())).toBeLessThan(60_000)
    } finally {
      await handle.stop()
    }
  })
})

/** Type-level guard: `SpawnHeadlessResult` is what the spawn port must return.
 *  Referenced so a change to that contract fails this file at typecheck rather
 *  than silently widening what a fake spawner may return. */
export type _SpawnPortReturns = Awaited<ReturnType<InfraPorts['spawn']>> extends SpawnHeadlessResult ? true : never
