/**
 * What `jean agent add` writes into a new agent's settings (task 117 leftover).
 *
 * ── WHY THIS NEEDS A TEST AT ALL, given it asserts an ABSENCE ──
 *
 * Until this commit every new agent got two hooks: a Stop hook POSTing to
 * `/agent-idle` and a PermissionRequest hook POSTing to `/permissions`. Both
 * intakes were retired by ruling during the rewrite — there is no
 * `/agent-idle` route, and `POST /permissions` is pinned at 404 — but the
 * code that INSTALLS them survived the teardown that was supposed to take it.
 *
 * That is the shape worth guarding. The hooks' wrongness is invisible from
 * every direction the suite normally looks: nothing throws, no endpoint
 * changes, no agent misbehaves. They just spawn a process per turn-end and
 * per permission request to POST at nothing, and the only way to notice is to
 * read the file they were written into. So this reads that file.
 *
 * The permissions assertion below is not decoration. "No `hooks` key" is
 * satisfied by an empty file, a missing file, or a settings write that
 * silently failed — asserting the file still carries what it is FOR is what
 * separates "the hooks were removed" from "the write broke".
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

describe('jean agent add — the settings a new agent is born with', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-agent-settings-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('carries permissions and NO hooks — the retired intakes get no new callers', () => {
    const root = resolve(tmp, 'dojo')
    const init = runJean(tmp, 'dojo', 'init', root, '--git', '--port', '8700')
    expect(init.exitCode, init.stderr).toBe(0)
    const added = runJean(root, 'agent', 'add', 'worker1')
    expect(added.exitCode, added.stderr).toBe(0)

    const settingsPath = resolve(root, 'worker1', '.claude', 'settings.local.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks?: unknown
      permissions?: { allow?: string[] }
    }

    // The file is real and is doing its job — see the header on why this
    // comes first.
    expect(settings.permissions?.allow).toContain('mcp__jean__*')

    // THE ABSENCE. Not `hooks: {}` either: an empty hooks block is a place for
    // the next one to be added back without anybody deciding to.
    expect(settings).not.toHaveProperty('hooks')

    // And named individually, so a re-addition under a different key still
    // fails: it is the DEAD ENDPOINTS that must gain no callers, not one
    // particular spelling of the block that held them.
    const raw = readFileSync(settingsPath, 'utf8')
    expect(raw).not.toContain('/agent-idle')
    expect(raw).not.toContain('/permissions')
  }, 60_000)
})
