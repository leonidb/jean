# Jean — Research Findings

Context gathered during concept development (Mar 26-28, 2026).

## Claude Code Channels

### What they are
Channels push events into a running Claude Code session from external sources. A channel is an MCP server that declares `experimental: { 'claude/channel': {} }` capability. Claude Code spawns it as a subprocess over stdio.

### Validated findings (Mar 27, v2.1.85)
- **Inbound works**: External process → channel plugin → Claude session. Message appears as `<channel source="name" ...>content</channel>` tag.
- **Outbound works**: Claude calls a `reply` tool exposed by the channel plugin → plugin forwards to external process.
- **Wakes idle sessions**: Messages arrive even when Claude is at the `>` prompt. No active turn required.
- **Reply is unprompted**: The `reply` tool can be called by Claude at any time, not just in response to a channel message.
- **`--channels` flag required**: No settings file equivalent. Must be passed at CLI launch. Hidden from `--help` (research preview).
- **Custom channels**: Use `--dangerously-load-development-channels server:<name>` during research preview.
- **(v2.1.160, 2026-06-02) Channels resolve only from auto-discovered MCP config**: `--dangerously-load-development-channels server:<name>` resolves the server from `~/.claude.json` (user scope) or a project `.mcp.json` in the launch cwd — **NOT** from a server injected via `--mcp-config`. Jean registers its channel once per machine in user scope (`jean setup` → `claude mcp add jean --scope user`) and the server self-identifies per session from the worktree's `.jean-agent.json`. (Earlier builds resolved `--mcp-config`-injected servers; the change silently broke every fresh agent start until the user-scope registration was adopted.)
- **Auth**: Works on claude.ai Max plan. API key auth untested.

### How to test
```bash
# Install fakechat (reference channel plugin)
claude plugin install fakechat@claude-plugins-official

# Install dependencies
cd ~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat
bun install

# Start Claude with channel
claude --channels plugin:fakechat@claude-plugins-official

# Open http://localhost:8787 in browser, send a message
```

### Reference implementation
Fakechat source: `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat/server.ts`

Key patterns from fakechat:
```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// 1. Create server with channel capability
const mcp = new Server(
  { name: 'fakechat', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: `Instructions injected into Claude's system prompt...`,
  },
)

// 2. Register tools (e.g., reply)
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'reply', description: '...', inputSchema: {...} }],
}))
mcp.setRequestHandler(CallToolRequestSchema, async req => {
  // Handle tool calls from Claude
})

// 3. Connect via stdio
await mcp.connect(new StdioServerTransport())

// 4. Push notifications to Claude
function deliver(content: string, meta: Record<string, string>) {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: { content, meta },
  })
}

// 5. HTTP server for external communication
Bun.serve({
  port: 8787,
  hostname: '127.0.0.1',
  // WebSocket + HTTP endpoints that call deliver()
})
```

### MCP configuration
Claude needs the channel registered as an MCP server in **auto-discovered** config (see the v2.1.160 note above — `--mcp-config` no longer works for channel resolution). Jean does this once per machine in user scope via `jean setup`:
```bash
claude mcp add jean --scope user -- bun /path/to/jean/src/channel/server.ts
```
which writes to `~/.claude.json`:
```json
{
  "mcpServers": {
    "jean": { "command": "bun", "args": ["/path/to/jean/src/channel/server.ts"] }
  }
}
```
No per-worktree `.mcp.json` and no per-agent env: the server self-identifies from the launch cwd's `.jean-agent.json` and finds the dojo by walking up to `.jean/jean.config.json`.

## Claude Code Stop Hook

The `Stop` hook fires when Claude finishes responding and returns to the `>` prompt. This is how Jean detects that an agent went idle.

Configuration in `.claude/settings.local.json`:
```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "curl -s http://localhost:8700/agent-idle?name=scratch"
      }]
    }]
  }
}
```

**Not yet validated** — needs testing in Milestone 1.

## Claude Code Agent Teams (for reference)

How the built-in agent teams feature works internally:
- File-based JSON inbox at `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`
- Messages are JSON objects with `from`, `text`, `summary`, `timestamp` fields
- Agents poll their inbox file. New messages are injected as synthetic conversation turns.
- `flock()` for concurrent access prevention
- No daemon or message broker — filesystem is the coordination substrate

Jean takes a different approach (channels instead of file polling) but this is useful reference.

## Existing Tools Comparison

| Tool | Architecture | How Jean differs |
|------|-------------|------------------|
| **Overstory** | tmux + SQLite mail + git worktrees | Jean uses channels (no tmux dependency for communication). Playbook-driven. |
| **claude-code-dispatch** | Fire-and-forget `claude -p` + lifecycle hooks | Jean agents are interactive and persistent, not headless. |
| **Agent Farm** | 20+ parallel agents with tmux monitoring | Jean is playbook-typed with gates. Thoughtful side-tasks, not mass parallelism. |
| **Block's agent-task-queue** | MCP-based FIFO + SQLite | Jean is a full lifecycle (capture → work → gate → approve). |
| **dmux** | tmux pane manager + `send-keys` | Jean uses channels — no tmux dependency for message delivery. |

## Claude Code CLI Flags (relevant)

| Flag | Purpose | Verified |
|------|---------|----------|
| `--channels` | Enable channel plugins (hidden from --help) | Yes |
| `--dangerously-load-development-channels` | Custom channel plugins | Yes |
| `--append-system-prompt` | Inject system prompt | Yes (in --help) |
| `--model` | Select model (sonnet, opus, haiku) | Yes |
| `--max-budget-usd` | Cost cap per session | Yes |
| `--name` / `--resume` | Session naming and resumption | Yes |
| `-p` / `--print` | Headless mode | Yes |
| `--output-format json` | Structured output | Yes |
| `--json-schema` | Validated JSON output | Yes |

**Does NOT exist**: `--max-turns` (hallucinated by research agents).
