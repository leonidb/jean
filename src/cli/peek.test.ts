import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import type { StoredEvent } from '../es/index.ts'
import { peekDojo, readCursor, writeCursor } from './peek.ts'

function makeDojo(tmp: string, name: string, events: StoredEvent[] = [], config?: Record<string, unknown>) {
  const dojo = resolve(tmp, name)
  const jean = resolve(dojo, '.jean')
  mkdirSync(jean, { recursive: true })
  writeFileSync(
    resolve(jean, 'history.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''),
  )
  if (config) writeFileSync(resolve(jean, 'jean.config.json'), JSON.stringify(config))
  return dojo
}

function ev(
  id: number,
  stream: string,
  type: string,
  data: Record<string, unknown>,
  ts = '2026-04-23T00:00:00Z',
): StoredEvent {
  return { id, stream, type, ts, data }
}

describe('peekDojo', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-peek-test-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('projects the board from history events', async () => {
    const events = [
      ev(1, 'task-001', 'task-created', { title: 'First', description: '', queue: 'worker' }),
      ev(2, 'task-001', 'task-status', { from: 'todo', to: 'in-progress', actor: 'sensei' }),
      ev(3, 'task-002', 'task-created', { title: 'Second', description: '', queue: 'worker' }),
    ]
    const dojo = makeDojo(tmp, 'target', events, { identity: 'target', port: 8800 })

    const result = await peekDojo(dojo)
    expect(result.target.identity).toBe('target')
    expect(result.board.tasks).toHaveLength(2)
    expect(result.board.tasks.find((t) => t.id === '001')?.status).toBe('in-progress')
    expect(result.cursor.lastEventId).toBe(3)
  })

  test('errors cleanly on a path with no .jean/', async () => {
    const notADojo = resolve(tmp, 'plain')
    mkdirSync(notADojo)
    await expect(peekDojo(notADojo)).rejects.toThrow(/Not a Jean dojo/)
  })

  test('handles stopped dojo with no history.jsonl yet', async () => {
    const dojo = makeDojo(tmp, 'fresh', [])
    // Delete the (empty) history.jsonl to simulate a freshly-init'd dojo
    rmSync(resolve(dojo, '.jean', 'history.jsonl'))
    const result = await peekDojo(dojo)
    expect(result.board.tasks).toEqual([])
    expect(result.events).toEqual([])
    expect(result.cursor.lastEventId).toBe(0)
  })

  test('--since returns only events past the cursor', async () => {
    const events = [
      ev(1, 'task-001', 'task-created', { title: 'A', description: '', queue: 'w' }),
      ev(2, 'task-001', 'task-status', { from: 'todo', to: 'in-progress' }),
      ev(3, 'task-001', 'task-status', { from: 'in-progress', to: 'done' }),
    ]
    const dojo = makeDojo(tmp, 'deltas', events)

    const first = await peekDojo(dojo, { sinceId: 1 })
    expect(first.events.map((e) => e.id)).toEqual([2, 3])
    expect(first.cursor.eventsSince).toBe(2)

    const second = await peekDojo(dojo, { sinceId: 3 })
    expect(second.events).toEqual([])
    expect(second.cursor.eventsSince).toBe(0)
    expect(second.cursor.lastEventId).toBe(3) // board state is still fully projected
  })

  test('filters out administrative events (ack, nudge, register) from window', async () => {
    const events = [
      ev(1, 'system', 'start', { port: 8800 }),
      ev(2, 'agent-sensei', 'register', { agent: 'sensei', role: 'sensei' }),
      ev(3, 'task-001', 'task-created', { title: 'Real work', description: '', queue: 'w' }),
      ev(4, 'system', 'ack', { upToId: 3 }),
      ev(5, 'task-001', 'task-status', { from: 'todo', to: 'in-progress' }),
    ]
    const dojo = makeDojo(tmp, 'noisy', events)

    const result = await peekDojo(dojo)
    const types = result.events.map((e) => e.type)
    expect(types).toContain('task-created')
    expect(types).toContain('task-status')
    expect(types).not.toContain('register')
    expect(types).not.toContain('ack')
    expect(types).not.toContain('start')
  })

  test('discovers agent names from events', async () => {
    const events = [
      ev(1, 'task-001', 'task-created', { title: 'x', description: '', queue: 'builder' }),
      ev(2, 'task-001', 'task-status', { from: 'todo', to: 'in-progress' }),
      ev(3, 'task-001', 'send', { from: 'sensei', to: 'builder', text: 'go' }),
      ev(4, 'task-001', 'reply', { agent: 'builder', text: 'done' }),
    ]
    const dojo = makeDojo(tmp, 'agents', events)

    const result = await peekDojo(dojo)
    expect(result.agents).toContain('builder')
    expect(result.agents).toContain('sensei')
  })
})

