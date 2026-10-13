import { resolve } from 'node:path'

/** Inherited from a background session's shell, these would mark the agent's
 *  foreground session as a background one. */
const BACKGROUND_MARKER = /^(CLAUDE_JOB_DIR|CLAUDE_BG_.*|CLAUDE_CODE_SESSION_KIND|CLAUDE_CODE_SESSION_ID)$/

/** The env `jean agent start` runs `claude` under. Agent view off: Claude Code
 *  then refuses to background the session or start its daemon from it. */
export function agentLaunchEnv(
  base: Record<string, string | undefined>,
  agent: { name: string; role: string; dojoRoot: string; agentDir: string },
): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(Object.entries(base).filter(([key]) => !BACKGROUND_MARKER.test(key))),
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
    JEAN_AGENT: agent.name,
    JEAN_ROLE: agent.role,
    JEAN_DOJO: agent.dojoRoot,
    JEAN_AGENT_DIR: resolve(agent.agentDir, '.jean'),
  }
}
