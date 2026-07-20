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
 */

import { resolve } from 'node:path'
import type { AgentRole } from '../infra/protocol.ts'

export type Permissions = {
  allow: string[]
  deny: string[]
}

export function defaultPermissions(role: AgentRole, dojoRoot: string): Permissions {
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
      deny: [`Edit(${rawCtx}/**)`, `Write(${rawCtx}/**)`, `Edit(${librarianWs}/**)`, `Write(${librarianWs}/**)`],
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
  const ctx = resolve(dojoRoot, '.jean', 'context')
  const ws = resolve(dojoRoot, '.jean', 'workspace')
  return {
    // mcp__jean__* covers all current + future Jean MCP tools (send, reply,
    // infra, memorize, recent_memories, ack, …). The channel plugin gates
    // tool exposure per role at the server level (sensei sees `send`,
    // workers see `reply`, etc.) and gates infra method per role at the
    // dispatch level — so the wildcard here is safe: it only grants what
    // the server already exposes to this role's session.
    allow:
      role === 'sensei'
        ? ['mcp__jean__*', 'Read', 'Glob', 'Grep', 'Bash(git:*)', `Edit(${ws}/**)`, `Write(${ws}/**)`]
        : ['mcp__jean__*', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(git:*)'],
    deny:
      role === 'sensei'
        ? [`Edit(${ctx}/**)`, `Write(${ctx}/**)`]
        : [`Edit(${ctx}/**)`, `Write(${ctx}/**)`, `Edit(${ws}/**)`, `Write(${ws}/**)`],
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
 */
export function mergePermissions(
  existing: Partial<Permissions> | undefined,
  defaults: Permissions,
): { merged: Permissions; addedAllow: string[]; addedDeny: string[] } {
  const existingAllow = existing?.allow ?? []
  const existingDeny = existing?.deny ?? []

  const addedAllow = defaults.allow.filter((rule) => !existingAllow.includes(rule))
  const addedDeny = defaults.deny.filter((rule) => !existingDeny.includes(rule))

  return {
    merged: {
      allow: [...existingAllow, ...addedAllow],
      deny: [...existingDeny, ...addedDeny],
    },
    addedAllow,
    addedDeny,
  }
}
