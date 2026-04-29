import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildHeadlessCommand,
  LibrarianRoleNotInitializedError,
  parseHeadlessJson,
  spawnHeadless,
} from './librarian.ts'

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

  test('model option emits --model <model>', () => {
    const argv = buildHeadlessCommand({
      dojoRoot: '/dojo',
      role: 'librarian',
      prompt: 'x',
      model: 'sonnet',
    })
    const idx = argv.indexOf('--model')
    expect(idx).toBeGreaterThan(0)
    expect(argv[idx + 1]).toBe('sonnet')
  })

  test('no --model when option omitted', () => {
    const argv = buildHeadlessCommand({
      dojoRoot: '/dojo',
      role: 'librarian',
      prompt: 'x',
    })
    expect(argv).not.toContain('--model')
  })

  test('default outputFormat is json — argv contains --output-format json', () => {
    const argv = buildHeadlessCommand({
      dojoRoot: '/dojo',
      role: 'librarian',
      prompt: 'x',
    })
    const idx = argv.indexOf('--output-format')
    expect(idx).toBeGreaterThan(0)
    expect(argv[idx + 1]).toBe('json')
  })

  test('outputFormat: text omits --output-format', () => {
    const argv = buildHeadlessCommand({
      dojoRoot: '/dojo',
      role: 'librarian',
      prompt: 'x',
      outputFormat: 'text',
    })
    expect(argv).not.toContain('--output-format')
  })
})

describe('parseHeadlessJson', () => {
  test('extracts session_id, cost, tokens, model from typical payload', () => {
    const payload = JSON.stringify({
      session_id: '11111111-2222-3333-4444-555555555555',
      result: 'final answer text',
      total_cost_usd: 0.0123,
      usage: { total_tokens: 4567 },
      model: 'claude-sonnet-4-6',
    })
    const parsed = parseHeadlessJson(payload)
    expect(parsed?.sessionId).toBe('11111111-2222-3333-4444-555555555555')
    expect(parsed?.response).toBe('final answer text')
    expect(parsed?.costUsd).toBe(0.0123)
    expect(parsed?.totalTokens).toBe(4567)
    expect(parsed?.model).toBe('claude-sonnet-4-6')
  })

  test('falls back to camelCase keys', () => {
    const parsed = parseHeadlessJson(JSON.stringify({ sessionId: 'abc', costUsd: 0.5, usage: { totalTokens: 100 } }))
    expect(parsed?.sessionId).toBe('abc')
    expect(parsed?.costUsd).toBe(0.5)
    expect(parsed?.totalTokens).toBe(100)
  })

  test('synthesizes totalTokens from input + output when total absent', () => {
    const parsed = parseHeadlessJson(JSON.stringify({ usage: { input_tokens: 1000, output_tokens: 500 } }))
    expect(parsed?.totalTokens).toBe(1500)
  })

  test('returns undefined for non-JSON stdout', () => {
    expect(parseHeadlessJson('not json')).toBeUndefined()
    expect(parseHeadlessJson('')).toBeUndefined()
  })

  test('returns object with undefined fields for JSON without expected keys', () => {
    const parsed = parseHeadlessJson('{"unrelated": true}')
    expect(parsed).toBeDefined()
    expect(parsed?.sessionId).toBeUndefined()
    expect(parsed?.totalTokens).toBeUndefined()
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

  test('parses JSON output and surfaces parsed.sessionId', async () => {
    const stub = writeScript(
      resolve(TMP, 'json-out.sh'),
      `cat <<'EOF'
{"session_id": "deadbeef-1234-5678-9abc-def012345678", "result": "ok", "total_cost_usd": 0.005, "usage": {"input_tokens": 100, "output_tokens": 50}, "model": "claude-sonnet-4-6"}
EOF`,
    )
    const result = await spawnHeadless({
      dojoRoot: TMP,
      role: 'librarian',
      prompt: 'unused',
      binary: stub,
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed?.sessionId).toBe('deadbeef-1234-5678-9abc-def012345678')
    expect(result.parsed?.costUsd).toBe(0.005)
    expect(result.parsed?.totalTokens).toBe(150)
    expect(result.parsed?.model).toBe('claude-sonnet-4-6')
  })

  test('outputFormat: text skips JSON parsing — parsed is undefined', async () => {
    const stub = writeScript(resolve(TMP, 'plain.sh'), 'echo "plain text response"')
    const result = await spawnHeadless({
      dojoRoot: TMP,
      role: 'librarian',
      prompt: 'unused',
      binary: stub,
      outputFormat: 'text',
    })
    expect(result.parsed).toBeUndefined()
    expect(result.stdout).toContain('plain text response')
  })

  test('parsed is undefined when stdout is not JSON despite outputFormat=json', async () => {
    const stub = writeScript(resolve(TMP, 'malformed.sh'), 'echo "this is not json"')
    const result = await spawnHeadless({
      dojoRoot: TMP,
      role: 'librarian',
      prompt: 'unused',
      binary: stub,
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed).toBeUndefined()
  })
})
