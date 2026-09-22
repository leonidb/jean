import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { readRegistry } from '../infra/registry.ts'
import { macosOnly } from '../test-tags.ts'

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

/** Async spawn (not spawnSync) — for the one test that also runs a Bun.serve
 *  in this process for the child to reach. See dojo-repair.test.ts's
 *  runJeanAsync for why: spawnSync blocks the event loop the server needs. */
async function runJeanAsync(
  cwd: string,
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

/** Content hash of every file under `root`, keyed by relative path — for
 *  asserting a tree is untouched, not just that git status still works. */
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) out[p.slice(root.length)] = sha256(p)
    }
  }
  walk(root)
  return out
}

/** `dojo init` leaves .jean/context as a plain directory — only the
 *  librarian's first run git-inits it. Export now refuses when a present
 *  .jean/context or .jean/workspace isn't a git repo, so every test that
 *  isn't specifically about that requirement gets context out of the way
 *  first (workspace is already git-initialized by `dojo init` itself,
 *  regardless of `--git`). */
function gitInitContext(dojoRoot: string): void {
  const context = resolve(dojoRoot, '.jean', 'context')
  Bun.spawnSync(['git', '-C', context, 'init', '-q', '-b', 'main'])
  Bun.spawnSync(['git', '-C', context, 'add', '-A'])
  Bun.spawnSync(['git', '-C', context, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'initial'])
}

