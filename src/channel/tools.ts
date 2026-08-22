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

/**
 * The read ladder as ONE operation (task 057; spec = task 056's design
 * comments). First instance of the noun-tool pattern: one tool per protocol
 * noun, operations as a parameter, a separate tool only where a contract is
 * load-bearing at the call site (`ack` stays separate — it is the write, and
 * its description IS the read-before-ack contract).
 *
 * TWO PROPERTIES ARE THE POINT, not incidental:
 * (1) DEFAULT view:'summary' — the canonical opening move (052) is the
 *     zero-argument call, mechanical rather than remembered.
 * (2) The description carries CONTRACTS ONLY — what, params, invariants.
 *     When/why sentences live in the skills; that boundary is the guard
 *     against tool-description bloat replacing skill bloat.
 *
 * Pure plugin-side mapping (resolveInboxCall below): view → existing
 * endpoint, selector → query param. Zero new server surface.
 */
export const INBOX_TOOL: Tool = {
  name: 'inbox',
  description:
    'Read your mailbox — the one queue behind every announcement, cheapest view first. ' +
    "'counts': numbers by priority — is anything worth stopping for. " +
    "'summary' (default): one line per event with ids — the recommended first read. " +
    "'grouped': {inbox, line} — the grouping a nudge shows: blocking per sender, queued by type. " +
    "'fetch': full payloads plus each event's ack code — the only view with codes; `ack` needs them. " +
    "With view:'fetch', narrow with ONE selector: `ids` (from any summary), `from` (a blocking group's sender key), or `type` (a queued byType key, verbatim). " +
    "Ids no longer in your mailbox come back in `missing` — acked-since-summary is normal; check, don't assume. " +
    'Fetching is not acking.',
  inputSchema: {
    type: 'object',
    properties: {
      view: {
        type: 'string',
        enum: ['counts', 'summary', 'grouped', 'fetch'],
        description: "Which view of the mailbox. Default: 'summary'.",
      },
      ids: {
        type: 'array',
        items: { type: 'number' },
        description: "view:'fetch' only — exactly these event ids.",
      },
      from: { type: 'string', description: "view:'fetch' only — one blocking group, by its sender key." },
      type: { type: 'string', description: "view:'fetch' only — one queued group, by its byType key." },
    },
    required: [],
  },
}

const INBOX_VIEWS = ['counts', 'summary', 'grouped', 'fetch'] as const
type InboxView = (typeof INBOX_VIEWS)[number]

const INBOX_PATHS: Record<InboxView, string> = {
  counts: '/events/counts',
  summary: '/events/summary',
  grouped: '/inbox',
  fetch: '/events',
}

/**
 * Map an `inbox` call to the HTTP path it wraps, or a teaching error.
 *
 * Pure so the mapping is testable without the MCP subprocess. Validation
 * mirrors the server's own 051 rules (one selector, loud on malformed) —
 * the flat JSON schema cannot express "selectors ride view:'fetch' only",
 * so that contract is enforced here with the remedy named, the same
 * enforcement class as one-selector-per-request on the server.
 */
export function resolveInboxCall(args: Record<string, unknown>): { path: string } | { error: string } {
  const view = args.view === undefined ? 'summary' : args.view
  if (typeof view !== 'string' || !(INBOX_VIEWS as readonly string[]).includes(view)) {
    return { error: `inbox: unknown view "${String(args.view)}" — pass one of counts, summary, grouped, fetch.` }
  }
  const present = (['ids', 'from', 'type'] as const).filter((k) => args[k] !== undefined)
  if (present.length > 0 && view !== 'fetch') {
    return {
      error: `inbox: \`${present.join('`/`')}\` narrows view:'fetch' only — pass view:'fetch', or drop the selector.`,
    }
  }
  if (present.length > 1) {
    return { error: 'inbox: one selector per call — ids, from, or type.' }
  }
  const [selector] = present
  if (selector === 'ids') {
    const ids = args.ids
    // Safe-integer bound mirrors the server's own (051): two distinct unsafe
    // ids collapse to one float, so refuse here with the teaching error
    // rather than relaying a server 400.
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((n) => Number.isSafeInteger(n) && (n as number) > 0)) {
      return { error: 'inbox: `ids` must be a non-empty array of event ids, e.g. {view: "fetch", ids: [41, 42]}.' }
    }
    return { path: `/events?ids=${ids.join(',')}` }
  }
  if (selector === 'from' || selector === 'type') {
    const value = optionalString(args, selector)
    if (!value) {
      return { error: `inbox: \`${selector}\` needs a non-empty key — the grouped view shows the keys.` }
    }
    return { path: `/events?${selector}=${encodeURIComponent(value)}` }
  }
  return { path: INBOX_PATHS[view as InboxView] }
}

export const ACK_TOOL: Tool = {
  name: 'ack',
  description:
    'Acknowledge events you have READ and decided about, clearing them from your pending queue. ' +
    'ONE form: `pairs`, a list of `{id, code}` — and the code comes only from `GET /events`. ' +
    'That is deliberate: you cannot ack an event you have not fetched, so "acked" always means "read". ' +
    'Ack the events you decided to HOLD as well as the ones you acted on — "hold and acked" is a normal verdict, ' +
    '"hold without ack" is the bug that produces re-notification loops. ' +
    'A wrong or stale code clears nothing and is not an error: the rest of the batch still applies.',
  inputSchema: {
    type: 'object',
    properties: {
      pairs: {
        type: 'array',
        description:
          'The events to ack. Each entry is {id, code} exactly as returned by GET /events — the code is per event, not per response.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'number', description: 'Event id.' },
            code: { type: 'string', description: "The ack code from that event's fetch response." },
          },
          required: ['id', 'code'],
        },
      },
    },
    required: ['pairs'],
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
  'Call the Jean infrastructure HTTP API — the escape hatch for everything without a dedicated tool: ' +
  'board, tasks, triggers, playbooks, permissions. The mailbox has its own tools (`inbox`, `ack`). ' +
  'Path must start with "/" (e.g. "/board", "/tasks", "/triggers"). ' +
  `Responses above ~${INFRA_MAX_BODY_KB}KB are truncated — always paginate large endpoints (e.g. "/history?last=20").`

