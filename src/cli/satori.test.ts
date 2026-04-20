import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CLI = resolve(import.meta.dir, 'jean.ts')

function runJean(cwd: string, env: Record<string, string | undefined>, ...args: string[]) {
  const result = Bun.spawnSync(['bun', 'run', CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

/** Create a fake `claude` binary that exits 0, so spawnSync doesn't block on a real session. */
function stubClaude(tmp: string): string {
  const binDir = resolve(tmp, 'bin')
  mkdirSync(binDir, { recursive: true })
  const claudeBin = resolve(binDir, 'claude')
  writeFileSync(claudeBin, '#!/bin/sh\nexit 0\n')
  chmodSync(claudeBin, 0o755)
  return binDir
}

describe('jean satori', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-satori-test-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('errors cleanly when run outside a dojo', () => {
    const result = runJean(tmp, {}, 'satori')
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Not a Jean dojo')
  })

  test('writes the satori skill into the dojo shared-skills dir before launching claude', () => {
    const dojo = resolve(tmp, 'dojo')
    const init = runJean(tmp, {}, 'dojo', 'init', dojo, '--git', '--port', '8700')
    expect(init.exitCode).toBe(0)

    const binDir = stubClaude(tmp)
    const result = runJean(dojo, { PATH: `${binDir}:${process.env.PATH ?? ''}` }, 'satori')
    if (result.exitCode !== 0) console.error(`[satori stderr]\n${result.stderr}`)
    expect(result.exitCode).toBe(0)

    const skillPath = resolve(dojo, '.jean', '.claude', 'skills', 'satori', 'SKILL.md')
    expect(existsSync(skillPath)).toBe(true)
    const skill = readFileSync(skillPath, 'utf8')
    expect(skill).toContain('name: satori')
    expect(skill).toContain('Satori — Jean dojo setup')
  })
})
