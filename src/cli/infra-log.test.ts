/**
 * The daemon log — where a detached server's output goes (task 121).
 *
 * ── WHY THIS FILE EXISTS, precisely ──
 *
 * `jean infra start` spawns the server and returns. Its stdout was `ignore`
 * and its stderr was `inherit`, which reads as "the operator sees it" and is
 * true only while the launching shell lives. It does not: the process detaches
 * (`ps` reports TTY `??`), the shell exits, and the inherited fd leads
 * nowhere.
 *
 * That is not a tidiness argument. On the night this was written the Telegram
 * bridge failed for forty-five minutes. The bridge reports a poll failure on
 * the TRANSITION only — one line, `[jean] telegram poll error: … — retrying`,
 * correctly not repeated once per two-second retry — so the entire outage
 * produced exactly one explanation, and it was written to a terminal nobody
 * was reading. The question "what did those failures say" was unanswerable an
 * hour later, with the process still running and healthy.
 *
 * So the test that matters is the one below that proves the SERVER's own
 * output reaches the file. A test of the CLI's boot marker alone would pass
 * against a build that still threw the server's stderr away.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CLI = resolve(import.meta.dir, 'jean.ts')
const dirs: string[] = []
/** Every server this file started, by pid. `infra stop` reads the dojo's pid
 *  file, so it cannot help once the directory is gone — and a start under a
 *  BROKEN build may never write one. Holding the pid ourselves is what makes
 *  teardown unconditional; the first draft of this file leaked two servers
 *  onto the machine during its own mutation check. */
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
  // Stop politely first — it is the real path and exercises the real command.
  for (const dir of dirs) runJean(dir, 'infra', 'stop')
  // Then unconditionally, because polite failed once.
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid)
    } catch {
      /* already gone, which is the good case */
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** The pid `infra start` reports, so teardown never depends on the dojo's
 *  files still existing. */
function pidFrom(stdout: string): number | undefined {
  const m = stdout.match(/PID:\s+(\d+)/)
  return m?.[1] === undefined ? undefined : Number(m[1])
}

/** A port nobody is using, asked of the OS rather than guessed. Hard-coded
 *  test ports collide with whatever else the machine is running, and the
 *  failure then looks like this feature breaking. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') })
  const port = probe.port
  probe.stop(true)
  // A bound server always has one; the type says otherwise, and guessing a
  // fallback here would reintroduce exactly the collision this removes.
  if (port === undefined) throw new Error('Bun.serve bound without reporting a port')
  return port
}

/** A dojo of its own. */
function freshDojo(port: number): string {
  const parent = mkdtempSync(resolve(tmpdir(), 'jean-log-'))
  dirs.push(parent)
  const root = resolve(parent, 'dojo')
  const init = runJean(parent, 'dojo', 'init', root, '--port', String(port))
  expect(init.exitCode, init.stderr).toBe(0)
  return root
}

describe('a detached server writes where someone can read it', () => {
  // BUDGETS STATED. `jean infra start` polls the port file for up to six
  // seconds before giving up, which already exceeds bun's five-second default —
  // so the default turns a slow start into a timeout that reads as this
  // feature failing (codex pass, task 121).
  test('the SERVER’s own output lands in .jean/infra.log, not only the launcher’s', async () => {
    const root = freshDojo(freePort())
    const boot = runJean(root, 'infra', 'start')
    expect(boot.exitCode, boot.stderr).toBe(0)
    const pid = pidFrom(boot.stdout)
    if (pid !== undefined) started.push(pid)

    const logPath = resolve(root, '.jean', 'infra.log')
    // The command names the file, because an operator who has to find it will
    // not be looking at this test.
    expect(boot.stdout).toContain(logPath)

    // Poll: the boot line is written by the child, after this command returned.
    let text = ''
    for (let attemptsLeft = 60; attemptsLeft > 0; attemptsLeft--) {
      text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
      if (text.includes('[jean:new] listening on')) break
      await new Promise((r) => setTimeout(r, 50))
    }

    // THE DISCRIMINATING ASSERTION. `[jean:new] listening on` is the server's,
    // written to its own stderr after the fork — a build that captured only
    // the CLI's marker line passes every other check here and fails this one.
    expect(text).toContain('[jean:new] listening on')
    // …and the marker, which is what separates one run's lines from the last's.
    expect(text).toContain('── infra start ')

    runJean(root, 'infra', 'stop')
  }, 30_000)

  test('an oversized log is rotated once at start, and the previous run survives to be read', () => {
    const root = freshDojo(freePort())
    const logPath = resolve(root, '.jean', 'infra.log')
    // Over the cap, carrying a line only this run could have written.
    writeFileSync(logPath, `${'x'.repeat(5_000_001)}\nMARKER FROM THE OLD RUN\n`)

    const boot = runJean(root, 'infra', 'start')
    expect(boot.exitCode, boot.stderr).toBe(0)
    const pid = pidFrom(boot.stdout)
    if (pid !== undefined) started.push(pid)

    // The old file is beside it, not gone: the restart you perform WHILE
    // diagnosing is exactly when the previous tail is the thing you need.
    expect(readFileSync(`${logPath}.1`, 'utf8')).toContain('MARKER FROM THE OLD RUN')
    expect(statSync(logPath).size).toBeLessThan(5_000_000)

    runJean(root, 'infra', 'stop')
  }, 30_000)
})