const READONLY_INFRA_DESCRIPTION =
  'Read-only Jean infrastructure HTTP API (GET only) — the escape hatch for lookups without a dedicated tool. ' +
  'Use it for the context of the work you are doing: task comments, the board, related tasks, connected agents. Most useful: ' +
  '`/tasks/<id>?include=comments` returns a task plus the curated comments; add `messages` for the full correspondence too. ' +
  "For the board, filter with `/tasks?status=&queue=` — `/board` returns every task's full description and truncates. " +
  'Use these when you need "what was discussed/decided about this task". The mailbox has its own tools (`inbox`, `ack`). ' +
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
            : 'API path starting with "/" — e.g. "/tasks/001?include=comments" or "/tasks?status=assigned"',
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

/** The MCP tool list exposed to Claude for a given role. `inbox` precedes
 *  `ack` deliberately: the read comes before the write it enables. */
export function buildTools(role: AgentRole): Tool[] {
  if (role === 'sensei') return [SEND_TOOL, COMMENT_TOOL, MEMORIZE_TOOL, INBOX_TOOL, ACK_TOOL, buildInfraTool(role)]
  // Workers ack too (delivery unification, ruled 2026-08-11: the mailbox is
  // for every agent). A worker's mailbox queues its dispatches now, and its
  // events sit in NO other clearable mailbox (a sensei-authored send is
  // self-excluded from the sensei's own) — a worker without `ack` would be
  // nudged about its queue forever with no way to clear it. `inbox` is
  // role-uniform for the same reason: the mailbox is one mechanism (E6).
  return [REPLY_TOOL, COMMENT_TOOL, MEMORIZE_TOOL, INBOX_TOOL, ACK_TOOL, buildInfraTool(role)]
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

/**
 * Interpret POST /send's response for the `send` tool (task 057's codex pass).
 *
 * TWO SUCCESS SHAPES, not one: an adapter-delivered send (bridge, peer,
 * trigger surfaces) answers `{delivered: true}`; a dojo-agent send answers
 * `{queued: true}` — the mailbox is the delivery, and the recipient's
 * notifier announces it (offline recipients hear on reconnect). The plugin
 * read ONLY `delivered` from the day of the unification, so every queued
 * dispatch reported "NOT delivered — nothing was sent" while the message sat
 * safely in the mailbox: a false failure on the system's most common send,
 * latent because this dojo's live infra predates queued sends. Found by the
 * 057 adversarial pass.
 */
export function sendOutcome(body: { delivered?: boolean; queued?: boolean }): { ok: boolean; queued: boolean } {
  const queued = body.queued === true
  return { ok: queued || body.delivered === true, queued }
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
      `Use the \`send\` tool to message any agent or channel (including the human via the Slack channel). Use the \`comment\` tool to record durable decisions/context on a task (visible to workers via ?include=comments). Read your mailbox with the \`inbox\` tool; clear events with \`ack\`. Use the \`infra\` tool for the rest of the API (board, tasks, triggers, playbooks).`,
      `After reading the events that prompted a notification — and deciding what (if anything) to do about each — ack them; the codes come from \`inbox({view: 'fetch'})\`. Fetching is not acking, and nothing else clears an event — answering a human does not clear their message; ack it like everything else. The jean-sensei skill carries the triage flow.`,
    ].join('\n')
  }
  return [
    `You are connected to the Jean orchestration system as agent "${agentName}".`,
    `When you receive any message from Jean, FIRST load the jean-worker skill, then follow its instructions.`,
    `Messages to you land in YOUR MAILBOX on infra; what reaches your session is infra's announcement (a push or the inbox line on a response). When one arrives: read the mailbox with the \`inbox\` tool (\`view: 'fetch'\` returns full payloads with ack codes), act on what it says, then \`ack({pairs: [{id, code}, ...]})\` for what you handled or decided about. Reading is not acking — infra keeps re-announcing while anything sits unacked.`,
    `Use the \`reply\` tool for conversation with the orchestrator (including short acks, questions, "still working"). Use the \`comment\` tool when you have something substantive worth recording on a task — findings, blocker resolved, phase done. Comments are curated; replies are chat.`,
    `Use the \`infra\` tool (read-only — GET only) to look up context: \`GET /tasks/<id>?include=comments,messages\` for both the curated comments and the full correspondence on a task you're working on, \`GET /tasks?status=&queue=\` for related tasks, \`GET /agents\` to see who else is connected. Prefer that filtered read over \`GET /board\`, which returns every task's full description and truncates. State changes are the sensei's job — if you need something written, ask via \`reply\`.`,
    `ALWAYS end a turn with \`reply\` — your stdout is invisible to the sensei, and nothing else announces that your turn ended. If you finish, hit a blocker, or need to stop, call \`reply\` before stopping. Not doing so means the sensei never learns anything happened.`,
  ].join('\n')
}
