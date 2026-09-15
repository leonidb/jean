import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe('jean agent remove', () => {
  let tmp: string
  let prevReg: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-agent-remove-test-'))
    prevReg = process.env.JEAN_REGISTRY_PATH
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
  })

  afterEach(() => {
    if (prevReg === undefined) delete process.env.JEAN_REGISTRY_PATH
    else process.env.JEAN_REGISTRY_PATH = prevReg
    rmSync(tmp, { recursive: true, force: true })
  })

  test('a worktree whose .git points at a missing bare fails the check, not the "clean" read a stdout-only test gave it', () => {
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8790').exitCode).toBe(0)
    expect(runJean(dojoRoot, 'agent', 'add', 'worker1').exitCode).toBe(0)

    const agentGit = resolve(dojoRoot, 'worker1', '.git')
    expect(readFileSync(agentGit, 'utf8').startsWith('gitdir: ')).toBe(true)
    writeFileSync(agentGit, 'gitdir: /nonexistent/bare/worktrees/worker1\n')

    // Without --force: jean's own check runs `git status`, which fails
    // against the missing bare (exit 128) — reported as a check failure,
    // not silently treated as clean the way a stdout-only dirty test would.
    const blocked = runJean(dojoRoot, 'agent', 'remove', 'worker1')
    expect(blocked.exitCode).toBe(1)
    expect(blocked.stderr).toContain('git status check failed')
    expect(blocked.stderr).toContain('Use --force to remove anyway')

    // --force skips jean's own gate, same as it already does for "dirty" —
    // whether the operation then succeeds is git's own call. Here `git
    // worktree remove` independently refuses a worktree whose `.git` no
    // longer names its recorded gitdir (validated, exit 1) — measured, not
    // assumed. Either way, both paths surface a clear error rather than
    // silently doing the wrong thing.
    const forced = runJean(dojoRoot, 'agent', 'remove', 'worker1', '--force')
    expect(forced.exitCode).toBe(1)
    expect(forced.stderr).toContain('Failed to remove worktree')
  })
})
