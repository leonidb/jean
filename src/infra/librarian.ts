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

import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { AgentRole } from './protocol.ts'

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
   * Output format. Default `'json'` — Claude Code returns a single JSON
   * object with `session_id`, the final response, and usage stats. We parse
   * this and surface session_id + cost/tokens in SpawnHeadlessResult.parsed.
   * `'text'` keeps stdout as raw response text — useful when JSON parsing
   * would get in the way (rare).
   */
  outputFormat?: 'json' | 'text'
  /**
   * Override binary. Default `'claude'`. Tests use this to point at a stub
   * (e.g. `/bin/echo`) so they don't need a real Claude installation.
   */
  binary?: string
  /** Extra argv pushed after the prompt — escape hatch for special flags. */
  extraArgs?: string[]
  /** Hard timeout. Default 10 minutes. */
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
  const outputFormat = opts.outputFormat ?? 'json'
  return [
    opts.binary ?? 'claude',
    '-p',
    opts.prompt,
    '--add-dir',
    relJean,
    '--mcp-config',
    `${relJean}/.mcp.json`,
    ...(opts.model ? ['--model', opts.model] : []),
    ...(outputFormat === 'json' ? ['--output-format', 'json'] : []),
    ...(opts.extraArgs ?? []),
  ]
}

/**
 * Best-effort extraction of the fields we care about from Claude Code's
 * `--output-format json` payload. The exact key names have shifted between
 * versions (`session_id` vs `sessionId`, `total_cost_usd` vs `cost_usd`),
 * so we accept either shape and tolerate missing fields.
 */
export function parseHeadlessJson(stdout: string): HeadlessParsed | undefined {
  try {
    const obj = JSON.parse(stdout) as Record<string, unknown>
    const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
    const usage = (obj.usage ?? {}) as Record<string, unknown>
    return {
      sessionId: str(obj.session_id) ?? str(obj.sessionId),
      response: str(obj.result) ?? str(obj.response),
      costUsd: num(obj.total_cost_usd) ?? num(obj.cost_usd) ?? num(obj.costUsd),
      totalTokens:
        num(usage.total_tokens) ??
        num(usage.totalTokens) ??
        ((num(usage.input_tokens) ?? 0) + (num(usage.output_tokens) ?? 0) || undefined),
      model: str(obj.model),
    }
  } catch {
    return undefined
  }
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
  const timeoutMs = opts.timeoutMs ?? 600_000

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

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  clearTimeout(timer)

  const outputFormat = opts.outputFormat ?? 'json'
  const parsed = exitCode === 0 && outputFormat === 'json' ? parseHeadlessJson(stdout) : undefined

  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - start,
    timedOut,
    ...(parsed && { parsed }),
  }
}
