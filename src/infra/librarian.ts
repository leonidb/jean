/**
 * Spawn a headless Claude process — the librarian and other one-shot agents.
 *
 * Used by the `consolidate-wiki` trigger (and any future headless trigger
 * type). Unlike persistent agents, headless processes:
 *   - Have no WebSocket registration with infra
 *   - Don't appear in `jean agent list`
 *   - Spawn → run → exit; resource cost is one process for ~minutes
 *
 * The role's permissions live in `<dojo>/.jean/roles/<role>/.claude/
 * settings.local.json` (written by bootstrap). Claude Code discovers them
 * automatically because we cd into that directory before spawning. Same
 * for skills: `<dojo>/.jean/roles/<role>/.claude/skills/<name>/SKILL.md`
 * is auto-discovered.
 *
 * See docs/llm-wiki-design.md (Adaptation 7).
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import type { AgentRole } from './protocol.ts'
import type { WikiConsolidatedData } from './reducers.ts'

export type SpawnHeadlessOpts = {
  /** The dojo root containing `.jean/`. */
  dojoRoot: string
  /** Which role's permissions/skills directory to use as the working dir. */
  role: AgentRole
  /** The user-prompt fed to Claude. Becomes argv after `-p`. */
  prompt: string
  /**
   * Model to invoke. Accepts Claude Code shorthand (`sonnet`, `opus`,
   * `haiku`) or a full model ID. Cheaper models can run wiki consolidation
   * or other structured-editing work at a fraction of Opus cost.
   * When unset, Claude Code's default model is used.
   */
  model?: string
  /**
   * Output format. `'json'` (default) returns a single JSON object on exit;
   * `'text'` keeps stdout as raw response text. Setting `streamSinkPath`
   * overrides this to stream-json mode regardless.
   */
  outputFormat?: 'json' | 'text'
  /**
   * Relative-to-dojoRoot path. When set, the spawn switches to stream-json
   * output (one JSON event per line — assistant turns, tool_use,
   * tool_result, final `result`) and tees stdout to this path as it
   * arrives. A killed run still leaves a forensic trace at this path.
   * Parent dir is created if missing.
   */
  streamSinkPath?: string
  /**
   * Override binary. Default `'claude'`. Tests use this to point at a stub
   * (e.g. `/bin/echo`) so they don't need a real Claude installation.
   */
  binary?: string
  /** Extra argv pushed after the prompt — escape hatch for special flags. */
  extraArgs?: string[]
  /** Hard timeout. Default 20 minutes. */
  timeoutMs?: number
}

/** Subset of the `claude -p --output-format json` payload we surface. */
export type HeadlessParsed = {
  /**
   * Session ID — used to locate the conversation JSONL at
   * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`.
   */
  sessionId?: string
  /** Final assistant text (the bare answer, no tool-call details). */
  response?: string
  /** USD cost as reported by Claude Code, when available. */
  costUsd?: number
  /** Total tokens (input + output + cached) when available. */
  totalTokens?: number
  /** Model that actually answered (may differ from requested e.g. on fallback). */
  model?: string
}

export type SpawnHeadlessResult = {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  /** True if the process was killed because it exceeded `timeoutMs`. */
  timedOut: boolean
  /**
   * Structured fields parsed from stdout when `outputFormat: 'json'` and the
   * process exited successfully. `undefined` when output was text format,
   * the run failed before producing JSON, or stdout wasn't valid JSON.
   */
  parsed?: HeadlessParsed
}

export class LibrarianRoleNotInitializedError extends Error {
  constructor(public readonly path: string) {
    super(`Role directory does not exist: ${path}. Bootstrap the role first.`)
    this.name = 'LibrarianRoleNotInitializedError'
  }
}

