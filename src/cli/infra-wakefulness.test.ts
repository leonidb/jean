/**
 * The power assertion a running dojo holds (task 122).
 *
 * ── WHAT THIS HAS TO PROVE, and what would fool it ──
 *
 * Two clauses of the ruling, and neither is provable by reading the spawn
 * arguments alone:
 *
 *   1. while the server lives, the machine is held awake — on AC only;
 *   2. the assertion dies with the server, leaving no orphaned caffeinate.
 *
 * The trap is that this machine already runs OTHER caffeinate processes —
 * `caffeinate -i -t 300`, spawned by unrelated tooling — so a test that looks
 * for "a caffeinate" passes on a build that takes no assertion at all. Measured
 * on the host while writing this, which is the only reason the assertion below
 * matches the full command line rather than the program name.
 *
 * The second assertion goes past our own argv to `pmset`, which reports what
 * the KERNEL holds: `PreventSystemSleep`, owned by that pid. A flag typo that
 * still spawns a live caffeinate — `-i`, or a bare `caffeinate` — is caught by
 * the argv match; a caffeinate that spawned and asserted nothing is caught by
 * pmset.
 *
 * macOS only, because `caffeinate` is. On any other platform the feature is a
 * deliberate no-op and there is nothing here to run.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CLI = resolve(import.meta.dir, 'jean.ts')
const dirs: string[] = []
/** Every process this file started, by pid — servers and sidecars alike. The
 *  sidecar releases itself when the server exits, so this is a net under a
 *  BROKEN build, which is exactly the build a test file should assume. */
const started: number[] = []

function runJean(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['bun', 'run', CLI, ...args], {
    cwd,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

afterEach(() => {
  for (const dir of dirs) runJean(dir, 'infra', 'stop')
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid)
    } catch {
      /* already gone, which is the good case */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function pidFrom(stdout: string): number | undefined {
  const m = stdout.match(/PID:\s+(\d+)/)
  return m?.[1] === undefined ? undefined : Number(m[1])
}

/** A port nobody is using, asked of the OS rather than guessed. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) throw new Error('Bun.serve bound without reporting a port')
  return port
}

function freshDojo(port: number): string {
  const parent = mkdtempSync(resolve(tmpdir(), 'jean-awake-'))
  dirs.push(parent)
  const root = resolve(parent, 'dojo')
  const init = runJean(parent, 'dojo', 'init', root, '--port', String(port))
  expect(init.exitCode, init.stderr).toBe(0)
  return root
}

/** The pid of the caffeinate watching `serverPid`, matched on its WHOLE command
 *  line — see the header: program-name matching is satisfied by processes this
 *  code did not start. */
function sitterWatching(serverPid: number): number | undefined {
  const ps = Bun.spawnSync(['ps', '-ax', '-o', 'pid=,command='], { stdout: 'pipe', stderr: 'pipe' })
  for (const line of ps.stdout.toString().split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*?)\s*$/)
    if (m?.[1] === undefined || m[2] === undefined) continue
    if (new RegExp(`(?:^|/)caffeinate -s -w ${serverPid}$`).test(m[2])) return Number(m[1])
  }
  return undefined
}

/** What the kernel says that pid is holding. */
function kernelAssertionsOf(sitterPid: number): string {
  const out = Bun.spawnSync(['pmset', '-g', 'assertions'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString()
  return out
    .split('\n')
    .filter((l) => l.includes(`pid ${sitterPid}(`))
    .join('\n')
}

describe.skipIf(process.platform !== 'darwin')('a live dojo holds the machine awake, and lets go when it stops', () => {
  test('the assertion is held for the server’s own pid, and released when the server exits', async () => {
    const root = freshDojo(freePort())
    const boot = runJean(root, 'infra', 'start')
    expect(boot.exitCode, boot.stderr).toBe(0)

    // The pid the command reports is the one `infra stop` kills — pinning the
    // sidecar to it is the whole point, so the test reads it the same way an
    // operator would.
    const serverPid = pidFrom(boot.stdout)
    expect(serverPid, boot.stdout).toBeDefined()
    if (serverPid === undefined) return
    started.push(serverPid)

    const sitter = sitterWatching(serverPid)
    expect(sitter, `no "caffeinate -s -w ${serverPid}" among the running processes`).toBeDefined()
    if (sitter === undefined) return
    started.push(sitter)

    // Past our own argv: what the system actually holds. `PreventSystemSleep`
    // is the AC-scoped one; `PreventUserIdleSystemSleep` (what a bare
    // caffeinate or `-i` takes) would fail this, and it is a distinct string,
    // not a prefix of it.
    const held = kernelAssertionsOf(sitter)
    expect(held).toContain('PreventSystemSleep')

    // …and the operator is told, because it changes how their machine behaves.
    expect(boot.stdout).toContain('idle sleep prevented while this runs (AC power only')

    // ── THE RELEASE ──
    //
    // Stated plainly: no mutation of the code above can reach this and leave
    // it green, because the release is `-w`'s doing and `-w` is pinned by the
    // argv match. What it checks is the man page's claim — "once the process
    // exits, the assertion is also released" — on the OS actually running it.
    // The no-orphan half of the ruling rests entirely on that sentence being
    // true here, so it is measured rather than cited.
    runJean(root, 'infra', 'stop')
    let remaining: number | undefined
    for (let attemptsLeft = 40; attemptsLeft > 0; attemptsLeft--) {
      remaining = sitterWatching(serverPid)
      if (remaining === undefined) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(remaining, `caffeinate ${sitter} outlived the server it was watching`).toBeUndefined()
  }, 30_000)
})
