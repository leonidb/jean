// `jean ask` — synchronous ask-and-wait over the dojo WS as the `cli` user
// identity. The full attention stack serves the CLI: the question lands as a
// BLOCKING event (immediate sensei wake), and the sensei's normal
// send(to:"cli") both delivers to the waiting process AND auto-clears the
// question (phase 3 exactly-one rule).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Subprocess } from 'bun'
import type { DeliverMsg } from '../infra/protocol.ts'
import { connectAgent } from '../infra/test-helpers.ts'

const TEST_PORT = 8790
const DOJO = '/tmp/jean-test-ask'
const DATA_DIR = `${DOJO}/.jean`
const BASE = `http://127.0.0.1:${TEST_PORT}`
const WS_URL = `ws://127.0.0.1:${TEST_PORT}/ws`
const CLI = resolve(import.meta.dir, 'jean.ts')
let server: Subprocess

beforeAll(async () => {
  try {
    rmSync(DOJO, { recursive: true })
  } catch {}
  mkdirSync(DATA_DIR, { recursive: true })
  // findDojoRoot's marker — the CLI refuses to run without it.
  writeFileSync(resolve(DATA_DIR, 'jean.config.json'), JSON.stringify({ port: TEST_PORT }))
  server = Bun.spawn(['bun', 'run', 'src/infra/server.ts'], {
    env: {
      ...process.env,
      JEAN_PORT: String(TEST_PORT),
      JEAN_DATA_DIR: DATA_DIR,
      // Private registry: this server self-registers at startup, and an entry
      // in the SHARED throwaway registry would make peer.test's fixed-port
      // `dojo init` calls fail on a phantom collision (cli tests run in
      // alphabetical order — this file spawns a server before peer.test runs).
      JEAN_REGISTRY_PATH: resolve(DOJO, 'registry.json'),
    },
    stdout: 'ignore',
    stderr: 'pipe',
  })
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(`${BASE}/`)
      break
    } catch {
      await Bun.sleep(100)
    }
  }
})

afterAll(() => {
  server.kill()
})

describe('jean ask', () => {
  test('question wakes the sensei as blocking; reply prints and auto-clears; multi-part collected', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')

    // Run the CLI from inside the dojo dir. Short grace so the test is quick.
    const ask = Bun.spawn(
      ['bun', 'run', CLI, 'ask', 'sensei', 'what is the answer?', '--grace', '1', '--timeout', '20'],
      {
        cwd: DOJO,
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    // The sensei must receive a BLOCKING wake carrying the question.
    let wake: string | undefined
    const isAskWake = (m: { type: string }): m is DeliverMsg =>
      m.type === 'deliver' &&
      (m as DeliverMsg).text.startsWith('A human is waiting') &&
      (m as DeliverMsg).text.includes('what is the answer?')
    for (let i = 0; i < 40 && !wake; i++) {
      wake = sensei.messages.find(isAskWake)?.text
      if (!wake) await Bun.sleep(100)
    }
    expect(wake).toBeDefined()

    // Sensei answers in two parts via its normal send path.
    for (const part of ['42.', 'And that is final.']) {
      await fetch(`${BASE}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'sensei', to: 'cli', text: part }),
      })
      await Bun.sleep(150)
    }

    const exitCode = await ask.exited
    const out = await new Response(ask.stdout).text()
    expect(exitCode).toBe(0)
    expect(out).toContain('42.')
    expect(out).toContain('And that is final.') // grace window caught part 2

    // Auto-clear: the cli's question is no longer pending (the reply WAS the ack).
    const events = (await (await fetch(`${BASE}/events`)).json()) as {
      events: Array<{ type: string; data: { agent?: string } }>
    }
    expect(events.events.some((e) => e.type === 'reply' && e.data.agent === 'cli')).toBe(false)
  }, 30_000)

  test('timeout leaves the question queued and exits nonzero', async () => {
    using sensei = await connectAgent(WS_URL, 'sensei', 'sensei')
    void sensei // connected but silent — never answers

    const ask = Bun.spawn(['bun', 'run', CLI, 'ask', 'sensei', 'anyone home?', '--timeout', '3', '--grace', '1'], {
      cwd: DOJO,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await ask.exited
    expect(exitCode).toBe(1)

    // The question survives the CLI's exit — still queued (blocking) for the agent.
    const events = (await (await fetch(`${BASE}/events`)).json()) as {
      events: Array<{ id: number; type: string; data: { agent?: string; text?: string } }>
    }
    const mine = events.events.filter((e) => e.type === 'reply' && e.data.agent === 'cli')
    expect(mine.length).toBe(1)
    expect(mine[0]?.data.text).toBe('anyone home?')

    // Cleanup so the file leaves no pending state.
    await fetch(`${BASE}/events/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: mine.map((e) => e.id) }),
    })
  }, 15_000)
})