/**
 * Recover the wiki layout from a possible mid-swap crash before letting the
 * librarian LLM run. Deterministic, no LLM involvement.
 *
 * Three crash states this fixes:
 *   - context/ missing, staging/ present       → mv staging → context (new version wins)
 *   - context/ missing, old-<ts>/ present      → mv old-<ts> → context (rollback)
 *   - context/ present AND old-<ts>/ present   → rm -rf old-<ts>/ (swap completed; cleanup raced)
 *
 * After this returns, `.jean/context/` is guaranteed to exist as a real
 * directory (or the dojo is in a state we can't auto-recover from, in
 * which case we throw and the librarian doesn't run).
 *
 * Steady state where context/ exists and no old-* exists is a no-op.
 */
export function recoverWikiLayout(dojoRoot: string): { recovered: 'staging' | 'old' | 'cleanup' | 'none' } {
  const { consolidator, context, staging } = consolidatorPaths(dojoRoot)

  const oldDirs = existsSync(consolidator)
    ? readdirSync(consolidator)
        .filter((n) => n.startsWith('old-'))
        .map((n) => resolve(consolidator, n))
        .sort()
    : []

  if (!existsSync(context)) {
    if (existsSync(staging)) {
      renameSync(staging, context)
      for (const o of oldDirs) rmSync(o, { recursive: true, force: true })
      return { recovered: 'staging' }
    }
    if (oldDirs.length > 0) {
      const newest = oldDirs[oldDirs.length - 1] as string
      renameSync(newest, context)
      for (const o of oldDirs.slice(0, -1)) rmSync(o, { recursive: true, force: true })
      return { recovered: 'old' }
    }
    throw new Error(
      `wiki-recovery: .jean/context/ missing and no staging/ or old-*/ to restore. ` +
        `Bootstrap the wiki at ${context} before running the librarian.`,
    )
  }

  // Steady state: context/ exists. Sweep transient dirs from a previous run.
  if (oldDirs.length > 0) {
    for (const o of oldDirs) rmSync(o, { recursive: true, force: true })
    return { recovered: 'cleanup' }
  }
  if (existsSync(staging)) {
    rmSync(staging, { recursive: true, force: true })
    return { recovered: 'cleanup' }
  }

  return { recovered: 'none' }
}

/**
 * Build the argv for a headless Claude invocation. Pure — no spawn side effect.
 *
 * Layout that this assumes the caller will set up:
 *   <dojoRoot>/.jean/                          — dojo data
 *   <dojoRoot>/.jean/roles/<role>/             — working directory
 *   <dojoRoot>/.jean/roles/<role>/.claude/     — settings.local.json + skills/
 *   <dojoRoot>/.jean/.mcp.json                 — Jean MCP config (optional)
 *
 * `--add-dir` is set for the dojo's `.jean/` (relative path from cwd) so
 * Claude can read the event log, peers, and other dojo state.
 */
export function buildHeadlessCommand(opts: SpawnHeadlessOpts): string[] {
  const jeanDir = resolve(opts.dojoRoot, '.jean')
  const roleDir = resolve(jeanDir, 'roles', opts.role)
  const relJean = relative(roleDir, jeanDir) || '.'
  const streaming = opts.streamSinkPath !== undefined
  const outputFormat = opts.outputFormat ?? 'json'
  return [
    opts.binary ?? 'claude',
    '-p',
    opts.prompt,
    '--add-dir',
    relJean,
    // Skip the interactive permission UI — headless can't answer prompts
    // and they would silently stall until our timeout. The role's
    // settings.local.json deny rules are still enforced; this flag only
    // bypasses the "ask the user" step, not the OS-level access controls.
    '--dangerously-skip-permissions',
    ...(opts.model ? ['--model', opts.model] : []),
    // Claude Code requires --verbose alongside --output-format stream-json
    // when running with -p; without it the CLI rejects the combination.
    ...(streaming
      ? ['--output-format', 'stream-json', '--verbose']
      : outputFormat === 'json'
        ? ['--output-format', 'json']
        : []),
    ...(opts.extraArgs ?? []),
  ]
}

