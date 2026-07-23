import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  buildHeadlessCommand,
  CONSOLIDATE_WIKI_PROMPT,
  CONSOLIDATE_WIKI_TRIGGER_ID,
  commitConsolidation,
  LIBRARIAN_DEFAULT_CRON,
  LIBRARIAN_DEFAULT_MODEL,
  LibrarianRoleNotInitializedError,
  parseHeadlessJson,
  parseHeadlessStreamJson,
  probeAnthropicAPI,
  provisionLibrarianTrigger,
  recoverWikiLayout,
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
  test('emits claude -p <prompt> with --add-dir and no MCP (--strict-mcp-config) relative to role dir', () => {
    const argv = buildHeadlessCommand({
      dojoRoot: '/dojo',
      role: 'librarian',
      prompt: 'consolidate the wiki',
    })
    expect(argv[0]).toBe('claude')
    expect(argv[1]).toBe('-p')
    expect(argv[2]).toBe('consolidate the wiki')
    expect(argv).toContain('--add-dir')
    // From /dojo/.jean/roles/librarian/, relative .jean is "../.."
    const addDirIdx = argv.indexOf('--add-dir')
    expect(argv[addDirIdx + 1]).toBe('../..')
    // Headless runs intentionally do NOT load MCP; the librarian uses
    // native Read/Edit/Write/Bash. No --mcp-config in argv, and
    // --strict-mcp-config forces zero MCP servers (ignoring the global
    // jean channel registration) so the run never registers as a worker.
    expect(argv).not.toContain('--mcp-config')
    expect(argv).toContain('--strict-mcp-config')
    // Permission UI bypassed — headless can't answer prompts, would stall.
    expect(argv).toContain('--dangerously-skip-permissions')
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

  test('streamSinkPath switches to --output-format stream-json --verbose, overriding outputFormat', () => {
    const argv = buildHeadlessCommand({
      dojoRoot: '/dojo',
      role: 'librarian',
      prompt: 'x',
      streamSinkPath: '.jean/.headless/x.jsonl',
    })
    const idx = argv.indexOf('--output-format')
    expect(idx).toBeGreaterThan(0)
    expect(argv[idx + 1]).toBe('stream-json')
    // Claude Code rejects --output-format stream-json without --verbose under -p.
    expect(argv).toContain('--verbose')
  })
})

