import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CLI = resolve(import.meta.dir, 'jean.ts')

function runJean(cwd: string, ...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['bun', 'run', CLI, ...args], {
    cwd,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
  if (out.exitCode !== 0 && out.stderr) console.error(`[runJean stderr]\n${out.stderr}`)
  return out
}

describe('jean dojo move', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-move-test-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('relocates the dojo, repairs worktrees, and rewrites JEAN_DOJO', () => {
    const oldRoot = resolve(tmp, 'old-dojo')
    expect(runJean(tmp, 'dojo', 'init', oldRoot, '--git', '--port', '8700').exitCode).toBe(0)
    expect(runJean(oldRoot, 'agent', 'add', 'worker1').exitCode).toBe(0)

    const newRoot = resolve(tmp, 'nested', 'new-dojo')
    const move = runJean(oldRoot, 'dojo', 'move', newRoot)
    expect(move.exitCode).toBe(0)

    expect(existsSync(oldRoot)).toBe(false)
    expect(existsSync(resolve(newRoot, '.jean'))).toBe(true)
    expect(existsSync(resolve(newRoot, 'worker1'))).toBe(true)

    // JEAN_DOJO rewritten in agent MCP config (via realpath — `/var` → `/private/var` on macOS)
    const mcp = JSON.parse(readFileSync(resolve(newRoot, 'worker1', '.jean', '.mcp.json'), 'utf8'))
    expect(mcp.mcpServers.jean.env.JEAN_DOJO).toBe(realpathSync(newRoot))

    // Worktree gitdir repaired — `git status` from inside should work
    const status = Bun.spawnSync(['git', 'status'], {
      cwd: resolve(newRoot, 'worker1'),
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (status.exitCode !== 0) console.error(`[git status stderr]\n${status.stderr.toString()}`)
    expect(status.exitCode).toBe(0)
  })

  test('refuses to overwrite an existing destination', () => {
    const oldRoot = resolve(tmp, 'old')
    expect(runJean(tmp, 'dojo', 'init', oldRoot, '--port', '8701').exitCode).toBe(0)

    const newRoot = resolve(tmp, 'taken')
    expect(runJean(tmp, 'dojo', 'init', newRoot, '--port', '8702').exitCode).toBe(0)

    const move = runJean(oldRoot, 'dojo', 'move', newRoot)
    expect(move.exitCode).toBe(1)
    expect(move.stderr).toContain('Destination already exists')
    // Original untouched
    expect(existsSync(resolve(oldRoot, '.jean'))).toBe(true)
  })

  test('refuses to move a dojo into itself', () => {
    const oldRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', oldRoot, '--port', '8703').exitCode).toBe(0)

    const move = runJean(oldRoot, 'dojo', 'move', resolve(oldRoot, 'nested'))
    expect(move.exitCode).toBe(1)
    expect(move.stderr).toContain('into itself')
    expect(existsSync(resolve(oldRoot, '.jean'))).toBe(true)
  })

  test('errors cleanly when not inside a dojo', () => {
    const move = runJean(tmp, 'dojo', 'move', resolve(tmp, 'elsewhere'))
    expect(move.exitCode).toBe(1)
    expect(move.stderr).toContain('Not a Jean dojo')
  })
})
