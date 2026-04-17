/**
 * Default Claude Code permission allowlists per agent role.
 *
 * Used by `jean agent add` to generate the agent's initial settings.local.json.
 * Sensei gets send+infra for messaging and state; workers/users get reply+read-only infra.
 * No Bash(curl:*) — agents should use the MCP tools, not raw curl.
 */

import type { AgentRole } from '../infra/protocol.ts'

export function defaultPermissions(role: AgentRole): string[] {
  if (role === 'sensei') {
    return ['mcp__jean__send', 'mcp__jean__infra', 'Read', 'Glob', 'Grep', 'Bash(git:*)']
  }
  // Non-sensei roles (worker, user) share a read-only allowlist.
  return ['mcp__jean__reply', 'mcp__jean__infra', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(git:*)']
}
