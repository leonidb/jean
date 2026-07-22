/**
 * Default Claude Code permissions per agent role.
 *
 * Used by `jean agent add` to generate the agent's initial settings.local.json.
 * Sensei gets send+infra for messaging and state; workers/users get reply+read-only infra.
 * No Bash(curl:*) — agents should use the MCP tools, not raw curl.
 *
 * Returns both `allow` and `deny`. The deny list is path-aware (needs the dojo
 * root) and is the load-bearing rule for two read-write asymmetries: the wiki
 * (`.jean/context/**` — librarian writes, everyone else memorizes) and the
 * workspace (`.jean/workspace/**` — sensei writes, everyone else reads). Reads
 * are open everywhere.
 *
 * Write fence (the reason a worktree path is threaded in): agents run in the
 * DEFAULT permission mode, so an allow-listed tool auto-approves and anything
 * else falls through to a prompt — and a dojo agent has no human to answer the
 * prompt, so an un-allowed write is effectively blocked. A BARE `Edit`/`Write`
 * in the allow list therefore auto-approves writes ANYWHERE on disk (this is
 * how a worker once wrote cross-repo, unseen). So workers get their `Edit`/
 * `Write` SCOPED to their own worktree (`Edit(<wt>/**)`) — a hard fence. The
 * sensei stays fenced to its workspace but can be widened per-dojo via
 * `senseiWritePaths` (its outbound delivery escape hatch). The librarian keeps
 * bare Edit/Write (it stages the wiki across .jean/ and needs the breadth).
 */

import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import type { AgentRole } from '../infra/protocol.ts'

export type Permissions = {
  allow: string[]
  deny: string[]
}

/** Per-agent knobs the fence needs. `worktree` is the agent's own directory
 *  (a git worktree, or a plain dir for `--no-worktree` agents) — write access
 *  is scoped to it. `senseiWritePaths` widens the sensei's fence to extra
 *  directories (absolute, or `~/`-anchored, or dojo-relative). */
export type PermissionOpts = { worktree?: string; senseiWritePaths?: string[] }

/** Expand `~/` and resolve a configured write path to an absolute glob root.
 *  Absolute paths pass through; relative ones anchor to the dojo root. */
function resolveWritePath(p: string, dojoRoot: string): string {
  const expanded = p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p
  return resolve(dojoRoot, expanded)
}

/** Validate + resolve the sensei's configured outbound write dirs, guarding the
 *  footguns a hand-edited jean.config.json invites: a non-array (`.flatMap`
 *  would throw during a permission sync and leave stale grants unmigrated), an
 *  empty/whitespace entry (`""` → the dojo root → write to the WHOLE dojo), and
 *  any entry that resolves to the dojo root or an ANCESTOR of it (equally
 *  over-broad). Legitimate outbound targets — an iCloud folder, a specific
 *  subdir — pass through.
 *
 *  KNOWN LIMITATION: the ancestry check is LEXICAL — it does not canonicalize
 *  symlinks or case-folding. On a case-insensitive FS `/users/x` reads as
 *  unrelated to `/Users/x`, and a symlinked subdir can point back at the dojo.
 *  senseiWritePaths is trusted, user-authored config, so this guards typos, not
 *  a hostile sensei; use canonical absolute paths. (Full realpath resolution is
 *  backlogged with the git-wrapper hardening.) */
function sanitizeWritePaths(paths: unknown, dojoRoot: string): string[] {
  if (!Array.isArray(paths)) return []
  const out: string[] = []
  for (const p of paths) {
    if (typeof p !== 'string' || p.trim() === '') continue
    const root = resolveWritePath(p, dojoRoot)
    // rel === '' → root IS the dojo; a rel with no leading `..` and not
    // absolute → the dojo lives under root (root is an ancestor). Both grant
    // far more than an outbound delivery folder should.
    const rel = relative(root, dojoRoot)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) continue
    out.push(root)
  }
  return out
}

/** A Claude Code file-rule path for a FILESYSTEM-ABSOLUTE directory. CC anchors
 *  a single leading `/` at the *settings source*, NOT the filesystem root — so
 *  `Edit(/Users/…/.jean/**)` silently fails to match and the rule is inert. The
 *  filesystem root needs a DOUBLE leading slash. (CC permissions docs, the
 *  `//path` vs `/path` table.) resolve() returns a single-slash absolute path;
 *  this re-anchors it to `//`. */
function fsAbs(p: string): string {
  return `//${p.replace(/^\/+/, '')}`
}

/** A path-scoped file deny/allow. Only `Edit(path)` is matched by CC's file
 *  permission checks — and it gates the Edit, Write AND NotebookEdit tools. A
 *  `Write(path)` / `NotebookEdit(path)` rule is accepted-but-never-matched and
 *  warns at startup, so we emit ONLY the `Edit(...)` form. */