function extractParsedFields(obj: Record<string, unknown>): HeadlessParsed {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const usage = (obj.usage ?? {}) as Record<string, unknown>
  const inputT = num(usage.input_tokens)
  const outputT = num(usage.output_tokens)
  const sumT = inputT !== undefined || outputT !== undefined ? (inputT ?? 0) + (outputT ?? 0) : undefined
  return {
    sessionId: str(obj.session_id) ?? str(obj.sessionId),
    response: str(obj.result) ?? str(obj.response),
    costUsd: num(obj.total_cost_usd) ?? num(obj.cost_usd) ?? num(obj.costUsd),
    totalTokens: num(usage.total_tokens) ?? num(usage.totalTokens) ?? sumT,
    model: str(obj.model),
  }
}

/**
 * Best-effort extraction of the fields we care about from Claude Code's
 * `--output-format json` payload. The exact key names have shifted between
 * versions (`session_id` vs `sessionId`, `total_cost_usd` vs `cost_usd`),
 * so we accept either shape and tolerate missing fields.
 */
export function parseHeadlessJson(stdout: string): HeadlessParsed | undefined {
  try {
    return extractParsedFields(JSON.parse(stdout) as Record<string, unknown>)
  } catch {
    return undefined
  }
}

/**
 * Find the final `result` event in a `--output-format stream-json` stdout
 * and extract the same summary fields parseHeadlessJson surfaces.
 *
 * stream-json produces one JSON object per line. The terminal event has
 * `type: "result"` (or sometimes `subtype: "success"`) and carries the
 * same session_id / total_cost_usd / usage fields as single-shot JSON mode.
 * If the run was killed mid-flight, no result line is emitted and we
 * return undefined — callers should treat that the same as a failed parse.
 */
export function parseHeadlessStreamJson(stdout: string): HeadlessParsed | undefined {
  const lines = stdout.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as Record<string, unknown>
      if (obj.type === 'result') return extractParsedFields(obj)
    } catch {}
  }
  return undefined
}

/**
 * Spawn the headless process and wait for it to exit. Returns captured
 * stdout/stderr, the exit code, wall-clock duration, and whether the run
 * was killed by the timeout.
 *
 * Throws `LibrarianRoleNotInitializedError` if the role directory doesn't
 * exist — caller is responsible for bootstrapping the role.
 */
export async function spawnHeadless(opts: SpawnHeadlessOpts): Promise<SpawnHeadlessResult> {
  const cwd = resolve(opts.dojoRoot, '.jean', 'roles', opts.role)
  if (!existsSync(cwd)) {
    throw new LibrarianRoleNotInitializedError(cwd)
  }

  const argv = buildHeadlessCommand(opts)
  const start = Date.now()
  const timeoutMs = opts.timeoutMs ?? 1_200_000
  const streaming = opts.streamSinkPath !== undefined
  const outputFormat = opts.outputFormat ?? 'json'

  let timedOut = false
  const proc = Bun.spawn(argv, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)

  const stdoutP = streaming
    ? teeStreamToFile(proc.stdout, resolve(opts.dojoRoot, opts.streamSinkPath as string))
    : new Response(proc.stdout).text()

  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, stdoutP, new Response(proc.stderr).text()])
  clearTimeout(timer)

  let parsed: HeadlessParsed | undefined
  if (exitCode === 0) {
    if (streaming) parsed = parseHeadlessStreamJson(stdout)
    else if (outputFormat === 'json') parsed = parseHeadlessJson(stdout)
  }

  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - start,
    timedOut,
    ...(parsed && { parsed }),
  }
}

async function teeStreamToFile(stream: ReadableStream<Uint8Array>, path: string): Promise<string> {
  mkdirSync(dirname(path), { recursive: true })
  const writer = Bun.file(path).writer()
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let acc = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      writer.write(value)
      // Flush per chunk so a kill -9 still leaves the partial run visible
      // on disk. stream-json chunks are small (per-tool-call); flush cost
      // is negligible compared to the visibility win.
      await writer.flush()
      acc += decoder.decode(value, { stream: true })
    }
    acc += decoder.decode()
  } finally {
    await writer.end()
  }
  return acc
}

