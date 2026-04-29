/**
 * Default Claude Code permissions per agent role.
 *
 * Used by `jean agent add` to generate the agent's initial settings.local.json.
 * Sensei gets send+infra for messaging and state; workers/users get reply+read-only infra.
 * No Bash(curl:*) — agents should use the MCP tools, not raw curl.
 *
 * Returns both `allow` and `deny`. The deny list is path-aware (needs the dojo
 * root) and is the load-bearing rule for the wiki's read-write asymmetry: no
 * non-librarian agent may Edit/Write inside `.jean/context/**`. Reads are open;
 * direct writes go through memorize, not the file system.
 */

import { resolve } from 'node:path'
import type { AgentRole } from '../infra/protocol.ts'

export type Permissions = {
  allow: string[]
  deny: string[]
}

export function defaultPermissions(role: AgentRole, dojoRoot?: string): Permissions {
  if (role === 'librarian') {
    // Librarian is the wiki's only writer and runs headless without MCP.
    // Reads history.jsonl + wiki pages directly via Read/Glob/Grep, builds
    // the staging dir via Edit/Write, swaps via Bash(mv/rm), and emits the
    // wiki-consolidated event via Bash(curl) against the local infra.
    // No deny on .jean/context/** — that would block the very thing this
    // role exists to do.
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
        'Bash(cat:*)',
        'Bash(jq:*)',
        'Bash(curl:*)',
        'Bash(date:*)',
      ],
      deny: [],
    }
  }

  const allow =
    role === 'sensei'
      ? ['mcp__jean__send', 'mcp__jean__infra', 'Read', 'Glob', 'Grep', 'Bash(git:*)']
      : ['mcp__jean__reply', 'mcp__jean__infra', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(git:*)']

  const deny: string[] = []
  if (dojoRoot) {
    // Wiki is library-managed: agents read freely, but only the librarian
    // (a headless Claude on the consolidate-wiki trigger) may write. Direct
    // edits would create state that can't be reproduced from the event log.
    // See docs/llm-wiki-design.md (Adaptation 5: read-write asymmetry).
    const ctx = resolve(dojoRoot, '.jean', 'context')
    deny.push(`Edit(${ctx}/**)`, `Write(${ctx}/**)`)
  }
  return { allow, deny }
}