describe('recoverWikiLayout', () => {
  const ROOT = '/tmp/jean-test-recovery'
  const ctx = resolve(ROOT, '.jean', 'context')
  const consolidator = resolve(ROOT, '.jean', '.consolidator')
  const staging = resolve(consolidator, 'staging')

  beforeEach(() => {
    try {
      rmSync(ROOT, { recursive: true })
    } catch {}
    mkdirSync(resolve(ROOT, '.jean'), { recursive: true })
    mkdirSync(consolidator, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(ROOT, { recursive: true })
    } catch {}
  })

  test('steady state (context/ exists, no staging or old) → no-op', () => {
    mkdirSync(ctx, { recursive: true })
    writeFileSync(resolve(ctx, 'index.md'), 'hello')
    const r = recoverWikiLayout(ROOT)
    expect(r.recovered).toBe('none')
    expect(readFileSync(resolve(ctx, 'index.md'), 'utf8')).toBe('hello')
  })

  test('crash before swap (context/ + staging/ both exist) → wipes staging/', () => {
    mkdirSync(ctx, { recursive: true })
    writeFileSync(resolve(ctx, 'index.md'), 'real')
    mkdirSync(staging, { recursive: true })
    writeFileSync(resolve(staging, 'index.md'), 'partial')
    const r = recoverWikiLayout(ROOT)
    expect(r.recovered).toBe('cleanup')
    expect(existsSync(staging)).toBe(false)
    expect(readFileSync(resolve(ctx, 'index.md'), 'utf8')).toBe('real')
  })

  test('crash mid-swap with staging/ ready (no context/) → staging wins, becomes context/', () => {
    mkdirSync(staging, { recursive: true })
    writeFileSync(resolve(staging, 'index.md'), 'new version')
    const r = recoverWikiLayout(ROOT)
    expect(r.recovered).toBe('staging')
    expect(existsSync(ctx)).toBe(true)
    expect(existsSync(staging)).toBe(false)
    expect(readFileSync(resolve(ctx, 'index.md'), 'utf8')).toBe('new version')
  })

  test('crash mid-swap with only old-<ts>/ (no staging, no context) → rolls back', () => {
    const oldDir = resolve(consolidator, 'old-20260429T000000Z')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(resolve(oldDir, 'index.md'), 'previous')
    const r = recoverWikiLayout(ROOT)
    expect(r.recovered).toBe('old')
    expect(existsSync(ctx)).toBe(true)
    expect(existsSync(oldDir)).toBe(false)
    expect(readFileSync(resolve(ctx, 'index.md'), 'utf8')).toBe('previous')
  })

  test('staging present beats old when both exist (new version wins)', () => {
    mkdirSync(staging, { recursive: true })
    writeFileSync(resolve(staging, 'index.md'), 'new')
    const oldDir = resolve(consolidator, 'old-20260429T000000Z')
    mkdirSync(oldDir, { recursive: true })
    writeFileSync(resolve(oldDir, 'index.md'), 'previous')
    const r = recoverWikiLayout(ROOT)
    expect(r.recovered).toBe('staging')
    expect(readFileSync(resolve(ctx, 'index.md'), 'utf8')).toBe('new')
    expect(existsSync(oldDir)).toBe(false)
  })

  test('multiple old-* dirs → newest wins, others wiped', () => {
    const a = resolve(consolidator, 'old-20260427T000000Z')
    const b = resolve(consolidator, 'old-20260429T000000Z')
    mkdirSync(a, { recursive: true })
    mkdirSync(b, { recursive: true })
    writeFileSync(resolve(a, 'index.md'), 'older')
    writeFileSync(resolve(b, 'index.md'), 'newer')
    const r = recoverWikiLayout(ROOT)
    expect(r.recovered).toBe('old')
    expect(readFileSync(resolve(ctx, 'index.md'), 'utf8')).toBe('newer')
    expect(existsSync(a)).toBe(false)
    expect(existsSync(b)).toBe(false)
  })

  test('context/ + old-<ts>/ (swap completed but cleanup raced) → wipes old', () => {
    mkdirSync(ctx, { recursive: true })
    writeFileSync(resolve(ctx, 'index.md'), 'current')
    const oldDir = resolve(consolidator, 'old-20260429T000000Z')
    mkdirSync(oldDir, { recursive: true })
    const r = recoverWikiLayout(ROOT)
    expect(r.recovered).toBe('cleanup')
    expect(existsSync(oldDir)).toBe(false)
    expect(readFileSync(resolve(ctx, 'index.md'), 'utf8')).toBe('current')
  })

  test('no context/, no staging/, no old-* → throws (caller must bootstrap)', () => {
    expect(() => recoverWikiLayout(ROOT)).toThrow(/missing/)
  })

  // Establish context/ as a git repo with one committed page.
  const gitInitCtx = () => {
    mkdirSync(ctx, { recursive: true })
    writeFileSync(resolve(ctx, 'a.md'), 'committed\n')
    const g = (args: string[]) => Bun.spawnSync(['git', '-C', ctx, ...args], { stdout: 'pipe', stderr: 'pipe' })
    g(['init', '-q'])
    g(['add', '-A'])
    g(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
  }

  test('git era: dirty context/ + staging → reverts tracked to HEAD, PRESERVES untracked', () => {
    gitInitCtx()
    // Crash mid copy-sync: a tracked page half-written, plus untracked content —
    // a human's manual page that was never committed — with staging present.
    writeFileSync(resolve(ctx, 'a.md'), 'HALF-WRITTEN\n')
    writeFileSync(resolve(ctx, 'human-notes.md'), 'hand-written, never committed\n')
    mkdirSync(staging, { recursive: true })
    writeFileSync(resolve(staging, 'x.md'), 'x\n')

    const r = recoverWikiLayout(ROOT)

    expect(r.recovered).toBe('reset')
    expect(readFileSync(resolve(ctx, 'a.md'), 'utf8')).toBe('committed\n') // tracked reverted to HEAD
    // Untracked content is NEVER destroyed — recovery must not `git clean` it away.
    expect(readFileSync(resolve(ctx, 'human-notes.md'), 'utf8')).toBe('hand-written, never committed\n')
    expect(existsSync(staging)).toBe(false) // staging dropped → next run rebuilds
  })

  test('git era: clean context/ + staging present → drops staging, keeps the commit', () => {
    gitInitCtx()
    mkdirSync(staging, { recursive: true })
    writeFileSync(resolve(staging, 'x.md'), 'x\n')

    const r = recoverWikiLayout(ROOT)

    expect(r.recovered).toBe('cleanup')
    expect(existsSync(staging)).toBe(false)
    expect(readFileSync(resolve(ctx, 'a.md'), 'utf8')).toBe('committed\n') // untouched
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

describe('parseHeadlessStreamJson', () => {
  test('finds the final result event in a multi-line stream and extracts fields', () => {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 'abc',
        result: 'done',
        total_cost_usd: 0.05,
        usage: { input_tokens: 1000, output_tokens: 200 },
        model: 'claude-sonnet-4-6',
      }),
    ].join('\n')
    const parsed = parseHeadlessStreamJson(stream)
    expect(parsed?.sessionId).toBe('abc')
    expect(parsed?.response).toBe('done')
    expect(parsed?.costUsd).toBe(0.05)
    expect(parsed?.totalTokens).toBe(1200)
    expect(parsed?.model).toBe('claude-sonnet-4-6')
  })

  test('returns undefined when no result line is present (e.g. killed mid-flight)', () => {
    const partialStream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'still thinking' }] } }),
      // no result line — process was killed before final event
    ].join('\n')
    expect(parseHeadlessStreamJson(partialStream)).toBeUndefined()
  })

  test('skips malformed trailing lines and finds the result line above them', () => {
    const stream =
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 'abc',
        total_cost_usd: 0.01,
      }) + '\n{ truncated half-line'
    const parsed = parseHeadlessStreamJson(stream)
    expect(parsed?.sessionId).toBe('abc')
    expect(parsed?.costUsd).toBe(0.01)
  })

  test('returns undefined for empty stdout', () => {
    expect(parseHeadlessStreamJson('')).toBeUndefined()
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

  test('streamSinkPath tees stdout to disk (relative-to-dojoRoot) and parses the result line', async () => {
    const stub = writeScript(
      resolve(TMP, 'stream.sh'),
      `cat <<'EOF'
{"type":"system","subtype":"init","session_id":"sess-1"}
{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}]}}
{"type":"result","subtype":"success","session_id":"sess-1","result":"done","total_cost_usd":0.02,"usage":{"input_tokens":500,"output_tokens":100},"model":"claude-sonnet-4-6"}
EOF`,
    )
    const sinkRel = '.jean/.headless/librarian-test.jsonl'
    const result = await spawnHeadless({
      dojoRoot: TMP,
      role: 'librarian',
      prompt: 'unused',
      binary: stub,
      streamSinkPath: sinkRel,
    })
    expect(result.exitCode).toBe(0)
    expect(result.parsed?.sessionId).toBe('sess-1')
    expect(result.parsed?.response).toBe('done')
    expect(result.parsed?.totalTokens).toBe(600)
    const onDisk = readFileSync(resolve(TMP, sinkRel), 'utf8')
    expect(onDisk).toContain('"type":"result"')
    expect(onDisk).toContain('"session_id":"sess-1"')
  })
})