// ── Multi-phase consolidation pipeline ──────────────────────────────
// Phases 1 + 2 are CC subprocess spawns (see runHeadlessAttempt in server.ts);
// phase 3 (commitConsolidation below) stays in-process so failures are
// observable and not subject to SDK lifecycle issues.

export type LibrarianPhase = 'draft' | 'review'

type AnomalyEntry = string | { type?: string; text?: string; [k: string]: unknown }

export type ConsolidatorPlan = {
  phase: 'draft'
  ts?: string
  newCursor: number
  newRawCursor?: string
  decisions: Array<{ op: 'create' | 'update' | 'keep' | 'archive'; page: string; reason?: string }>
  stats?: {
    eventsProcessed?: number
    tasksDistilled?: number
    rawFilesProcessed?: number
    pagesCreated?: number
    pagesUpdated?: number
    pagesArchived?: number
    corrections?: number
  }
  anomalies?: AnomalyEntry[]
}

export type ConsolidatorReview = {
  phase: 'review'
  ts?: string
  changes?: Array<{ page: string; kind: string; detail?: string }>
  anomalies?: AnomalyEntry[]
}

export type CommitConsolidationResult = {
  /** Whether the swap actually happened (false when plan.decisions is empty). */
  swapped: boolean
  /** Number of pages in context/ after the run. */
  pageCount: number
  /** Event payload appended to history. */
  emitted: WikiConsolidatedData
}

/** Centralizes the .consolidator/* path strings shared by recovery + commit. */
function consolidatorPaths(dojoRoot: string) {
  const jeanDir = resolve(dojoRoot, '.jean')
  const consolidator = resolve(jeanDir, '.consolidator')
  return {
    jeanDir,
    consolidator,
    context: resolve(jeanDir, 'context'),
    staging: resolve(consolidator, 'staging'),
    planPath: resolve(consolidator, 'plan.json'),
    reviewPath: resolve(consolidator, 'review.json'),
    cursorPath: resolve(consolidator, 'cursor.json'),
  }
}

function flattenAnomaly(a: AnomalyEntry): string {
  if (typeof a === 'string') return a
  const text = typeof a.text === 'string' ? a.text : JSON.stringify(a)
  return a.type ? `${a.type}: ${text}` : text
}

/**
 * Phase 3: read the staging/ + plan.json + (optional) review.json produced
 * by phases 1–2, atomically swap staging→context, emit wiki-consolidated,
 * advance cursor, clean up.
 *
 * Order is swap → emit → cursor on purpose: if event emission throws, we
 * leave cursor at its old value so the next run re-emits a no-op event
 * (decisions are already on disk so hasChanges=false and the swap doesn't
 * recur). Mid-swap rename failures are recovered by `recoverWikiLayout`
 * on the next pre-spawn pass.
 *
 * Throws if plan.json is missing (phase 1 didn't complete). Tolerates
 * a missing review.json — commits on plan.json alone in that case.
 */
