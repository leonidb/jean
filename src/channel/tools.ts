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
    'Use this to report progress, ask questions, or share results. ' +
    'The reply is automatically attributed to the task of the most recent incoming message; ' +
    'pass `taskId` explicitly only when responding to an older or different task.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The message to send to the orchestrator' },
      taskId: {
        type: 'string',
        description:
          'Optional — overrides the auto-attached taskId when you are replying to a task other than the most recent one',
      },
    },
    required: ['text'],
  },
}

export const COMMENT_TOOL: Tool = {
  name: 'comment',
  description:
    'Record a substantive comment on a task. Distinct from `reply`: `reply` is conversation (messages, chatter, short acks); ' +
    '`comment` is a curated, deliberate note the sensei or human will want to read when scanning the task. ' +
    'Use `comment` when: you found something worth recording, a blocker is resolved, a phase is complete, or the task state has meaningfully advanced. ' +
    'Use `reply` for everything else. Requires an explicit `taskId`.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'The task this comment is about' },
      text: { type: 'string', description: 'The comment text — substantive, self-contained' },
    },
    required: ['taskId', 'text'],
  },
}

export const SEND_TOOL: Tool = {
  name: 'send',
  description:
    'Send a message to another agent or channel in the Jean system. ' +
    'Use this for all agent-to-agent and agent-to-channel messaging, including replying to the human via the chat bridge (Telegram/Slack). ' +
    'To send files (screenshots, audio briefings, PDFs) to a chat surface, pass their absolute local paths in `attachments` — Telegram uploads them as photos/audio/documents by type; text-only surfaces ignore them. ' +
    'The `from` field is always set to your own agent name — you cannot spoof it.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Target agent or channel name' },
      text: { type: 'string', description: 'Message body' },
      taskId: { type: 'string', description: 'Optional task ID to scope the message to a task' },
      attachments: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional absolute local file paths to upload alongside the text (media surfaces only)',
      },
    },
    required: ['to', 'text'],
  },
}

export const MEMORIZE_TOOL: Tool = {
  name: 'memorize',
  description:
    'Record a durable cross-task observation in the dojo wiki pipeline. ' +
    'Use for findings, decisions, conventions, or learnings worth surfacing to future tasks ' +
    '(NOT in-task progress — that goes via `comment`). ' +
    'The librarian batches and distills these into `.jean/context/` on its consolidation cadence. ' +
    'See the `context` skill for the full mental model.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Observation, finding, or decision (full sentence)' },
      scope: {
        type: 'string',
        enum: ['dojo', 'user'],
        description: '`dojo` (default) for dojo-specific knowledge; `user` for cross-dojo identity facts',
      },
      taskId: {
        type: 'string',
        description: 'Optional — task this memory came up in, for librarian attribution',
      },
    },
    required: ['text'],
  },
}

export const ACK_TOOL: Tool = {
  name: 'ack',
  description:
    'Acknowledge events as processed, advancing the per-agent pending count. ' +
    'Pass `upToId` = the highest event id you have read and decided about — including events you decided to "hold" or take no action on. ' +
    'Without acking, the orchestrator keeps re-nudging with the same pendingCount, producing an infinite loop. ' +
    'Treat ack as a normal part of every turn that consumed events, not a rare operation.',
  inputSchema: {
    type: 'object',
    properties: {
      upToId: {
        type: 'number',
        description: 'Highest event id you have read and processed. All pending events with id ≤ upToId are acked.',
      },
    },
    required: ['upToId'],
  },
}

/** HTTP verbs per role. Sensei has full access; workers/users are read-only.
 *  Peers never run as local channels (they don't load this plugin); the entry
 *  exists only to keep the Record exhaustive and would act as read-only if
 *  somehow used. */
const METHODS_BY_ROLE: Record<AgentRole, string[]> = {
  sensei: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  worker: ['GET'],
  user: ['GET'],
  peer: ['GET'],
  // Librarian is a trusted infra role; if it ever loads the channel plugin
  // it gets full write access for emitting wiki-consolidated and similar
  // events. In practice it usually runs without the plugin (headless +
  // direct file I/O), so this is defensive only.
  librarian: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
}

/**
 * Max response body delivered to the agent. Measured in UTF-16 code units (JavaScript `string.length`);
 * for ASCII JSON — the common case here — this equals bytes. The marker and user-facing docs round to KB.
 */
export const INFRA_MAX_BODY_BYTES = 48 * 1024
export const INFRA_MAX_BODY_KB = INFRA_MAX_BODY_BYTES / 1024

const SENSEI_INFRA_DESCRIPTION =
  'Call the Jean infrastructure HTTP API. Use this for board, tasks, triggers, events, playbooks, permissions. ' +
  'Path must start with "/" (e.g. "/board", "/tasks", "/triggers"). ' +
  `Responses above ~${INFRA_MAX_BODY_KB}KB are truncated — always paginate large endpoints (e.g. "/history?last=20").`