describe('probeAnthropicAPI', () => {
  beforeEach(() => {
    try {
      rmSync(TMP, { recursive: true })
    } catch {}
    mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TMP, { recursive: true })
    } catch {}
  })

  test('returns ok=true when stub binary exits 0 quickly', async () => {
    const stub = writeScript(resolve(TMP, 'probe-ok.sh'), 'exit 0')
    const result = await probeAnthropicAPI({ binary: stub, timeoutMs: 2000 })
    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.latencyMs).toBeLessThan(2000)
  })

  test('returns ok=false with timeout error when stub hangs past timeoutMs', async () => {
    const stub = writeScript(resolve(TMP, 'probe-hang.sh'), 'sleep 5')
    const result = await probeAnthropicAPI({ binary: stub, timeoutMs: 200 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('timed out')
    expect(result.latencyMs).toBeLessThan(2000)
  })

  test('returns ok=false when stub binary exits non-zero', async () => {
    const stub = writeScript(resolve(TMP, 'probe-fail.sh'), 'exit 3')
    const result = await probeAnthropicAPI({ binary: stub, timeoutMs: 2000 })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('exit code 3')
  })

  test('returns ok=false when binary does not exist', async () => {
    const result = await probeAnthropicAPI({ binary: '/nonexistent/path/to/claude', timeoutMs: 2000 })
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })
})

