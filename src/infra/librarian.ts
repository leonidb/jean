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

import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { createStore, jsonlBackend } from '../es/index.ts'
import type { AgentRole } from './protocol.ts'
import { TRIGGERS_STREAM, type TriggerCreatedData, type WikiConsolidatedData } from './reducers.ts'

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
 * Recover the wiki layout from a possible mid-run crash before letting the
 * librarian LLM run. Deterministic, no LLM involvement.
 *
 * Git era (context/ is a git repo): a crash during the copy-sync leaves
 * context/ dirty with staging/ still present → reset context/ to its last
 * commit (the last consistent wiki) and drop staging so the next run rebuilds.
 *
 * Legacy (pre-git, rename-swap era) crash states, still handled for dojos that
 * crashed before migrating:
 *   - context/ missing, staging/ present   → mv staging → context (new version won)
 *   - context/ missing, old-<ts>/ present  → mv old-<ts> → context (rollback)
 *   - context/ present AND old-<ts>/       → rm -rf old-<ts>/ (swap done; cleanup raced)
 *
 * After this returns, `.jean/context/` is guaranteed to exist (or the dojo is in
 * a state we can't auto-recover from, in which case we throw). Steady state
 * (context/ present, no staging, no old-*) is a no-op.
 */
export function recoverWikiLayout(dojoRoot: string): {
  recovered: 'staging' | 'old' | 'cleanup' | 'reset' | 'none'
} {
  const { consolidator, context, staging } = consolidatorPaths(dojoRoot)

  const oldDirs = existsSync(consolidator)
    ? readdirSync(consolidator)
        .filter((n) => n.startsWith('old-'))
        .map((n) => resolve(consolidator, n))
        .sort()
    : []

  // Legacy: context/ was renamed away mid-swap (only possible on a pre-git dojo).
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

  // context/ exists. Sweep any legacy old-<ts>/ left by the rename era.
  let sweptOld = false
  if (oldDirs.length > 0) {
    for (const o of oldDirs) rmSync(o, { recursive: true, force: true })
    sweptOld = true
  }

  // Git era: only act when staging/ is present (a crashed/incomplete run). A
  // clean git repo with no staging is steady state — don't touch it, and don't
  // reset a human's manual wiki edit (the next commit will just include it).
  if (isGitRepo(context) && existsSync(staging)) {
    const hasHead = git(context, ['rev-parse', '--verify', '-q', 'HEAD']).exitCode === 0
    const dirty = hasHead && git(context, ['status', '--porcelain']).stdout.trim().length > 0
    if (dirty) {
      // Revert TRACKED files to the last commit (undoes a torn/partial sync).
      // Deliberately NOT `git clean -fd`: that would also destroy UNTRACKED
      // content — a human's manually-added page, or a new page from the crashed
      // run not yet committed. Untracked leftovers are harmless here; the next
      // run's sync mirrors away anything not part of the rebuilt wiki.
      git(context, ['checkout', '--', '.'])
      rmSync(staging, { recursive: true, force: true })
      return { recovered: 'reset' }
    }
    // Clean tree + staging present → the commit landed before staging was
    // removed (or draft/review crashed after building it). Just drop staging.
    rmSync(staging, { recursive: true, force: true })
    return { recovered: 'cleanup' }
  }

  // Non-git context/ with a straggler staging/ (pre-migration, or mid-draft crash).
  if (existsSync(staging)) {
    rmSync(staging, { recursive: true, force: true })
    return { recovered: 'cleanup' }
  }

  return { recovered: sweptOld ? 'cleanup' : 'none' }
}

/**
 * Build the argv for a headless Claude invocation. Pure — no spawn side effect.
 *
 * Layout that this assumes the caller will set up:
 *   <dojoRoot>/.jean/                          — dojo data
 *   <dojoRoot>/.jean/roles/<role>/             — working directory
 *   <dojoRoot>/.jean/roles/<role>/.claude/     — settings.local.json + skills/
 *
 * Headless runs are MCP-free BY DESIGN — for every role, not just the librarian.
 * They use native Read/Edit/Write + Bash(curl) and talk to the dojo over HTTP,
 * never via channel/MCP tools. We force `--strict-mcp-config` (with no
 * `--mcp-config`) so NO MCP server loads; otherwise the globally-registered jean
 * channel server (in ~/.claude.json, from `jean setup`) would load on every
 * `claude` invocation and register this run into the dojo as an anonymous
 * "unnamed" worker, producing hourly register/disconnect nudge noise. A headless
 * trigger that needs dojo state reads/writes it with curl, not MCP tools.
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
    // Headless = no MCP, by design, for ALL roles (not librarian-specific).
    // --strict-mcp-config with no --mcp-config loads zero servers, so the global
    // jean channel never loads and this run never registers as an "unnamed"
    // worker (see the header comment above).
    '--strict-mcp-config',
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

type AnomalyEntry =
  | string
  | { type?: string; severity?: string; page?: string; text?: string; issue?: string; [k: string]: unknown }

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

/** Coerce a structured anomaly into the `string` shape WikiConsolidatedData expects.
 *  Plan + review skills produce two shapes in the wild:
 *    {type, text}                 — early shape
 *    {page, issue, severity, …}   — current review-skill shape
 *  Plus bare strings. We accept all three and fall back to JSON only when no
 *  human-readable field is present. */
function flattenAnomaly(a: AnomalyEntry): string {
  if (typeof a === 'string') return a
  const text = (typeof a.text === 'string' && a.text) || (typeof a.issue === 'string' && a.issue) || JSON.stringify(a)
  const label = (typeof a.severity === 'string' && a.severity) || (typeof a.type === 'string' && a.type) || ''
  const pageRef = typeof a.page === 'string' && a.page ? `[${a.page}]` : ''
  const prefix = [label && `${label}:`, pageRef].filter(Boolean).join(' ')
  return prefix ? `${prefix} ${text}` : text
}

// ── Git-backed context/ ─────────────────────────────────────────────
// context/ is its own git repo (like .jean/workspace/) so every consolidation
// is a commit: durable history, `git revert`-able rollback, and a diff that
// shows exactly which pages changed. The librarian does its slow work in
// staging/, then a fast copy-sync into context/ + a commit — readers see a
// consistent wiki (the copy window is sub-second vs. the minutes of LLM work)
// and a crash is recovered by resetting context/ to its last commit. `.git`
// lives inside context/ and never moves, so it survives the sync (which is why
// we copy-in-place rather than rename-swap). The dojo's own .gitignore excludes
// all of .jean/, so this nested repo is invisible to the dojo repo.

/** Run a git subcommand inside `dir`. Never throws — caller inspects exitCode.
 *  Bun.spawnSync THROWS when the binary is missing (rather than returning a
 *  nonzero exit), so we catch that and surface it as exitCode -1 to honor the
 *  contract; a git-less machine then fails loudly at ensureContextGitRepo with
 *  a clear message instead of an opaque uncaught throw. */
function git(dir: string, args: string[]): { exitCode: number; stdout: string; stderr: string } {
  try {
    const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' })
    return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }
  } catch (err) {
    return { exitCode: -1, stdout: '', stderr: String(err) }
  }
}