function fileRule(absPath: string, glob = '/**'): string {
  return `Edit(${fsAbs(absPath)}${glob})`
}

export function defaultPermissions(role: AgentRole, dojoRoot: string, opts: PermissionOpts = {}): Permissions {
  if (role === 'librarian') {
    // Librarian is the wiki's only writer and runs headless without MCP.
    // Reads history.jsonl + wiki pages + raw_context/ directly via
    // Read/Glob/Grep, builds the staging dir via Edit/Write, swaps via
    // Bash(mv/rm), and emits the wiki-consolidated event via Bash(curl).
    // No deny on .jean/context/** — that would block the very thing this
    // role exists to do. Deny on .jean/raw_context/** — those are
    // human-curated source material; librarian reads but never modifies
    // (Karpathy's immutability rule, Adaptation 9).
    const rawCtx = resolve(dojoRoot, '.jean', 'raw_context')
    const librarianWs = resolve(dojoRoot, '.jean', 'workspace')
    return {
      allow: [
        'Read',
        'Glob',
        'Grep',
        'Edit',
        'Write',
        'Bash(git:*)',
        'Bash(ln:*)',
        'Bash(mv:*)',
        'Bash(rm:*)',
        'Bash(cp:*)',
        'Bash(mkdir:*)',
        'Bash(cat:*)',
        'Bash(jq:*)',
        'Bash(curl:*)',
        'Bash(date:*)',
        'Bash(ls:*)',
        'Bash(find:*)',
      ],
      // raw_context/: human-curated source material, read-but-never-modify.
      // workspace/: the librarian ignores it entirely (not read as authority,
      // not rewritten) — the deny enforces the "ignores" half it could violate.
      // (Bare Edit/Write above are tool-level grants; these path denies win.)
      deny: [fileRule(rawCtx), fileRule(librarianWs)],
    }
  }

  // Wiki is library-managed: agents read freely, but only the librarian
  // (headless Claude on the consolidate-wiki trigger) may write. Direct
  // edits would create state that can't be reproduced from the event log.
  // See docs/llm-wiki-design.md (Adaptation 5: read-write asymmetry).
  // Workspace is sensei-managed: same asymmetry, different writer — the
  // sensei gets a scoped Edit/Write allow (it otherwise has none, so
  // workspace curation would prompt), everyone else gets a deny.
  // See the context skill ("Where data lives").
  const jeanDir = resolve(dojoRoot, '.jean')
  const ctx = resolve(jeanDir, 'context')
  const ws = resolve(jeanDir, 'workspace')

  // The write allow, scoped by the fence. Common infra (MCP + read + git) is
  // shared; the Edit/Write grant is where roles diverge.
  const base = ['mcp__jean__*', 'Read', 'Glob', 'Grep', 'Bash(git:*)']

  if (role === 'sensei') {
    // Sensei writes its workspace (its own git repo) plus any explicitly
    // configured outbound directories — its delivery escape hatch. It gets NO
    // bare Edit/Write: a stale sensei that still carries one is exactly the
    // "wrote to iCloud freely" footgun `senseiWritePaths` replaces.
    const extra = sanitizeWritePaths(opts.senseiWritePaths, dojoRoot).map((root) => fileRule(root))
    return {
      allow: [...base, fileRule(ws), ...extra],
      deny: [fileRule(ctx)],
    }
  }

  // Worker / user: hard-fenced to their own worktree. Two mechanisms, because
  // dojo agents run in auto-approve (`acceptEdits`) mode where the ALLOW list
  // is bypassed for edits — so the scoped allow below only bites in `default`
  // mode; under auto-approve the fence is the OTHER two facts:
  //   1. Removing the bare `Edit`/`Write` grant. Auto-approve only auto-accepts
  //      edits INSIDE the workspace (cwd + `--add-dir`); anything outside
  //      prompts (= blocked, no human). A bare grant, by contrast, matches an
  //      allow rule in EVERY mode and would auto-approve edits anywhere — the
  //      actual hole a worker used to write cross-repo. Gone now.
  //   2. Deny rules, which win in every mode. The worker's launch `--add-dir`s
  //      the dojo `.jean/` (to READ roles/skills), which under auto-approve
  //      also makes it auto-WRITABLE — so we deny the whole `.jean/**` below,
  //      not just context+workspace. Truly-outside paths (other repos, $HOME)
  //      need no deny: they're outside the workspace, so auto-approve prompts.
  // Without a worktree (test/degenerate callers only), fall back to bare
  // Edit/Write — the pre-fence behavior — rather than silently granting nothing.
  const wt = opts.worktree
  const writeAllow = wt ? [fileRule(wt)] : ['Edit', 'Write']
  return {
    // mcp__jean__* covers all current + future Jean MCP tools (send, reply,
    // infra, memorize, ack, …). The channel plugin gates tool exposure per
    // role at the server level (sensei sees `send`, workers see `reply`, etc.)
    // and gates infra method per role at the dispatch level — so the wildcard
    // here is safe: it only grants what the server already exposes to this
    // role's session.
    //
    // Bash(git:*) is a KNOWN residual write vector the Edit/Write fence does
    // NOT close: `git -C <other> …`, `git clone … <outside>`, hooks, or
    // `git config` can write outside the worktree. Glob-scoping git by target
    // would break legitimate in-worktree git; the real close is a git MCP
    // wrapper. Documented, not yet fenced.
    allow: ['mcp__jean__*', 'Read', 'Glob', 'Grep', ...writeAllow, 'Bash(git:*)'],
    deny: [
      // Deny ALL writes to the dojo `.jean/**` (wiki, workspace, event log,
      // config, sessions, roles). Under auto-approve this is load-bearing, not
      // redundant: the worker `--add-dir`s the dojo `.jean/` for READ access,
      // which also makes it auto-writable — so without this a worker could
      // clobber dojo state (history.jsonl, jean.config.json). Workers never
      // write `.jean/` directly; they memorize/comment via MCP. (Covers the
      // old context+workspace denies, which were subsets of this.)
      fileRule(jeanDir),
      // The worktree allow otherwise covers the worker's OWN authority files,
      // which live inside it — a self-escalation hole. Editing
      // .claude/settings.local.json would let it re-add a bare Edit/Write
      // (self-unfence); editing .jean/.jean-agent.json would let it change its
      // role to sensei (trusted at the next `jean agent start` → sensei MCP/
      // infra authority); writing .mcp.json would let it define its own
      // `server:jean` (Claude Code resolves that from a project .mcp.json in
      // the launch cwd, and `jean agent start` doesn't pass
      // --strict-mcp-config) → code execution / spoofed channel on next start.
      // Deny beats the worktree allow, closing all three.
      ...(wt ? [fileRule(wt, '/.claude/**'), fileRule(wt, '/.jean/**'), fileRule(wt, '/.mcp.json')] : []),
    ],
  }
}

