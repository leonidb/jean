import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { readRegistry } from '../infra/registry.ts'

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

/** Same as `runJean`, but non-blocking (`Bun.spawn`, not `spawnSync`) — for a
 *  test that also runs a `Bun.serve` in THIS process for the child to reach.
 *  `spawnSync` blocks this process's event loop until the child exits, which
 *  is also the loop that would have to service that in-process server: the
 *  child's request never gets answered and the run hangs. Measured while
 *  writing this test. */
async function runJeanAsync(
  cwd: string,
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd, env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
  await proc.exited
  const out = {
    exitCode: proc.exitCode ?? -1,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  }
  if (out.exitCode !== 0 && out.stderr) console.error(`[runJeanAsync stderr]\n${out.stderr}`)
  return out
}

/** Deterministic content hash of every file under `root`, keyed by relative
 *  path — a stronger "nothing changed" check than eyeballing a few files. */
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.isFile()) out[p.slice(root.length)] = createHash('sha256').update(readFileSync(p)).digest('hex')
    }
  }
  walk(root)
  return out
}

function addRule(settingsPath: string, list: 'allow' | 'deny', rule: string): void {
  const json = JSON.parse(readFileSync(settingsPath, 'utf8'))
  json.permissions[list].push(rule)
  writeFileSync(settingsPath, JSON.stringify(json, null, 2))
}