describe('cursor persistence', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-cursor-test-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('round-trips a cursor per (caller, target) pair', () => {
    const caller = resolve(tmp, 'caller')
    mkdirSync(resolve(caller, '.jean'), { recursive: true })

    expect(readCursor(caller, '/path/to/A')).toBeUndefined()
    writeCursor(caller, '/path/to/A', 42)
    expect(readCursor(caller, '/path/to/A')).toBe(42)

    writeCursor(caller, '/path/to/B', 99)
    expect(readCursor(caller, '/path/to/A')).toBe(42)
    expect(readCursor(caller, '/path/to/B')).toBe(99)
  })

  test('stored file has stable human-readable shape', () => {
    const caller = resolve(tmp, 'caller')
    mkdirSync(resolve(caller, '.jean'), { recursive: true })
    writeCursor(caller, '/path/to/X', 7)

    const contents = JSON.parse(readFileSync(resolve(caller, '.jean', 'peek-cursors.json'), 'utf8'))
    expect(contents.cursors['/path/to/X'].lastEventId).toBe(7)
    expect(typeof contents.cursors['/path/to/X'].lastPeekAt).toBe('string')
  })
})

describe('peek CLI integration', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-peek-cli-test-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  const CLI = resolve(import.meta.dir, 'jean.ts')

  function runJean(cwd: string, ...args: string[]) {
    const result = Bun.spawnSync(['bun', 'run', CLI, ...args], {
      cwd,
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return {
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  }

  test('peek without args errors with usage', () => {
    const out = runJean(tmp, 'peek')
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('Usage: jean peek')
  })

  test('peek against a non-dojo path errors clearly', () => {
    mkdirSync(resolve(tmp, 'plain'))
    const out = runJean(tmp, 'peek', resolve(tmp, 'plain'))
    expect(out.exitCode).not.toBe(0)
    expect(out.stderr + out.stdout).toContain('Not a Jean dojo')
  })

  test('peek --json returns parseable JSON with expected shape', () => {
    const events = [ev(1, 'task-001', 'task-created', { title: 'T', description: '', queue: 'w' })]
    const dojo = makeDojo(tmp, 'dojo', events, { identity: 'dojo' })
    const out = runJean(tmp, 'peek', dojo, '--json')
    expect(out.exitCode).toBe(0)
    const parsed = JSON.parse(out.stdout)
    expect(parsed.target.identity).toBe('dojo')
    expect(parsed.board.tasks).toHaveLength(1)
    expect(parsed.cursor.lastEventId).toBe(1)
  })

  test('--since-last advances the cursor and subsequent peek is empty', () => {
    // Set up caller as a dojo so cursor can persist
    const caller = resolve(tmp, 'caller')
    mkdirSync(resolve(caller, '.jean'), { recursive: true })

    const events = [
      ev(1, 'task-001', 'task-created', { title: 'T', description: '', queue: 'w' }),
      ev(2, 'task-001', 'task-status', { from: 'todo', to: 'in-progress' }),
    ]
    const target = makeDojo(tmp, 'target', events)

    const first = runJean(caller, 'peek', target, '--since-last', '--json')
    expect(first.exitCode).toBe(0)
    const firstData = JSON.parse(first.stdout)
    expect(firstData.cursor.lastEventId).toBe(2)

    // After first call, cursor was at 0 → delta returned events past 0 (i.e. all 2)
    expect(firstData.events.length).toBeGreaterThanOrEqual(1)

    const second = runJean(caller, 'peek', target, '--since-last', '--json')
    expect(second.exitCode).toBe(0)
    const secondData = JSON.parse(second.stdout)
    expect(secondData.events).toEqual([])
    expect(secondData.cursor.eventsSince).toBe(0)
  })

  test('--since-last errors when caller is not in a dojo', () => {
    const target = makeDojo(tmp, 'target', [])
    const out = runJean(tmp, 'peek', target, '--since-last')
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('--since-last requires')
  })
})