/**
 * Union-merge framework defaults into an existing permissions object.
 *
 * Why union, not replace: existing settings.local.json files may carry
 * project-specific allows the user added (e.g. `Bash(npm:*)` for a JS
 * dojo). A reset-style sync would silently drop those. Framework deny
 * rules are the load-bearing piece — they MUST be present — so we add
 * what's missing without removing user customizations.
 *
 * Two exceptions to "never remove":
 *  - `obsoleteAllow`: rules a new default supersedes that would DEFEAT it if
 *    left in place. The write fence needs this — a scoped `Edit(<wt>/**)` is
 *    worthless while a bare `Edit` still auto-approves everything — so sync
 *    passes `['Edit','Write']` for fenced roles. Matched exactly (bare `Edit`),
 *    so scoped `Edit(<path>/**)` rules are never touched.
 *  - Dead `Write(path)` rules: current Claude Code matches file writes via
 *    `Edit(path)` ONLY; a `Write(path)` rule is accepted-but-never-matched and
 *    warns at startup. Older Jean versions emitted them, so we strip every
 *    `Write(...)` (path-form) rule from both lists — inert, so removing changes
 *    no behavior, but it clears the warnings and half the legacy cruft. (Bare
 *    `Write`, a tool-level grant, is NOT a path-form and is left alone.)
 */
const isDeadWriteRule = (rule: string) => rule.startsWith('Write(')

export function mergePermissions(
  existing: Partial<Permissions> | undefined,
  defaults: Permissions,
  opts: { obsoleteAllow?: string[] } = {},
): { merged: Permissions; addedAllow: string[]; addedDeny: string[]; removedAllow: string[]; removedDeny: string[] } {
  const existingAllow = existing?.allow ?? []
  const existingDeny = existing?.deny ?? []
  const obsolete = new Set(opts.obsoleteAllow ?? [])
  const dropAllow = (rule: string) => obsolete.has(rule) || isDeadWriteRule(rule)

  const removedAllow = existingAllow.filter(dropAllow)
  const keptAllow = existingAllow.filter((rule) => !dropAllow(rule))
  const removedDeny = existingDeny.filter(isDeadWriteRule)
  const keptDeny = existingDeny.filter((rule) => !isDeadWriteRule(rule))
  const addedAllow = defaults.allow.filter((rule) => !keptAllow.includes(rule))
  const addedDeny = defaults.deny.filter((rule) => !keptDeny.includes(rule))

  return {
    merged: {
      allow: [...keptAllow, ...addedAllow],
      deny: [...keptDeny, ...addedDeny],
    },
    addedAllow,
    addedDeny,
    removedAllow,
    removedDeny,
  }
}
