/**
 * Pins the `lastTaskContext` projection's LIVE apply (refactor stage 3, commit
 * 0.5 — task 033).
 *
 * THE BUG THIS FIXES. `catchUp()` folded six projections at startup; `record()`
 * applied only five. `lastTaskContext` — "the last task an agent was messaged
 * on", the fallback `inferTaskId()` uses when the board can't attribute an
 * agent — was therefore BOOT-FROZEN: every post-boot `send` was appended to the
 * log and never entered the projection, so inference ran against whatever
 * history happened to exist at startup until the next restart.
 *
 * Why nobody noticed for months: the blast radius is the FALLBACK only.
 * Explicit `taskId`s (the WS `reply` path flows one through from the deliver)
 * are unaffected, and the board lookup — an in-progress/waiting task assigned to
 * that agent — wins ahead of it whenever it can answer. What was left was the
 * uncommon case: a reply from an agent with no board task of its own.
 *
 * The test therefore has to create exactly that case, which is also the trap in
 * writing it: give the worker a board task and the first branch of
 * `inferTaskId()` answers, the fallback is never consulted, and the test passes
 * against the bug. The board stays empty here on purpose.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { InfraPorts } from './ports.ts'
import { createInfraServer } from './server.ts'
import { connectAgent } from './test-helpers.ts'

const ROOT = '/tmp/jean-test-task-context'
const REGISTRY_PATH = resolve(ROOT, 'registry.json')

/** Never spawns — startup trigger catch-up must not be able to reach a real
 *  `claude` binary from any fixture this test leaves behind. */
const neverSpawn = (async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
  timedOut: false,
})) as unknown as InfraPorts['spawn']

type ApiEvent = { id: number; type: string; taskId?: string; data: Record<string, unknown> }

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

describe('lastTaskContext folds live, not only at boot', () => {
  test('a post-boot send steers taskId inference for the agent it was sent to', async () => {
    const dataDir = resolve(ROOT, 'live-apply')
    mkdirSync(dataDir, { recursive: true })
    const handle = await createInfraServer({
      dataDir,
      port: 0,
      enforceSingleInstance: false,
      writeRuntimeFiles: false,
      ports: { spawn: neverSpawn },
    })
    const base = `http://127.0.0.1:${handle.port}`
    const wsUrl = `ws://127.0.0.1:${handle.port}/ws`

    try {
      using sensei = await connectAgent(wsUrl, 'sensei', 'sensei')
      void sensei
      using worker = await connectAgent(wsUrl, 'w1', 'worker')

      const send = (taskId: string) =>
        fetch(`${base}/send`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: 'sensei', to: 'w1', text: `work on ${taskId}`, taskId }),
        })

      // Two sends, so the assertion pins "folds every time" rather than "folded
      // once". A projection that applied only the first would still satisfy a
      // single-send test.
      await send('901')
      await send('902')

      // A reply with NO taskId on the wire — the only path that reaches the
      // inference fallback.
      worker.ws.send(JSON.stringify({ type: 'reply', from: 'w1', text: 'done' }))

      const reply = await eventually(base, (e) => e.type === 'reply' && e.data.agent === 'w1')
      // Boot-frozen, this is `undefined`: the reply lands on `agent-w1` instead.
      expect(reply?.taskId).toBe('902')
    } finally {
      await handle.stop()
    }
  })
})

/** Poll `/events` until an event matching `match` shows up. The reply arrives
 *  via `void record(...)` on the WS path — fire-and-forget by design, so there
 *  is nothing to await and a fixed sleep would just be a guess. */
async function eventually(
  base: string,
  match: (e: ApiEvent) => boolean,
  budgetMs = 2000,
): Promise<ApiEvent | undefined> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const body = (await (await fetch(`${base}/events`)).json()) as { events: ApiEvent[] }
    const hit = body.events.find(match)
    if (hit) return hit
    await Bun.sleep(25)
  }
  return undefined
}
