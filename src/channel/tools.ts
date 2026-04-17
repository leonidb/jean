/**
 * Pure builders for the channel plugin's MCP tool list and system instructions.
 *
 * Extracted from server.ts so they can be unit-tested without spawning the MCP subprocess.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { AgentRole } from '../infra/protocol.ts'

export const REPLY_TOOL: Tool = {
  name: 'reply',
  description:
    'Send a message to the orchestrator through the Jean channel. ' +
    'Use this to report progress, ask questions, or share results.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The message to send to the orchestrator' },
    },
    required: ['text'],
  },
}

export const SEND_TOOL: Tool = {
  name: 'send',
  description:
    'Send a message to another agent or channel in the Jean system. ' +
    'Use this for all agent-to-agent and agent-to-channel messaging, including replying to the human via the Slack channel. ' +
    'The `from` field is always set to your own agent name — you cannot spoof it.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Target agent or channel name' },
      text: { type: 'string', description: 'Message body' },
      taskId: { type: 'string', description: 'Optional task ID to scope the message to a task' },
    },
    required: ['to', 'text'],
  },
}

export const INFRA_TOOL: Tool = {
  name: 'infra',
  description:
    'Call the Jean infrastructure HTTP API. Use this for board, tasks, triggers, events, playbooks, permissions. ' +
    'Path must start with "/" (e.g. "/board", "/tasks", "/triggers"). ' +
    'Responses above ~48KB are truncated — always paginate large endpoints (e.g. "/history?last=20").',
  inputSchema: {
    type: 'object',
    properties: {
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
        description: 'HTTP method',
      },
      path: {
        type: 'string',
        description: 'API path starting with "/" — e.g. "/board" or "/tasks/001/status"',
      },
      body: {
        description: 'Optional JSON body for POST/PATCH/PUT. Pass a structured object, not a string.',
      },
    },
    required: ['method', 'path'],
  },
}

/** The MCP tool list exposed to Claude for a given role. */
export function buildTools(role: AgentRole): Tool[] {
  if (role === 'sensei') return [SEND_TOOL, INFRA_TOOL]
  return [REPLY_TOOL]
}

/** System prompt wired into the MCP server's `instructions` field. */
export function buildInstructions(role: AgentRole, agentName: string): string {
  if (role === 'sensei') {
    return [
      `You are the sensei (orchestrator) in the Jean system, agent "${agentName}".`,
      `When you receive any message from Jean, FIRST load the jean-sensei skill, then follow its instructions.`,
      `Use the \`send\` tool to message any agent or channel (including the human via the Slack channel). Use the \`infra\` tool for all other API calls (board, tasks, triggers, playbooks, events).`,
    ].join('\n')
  }
  return [
    `You are connected to the Jean orchestration system as agent "${agentName}".`,
    `Messages from the orchestrator arrive as <channel source="jean" ...> tags.`,
    `Use the \`reply\` tool to send messages back to the orchestrator.`,
    `When you finish a task or get stuck, just stop — the orchestrator will check on you.`,
  ].join('\n')
}
