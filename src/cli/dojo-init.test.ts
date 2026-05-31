import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CLI = resolve(import.meta.dir, 'jean.ts')

function runInit(target: string, ...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['bun', 'run', CLI, 'dojo', 'init', target, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
  // Failures from `bun run` are otherwise opaque; surface stderr so a regression
  // in the CLI (e.g. a newly-broken dispatch path) doesn't manifest as a bare
  // "expected 0, got 1".
  if (out.exitCode !== 0 && out.stderr) console.error(`[runInit stderr]\n${out.stderr}`)
  return out
}

describe('jean dojo init', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-init-test-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('scaffolds every mechanical surface with --git', () => {
    const dojo = resolve(tmp, 'dojo')
    const { exitCode } = runInit(dojo, '--git', '--port', '8700')
    expect(exitCode).toBe(0)

    // Core directories
    expect(existsSync(resolve(dojo, '.jean', 'playbooks'))).toBe(true)
    expect(existsSync(resolve(dojo, '.jean', 'context'))).toBe(true)
    expect(existsSync(resolve(dojo, '.jean', 'sessions'))).toBe(true)
    expect(existsSync(resolve(dojo, '.jean', '.claude', 'skills'))).toBe(true)

    // Framework skills shipped
    expect(existsSync(resolve(dojo, '.jean', 'roles', 'sensei', '.claude', 'skills', 'jean-sensei', 'SKILL.md'))).toBe(
      true,
    )
    expect(existsSync(resolve(dojo, '.jean', 'roles', 'worker', '.claude', 'skills', 'jean-worker', 'SKILL.md'))).toBe(
      true,
    )

    // Bare repo exists and the shared exclude is primed for future worktrees
    const excludePath = resolve(dojo, '.jean', '.bare', 'info', 'exclude')
    expect(existsSync(excludePath)).toBe(true)
    const exclude = readFileSync(excludePath, 'utf8')
    expect(exclude).toContain('.jean/')
    expect(exclude).toContain('.claude/settings.local.json')

    // Config captures the port the user explicitly chose.
    const configPath = resolve(dojo, '.jean', 'jean.config.json')
    expect(existsSync(configPath)).toBe(true)
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(cfg.port).toBe(8700)

    // Context seeded
    const readmePath = resolve(dojo, '.jean', 'context', 'readme.md')
    expect(existsSync(readmePath)).toBe(true)
    expect(readFileSync(readmePath, 'utf8')).toContain('Dojo context')
  })

  test('persists the port value passed via --port', () => {
    const dojo = resolve(tmp, 'dojo')
    const { exitCode } = runInit(dojo, '--git', '--port', '9123')
    expect(exitCode).toBe(0)

    const config = JSON.parse(readFileSync(resolve(dojo, '.jean', 'jean.config.json'), 'utf8'))
    expect(config.port).toBe(9123)
  })

  test('refuses to re-init an existing dojo', () => {
    const dojo = resolve(tmp, 'dojo')
    expect(runInit(dojo, '--git', '--port', '8700').exitCode).toBe(0)
    const second = runInit(dojo, '--git', '--port', '8700')
    expect(second.exitCode).toBe(1)
    expect(second.stderr).toContain('Already a Jean dojo')
  })

  test('scaffolds without --git and writes no bare repo', () => {
    const dojo = resolve(tmp, 'dojo')
    const { exitCode } = runInit(dojo, '--port', '8700')
    expect(exitCode).toBe(0)

    // Mechanical scaffolding still happens
    expect(existsSync(resolve(dojo, '.jean', 'sessions'))).toBe(true)
    expect(existsSync(resolve(dojo, '.jean', 'context', 'readme.md'))).toBe(true)
    expect(existsSync(resolve(dojo, '.jean', 'jean.config.json'))).toBe(true)
    expect(existsSync(resolve(dojo, '.jean', 'roles', 'sensei', '.claude', 'skills', 'jean-sensei', 'SKILL.md'))).toBe(
      true,
    )

    // But the git bits are absent
    expect(existsSync(resolve(dojo, '.jean', '.bare'))).toBe(false)
  })

  test('errors cleanly when --port is missing', () => {
    const dojo = resolve(tmp, 'dojo')
    const { exitCode, stderr } = runInit(dojo, '--git')
    expect(exitCode).toBe(1)
    expect(stderr).toContain('--port <N> is required')
    // No scaffolding should have been left behind on a failed init.
    expect(existsSync(resolve(dojo, '.jean', 'jean.config.json'))).toBe(false)
  })

  test('--git-from clones an existing repo into .jean/.bare', () => {
    // Build a throwaway source repo with one commit.
    const src = resolve(tmp, 'source-repo')
    mkdirSync(src, { recursive: true })
    const git = (...a: string[]) => Bun.spawnSync(['git', '-C', src, ...a], { stdout: 'pipe', stderr: 'pipe' })
    git('init', '-q')
    writeFileSync(resolve(src, 'hello.txt'), 'hi\n')
    git('add', 'hello.txt')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed')

    const dojo = resolve(tmp, 'dojo')
    const { exitCode } = runInit(dojo, '--git-from', src, '--port', '8700')
    expect(exitCode).toBe(0)

    const bare = resolve(dojo, '.jean', '.bare')
    expect(existsSync(bare)).toBe(true)

    // It's a bare repo...
    const isBare = Bun.spawnSync(['git', '-C', bare, 'rev-parse', '--is-bare-repository'], { stdout: 'pipe' })
      .stdout.toString()
      .trim()
    expect(isBare).toBe('true')

    // ...cloned from the source (origin preserved)...
    const origin = Bun.spawnSync(['git', '-C', bare, 'remote', 'get-url', 'origin'], { stdout: 'pipe' })
      .stdout.toString()
      .trim()
    expect(origin).toBe(src)

    // ...with the source content present...
    const tree = Bun.spawnSync(['git', '-C', bare, 'ls-tree', '-r', '--name-only', 'HEAD'], {
      stdout: 'pipe',
    }).stdout.toString()
    expect(tree).toContain('hello.txt')

    // ...and the worktree exclude primed, same as the --git path.
    const exclude = readFileSync(resolve(bare, 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('.jean/')

    // No spurious initial-commit .gitignore left in the dojo root.
    expect(existsSync(resolve(dojo, '.gitignore'))).toBe(false)
  })

  test('rejects --git together with --git-from', () => {
    const dojo = resolve(tmp, 'dojo')
    const { exitCode, stderr } = runInit(dojo, '--git', '--git-from', resolve(tmp, 'src'), '--port', '8700')
    expect(exitCode).toBe(1)
    expect(stderr).toContain('Use either --git')
  })

  test('errors when --git-from has no repository value', () => {
    const dojo = resolve(tmp, 'dojo')
    const { exitCode, stderr } = runInit(dojo, '--git-from', '--port', '8700')
    expect(exitCode).toBe(1)
    expect(stderr).toContain('--git-from requires a repository')
  })
})
