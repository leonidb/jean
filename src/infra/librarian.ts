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
   * Override binary. Default `'claude'`. Tests use this to point at a stub
   * (e.g. `/bin/echo`) so they don't need a real Claude installation.
   */
  binary?: string
  /** Extra argv pushed after the prompt — escape hatch for special flags. */
  extraArgs?: string[]
  /** Hard timeout. Default 10 minutes. */
  timeoutMs?: number
}

export type SpawnHeadlessResult = {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  /** True if the process was killed because it exceeded `timeoutMs`. */
  timedOut: boolean
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
  return [
    opts.binary ?? 'claude',
    '-p',
    opts.prompt,
    '--add-dir',
    relJean,
    '--mcp-config',
    `${relJean}/.mcp.json`,
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.extraArgs ?? []),
  ]
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

  return {
    exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - start,
    timedOut,
  }
}
