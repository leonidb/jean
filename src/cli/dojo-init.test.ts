import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { readRegistry } from '../infra/registry.ts'

const CLI = resolve(import.meta.dir, 'jean.ts')

function runInit(target: string, ...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['bun', 'run', CLI, 'dojo', 'init', target, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    // Pass env explicitly so the child inherits the runtime-set JEAN_REGISTRY_PATH
    // (Bun.spawnSync's default env does not pick up our beforeEach mutation) — keeps
    // tests off the real ~/.jean/dojos.json.
    env: { ...process.env },
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
  let prevReg: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-init-test-'))
    // Point the machine-global registry at a throwaway file so init's port
    // allocation never touches the real ~/.jean/dojos.json. The spawned CLI
    // inherits this via process.env.
    prevReg = process.env.JEAN_REGISTRY_PATH
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
  })

  afterEach(() => {
    if (prevReg === undefined) delete process.env.JEAN_REGISTRY_PATH
    else process.env.JEAN_REGISTRY_PATH = prevReg
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

    // Workspace is its own git repo with an initial commit (sensei-owned home;
    // historyless workspace would recreate the uncommitted-artifact fragility).
    const workspace = resolve(dojo, '.jean', 'workspace')
    expect(existsSync(resolve(workspace, '.git'))).toBe(true)
    expect(readFileSync(resolve(workspace, 'README.md'), 'utf8')).toContain('Sensei-only writes')
    const wsLog = Bun.spawnSync(['git', '-C', workspace, 'log', '--oneline'], { stdout: 'pipe', stderr: 'pipe' })
    expect(wsLog.exitCode).toBe(0)
    expect(wsLog.stdout.toString()).toContain('workspace: initial commit')
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

    // Workspace is created regardless of --git (the workspace repo is its
    // own, independent of the dojo's bare repo).
    expect(existsSync(resolve(dojo, '.jean', 'workspace', '.git'))).toBe(true)
  })

  test('provisions the librarian by default — role + consolidate-wiki trigger in the log', () => {
    const dojo = resolve(tmp, 'dojo')
    const { exitCode, stdout } = runInit(dojo, '--port', '8700')
    expect(exitCode).toBe(0)

    // Role dir: skills + permissions shipped.
    expect(
      existsSync(resolve(dojo, '.jean', 'roles', 'librarian', '.claude', 'skills', 'consolidate-wiki', 'SKILL.md')),
    ).toBe(true)
    expect(existsSync(resolve(dojo, '.jean', 'roles', 'librarian', '.claude', 'settings.local.json'))).toBe(true)
    expect(existsSync(resolve(dojo, '.jean', 'raw_context'))).toBe(true)

    // Trigger written directly into the fresh event log — first `infra start`
    // will replay + schedule it (no server was running at init).
    const events = readFileSync(resolve(dojo, '.jean', 'history.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const created = events.filter((e) => e.type === 'trigger-created' && e.data.id === 'consolidate-wiki')
    expect(created).toHaveLength(1)
    expect(created[0].data.agent).toBe('librarian')
    expect(created[0].data.kind).toBe('headless')
    expect(created[0].data.cron).toBe('0 3 * * *')
    expect(created[0].data.model).toBe('sonnet')

    // Init tells the human it scheduled a nightly run (transparency — it's a cost).
    expect(stdout).toContain('Librarian scheduled')
  })

  test('--no-librarian skips the trigger and the runnable role config', () => {
    const dojo = resolve(tmp, 'dojo')
    const { exitCode, stdout } = runInit(dojo, '--port', '8700', '--no-librarian')
    expect(exitCode).toBe(0)

    expect(stdout).not.toContain('Librarian scheduled')

    // The librarian can't RUN without its permissions or a schedule — those are
    // what --no-librarian withholds. (Framework skills still ship into the role
    // dir unconditionally; they're inert with no trigger + no settings.)
    expect(existsSync(resolve(dojo, '.jean', 'roles', 'librarian', '.claude', 'settings.local.json'))).toBe(false)
    expect(existsSync(resolve(dojo, '.jean', 'raw_context'))).toBe(false)

    // No trigger event (and typically no history.jsonl at all, since init writes
    // no other events).
    const historyPath = resolve(dojo, '.jean', 'history.jsonl')
    if (existsSync(historyPath)) {
      const hasTrigger = readFileSync(historyPath, 'utf8').includes('"consolidate-wiki"')
      expect(hasTrigger).toBe(false)
    }
  })

  test('auto-allocates a port when --port is omitted and records it in the registry', () => {
    const dojo = resolve(tmp, 'dojo')
    const { exitCode } = runInit(dojo, '--git')
    expect(exitCode).toBe(0)
    // Empty per-test registry → first free port.
    const cfg = JSON.parse(readFileSync(resolve(dojo, '.jean', 'jean.config.json'), 'utf8'))
    expect(cfg.port).toBe(8700)
    expect(readRegistry().some((e) => e.port === 8700)).toBe(true)
  })

  test('rejects a --port already held by another registered dojo', () => {
    const a = resolve(tmp, 'a')
    const b = resolve(tmp, 'b')
    expect(runInit(a, '--port', '8700').exitCode).toBe(0)
    const second = runInit(b, '--port', '8700')
    expect(second.exitCode).toBe(1)
    expect(second.stderr).toContain('already registered')
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

    // ...with a fetch refspec set (clone --bare omits it; init repairs it) so
    // `git fetch origin` / `@{u}` work in worktrees...
    const fetchSpec = Bun.spawnSync(['git', '-C', bare, 'config', '--get', 'remote.origin.fetch'], { stdout: 'pipe' })
      .stdout.toString()
      .trim()
    expect(fetchSpec).toBe('+refs/heads/*:refs/remotes/origin/*')

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
