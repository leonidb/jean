/**
 * Route pins for `/permissions` and `/playbooks` (refactor stage 5 — task 038;
 * the coverage gap named in 029 D3 and re-verified on main by 037).
 *
 * ── THESE ARE PINS, NOT COVERAGE ──
 *
 * Both routes had ZERO tests. Stage 5 rewrites branches to parse→call→render,
 * and "behaviour-preserving" is not a claim you can make about a branch nothing
 * observes — it is just a rewrite. So these land FIRST, green against
 * unmodified code, exactly as phase A's race-guard tests did in stage 3: the
 * evidence that they were green before anything moved is a separate commit in
 * git rather than my word for it.
 *
 * They assert request in → status + shape out, and nothing more. Pinning the
 * internals of routes the protocol build may reshape would be inventing a
 * contract, not recording one.
 *
 * ── ONE TRAP WORTH NAMING ──
 *
 * `/permissions` LOOKS tested: `src/cli/permissions.test.ts` exists. It covers
 * CLI permission-FILE merging and never touches this HTTP surface. The
 * architect flagged that false positive twice, in D3 and again in 037, because
 * it is the kind that fools a grep and then fools the next person.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { InfraPorts } from './ports.ts'
import { createInfraServer, type InfraHandle } from './server.ts'

const ROOT = '/tmp/jean-test-route-pins'
const REGISTRY_PATH = resolve(ROOT, 'registry.json')

/** Never spawns — startup trigger catch-up must not reach a real `claude`. */
const neverSpawn = (async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
  timedOut: false,
})) as unknown as InfraPorts['spawn']

let handle: InfraHandle
let base: string
let savedRegistryPath: string | undefined

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  savedRegistryPath = process.env.JEAN_REGISTRY_PATH
  process.env.JEAN_REGISTRY_PATH = REGISTRY_PATH

  // Seed a playbook through the directory the factory already reconciles from,
  // rather than by writing events: that is how a playbook actually comes to
  // exist, so the pin covers the real path in.
  mkdirSync(resolve(ROOT, 'playbooks'), { recursive: true })
  writeFileSync(
    resolve(ROOT, 'playbooks', 'triage.md'),
    ['---', 'name: Triage', 'description: How to triage an incoming request', '---', '', 'Read it. Route it.', ''].join(
      '\n',
    ),
  )

  handle = await createInfraServer({
    dataDir: ROOT,
    port: 0,
    enforceSingleInstance: false,
    writeRuntimeFiles: false,
    ports: { spawn: neverSpawn },
  })
  base = `http://127.0.0.1:${handle.port}`
})

afterAll(async () => {
  await handle.stop()
  if (savedRegistryPath === undefined) delete process.env.JEAN_REGISTRY_PATH
  else process.env.JEAN_REGISTRY_PATH = savedRegistryPath
})

type Permissions = { permissions: Record<string, Record<string, { count: number; samples: unknown[] }>> }

describe('POST /permissions', () => {
  test('a well-formed request is accepted', async () => {
    const res = await fetch(`${base}/permissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'w1', tool: 'Bash', input: { command: 'ls' } }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('a missing field is a 400 — both of them, not just the first', async () => {
    for (const body of [{ tool: 'Bash' }, { agent: 'w1' }, {}]) {
      const res = await fetch(`${base}/permissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: expect.any(String) })
    }
  })
})

describe('GET /permissions', () => {
  test('returns the requests that were posted, grouped by agent and tool', async () => {
    // Ordering note: the POST above has already run — `describe` blocks execute
    // in file order — so this is deliberately the "after a POST" case. The
    // empty case is covered below against an agent filter that matches nothing,
    // which is the same shape without needing a second server.
    const res = await fetch(`${base}/permissions`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Permissions
    expect(body.permissions.w1?.Bash?.count).toBe(1)
    expect(body.permissions.w1?.Bash?.samples).toEqual([{ command: 'ls' }])
  })

  test('an agent filter that matches nothing returns the empty shape, not an error', async () => {
    const res = await fetch(`${base}/permissions?agent=nobody`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ permissions: {} })
  })

  test('AGGREGATES across requests, and the agent filter selects', async () => {
    // Added after a review pass pointed out the pin above only ever sees
    // `count: 1` — so a broken aggregation would have passed it. Counting
    // repeats is what this route is FOR; a pin that never exercises it is
    // pinning the shape and not the behaviour.
    for (const agent of ['w2', 'w2', 'w3']) {
      await fetch(`${base}/permissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent, tool: 'Write' }),
      })
    }

    const all = (await (await fetch(`${base}/permissions`)).json()) as Permissions
    expect(all.permissions.w2?.Write?.count).toBe(2)
    expect(all.permissions.w3?.Write?.count).toBe(1)

    const filtered = (await (await fetch(`${base}/permissions?agent=w2`)).json()) as Permissions
    expect(filtered.permissions.w2?.Write?.count).toBe(2)
    expect(filtered.permissions.w3).toBeUndefined()

    // NOT pinned, on purpose: the 5-sample cap. That is an internal the
    // protocol build may well reshape, and pinning it would be inventing a
    // contract rather than recording one.
  })
})

describe('GET /playbooks', () => {
  test('lists playbooks reconciled from the playbooks directory', async () => {
    const res = await fetch(`${base}/playbooks`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { playbooks: { id: string; name: string; description: string }[] }
    expect(Array.isArray(body.playbooks)).toBe(true)
    const triage = body.playbooks.find((p) => p.id === 'triage')
    expect(triage).toMatchObject({ id: 'triage', name: 'Triage', description: 'How to triage an incoming request' })
    // The LIST omits content on purpose — `/playbooks/:id` is what serves it.
    expect(triage).not.toHaveProperty('content')
  })
})

describe('GET /playbooks/:id', () => {
  test('a known id serves the full playbook including its content', async () => {
    const res = await fetch(`${base}/playbooks/triage`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; name: string; content: string }
    expect(body.id).toBe('triage')
    expect(body.name).toBe('Triage')
    expect(body.content).toContain('Read it. Route it.')
  })

  test('an unknown id is a 404, not an empty 200', async () => {
    const res = await fetch(`${base}/playbooks/does-not-exist`)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: expect.any(String) })
  })
})