export async function commitConsolidation(opts: {
  dojoRoot: string
  recordEvent: (data: WikiConsolidatedData) => Promise<unknown>
}): Promise<CommitConsolidationResult> {
  const { dojoRoot, recordEvent } = opts
  const p = consolidatorPaths(dojoRoot)

  if (!existsSync(p.planPath)) {
    throw new Error(`commitConsolidation: plan.json missing at ${p.planPath} — draft phase did not complete`)
  }

  const planObj = JSON.parse(await Bun.file(p.planPath).text()) as ConsolidatorPlan
  const reviewObj: ConsolidatorReview | undefined = existsSync(p.reviewPath)
    ? (JSON.parse(await Bun.file(p.reviewPath).text()) as ConsolidatorReview)
    : undefined

  const decisions = Array.isArray(planObj.decisions) ? planObj.decisions : []
  const hasChanges = decisions.some((d) => d.op === 'create' || d.op === 'update' || d.op === 'archive')

  // Review is authoritative when present — it carries plan anomalies forward
  // and adds new ones. Don't union both lists (would double-count).
  const rawAnomalies: AnomalyEntry[] = reviewObj?.anomalies ?? planObj.anomalies ?? []
  const anomalies = rawAnomalies.map(flattenAnomaly)

  // Swap. recoverWikiLayout (above) handles any mid-rename crash on next start.
  if (hasChanges) {
    if (!existsSync(p.staging)) {
      throw new Error(`commitConsolidation: plan has changes but staging/ missing at ${p.staging}`)
    }
    const ts = `${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}Z`
    const oldDir = resolve(p.consolidator, `old-${ts}`)
    if (existsSync(p.context)) renameSync(p.context, oldDir)
    renameSync(p.staging, p.context)
    rmSync(oldDir, { recursive: true, force: true })
  } else {
    // No-op: sweep any straggler staging/ from a partial draft phase.
    rmSync(p.staging, { recursive: true, force: true })
  }

  const stats = planObj.stats ?? {}
  const emitted: WikiConsolidatedData = {
    pagesCreated: stats.pagesCreated ?? decisions.filter((d) => d.op === 'create').length,
    pagesUpdated: stats.pagesUpdated ?? decisions.filter((d) => d.op === 'update').length,
    eventsProcessed: stats.eventsProcessed ?? 0,
    tasksDistilled: stats.tasksDistilled ?? 0,
    rawFilesProcessed: stats.rawFilesProcessed ?? 0,
    ...(stats.corrections !== undefined && { corrections: stats.corrections }),
    ...(anomalies.length > 0 && { anomalies }),
  }
  await recordEvent(emitted)

  // Cursor only after event lands — keeps cursor and event log in lockstep.
  const cursor = {
    lastEventId: typeof planObj.newCursor === 'number' ? planObj.newCursor : 0,
    lastConsolidatedAt: new Date().toISOString(),
    lastRawConsolidatedAt: planObj.newRawCursor ?? new Date().toISOString(),
  }
  writeFileSync(p.cursorPath, `${JSON.stringify(cursor, null, 2)}\n`)

  rmSync(p.planPath, { force: true })
  rmSync(p.reviewPath, { force: true })

  const pageCount = existsSync(p.context) ? readdirSync(p.context).filter((n) => n.endsWith('.md')).length : 0
  return { swapped: hasChanges, pageCount, emitted }
}

export type ProbeResult = {
  ok: boolean
  latencyMs: number
  /** Populated when ok=false. Short human-readable cause. */
  error?: string
}

/**
 * Pre-flight probe for the Anthropic API. Spawns a tiny `claude -p`
 * call with Haiku and a hard timeout — if it doesn't return within
 * `timeoutMs`, the network stack is the suspected culprit (e.g. the
 * laptop just woke from deep sleep and DNS / TCP keepalive state is
 * stale). Failures here let the caller skip a doomed multi-minute
 * Sonnet spawn and either retry or defer.
 *
 * The probe deliberately uses Haiku regardless of the real run's
 * model: the failure mode this guards against is network-stack
 * level (a hung TCP socket post-wake), not model-specific.
 *
 * The prompt is the canonical "What is the capital of France?" —
 * it's a content-free check; we only care that *some* response
 * arrives within the window.
 */
export async function probeAnthropicAPI(opts?: { binary?: string; timeoutMs?: number }): Promise<ProbeResult> {
  const timeoutMs = opts?.timeoutMs ?? 10_000
  const binary = opts?.binary ?? 'claude'
  const start = Date.now()

  let timedOut = false
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([binary, '-p', 'What is the capital of France?', '--model', 'haiku', '--output-format', 'json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: `spawn failed: ${err}` }
  }

  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, timeoutMs)

  const exitCode = await proc.exited
  clearTimeout(timer)
  const latencyMs = Date.now() - start

  if (timedOut) return { ok: false, latencyMs, error: `probe timed out after ${timeoutMs}ms` }
  if (exitCode !== 0) return { ok: false, latencyMs, error: `probe exit code ${exitCode}` }
  return { ok: true, latencyMs }
}