describe('provisionLibrarianTrigger', () => {
  let dir: string
  let historyPath: string

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'jean-provision-'))
    historyPath = resolve(dir, 'history.jsonl')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Parse the jsonl event log back into objects. */
  function readEvents(): Array<{ id: number; stream: string; type: string; data: Record<string, unknown> }> {
    if (!existsSync(historyPath)) return []
    return readFileSync(historyPath, 'utf8')
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  }

  test('creates the consolidate-wiki trigger in an empty log with the pipeline-dispatching shape', async () => {
    const { created } = await provisionLibrarianTrigger({ historyPath })
    expect(created).toBe(true)

    const createdEvents = readEvents().filter((e) => e.type === 'trigger-created')
    expect(createdEvents).toHaveLength(1)
    const d = createdEvents[0]?.data as Record<string, unknown>
    // role + id are what server.ts keys the draft→review→commit pipeline on.
    expect(d.id).toBe(CONSOLIDATE_WIKI_TRIGGER_ID)
    expect(d.agent).toBe('librarian')
    expect(d.kind).toBe('headless')
    expect(d.cron).toBe(LIBRARIAN_DEFAULT_CRON)
    expect(d.model).toBe(LIBRARIAN_DEFAULT_MODEL)
    expect(d.prompt).toBe(CONSOLIDATE_WIKI_PROMPT)
    expect(d.actor).toBe('init')
    expect(createdEvents[0]?.stream).toBe('triggers')
  })

  test('is idempotent — a second call does not duplicate', async () => {
    const first = await provisionLibrarianTrigger({ historyPath })
    const second = await provisionLibrarianTrigger({ historyPath })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(readEvents().filter((e) => e.type === 'trigger-created')).toHaveLength(1)
  })

  test('does not resurrect a deliberately removed trigger', async () => {
    await provisionLibrarianTrigger({ historyPath })
    // Simulate a user `jean trigger remove consolidate-wiki`.
    appendFileSync(
      historyPath,
      `${JSON.stringify({
        id: 99,
        stream: 'triggers',
        type: 'trigger-removed',
        ts: '2026-01-01T00:00:00.000Z',
        data: { id: CONSOLIDATE_WIKI_TRIGGER_ID },
      })}\n`,
    )
    const { created } = await provisionLibrarianTrigger({ historyPath })
    expect(created).toBe(false)
    // Still exactly one create — we did not re-add it.
    expect(readEvents().filter((e) => e.type === 'trigger-created')).toHaveLength(1)
  })

  test('honors cron and model overrides', async () => {
    await provisionLibrarianTrigger({ historyPath, cron: '0 5 * * *', model: 'opus' })
    const d = readEvents().find((e) => e.type === 'trigger-created')?.data as Record<string, unknown>
    expect(d.cron).toBe('0 5 * * *')
    expect(d.model).toBe('opus')
  })
})

