import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

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

/**
 * The CLI used to silently fall back to http://127.0.0.1:8700 when cwd was
 * inside a dojo whose infra was stopped. This made `jean board` inside one dojo
 * return another dojo's board (whichever dojo happened to own port 8700). These
 * tests pin the strict behavior: no fallbacks, no env escape hatches; if
 * the target infra isn't unambiguous, fail.
 */

describe('infra URL discovery — strict, no fallbacks', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-infra-discovery-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function makeDojo(name: string, withInfraPort?: number): string {
    const dojo = resolve(tmp, name)
    const jeanDir = resolve(dojo, '.jean')
    mkdirSync(jeanDir, { recursive: true })
    writeFileSync(resolve(jeanDir, 'jean.config.json'), JSON.stringify({ identity: name }))
    if (withInfraPort !== undefined) {
      writeFileSync(resolve(jeanDir, 'infra.port'), String(withInfraPort))
      writeFileSync(resolve(jeanDir, 'infra.pid'), String(process.pid))
    }
    return dojo
  }

  test('fails when cwd is not inside any dojo', () => {
    const out = runJean(tmp, 'board')
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('Not inside a Jean dojo')
  })

  test('fails when cwd is in a dojo but its infra is not running', () => {
    const dojo = makeDojo('stopped')
    const out = runJean(dojo, 'board')
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('Infra is not running for this dojo')
    expect(out.stderr).toContain('stopped') // the dojo's name
    expect(out.stderr).toContain('jean infra start')
  })

  test('does NOT silently fall back to a default port', () => {
    const dojo = makeDojo('stopped')
    const out = runJean(dojo, 'board')
    // No mention of any specific port number — strict failure has nothing
    // to do with port 8700 anymore.
    expect(out.stdout).not.toContain('8700')
    expect(out.stderr).not.toContain('8700')
  })

  test('JEAN_INFRA_URL env is no longer honored as an override', () => {
    const dojo = makeDojo('stopped')
    const result = Bun.spawnSync(['bun', 'run', CLI, 'board'], {
      cwd: dojo,
      env: { ...process.env, JEAN_INFRA_URL: 'http://127.0.0.1:9999' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    // Should still fail with the same "infra not running" message — env override
    // doesn't sneak in a fallback.
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('Infra is not running for this dojo')
  })

  // jean infra start, jean infra stop, jean infra status, jean dojo init,
  // jean agent add — these don't talk to a running infra and shouldn't be
  // blocked by the strict discovery. Smoke-check by running `jean dojo init`
  // on a fresh dir; it must NOT trip the "not inside a dojo" guard.
  test('commands that do not need a running infra still work', () => {
    const target = resolve(tmp, 'fresh')
    const out = runJean(tmp, 'dojo', 'init', target, '--port', '9701')
    expect(out.exitCode).toBe(0)
  })
})