/** True if `dir` is the root of a git repo (has a `.git`). */
function isGitRepo(dir: string): boolean {
  return existsSync(resolve(dir, '.git'))
}

/**
 * Ensure context/ is a git repo. On a pre-git dojo this inits it and makes a
 * baseline commit of the current wiki (so the pre-migration state is commit #1),
 * which auto-migrates every existing dojo on its first git-backed consolidation.
 * No-op once the repo exists.
 */
function ensureContextGitRepo(context: string): void {
  if (isGitRepo(context)) return
  mkdirSync(context, { recursive: true })
  const init = git(context, ['init', '-q'])
  if (init.exitCode !== 0) {
    throw new Error(
      `git init failed in ${context} (is git installed and on PATH?): exit ${init.exitCode} ${init.stderr.trim()}`,
    )
  }
  // Fresh repos default to whatever init.defaultBranch is set to; pin main.
  // Tolerated if it fails (ancient git) — recovery is branch-agnostic (rev-parse
  // HEAD / checkout -- .), so an unusual default branch is harmless.
  git(context, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  // Baseline commit captures any pre-existing wiki. Force it even for an EMPTY
  // context/ (allowEmpty) so there is ALWAYS a HEAD to reset to — otherwise a
  // crash during the very first sync (no HEAD yet) leaves recovery unable to
  // restore a consistent state.
  gitCommitContext(context, 'wiki: initial commit (git-backed context)', { allowEmpty: true })
}

/**
 * Mirror staging/ into context/ in place, preserving `.git`. Copy first so a
 * reader mid-sync never sees a valid page momentarily missing (it sees the new
 * content, plus at worst a just-removed page lingering a few ms); then drop the
 * pages the new version removed.
 */
function syncStagingIntoContext(staging: string, context: string): void {
  // Copy staging → context (recursive adds/updates). Skip a stray `staging/.git`
  // so a bad copy (e.g. a skill that `cp -r`'d context including its repo) can
  // never clobber the real `.git` we're about to commit into.
  for (const e of readdirSync(staging)) {
    if (e === '.git') continue
    cpSync(resolve(staging, e), resolve(context, e), { recursive: true, force: true })
  }
  // Remove context entries the new version dropped — recursively, so a removed
  // NESTED page is deleted too (the wiki is flat today, but don't rely on it).
  mirrorDelete(staging, context, '')
}

/** Recursively delete context entries with no counterpart in staging. Preserves
 *  the top-level `.git`. */
function mirrorDelete(staging: string, context: string, rel: string): void {
  const dir = rel ? resolve(context, rel) : context
  for (const e of readdirSync(dir)) {
    if (rel === '' && e === '.git') continue
    const childRel = rel ? `${rel}/${e}` : e
    if (!existsSync(resolve(staging, childRel))) {
      rmSync(resolve(context, childRel), { recursive: true, force: true })
    } else if (statSync(resolve(context, childRel)).isDirectory()) {
      mirrorDelete(staging, context, childRel)
    }
  }
}

/**
 * Stage everything and commit — but only if the tree actually changed (git
 * compares blob content, so pages copied back byte-identical produce no diff
 * and no commit). Returns whether a commit was made. Identity is passed per
 * invocation so we never mutate the machine's git config.
 */
function gitCommitContext(context: string, message: string, opts?: { allowEmpty?: boolean }): boolean {
  git(context, ['add', '-A'])
  // `diff --cached --quiet` exits 0 when nothing is staged, 1 when there is.
  // Skip the no-diff short-circuit when allowEmpty (baseline commit must land).
  if (!opts?.allowEmpty && git(context, ['diff', '--cached', '--quiet']).exitCode === 0) return false
  const r = git(context, [
    '-c',
    'user.name=jean-librarian',
    '-c',
    'user.email=librarian@jean.local',
    'commit',
    '-q',
    ...(opts?.allowEmpty ? ['--allow-empty'] : []),
    '-m',
    message,
  ])
  if (r.exitCode !== 0) throw new Error(`git commit failed in ${context}: ${r.stderr.trim()}`)
  return true
}

/** Build the commit message from the run's plan — the consolidation "log" now
 *  lives in git history (`git log -p` = summary + the diff, together). The
 *  subject carries the event-id watermark (prev → new cursor) so it's clear at
 *  a glance which events each consolidation ran over. */
function buildCommitMessage(planObj: ConsolidatorPlan, anomalies: string[], prevCursor: number): string {
  const decisions = Array.isArray(planObj.decisions) ? planObj.decisions : []
  const byOp = (op: string) => decisions.filter((d) => d.op === op)
  const created = byOp('create')
  const updated = byOp('update')
  const archived = byOp('archive')
  const stats = planObj.stats ?? {}
  const ev = stats.eventsProcessed ?? 0
  const newCursor = typeof planObj.newCursor === 'number' ? planObj.newCursor : prevCursor

  const counts = [
    created.length && `${created.length} created`,
    updated.length && `${updated.length} updated`,
    archived.length && `${archived.length} archived`,
  ].filter(Boolean)
  const subject = `consolidate ${prevCursor}→${newCursor}: ${counts.length ? counts.join(', ') : 'no page changes'}`

  const body: string[] = [`events processed: ${ev} (cursor ${prevCursor} → ${newCursor})`]
  if (stats.corrections) body.push(`corrections: ${stats.corrections}`)
  if (stats.tasksDistilled) body.push(`tasks distilled: ${stats.tasksDistilled}`)
  if (stats.rawFilesProcessed) body.push(`raw files: ${stats.rawFilesProcessed}`)
  const pageLine = (label: string, ds: typeof decisions) =>
    ds.length ? `${label}: ${ds.map((d) => d.page).join(', ')}` : undefined
  for (const line of [pageLine('created', created), pageLine('updated', updated), pageLine('archived', archived)]) {
    if (line) body.push(line)
  }
  if (anomalies.length) {
    body.push('', 'anomalies:')
    for (const a of anomalies) body.push(`- ${a}`)
  }
  return `${subject}\n\n${body.join('\n')}\n`
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

  // Event-id watermark BEFORE this run — read the old cursor before we overwrite
  // it, so the commit subject can show prev → new (which events this run covered).
  const prevCursor = existsSync(p.cursorPath)
    ? ((JSON.parse(await Bun.file(p.cursorPath).text()) as { lastEventId?: number }).lastEventId ?? 0)
    : 0

  // Apply changes into the git-backed context/, then commit. A crash mid-sync
  // is recovered by recoverWikiLayout (reset context/ to its last commit) on
  // the next start; the cursor stays put so the run redoes cleanly.
  if (hasChanges) {
    if (!existsSync(p.staging)) {
      throw new Error(`commitConsolidation: plan has changes but staging/ missing at ${p.staging}`)
    }
    ensureContextGitRepo(p.context) // migrates a pre-git dojo on its first run
    // Preserve-over-reset (a sensei's catch): if context/ is dirty going in
    // — a human hand-edited a page, or a prior run left uncommitted state —
    // commit it FIRST as its own "manual edits" commit, so the consolidation's
    // overwrite never destroys content that isn't in git history. No-op (no
    // commit) when context/ is clean, which is the steady-state case.
    gitCommitContext(p.context, 'wiki: capture pre-consolidation edits')
    syncStagingIntoContext(p.staging, p.context)
    // Commit BEFORE removing staging: if the commit throws, staging survives so
    // recovery resets context/ to HEAD and the next run redoes the work cleanly.
    gitCommitContext(p.context, buildCommitMessage(planObj, anomalies, prevCursor))
    rmSync(p.staging, { recursive: true, force: true })
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
    // THE ADMISSION FLAG (task 119): the summary is MAIL to the
    // orchestrator, whose skill surfaces `anomalies` to the human. Without
    // this, the record resolves to nobody — the first scheduled night
    // delivered three anomalies to no mailbox. The old fold ignores the
    // extra field; the new resolution requires it.
    queued: true,
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

// ── Librarian provisioning (init-time) ──────────────────────────────
// The librarian is provisioned ONCE, at `jean dojo init`: the role dir (skills
// + permissions, written CLI-side) plus the consolidate-wiki trigger written
// here. There is deliberately NO reconcile-on-restart. A restart brings the
// process back up; it does not re-derive configuration. The event log is the
// single source of truth for triggers — re-emitting them every boot would both
// fight a deliberate `jean trigger remove` (you turn it off, the next start
// turns it back on) and spam the log with a no-op create on every boot. New
// dojos get the librarian at init; existing dojos already have it.

/** Trigger id the multi-phase consolidation pipeline dispatches on — server.ts
 *  keys the draft→review→commit pipeline on role==='librarian' && this id. A
 *  librarian trigger under any other id runs as a plain single-shot headless. */
export const CONSOLIDATE_WIKI_TRIGGER_ID = 'consolidate-wiki'

/** Default nightly schedule — 03:00 local. */
export const LIBRARIAN_DEFAULT_CRON = '0 3 * * *'

/** Consolidation is structured editing, not open-ended reasoning — sonnet is
 *  plenty and a fraction of the cost of an unpinned (Opus-default) run. */
export const LIBRARIAN_DEFAULT_MODEL = 'sonnet'

/** The trigger prompt. The real procedure lives in the consolidate-wiki skill;
 *  this only points the headless run at it. Kept identical to the working
 *  dojos' stored prompt so a freshly-provisioned dojo behaves the same. */
// NOTE: for the `consolidate-wiki` trigger this stored prompt is OVERRIDDEN at
// runtime — runLibrarianMultiPhase substitutes the draft/review phase prompts.
// It's kept accurate (not "swap / advance cursor", which the pipeline forbids)
// so `jean trigger list` and any direct read isn't misleading.
export const CONSOLIDATE_WIKI_PROMPT =
  'Run the scheduled wiki-consolidation pipeline (draft → review). The trigger harness commits the ' +
  'result into the git-backed .jean/context/ and advances the cursor — you build staging, not the wiki.'

/**
 * Write the `consolidate-wiki` trigger into a dojo's event log — idempotently.
 *
 * Called at `jean dojo init`, where the server is down and the log is
 * brand-new, so a direct append is race-free. Folds the trigger reducer over
 * existing TRIGGERS_STREAM events: a dojo that already has a live
 * consolidate-wiki trigger is left untouched (`created: false`), and a
 * create-then-remove history stays removed (we never resurrect a trigger the
 * user deleted).
 *
 * MUST NOT run against a dojo whose infra is live — the server owns the append
 * cursor in memory and a concurrent direct append would collide ids. Init is
 * safe by construction (the dojo does not exist yet).
 */
export async function provisionLibrarianTrigger(opts: {
  historyPath: string
  cron?: string
  model?: string
}): Promise<{ created: boolean }> {
  const store = createStore(jsonlBackend(opts.historyPath))
  const events = await store.read({ stream: TRIGGERS_STREAM })
  // Skip if a consolidate-wiki trigger was EVER created — not just if one is
  // currently live. A create-then-remove history means the user deliberately
  // deleted it; re-provisioning must not resurrect it. (Empty log at init →
  // always creates.)
  const everCreated = events.some(
    (e) => e.type === 'trigger-created' && (e.data as { id?: string }).id === CONSOLIDATE_WIKI_TRIGGER_ID,
  )
  if (everCreated) return { created: false }
  await store.append({
    stream: TRIGGERS_STREAM,
    type: 'trigger-created',
    data: {
      id: CONSOLIDATE_WIKI_TRIGGER_ID,
      cron: opts.cron ?? LIBRARIAN_DEFAULT_CRON,
      agent: 'librarian',
      prompt: CONSOLIDATE_WIKI_PROMPT,
      kind: 'headless',
      model: opts.model ?? LIBRARIAN_DEFAULT_MODEL,
      actor: 'init',
    } satisfies TriggerCreatedData,
  })
  return { created: true }
}