// macos-only: `dojo export` refuses on GNU tar, whose glob semantics differ
// from bsdtar's. Untag when the command is ported.
macosOnly.describe('jean dojo export / import', () => {
  let tmp: string
  let prevReg: string | undefined
  let servers: Array<{ stop: (force?: boolean) => void }> = []

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-export-test-'))
    prevReg = process.env.JEAN_REGISTRY_PATH
    servers = []
  })

  afterEach(() => {
    for (const s of servers) s.stop(true)
    if (prevReg === undefined) delete process.env.JEAN_REGISTRY_PATH
    else process.env.JEAN_REGISTRY_PATH = prevReg
    rmSync(tmp, { recursive: true, force: true })
  })

  test('round trip: worktree survives, permissions and registry carry the new path, transient state does not', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'old-machine-dojos.json')
    const dojoRoot = resolve(tmp, 'source-dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8740').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    expect(runJean(dojoRoot, 'agent', 'add', 'worker1').exitCode).toBe(0)
    expect(runJean(dojoRoot, 'agent', 'add', 'plain', '--no-worktree').exitCode).toBe(0)

    // The bare repo's own default branch — read rather than assumed, so the
    // test holds regardless of this machine's git config.
    const defaultBranch = readFileSync(resolve(dojoRoot, '.jean', '.bare', 'HEAD'), 'utf8')
      .trim()
      .replace('ref: refs/heads/', '')

    // Fixtures. The unrecognised top-level dir is named after the bare's own
    // default branch on purpose — an unanchored tar exclude for that name
    // would take `refs/heads/<name>` down with it (measured; see jean.ts).
    mkdirSync(resolve(dojoRoot, defaultBranch))
    writeFileSync(resolve(dojoRoot, defaultBranch, 'README.md'), 'not an agent\n')

    const worker1 = resolve(dojoRoot, 'worker1')
    writeFileSync(resolve(worker1, '.gitignore'), '.env\n')
    writeFileSync(resolve(worker1, '.env'), 'SECRET=abc123\n')
    writeFileSync(resolve(worker1, 'run.sh'), '#!/bin/sh\necho hi\n')
    chmodSync(resolve(worker1, 'run.sh'), 0o755)
    writeFileSync(resolve(worker1, 'target.txt'), 'linked\n')
    symlinkSync('target.txt', resolve(worker1, 'link.txt'))
    mkdirSync(resolve(worker1, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(resolve(worker1, 'node_modules', 'pkg', 'index.js'), 'noise')

    const cursorPath = resolve(dojoRoot, '.jean', '.consolidator', 'cursor.json')
    mkdirSync(resolve(dojoRoot, '.jean', '.consolidator'), { recursive: true })
    writeFileSync(cursorPath, '{"lastEventId":42}\n')
    mkdirSync(resolve(dojoRoot, '.jean', '.headless'), { recursive: true })
    writeFileSync(resolve(dojoRoot, '.jean', '.headless', 'transcript.jsonl'), '{}\n')

    const beforeEnvHash = sha256(resolve(worker1, '.env'))
    const beforeCursorHash = sha256(cursorPath)
    const beforeRunMode = mode(resolve(worker1, 'run.sh'))

    const archive = resolve(tmp, 'export.tar')
    const exportResult = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', archive)
    expect(exportResult.exitCode).toBe(0)
    expect(exportResult.stdout).toContain('no upstream') // worker1's branch was never pushed
    expect(exportResult.stdout).toContain(`${defaultBranch}: unrecognised top-level entry`)
    expect(existsSync(archive)).toBe(true)

    // The migration case: the source is gone by the time import runs (a
    // different machine entirely, in reality) — see the separate
    // same-machine test below for the case where it is still there.
    rmSync(dojoRoot, { recursive: true, force: true })

    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'new-machine-dojos.json')
    const importedRoot = resolve(tmp, 'imported-dojo')
    const importResult = runJean(tmp, 'dojo', 'import', archive, importedRoot)
    expect(importResult.exitCode).toBe(0)

    const importedWorker1 = resolve(importedRoot, 'worker1')

    // git worktree works at the new path.
    const status = Bun.spawnSync(['git', 'status'], { cwd: importedWorker1, stdout: 'pipe', stderr: 'pipe' })
    if (status.exitCode !== 0) console.error(`[git status stderr]\n${status.stderr.toString()}`)
    expect(status.exitCode).toBe(0)

    // The default branch's ref survived — the regression the anchor fixes.
    const refCheck = Bun.spawnSync(
      ['git', '-C', resolve(importedRoot, '.jean', '.bare'), 'rev-parse', '--verify', defaultBranch],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    expect(refCheck.exitCode).toBe(0)

    // Permissions carry the new path.
    const settings = JSON.parse(readFileSync(resolve(importedWorker1, '.claude', 'settings.local.json'), 'utf8'))
    const rules: string[] = [...settings.permissions.allow, ...settings.permissions.deny]
    expect(rules.some((r) => r.includes(importedRoot))).toBe(true)

    // The registry holds the new path.
    const entries = readRegistry()
    expect(entries.some((e) => e.path === realpathSync(importedRoot))).toBe(true)

    // Byte- and mode-identical survivors.
    expect(sha256(resolve(importedWorker1, '.env'))).toBe(beforeEnvHash)
    expect(sha256(resolve(importedRoot, '.jean', '.consolidator', 'cursor.json'))).toBe(beforeCursorHash)
    expect(mode(resolve(importedWorker1, 'run.sh'))).toBe(beforeRunMode)
    expect(lstatSync(resolve(importedWorker1, 'link.txt')).isSymbolicLink()).toBe(true)
    expect(readFileSync(resolve(importedWorker1, 'link.txt'), 'utf8')).toBe('linked\n')

    // Transient state did not travel.
    expect(existsSync(resolve(importedWorker1, 'node_modules'))).toBe(false)
    expect(existsSync(resolve(importedRoot, '.jean', '.headless'))).toBe(false)
    expect(existsSync(resolve(importedRoot, defaultBranch))).toBe(false)

    // The plain (--no-worktree) agent traveled as a directory and got permissions too.
    expect(existsSync(resolve(importedRoot, 'plain'))).toBe(true)
    expect(existsSync(resolve(importedRoot, 'plain', '.claude', 'settings.local.json'))).toBe(true)
  })

  test('a same-machine copy repairs itself without cross-wiring the still-existing source', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'old-machine-dojos.json')
    const src = resolve(tmp, 'source-dojo')
    expect(runJean(tmp, 'dojo', 'init', src, '--git', '--port', '8757').exitCode).toBe(0)
    gitInitContext(src)
    expect(runJean(src, 'agent', 'add', 'worker1').exitCode).toBe(0)

    const beforeSrcHash = hashTree(src)

    const archive = resolve(tmp, 'same-machine.tar')
    expect(runJean(src, 'dojo', 'export', '--yes', '--out', archive).exitCode).toBe(0)

    // Source is deliberately KEPT — this is the case that used to get
    // silently hijacked by `git worktree repair`'s cross-referencing.
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'same-machine-copy-dojos.json')
    const copy = resolve(tmp, 'copy-dojo')
    expect(runJean(tmp, 'dojo', 'import', archive, copy).exitCode).toBe(0)

    const copyWorker1 = resolve(copy, 'worker1')
    const commonDir = Bun.spawnSync(['git', '-C', copyWorker1, 'rev-parse', '--git-common-dir'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(commonDir.exitCode).toBe(0)
    expect(realpathSync(commonDir.stdout.toString().trim())).toBe(realpathSync(resolve(copy, '.jean', '.bare')))

    // The source is untouched — byte-identical, not just "git status still works".
    expect(hashTree(src)).toEqual(beforeSrcHash)
    const srcStatus = Bun.spawnSync(['git', 'status'], { cwd: resolve(src, 'worker1'), stdout: 'pipe', stderr: 'pipe' })
    expect(srcStatus.exitCode).toBe(0)
  })

  test('export refuses on a non-bsdtar tar, naming the assumption', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8762').exitCode).toBe(0)

    // A fake `tar` ahead on PATH, answering --version as GNU tar — the
    // anchor/escape semantics the exclude list relies on are bsdtar's alone.
    const fakeBin = resolve(tmp, 'fake-bin')
    mkdirSync(fakeBin)
    const fakeTar = resolve(fakeBin, 'tar')
    writeFileSync(fakeTar, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "tar (GNU tar) 1.34"; exit 0; fi\nexit 1\n')
    chmodSync(fakeTar, 0o755)

    const result = Bun.spawnSync(['bun', 'run', CLI, 'dojo', 'export', '--yes'], {
      cwd: dojoRoot,
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('bsdtar')
  })

  test('export refuses when .jean/context exists but is not a git repo, and names the fix', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8749').exitCode).toBe(0)
    // Deliberately NOT calling gitInitContext — this is the case it exists for.

    const result = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', resolve(tmp, 'out.tar'))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('.jean/context')
    expect(result.stderr).toContain('not a git repository')
    expect(result.stderr).toContain('git -C')
    expect(existsSync(resolve(tmp, 'out.tar'))).toBe(false)
  })

  test('export proceeds when .jean/context is absent entirely', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8750').exitCode).toBe(0)
    rmSync(resolve(dojoRoot, '.jean', 'context'), { recursive: true, force: true })

    const result = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', resolve(tmp, 'out.tar'))
    expect(result.exitCode).toBe(0)
  })

  test('export refuses when .jean/workspace exists but is not a git repo', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8751').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    // dojo init always git-inits workspace; break it to exercise this path.
    rmSync(resolve(dojoRoot, '.jean', 'workspace', '.git'), { recursive: true, force: true })

    const result = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', resolve(tmp, 'out.tar'))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('.jean/workspace')
    expect(result.stderr).toContain('not a git repository')
  })

  test('valid context and workspace each get exactly one pre-flight line', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8752').exitCode).toBe(0)
    gitInitContext(dojoRoot)

    const result = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', resolve(tmp, 'out.tar'))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.match(/\.jean\/context:/g)?.length).toBe(1)
    expect(result.stdout.match(/\.jean\/workspace:/g)?.length).toBe(1)
  })

  test('glob metacharacters in the dojo name or an unrecognised entry are treated as literal, not as wildcards', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'old-machine-dojos.json')
    // A dojo name containing bracket-glob syntax, and a top-level entry
    // named exactly a wildcard — the exact shape that silently excluded an
    // entire archive before the fix.
    const dojoRoot = resolve(tmp, 'my[dojo]')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8753').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    expect(runJean(dojoRoot, 'agent', 'add', 'worker1').exitCode).toBe(0)
    mkdirSync(resolve(dojoRoot, '*'))
    writeFileSync(resolve(dojoRoot, '*', 'whatever.txt'), 'x\n')

    const archive = resolve(tmp, 'glob.tar')
    const exportResult = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', archive)
    expect(exportResult.exitCode).toBe(0)
    expect(exportResult.stdout).toContain('*: unrecognised top-level entry')

    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'new-machine-dojos.json')
    const importedRoot = resolve(tmp, 'imported')
    expect(runJean(tmp, 'dojo', 'import', archive, importedRoot).exitCode).toBe(0)
    // Everything else survived — the bug this guards against dropped the
    // WHOLE archive (including worker1 and .jean) the moment a "*"-named
    // entry's exclude pattern was left unescaped.
    expect(existsSync(resolve(importedRoot, 'worker1', '.claude', 'settings.local.json'))).toBe(true)
    expect(existsSync(resolve(importedRoot, '.jean', 'jean.config.json'))).toBe(true)
    expect(existsSync(resolve(importedRoot, '*'))).toBe(false)
  })

  test('a symlinked --out parent cannot write physically inside the dojo', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8754').exitCode).toBe(0)
    gitInitContext(dojoRoot)

    const link = resolve(tmp, 'shortcut-into-dojo')
    symlinkSync(dojoRoot, link)

    const result = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', resolve(link, 'archive.tar'))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('inside the dojo itself')
    expect(existsSync(resolve(dojoRoot, 'archive.tar'))).toBe(false)
  })

  test('export picks a sensible default output path when --out is omitted', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8755').exitCode).toBe(0)
    gitInitContext(dojoRoot)

    const result = runJean(dojoRoot, 'dojo', 'export', '--yes')
    expect(result.exitCode).toBe(0)
    // Alongside the dojo (its parent dir), not inside it, named after the
    // dojo and today's date.
    const dateStamp = new Date().toISOString().slice(0, 10)
    const expected = resolve(tmp, `dojo-${dateStamp}.tar.gz`)
    expect(existsSync(expected)).toBe(true)
    expect(result.stdout).toContain(expected)
  })

  test('the default archive name uses the dojo basename, not a free-text identity', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'my-dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8761').exitCode).toBe(0)
    gitInitContext(dojoRoot)

    // identity is free text and may hold a `/` — using it in a path would
    // otherwise nest the archive under an unintended directory.
    const configPath = resolve(dojoRoot, '.jean', 'jean.config.json')
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    cfg.identity = 'team/nickname'
    writeFileSync(configPath, JSON.stringify(cfg, null, 2))

    const result = runJean(dojoRoot, 'dojo', 'export', '--yes')
    expect(result.exitCode).toBe(0)
    const dateStamp = new Date().toISOString().slice(0, 10)
    expect(existsSync(resolve(tmp, `my-dojo-${dateStamp}.tar.gz`))).toBe(true)
  })

  test('a basename with a space round-trips, and the printed import command is quoted', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'old-machine-dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8758').exitCode).toBe(0)
    gitInitContext(dojoRoot)

    const archive = resolve(tmp, 'my archive.tar.gz')
    const exportResult = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', archive)
    expect(exportResult.exitCode).toBe(0)
    expect(existsSync(archive)).toBe(true)
    expect(exportResult.stdout).toContain("jean dojo import 'my archive.tar.gz'")

    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'new-machine-dojos.json')
    const importedRoot = resolve(tmp, 'imported')
    expect(runJean(tmp, 'dojo', 'import', archive, importedRoot).exitCode).toBe(0)
    expect(existsSync(resolve(importedRoot, '.jean', 'jean.config.json'))).toBe(true)
  })

  test('a registry port collision is reported as incomplete, not printed as plain success', () => {
    const reg = resolve(tmp, 'dojos.json')
    process.env.JEAN_REGISTRY_PATH = reg
    const a = resolve(tmp, 'dojo-a')
    expect(runJean(tmp, 'dojo', 'init', a, '--port', '8759').exitCode).toBe(0)
    gitInitContext(a)

    const archive = resolve(tmp, 'out.tar.gz')
    expect(runJean(a, 'dojo', 'export', '--yes', '--out', archive).exitCode).toBe(0)

    // Import at the same registry a still holds 8759 in — forces the collision.
    const b = resolve(tmp, 'dojo-b')
    const importResult = runJean(tmp, 'dojo', 'import', archive, b)
    expect(importResult.exitCode).toBe(0) // reported, not failed
    expect(importResult.stdout).toContain('Registration incomplete')
    expect(importResult.stdout).toContain('already registered to')
    const entries = readRegistry()
    expect(entries.some((e) => e.path === realpathSync(b))).toBe(false)
  })

  test('a branch whose upstream ref is gone is reported distinctly from no-upstream', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8760').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    expect(runJean(dojoRoot, 'agent', 'add', 'worker1').exitCode).toBe(0)
    const worker1 = resolve(dojoRoot, 'worker1')
    Bun.spawnSync(['git', '-C', worker1, 'config', 'branch.jean/worker1.remote', 'origin'])
    Bun.spawnSync(['git', '-C', worker1, 'config', 'branch.jean/worker1.merge', 'refs/heads/jean/worker1'])

    const result = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', resolve(tmp, 'out.tar.gz'))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('upstream branch is gone')
  })

  test('export refuses when the archive destination already exists', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8756').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    const archive = resolve(tmp, 'out.tar')
    writeFileSync(archive, 'already here\n')

    const result = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', archive)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Archive already exists')
    expect(readFileSync(archive, 'utf8')).toBe('already here\n') // untouched
  })

  test('pre-flight names a dirty worktree', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8741').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    expect(runJean(dojoRoot, 'agent', 'add', 'worker1').exitCode).toBe(0)
    writeFileSync(resolve(dojoRoot, 'worker1', 'dirty.txt'), 'uncommitted\n')

    const result = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', resolve(tmp, 'out.tar'))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('uncommitted change')
  })

  test('a large dirty count is truncated to a sample, not printed in full', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8745').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    expect(runJean(dojoRoot, 'agent', 'add', 'worker1').exitCode).toBe(0)
    for (let i = 0; i < 20; i++) {
      writeFileSync(resolve(dojoRoot, 'worker1', `dirty-${i}.txt`), 'x\n')
    }

    const result = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', resolve(tmp, 'out.tar'))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('20 uncommitted change(s)')
    expect(result.stdout).toContain('+17 more') // 20 total, 3 named
    expect(result.stdout.match(/dirty-\d+\.txt/g)?.length).toBe(3)
  })

  test('a dojo with no product repo and all --no-worktree agents skips git checks for the agents', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'old-machine-dojos.json')
    const dojoRoot = resolve(tmp, 'plain-dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--port', '8746').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    expect(runJean(dojoRoot, 'agent', 'add', 'one', '--no-worktree').exitCode).toBe(0)
    expect(runJean(dojoRoot, 'agent', 'add', 'two', '--no-worktree').exitCode).toBe(0)

    const archive = resolve(tmp, 'plain.tar')
    const exportResult = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', archive)
    expect(exportResult.exitCode).toBe(0)
    // No repo check fired for either agent — neither is a git repo. (.jean/context
    // and .jean/workspace ARE git repos regardless of --git — required, and
    // pre-seeded above — so their own "no upstream" lines are expected and
    // unrelated to the agents.)
    expect(exportResult.stdout).not.toContain('one:')
    expect(exportResult.stdout).not.toContain('two:')
    expect(exportResult.stdout).not.toContain('uncommitted')

    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'new-machine-dojos.json')
    const importedRoot = resolve(tmp, 'plain-imported')
    const importResult = runJean(tmp, 'dojo', 'import', archive, importedRoot)
    expect(importResult.exitCode).toBe(0)
    expect(importResult.stdout).toContain('skip — no .jean/.bare')
    expect(existsSync(resolve(importedRoot, 'one', '.claude', 'settings.local.json'))).toBe(true)
    expect(existsSync(resolve(importedRoot, 'two', '.claude', 'settings.local.json'))).toBe(true)
  })

  test('a stray FILE at the dojo root is named and excluded, same as a stray directory', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'old-machine-dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8747').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    writeFileSync(resolve(dojoRoot, 'start-sensei.sh'), '#!/bin/sh\n')

    const archive = resolve(tmp, 'out.tar')
    const exportResult = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', archive)
    expect(exportResult.exitCode).toBe(0)
    expect(exportResult.stdout).toContain('start-sensei.sh: unrecognised top-level entry')

    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'new-machine-dojos.json')
    const importedRoot = resolve(tmp, 'imported')
    expect(runJean(tmp, 'dojo', 'import', archive, importedRoot).exitCode).toBe(0)
    expect(existsSync(resolve(importedRoot, 'start-sensei.sh'))).toBe(false)
  })

  test('pre-flight names a Slack credential alongside (or instead of) Telegram', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8748').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    expect(runJean(dojoRoot, 'config', 'set', 'slack.botToken', 'xoxb-fake').exitCode).toBe(0)

    const result = runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', resolve(tmp, 'out.tar'))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('config carries slack.botToken')
  })

  test('non-TTY without --yes refuses instead of silently proceeding', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8742').exitCode).toBe(0)
    gitInitContext(dojoRoot)

    const result = runJean(dojoRoot, 'dojo', 'export', '--out', resolve(tmp, 'out.tar'))
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Not a terminal')
    expect(existsSync(resolve(tmp, 'out.tar'))).toBe(false)
  })

  test('export refuses against a live server answering as this dojo, and writes no archive', async () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8743').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    const dojoRootReal = realpathSync(dojoRoot)
    const dataDir = resolve(dojoRootReal, '.jean')

    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ name: 'jean-infra', dataDir, pid: process.pid }),
    })
    servers.push(server)
    writeFileSync(resolve(dojoRoot, '.jean', 'infra.pid'), `${process.pid}\n`)
    writeFileSync(resolve(dojoRoot, '.jean', 'infra.port'), `${server.port}\n`)

    const archive = resolve(tmp, 'out.tar')
    const result = await runJeanAsync(dojoRoot, 'dojo', 'export', '--yes', '--out', archive)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Infra is running for this dojo')
    expect(existsSync(archive)).toBe(false)
  })

  test('--dry-run reports a running infra as a finding instead of aborting, and writes nothing', async () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8763').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    const dojoRootReal = realpathSync(dojoRoot)
    const dataDir = resolve(dojoRootReal, '.jean')

    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ name: 'jean-infra', dataDir, pid: process.pid }),
    })
    servers.push(server)
    writeFileSync(resolve(dojoRoot, '.jean', 'infra.pid'), `${process.pid}\n`)
    writeFileSync(resolve(dojoRoot, '.jean', 'infra.port'), `${server.port}\n`)

    const result = await runJeanAsync(dojoRoot, 'dojo', 'export', '--dry-run')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Infra is running for this dojo')
    // No default archive landed alongside the dojo.
    const dateStamp = new Date().toISOString().slice(0, 10)
    expect(existsSync(resolve(tmp, `dojo-${dateStamp}.tar.gz`))).toBe(false)
  })

  test('--dry-run reports a non-git .jean/context as a finding and keeps going through the rest of the report', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8764').exitCode).toBe(0)
    // Deliberately NOT calling gitInitContext — this is the finding under test.
    expect(runJean(dojoRoot, 'agent', 'add', 'worker1').exitCode).toBe(0)

    const result = runJean(dojoRoot, 'dojo', 'export', '--dry-run')
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('') // reported on stdout, not as a real refusal
    expect(result.stdout).toContain('.jean/context')
    expect(result.stdout).toContain('not a git repository')
    // The report continues past that finding instead of stopping there.
    expect(result.stdout).toContain('.jean/workspace:')
    expect(result.stdout).toContain('worker1:')
    const dateStamp = new Date().toISOString().slice(0, 10)
    expect(existsSync(resolve(tmp, `dojo-${dateStamp}.tar.gz`))).toBe(false)
  })

  test('--dry-run says so explicitly when there is nothing to report', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8765').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    // A freshly added agent is clean and simply lacks an upstream — normal,
    // not a finding — so this dojo has nothing at all to report.
    expect(runJean(dojoRoot, 'agent', 'add', 'worker1').exitCode).toBe(0)

    const result = runJean(dojoRoot, 'dojo', 'export', '--dry-run')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('No issues found')
    expect(result.stdout).not.toContain('Would stop a real export')
    const dateStamp = new Date().toISOString().slice(0, 10)
    expect(existsSync(resolve(tmp, `dojo-${dateStamp}.tar.gz`))).toBe(false)
  })

  test('--dry-run with findings does not print the all-clear line, writes nothing, and never prompts', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8766').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    expect(runJean(dojoRoot, 'agent', 'add', 'worker1').exitCode).toBe(0)
    writeFileSync(resolve(dojoRoot, 'worker1', 'dirty.txt'), 'uncommitted\n')

    // Non-TTY, no --yes: a real export would refuse here. --dry-run must not
    // even reach that prompt, clean report or not.
    const result = runJean(dojoRoot, 'dojo', 'export', '--dry-run')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('uncommitted change')
    expect(result.stdout).not.toContain('No issues found')
    expect(result.stdout).not.toContain('Not a terminal')
    const dateStamp = new Date().toISOString().slice(0, 10)
    expect(existsSync(resolve(tmp, `dojo-${dateStamp}.tar.gz`))).toBe(false)
  })

  test('import refuses an existing destination path', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'old-machine-dojos.json')
    const dojoRoot = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojoRoot, '--git', '--port', '8744').exitCode).toBe(0)
    gitInitContext(dojoRoot)
    const archive = resolve(tmp, 'out.tar')
    expect(runJean(dojoRoot, 'dojo', 'export', '--yes', '--out', archive).exitCode).toBe(0)

    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'new-machine-dojos.json')
    const target = resolve(tmp, 'already-here')
    mkdirSync(target)
    const result = runJean(tmp, 'dojo', 'import', archive, target)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('already exists')
  })
})