describe('commitConsolidation (git-backed context/)', () => {
  let dir: string
  let context: string
  let consolidator: string
  let staging: string

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'jean-commit-'))
    const jean = resolve(dir, '.jean')
    context = resolve(jean, 'context')
    consolidator = resolve(jean, '.consolidator')
    staging = resolve(consolidator, 'staging')
    mkdirSync(context, { recursive: true })
    mkdirSync(staging, { recursive: true })
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const writeCursor = (id: number) =>
    writeFileSync(
      resolve(consolidator, 'cursor.json'),
      JSON.stringify({ lastEventId: id, lastConsolidatedAt: 'x', lastRawConsolidatedAt: 'x' }),
    )
  const writePlan = (plan: Record<string, unknown>) =>
    writeFileSync(resolve(consolidator, 'plan.json'), JSON.stringify(plan))
  const gitSubjects = (repo: string): string[] =>
    Bun.spawnSync(['git', '-C', repo, 'log', '--format=%s'], { stdout: 'pipe', stderr: 'pipe' })
      .stdout.toString()
      .trim()
      .split('\n')
      .filter(Boolean)
  const filesInHead = (repo: string): string[] =>
    Bun.spawnSync(['git', '-C', repo, 'show', '--name-only', '--format=', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' })
      .stdout.toString()
      .trim()
      .split('\n')
      .filter(Boolean)
  const noop = async () => {}

  test('git-backs a fresh context/, commits the pages, advances the cursor', async () => {
    writeCursor(470)
    writeFileSync(resolve(staging, 'index.md'), '# Index\n')
    writeFileSync(resolve(staging, 'bills.md'), '# Bills\ncancelled\n')
    writePlan({
      phase: 'draft',
      newCursor: 512,
      decisions: [
        { op: 'create', page: 'bills.md' },
        { op: 'create', page: 'index.md' },
      ],
      stats: { eventsProcessed: 3, pagesCreated: 2 },
    })

    const res = await commitConsolidation({ dojoRoot: dir, recordEvent: noop })

    expect(res.swapped).toBe(true)
    expect(existsSync(resolve(context, '.git'))).toBe(true)
    expect(existsSync(resolve(context, 'bills.md'))).toBe(true)
    expect(existsSync(staging)).toBe(false) // staging consumed
    // Commit subject carries the event-id watermark (prev → new cursor).
    expect(gitSubjects(context)[0]).toBe('consolidate 470→512: 2 created')
    // Cursor advanced to the plan's newCursor.
    expect(JSON.parse(readFileSync(resolve(consolidator, 'cursor.json'), 'utf8')).lastEventId).toBe(512)
  })

  test('migrates a pre-git context/ with a baseline commit, then applies the run', async () => {
    // Pre-existing wiki, not yet a git repo.
    writeFileSync(resolve(context, 'old.md'), '# Old\nexisting\n')
    writeCursor(100)
    // Draft carries old.md forward (keep) and adds new.md.
    writeFileSync(resolve(staging, 'old.md'), '# Old\nexisting\n')
    writeFileSync(resolve(staging, 'new.md'), '# New\n')
    writePlan({
      phase: 'draft',
      newCursor: 120,
      decisions: [
        { op: 'keep', page: 'old.md' },
        { op: 'create', page: 'new.md' },
      ],
      stats: { eventsProcessed: 1, pagesCreated: 1 },
    })

    await commitConsolidation({ dojoRoot: dir, recordEvent: noop })

    const subjects = gitSubjects(context) // newest first
    expect(subjects.length).toBe(2)
    expect(subjects[1]).toContain('initial commit') // baseline captured old.md
    expect(subjects[0]).toBe('consolidate 100→120: 1 created')
    // The run commit's diff is ONLY new.md — old.md was byte-identical, no noise.
    expect(filesInHead(context)).toEqual(['new.md'])
    expect(existsSync(resolve(context, 'old.md'))).toBe(true)
  })

  test('an archived page is deleted and the deletion is committed', async () => {
    // First run establishes a git-backed context with a.md + b.md.
    writeCursor(0)
    writeFileSync(resolve(staging, 'a.md'), '# A\n')
    writeFileSync(resolve(staging, 'b.md'), '# B\n')
    writePlan({
      phase: 'draft',
      newCursor: 10,
      decisions: [
        { op: 'create', page: 'a.md' },
        { op: 'create', page: 'b.md' },
      ],
      stats: { eventsProcessed: 2, pagesCreated: 2 },
    })
    await commitConsolidation({ dojoRoot: dir, recordEvent: noop })
    expect(existsSync(resolve(context, 'b.md'))).toBe(true)

    // Second run: staging omits b.md (archived away).
    mkdirSync(staging, { recursive: true })
    writeFileSync(resolve(staging, 'a.md'), '# A\n')
    writePlan({
      phase: 'draft',
      newCursor: 20,
      decisions: [
        { op: 'keep', page: 'a.md' },
        { op: 'archive', page: 'b.md' },
      ],
      stats: { eventsProcessed: 1, pagesArchived: 1 },
    })
    await commitConsolidation({ dojoRoot: dir, recordEvent: noop })

    expect(existsSync(resolve(context, 'b.md'))).toBe(false) // removed from the tree
    expect(existsSync(resolve(context, 'a.md'))).toBe(true)
    expect(gitSubjects(context)[0]).toBe('consolidate 10→20: 1 archived')
    // b.md is recoverable from history even though it's gone from the tree.
    const show = Bun.spawnSync(['git', '-C', context, 'show', 'HEAD~1:b.md'], { stdout: 'pipe', stderr: 'pipe' })
    expect(show.exitCode).toBe(0)
    expect(show.stdout.toString()).toContain('# B')
  })

  test('a keep-only plan makes no commit and sweeps staging', async () => {
    writeCursor(5)
    writeFileSync(resolve(context, 'a.md'), '# A\n')
    writeFileSync(resolve(staging, 'a.md'), '# A\n')
    writePlan({ phase: 'draft', newCursor: 5, decisions: [{ op: 'keep', page: 'a.md' }], stats: {} })

    const res = await commitConsolidation({ dojoRoot: dir, recordEvent: noop })

    expect(res.swapped).toBe(false)
    expect(existsSync(staging)).toBe(false) // straggler staging swept
    expect(existsSync(resolve(context, '.git'))).toBe(false) // no changes → not git-backed yet
  })

  // First run helper: establish a git-backed context/ with the given pages.
  const firstRun = async (pages: Record<string, string>, newCursor: number) => {
    writeCursor(0)
    for (const [f, body] of Object.entries(pages)) {
      mkdirSync(resolve(staging, f, '..'), { recursive: true })
      writeFileSync(resolve(staging, f), body)
    }
    writePlan({
      phase: 'draft',
      newCursor,
      decisions: Object.keys(pages).map((page) => ({ op: 'create', page })),
      stats: { eventsProcessed: 1, pagesCreated: Object.keys(pages).length },
    })
    await commitConsolidation({ dojoRoot: dir, recordEvent: noop })
  }

  test('byte-identical update makes no commit but still advances the cursor', async () => {
    await firstRun({ 'a.md': '# A\ncontent\n' }, 10)
    const commitsAfterFirst = gitSubjects(context).length

    // Second run: an 'update' decision but byte-identical content → no git diff.
    mkdirSync(staging, { recursive: true })
    writeFileSync(resolve(staging, 'a.md'), '# A\ncontent\n') // identical bytes
    writePlan({
      phase: 'draft',
      newCursor: 20,
      decisions: [{ op: 'update', page: 'a.md' }],
      stats: { eventsProcessed: 1, pagesUpdated: 1 },
    })
    const res = await commitConsolidation({ dojoRoot: dir, recordEvent: noop })

    expect(res.swapped).toBe(true) // plan had changes...
    expect(gitSubjects(context).length).toBe(commitsAfterFirst) // ...but NO new commit (no diff)
    // Cursor still advances — the events were processed even if the wiki didn't change.
    expect(JSON.parse(readFileSync(resolve(consolidator, 'cursor.json'), 'utf8')).lastEventId).toBe(20)
  })

  test('a stray staging/.git never clobbers the real context/ repo', async () => {
    await firstRun({ 'a.md': '# A\n' }, 10)
    const firstHead = Bun.spawnSync(['git', '-C', context, 'rev-parse', 'HEAD'], { stdout: 'pipe' })
      .stdout.toString()
      .trim()

    // Second run whose staging contains a bogus .git (e.g. a skill that cp -r'd context).
    mkdirSync(staging, { recursive: true })
    writeFileSync(resolve(staging, 'a.md'), '# A\nv2\n')
    mkdirSync(resolve(staging, '.git'), { recursive: true })
    writeFileSync(resolve(staging, '.git', 'BOGUS'), 'not a real repo\n')
    writePlan({
      phase: 'draft',
      newCursor: 20,
      decisions: [{ op: 'update', page: 'a.md' }],
      stats: { eventsProcessed: 1, pagesUpdated: 1 },
    })
    await commitConsolidation({ dojoRoot: dir, recordEvent: noop })

    expect(existsSync(resolve(context, '.git', 'BOGUS'))).toBe(false) // bogus .git never copied in
    // History chains back to the first commit → the real repo was not clobbered.
    const parent = Bun.spawnSync(['git', '-C', context, 'rev-parse', 'HEAD~1'], { stdout: 'pipe' })
      .stdout.toString()
      .trim()
    expect(parent).toBe(firstHead)
  })

  test('a dirty context/ (human edit) is captured in its own commit before consolidation overwrites it', async () => {
    await firstRun({ 'a.md': '# A\noriginal\n' }, 10)
    // Human hand-edits a tracked page — dirty, never committed.
    writeFileSync(resolve(context, 'a.md'), '# A\nHUMAN EDIT never memorized\n')

    // A consolidation run overwrites a.md with a distilled version.
    mkdirSync(staging, { recursive: true })
    writeFileSync(resolve(staging, 'a.md'), '# A\ndistilled v2\n')
    writePlan({
      phase: 'draft',
      newCursor: 20,
      decisions: [{ op: 'update', page: 'a.md' }],
      stats: { eventsProcessed: 1, pagesUpdated: 1 },
    })
    await commitConsolidation({ dojoRoot: dir, recordEvent: noop })

    // Working tree ends at the distilled version...
    expect(readFileSync(resolve(context, 'a.md'), 'utf8')).toBe('# A\ndistilled v2\n')
    // ...but the human edit is NOT lost — captured in git history first.
    const subjects = gitSubjects(context)
    expect(subjects[0]).toContain('consolidate 10→20') // newest: the consolidation
    expect(subjects[1]).toBe('wiki: capture pre-consolidation edits') // the captured human edit
    const captured = Bun.spawnSync(['git', '-C', context, 'show', 'HEAD~1:a.md'], { stdout: 'pipe' }).stdout.toString()
    expect(captured).toContain('HUMAN EDIT never memorized')
  })

  test('a removed NESTED page is deleted (recursive mirror)', async () => {
    await firstRun({ 'topics/a.md': '# A\n', 'topics/b.md': '# B\n' }, 10)
    expect(existsSync(resolve(context, 'topics', 'b.md'))).toBe(true)

    // Second run: staging omits topics/b.md.
    mkdirSync(resolve(staging, 'topics'), { recursive: true })
    writeFileSync(resolve(staging, 'topics', 'a.md'), '# A\n')
    writePlan({
      phase: 'draft',
      newCursor: 20,
      decisions: [{ op: 'archive', page: 'topics/b.md' }],
      stats: { eventsProcessed: 1, pagesArchived: 1 },
    })
    await commitConsolidation({ dojoRoot: dir, recordEvent: noop })

    expect(existsSync(resolve(context, 'topics', 'b.md'))).toBe(false) // nested removal handled
    expect(existsSync(resolve(context, 'topics', 'a.md'))).toBe(true)
  })
})