describe('jean dojo repair', () => {
  let tmp: string
  let prevReg: string | undefined
  let servers: Array<{ stop: (force?: boolean) => void }> = []

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-repair-test-'))
    prevReg = process.env.JEAN_REGISTRY_PATH
    servers = []
  })

  afterEach(() => {
    for (const s of servers) s.stop(true)
    if (prevReg === undefined) delete process.env.JEAN_REGISTRY_PATH
    else process.env.JEAN_REGISTRY_PATH = prevReg
    rmSync(tmp, { recursive: true, force: true })
  })

  /** Old machine: a dojo with one worker, its own registry. Returns both
   *  roots plus a fresh, still-empty "new machine" registry path — repair
   *  itself is left to the caller so each test can plant its own fixture
   *  first. */
  function buildAndCopy(): { oldRoot: string; newRoot: string; newRegistry: string } {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'old-machine-dojos.json')
    const oldRoot = resolve(tmp, 'old-dojo')
    expect(runJean(tmp, 'dojo', 'init', oldRoot, '--git', '--port', '8710').exitCode).toBe(0)
    expect(runJean(oldRoot, 'agent', 'add', 'worker1').exitCode).toBe(0)
    const newRoot = resolve(tmp, 'copied-dojo')
    expect(Bun.spawnSync(['cp', '-R', oldRoot, newRoot]).exitCode).toBe(0)
    const newRegistry = resolve(tmp, 'new-machine-dojos.json')
    process.env.JEAN_REGISTRY_PATH = newRegistry
    return { oldRoot, newRoot, newRegistry }
  }

  test('fixes worktrees, permissions and the registry after a copy to a new machine', () => {
    const { oldRoot, newRoot } = buildAndCopy()
    const oldRootReal = realpathSync(oldRoot)

    const repair = runJean(newRoot, 'dojo', 'repair')
    expect(repair.exitCode).toBe(0)

    // git status works in the copied worktree — both ends of the gitdir
    // pointer were rewritten to the new path.
    const status = Bun.spawnSync(['git', 'status'], {
      cwd: resolve(newRoot, 'worker1'),
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (status.exitCode !== 0) console.error(`[git status stderr]\n${status.stderr.toString()}`)
    expect(status.exitCode).toBe(0)

    // The copied agent's settings.local.json carries rules for the new path.
    const settings = JSON.parse(readFileSync(resolve(newRoot, 'worker1', '.claude', 'settings.local.json'), 'utf8'))
    const allRules: string[] = [...settings.permissions.allow, ...settings.permissions.deny]
    expect(allRules.some((r) => r.includes(newRoot))).toBe(true)

    // The registry holds the new path, and never held the old one — they were
    // always two different machines' files.
    const entries = readRegistry()
    expect(entries.some((e) => e.path === realpathSync(newRoot))).toBe(true)
    expect(entries.some((e) => e.path === oldRootReal)).toBe(false)
  })

  test('a dead (not-alive) recorded pid is removed without refusal', () => {
    const { oldRoot, newRoot } = buildAndCopy()
    writeFileSync(resolve(oldRoot, '.jean', 'infra.pid'), '999999\n')
    writeFileSync(resolve(oldRoot, '.jean', 'infra.port'), '8710\n')
    // Re-copy so the fixture rides along (buildAndCopy already copied once).
    rmSync(newRoot, { recursive: true, force: true })
    expect(Bun.spawnSync(['cp', '-R', oldRoot, newRoot]).exitCode).toBe(0)

    const repair = runJean(newRoot, 'dojo', 'repair')
    expect(repair.exitCode).toBe(0)
    expect(repair.stdout).toContain('remove stale infra.pid')
    expect(existsSync(resolve(newRoot, '.jean', 'infra.pid'))).toBe(false)
    expect(existsSync(resolve(newRoot, '.jean', 'infra.port'))).toBe(false)
    // The original is untouched — this was a copy, not a move.
    expect(existsSync(resolve(oldRoot, '.jean', 'infra.pid'))).toBe(true)
  })

  test('a live pid whose port answers nothing is removed, not treated as ours', () => {
    const { newRoot } = buildAndCopy()

    // A pid that is definitely alive (this test process), paired with a port
    // that is definitely not one the probe gets an answer from.
    const grab = Bun.serve({ port: 0, fetch: () => new Response('') })
    const freePort = grab.port
    grab.stop(true)
    writeFileSync(resolve(newRoot, '.jean', 'infra.pid'), `${process.pid}\n`)
    writeFileSync(resolve(newRoot, '.jean', 'infra.port'), `${freePort}\n`)

    const repair = runJean(newRoot, 'dojo', 'repair')
    expect(repair.exitCode).toBe(0)
    expect(repair.stdout).toContain(`remove stale infra.pid / infra.port (pid ${process.pid})`)
    expect(existsSync(resolve(newRoot, '.jean', 'infra.pid'))).toBe(false)
    expect(existsSync(resolve(newRoot, '.jean', 'infra.port'))).toBe(false)
  })

  test('a live server answering as this dojo refuses, and leaves runtime files intact', async () => {
    const { newRoot } = buildAndCopy()
    const newRootReal = realpathSync(newRoot)
    const dataDir = resolve(newRootReal, '.jean')

    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ name: 'jean-infra', dataDir, pid: process.pid }),
    })
    servers.push(server)
    writeFileSync(resolve(newRoot, '.jean', 'infra.pid'), `${process.pid}\n`)
    writeFileSync(resolve(newRoot, '.jean', 'infra.port'), `${server.port}\n`)

    // Async spawn (see runJeanAsync) — this test's own event loop must stay
    // free to answer the child's probe against the Bun.serve above.
    const repair = await runJeanAsync(newRoot, 'dojo', 'repair')
    expect(repair.exitCode).toBe(1)
    expect(repair.stderr).toContain('Infra is running for this dojo')
    expect(repair.stderr).toContain(`pid ${process.pid}`)
    // Refused, so nothing was touched.
    expect(readFileSync(resolve(newRoot, '.jean', 'infra.pid'), 'utf8').trim()).toBe(`${process.pid}`)
    expect(readFileSync(resolve(newRoot, '.jean', 'infra.port'), 'utf8').trim()).toBe(`${server.port}`)
  })

  test('drops a dead absolute permission rule and names it, but keeps the .mcp.json self-deny', () => {
    const { oldRoot, newRoot } = buildAndCopy()
    const settingsPath = resolve(oldRoot, 'worker1', '.claude', 'settings.local.json')
    // A ghost senseiWritePaths-style rule: absolute, directory-glob, and its
    // target never exists anywhere.
    const ghost = '/tmp/jean-repair-test-ghost-does-not-exist-anywhere'
    addRule(settingsPath, 'allow', `Edit(//${ghost.slice(1)}/**)`)
    rmSync(newRoot, { recursive: true, force: true })
    expect(Bun.spawnSync(['cp', '-R', oldRoot, newRoot]).exitCode).toBe(0)

    const repair = runJean(newRoot, 'dojo', 'repair')
    expect(repair.exitCode).toBe(0)
    expect(repair.stdout).toContain(ghost)
    expect(repair.stdout).toContain('target does not exist')

    const settings = JSON.parse(readFileSync(resolve(newRoot, 'worker1', '.claude', 'settings.local.json'), 'utf8'))
    const allow: string[] = settings.permissions.allow
    const deny: string[] = settings.permissions.deny
    expect(allow.some((r) => r.includes(ghost))).toBe(false)
    // The one exact-file rule the framework emits is never supposed to
    // resolve — repair must not treat "target absent" as dead for this one.
    expect(deny.some((r) => r.endsWith('/.mcp.json)'))).toBe(true)
  })

  test('drops a peer whose recorded path no longer exists, and prints the link command to re-establish it', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'old-machine-dojos.json')
    const oldRoot = resolve(tmp, 'old-dojo')
    expect(runJean(tmp, 'dojo', 'init', oldRoot, '--git', '--port', '8712').exitCode).toBe(0)
    expect(runJean(oldRoot, 'agent', 'add', 'worker1').exitCode).toBe(0)

    const otherDojo = resolve(tmp, 'other-dojo')
    expect(runJean(tmp, 'dojo', 'init', otherDojo, '--port', '8713').exitCode).toBe(0)
    expect(
      runJean(oldRoot, 'peer', 'add', 'other', '--origin', otherDojo, '--description', 'a peer dojo').exitCode,
    ).toBe(0)
    // The peer dojo never made the trip — this is the common case (peers are
    // re-linked once every dojo involved is back up), simulated directly.
    rmSync(otherDojo, { recursive: true, force: true })

    const newRoot = resolve(tmp, 'copied-dojo')
    expect(Bun.spawnSync(['cp', '-R', oldRoot, newRoot]).exitCode).toBe(0)
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'new-machine-dojos.json')

    const repair = runJean(newRoot, 'dojo', 'repair')
    expect(repair.exitCode).toBe(0)
    expect(repair.stdout).toContain('other')
    expect(repair.stdout).toContain('jean peer link')

    const peers = JSON.parse(readFileSync(resolve(newRoot, '.jean', 'peers.json'), 'utf8'))
    expect(peers.peers.other).toBeUndefined()
  })

  test('--dry-run reports the plan and writes nothing', () => {
    const { oldRoot, newRoot } = buildAndCopy()
    // Plant a mix of stale state so dry-run has several steps' worth to report.
    writeFileSync(resolve(oldRoot, '.jean', 'infra.pid'), '999999\n')
    writeFileSync(resolve(oldRoot, '.jean', 'infra.port'), '8710\n')
    addRule(
      resolve(oldRoot, 'worker1', '.claude', 'settings.local.json'),
      'allow',
      'Edit(//tmp/jean-repair-dry-run-ghost/**)',
    )
    rmSync(newRoot, { recursive: true, force: true })
    expect(Bun.spawnSync(['cp', '-R', oldRoot, newRoot]).exitCode).toBe(0)

    const before = hashTree(newRoot)
    const dry = runJean(newRoot, 'dojo', 'repair', '--dry-run')
    expect(dry.exitCode).toBe(0)
    expect(dry.stdout).toContain('would')
    const after = hashTree(newRoot)
    expect(after).toEqual(before)

    // A real run afterward does change things — proving dry-run's silence was
    // about not writing, not about there being nothing to do.
    const real = runJean(newRoot, 'dojo', 'repair')
    expect(real.exitCode).toBe(0)
    expect(hashTree(newRoot)).not.toEqual(before)
  })

  test('refuses to register into a port collision, naming the holder and the next free port', () => {
    const reg = resolve(tmp, 'dojos.json')
    process.env.JEAN_REGISTRY_PATH = reg
    const a = resolve(tmp, 'dojo-a')
    const b = resolve(tmp, 'dojo-b')
    expect(runJean(tmp, 'dojo', 'init', a, '--port', '8730').exitCode).toBe(0)
    expect(runJean(tmp, 'dojo', 'init', b, '--port', '8731').exitCode).toBe(0)

    // Force the collision by hand — this is a same-registry scenario (two
    // dojos on one machine), not a fresh-machine one. Also drop B's own
    // init-time registration (at its ORIGINAL port): the scenario is "B's
    // config now says 8730 and has never been registered under that", not
    // "B has a second, stale entry at 8731 lying around" — a different,
    // uninteresting gap `dojo prune` already covers.
    const bConfigPath = resolve(b, '.jean', 'jean.config.json')
    const bConfig = JSON.parse(readFileSync(bConfigPath, 'utf8'))
    bConfig.port = 8730
    writeFileSync(bConfigPath, JSON.stringify(bConfig, null, 2))
    const registryBefore = JSON.parse(readFileSync(reg, 'utf8'))
    registryBefore.dojos = registryBefore.dojos.filter((d: { path: string }) => d.path !== realpathSync(b))
    writeFileSync(reg, JSON.stringify(registryBefore, null, 2))

    const repair = runJean(b, 'dojo', 'repair')
    expect(repair.exitCode).toBe(0) // reported, not fatal
    expect(repair.stdout).toContain('already registered to')
    expect(repair.stdout).toContain(realpathSync(a))
    expect(repair.stdout).toMatch(/Next free port: \d+/)

    const entries = readRegistry()
    expect(entries.filter((e) => e.port === 8730)).toHaveLength(1)
    expect(entries.some((e) => e.path === realpathSync(b))).toBe(false)
  })

  test('refuses when it cannot verify infra is not running: legacy same-machine case still works', () => {
    // Same-machine sanity check for the new "presume stale" default: a
    // genuinely dead pid from earlier on THIS machine is still just removed.
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const dojo = resolve(tmp, 'dojo')
    expect(runJean(tmp, 'dojo', 'init', dojo, '--port', '8714').exitCode).toBe(0)
    writeFileSync(resolve(dojo, '.jean', 'infra.pid'), '999999\n')

    const repair = runJean(dojo, 'dojo', 'repair')
    expect(repair.exitCode).toBe(0)
    expect(existsSync(resolve(dojo, '.jean', 'infra.pid'))).toBe(false)
  })

  test('errors cleanly when not inside a dojo', () => {
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
    const repair = runJean(tmp, 'dojo', 'repair')
    expect(repair.exitCode).toBe(1)
    expect(repair.stderr).toContain('Not a Jean dojo')
  })
})
