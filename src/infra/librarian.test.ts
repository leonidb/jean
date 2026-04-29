import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildHeadlessCommand, LibrarianRoleNotInitializedError, spawnHeadless } from './librarian.ts'

const TMP = '/tmp/jean-test-librarian'

/** Write an executable bash script that ignores all args and runs `body`. */
function writeScript(path: string, body: string): string {
  writeFileSync(path, `#!/bin/bash\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('buildHeadlessCommand', () => {
  test('emits claude -p <prompt> with --add-dir and --mcp-config relative to role dir', () => {
    const argv = buildHeadlessCommand({
      dojoRoot: '/dojo',
      role: 'librarian',
      prompt: 'consolidate the wiki',
    })
    expect(argv[0]).toBe('claude')
    expect(argv[1]).toBe('-p')
    expect(argv[2]).toBe('consolidate the wiki')
    expect(argv).toContain('--add-dir')
    expect(argv).toContain('--mcp-config')
    // From /dojo/.jean/roles/librarian/, relative .jean is "../.."
    const addDirIdx = argv.indexOf('--add-dir')
    expect(argv[addDirIdx + 1]).toBe('../..')
    const mcpIdx = argv.indexOf('--mcp-config')
    expect(argv[mcpIdx + 1]).toBe('../../.mcp.json')
  })

  test('binary override is respected', () => {
    const argv = buildHeadlessCommand({
      dojoRoot: '/dojo',
      role: 'librarian',
      prompt: 'x',
      binary: '/usr/local/bin/claude',
    })
    expect(argv[0]).toBe('/usr/local/bin/claude')
  })

  test('extraArgs are appended after the prompt', () => {
    const argv = buildHeadlessCommand({
      dojoRoot: '/dojo',
      role: 'librarian',
      prompt: 'x',
      extraArgs: ['--verbose', '--foo=bar'],
    })
    expect(argv).toContain('--verbose')
    expect(argv).toContain('--foo=bar')
  })
})

describe('spawnHeadless', () => {
  beforeEach(() => {
    try {
      rmSync(TMP, { recursive: true })
    } catch {}
    mkdirSync(resolve(TMP, '.jean', 'roles', 'librarian'), { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TMP, { recursive: true })
    } catch {}
  })

  test('throws LibrarianRoleNotInitializedError when role dir missing', async () => {
    rmSync(resolve(TMP, '.jean', 'roles', 'librarian'), { recursive: true })
    await expect(
      spawnHeadless({
        dojoRoot: TMP,
        role: 'librarian',
        prompt: 'x',
        binary: '/bin/echo',
      }),
    ).rejects.toThrow(LibrarianRoleNotInitializedError)
  })

  test('captures stdout from the spawned process', async () => {
    // Stub binary that ignores argv and prints a fixed string.
    const stub = writeScript(resolve(TMP, 'stub.sh'), 'echo "hello-from-stub"')
    const result = await spawnHeadless({
      dojoRoot: TMP,
      role: 'librarian',
      prompt: 'unused',
      binary: stub,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello-from-stub')
    expect(result.timedOut).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('timeoutMs kills a long-running process and reports timedOut=true', async () => {
    // Stub that ignores argv and sleeps 10s — much longer than the timeout.
    const stub = writeScript(resolve(TMP, 'sleeper.sh'), 'sleep 10')
    const result = await spawnHeadless({
      dojoRoot: TMP,
      role: 'librarian',
      prompt: 'unused',
      binary: stub,
      timeoutMs: 200,
    })
    expect(result.timedOut).toBe(true)
    expect(result.durationMs).toBeLessThan(2000)
  })

  test('non-zero exit code is captured', async () => {
    const stub = writeScript(resolve(TMP, 'failer.sh'), 'exit 7')
    const result = await spawnHeadless({
      dojoRoot: TMP,
      role: 'librarian',
      prompt: 'unused',
      binary: stub,
    })
    expect(result.exitCode).toBe(7)
    expect(result.timedOut).toBe(false)
  })

  test('captures stderr separately from stdout', async () => {
    const stub = writeScript(resolve(TMP, 'noisy.sh'), 'echo "out-line"\necho "err-line" >&2')
    const result = await spawnHeadless({
      dojoRoot: TMP,
      role: 'librarian',
      prompt: 'unused',
      binary: stub,
    })
    expect(result.stdout).toContain('out-line')
    expect(result.stderr).toContain('err-line')
    expect(result.stdout).not.toContain('err-line')
  })
})