const READONLY_INFRA_DESCRIPTION =
  'Read-only Jean infrastructure HTTP API (GET only). Use this to look up context for the work you are doing — ' +
  'task comments, the board, related tasks, connected agents. Most useful: ' +
  '`/tasks/<id>?include=comments` returns a task plus the curated comments; add `messages` for the full correspondence too. ' +
  'Use these when you need "what was discussed/decided about this task". ' +
  `Responses above ~${INFRA_MAX_BODY_KB}KB are truncated — paginate with \`?last=N\` on history endpoints. ` +
  "State changes are the sensei's job; if you need something written, ask via `reply`."

export function buildInfraTool(role: AgentRole): Tool {
  const methods = METHODS_BY_ROLE[role]
  const isSensei = role === 'sensei'
  return {
    name: 'infra',
    description: isSensei ? SENSEI_INFRA_DESCRIPTION : READONLY_INFRA_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: methods,
          description: isSensei ? 'HTTP method' : 'HTTP method (workers can only GET)',
        },
        path: {
          type: 'string',
          description: isSensei
            ? 'API path starting with "/" — e.g. "/board" or "/tasks/001/status"'
            : 'API path starting with "/" — e.g. "/tasks/001?include=comments" or "/board"',
        },
        ...(isSensei && {
          body: {
            type: 'object',
            description: 'Optional JSON body for POST/PATCH/PUT. Pass a structured object, not a string.',
          },
        }),
      },
      required: ['method', 'path'],
    },
  }
}

/** The MCP tool list exposed to Claude for a given role. */
export function buildTools(role: AgentRole): Tool[] {
  if (role === 'sensei') return [SEND_TOOL, COMMENT_TOOL, MEMORIZE_TOOL, ACK_TOOL, buildInfraTool(role)]
  return [REPLY_TOOL, COMMENT_TOOL, MEMORIZE_TOOL, buildInfraTool(role)]
}

/** Read a tool argument that should be a non-empty string. Non-string, empty, or whitespace-only values return undefined. */
export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const raw = args[key]
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed || undefined
}

/**
 * Format an infra HTTP response for the MCP tool result. On 2xx the raw body is returned as-is
 * (server already returns structured JSON; adding a "200 OK\n" prefix is pure noise). On 4xx/5xx
 * the status line is prepended since an empty or malformed body can still carry useful signal via status.
 * Long bodies are truncated with a pagination hint.
 */
export function formatInfraResponse(
  status: number,
  statusText: string,
  rawBody: string,
): { text: string; isError: boolean } {
  const body =
    rawBody.length <= INFRA_MAX_BODY_BYTES
      ? rawBody
      : `${rawBody.slice(0, INFRA_MAX_BODY_BYTES)}\n\n[truncated: ${rawBody.length - INFRA_MAX_BODY_BYTES} more chars — use pagination]`
  const isError = status >= 400
  return { text: isError ? `${status} ${statusText}\n${body}` : body, isError }
}

/** Resolve the taskId to attach to a reply tool call. Explicit arg wins; fall back to the most recent deliver's taskId. */
export function resolveReplyTaskId(
  args: Record<string, unknown>,
  lastDeliverTaskId: string | undefined,
): string | undefined {
  return optionalString(args, 'taskId') ?? lastDeliverTaskId
}

/** System prompt wired into the MCP server's `instructions` field. */
export function buildInstructions(role: AgentRole, agentName: string): string {
  if (role === 'sensei') {
    return [
      `You are the sensei (orchestrator) in the Jean system, agent "${agentName}".`,
      `When you receive any message from Jean, FIRST load BOTH the jean-sensei skill (orchestrator behavior) AND the context skill (wiki-awareness + memorize). Then follow jean-sensei's instructions.`,
      `Use the \`send\` tool to message any agent or channel (including the human via the Slack channel). Use the \`comment\` tool to record durable decisions/context on a task (visible to workers via ?include=comments). Use the \`infra\` tool for all other API calls (board, tasks, triggers, playbooks, events).`,
      `After reading the events that prompted a nudge — and deciding what (if anything) to do about each — call \`ack({upToId: <highest event id you processed>})\`. Ack also when you choose to "hold"; "hold and acked" is a normal verdict, "hold without ack" is the bug that produces nudge-loops.`,
    ].join('\n')
  }
  return [
    `You are connected to the Jean orchestration system as agent "${agentName}".`,
    `When you receive any message from Jean, FIRST load the jean-worker skill, then follow its instructions.`,
    `Messages from the orchestrator arrive as <channel source="jean" ...> tags.`,
    `Use the \`reply\` tool for conversation with the orchestrator (including short acks, questions, "still working"). Use the \`comment\` tool when you have something substantive worth recording on a task — findings, blocker resolved, phase done. Comments are curated; replies are chat.`,
    `Use the \`infra\` tool (read-only — GET only) to look up context: \`GET /tasks/<id>?include=comments,messages\` for both the curated comments and the full correspondence on a task you're working on, \`GET /board\` for related tasks, \`GET /agents\` to see who else is connected. State changes are the sensei's job — if you need something written, ask via \`reply\`.`,
    `ALWAYS end a turn with \`reply\` — your stdout is invisible to the sensei, and \`agent-idle\` does not wake it. If you finish, hit a blocker, or need to stop, call \`reply\` before stopping. Not doing so means the sensei never learns anything happened.`,
  ].join('\n')
}
