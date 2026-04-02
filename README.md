# Jean

Yet Another Lightweight Loom for Agents.

A framework for multi-agent execution where autonomous coding agents work in parallel, communicate through channels, and are orchestrated by a central intelligent agent. You describe a task — a bug to reproduce, a PR to review, code to investigate — and an orchestrator routes it to the right agent. Agents work in separate folders, each with role-specific skills. When an agent finishes or gets stuck, the orchestrator checks in, updates the board, and notifies you. The layer between "I noticed something" and "it's handled" — without breaking your flow.

**Status:** Early development

## How It Works

```
┌──────────┐     ┌──────────┐
│ Agent A  │     │ Agent B  │     (Claude sessions with Jean plugin)
│ (scratch)│     │ (review) │
└────┬─────┘     └────┬─────┘
     │                │
  channel          channel       (Claude Code channels)
     │                │
     └────────┬───────┘
              │
      ┌───────▼────────┐
      │  Orchestrator  │         (Claude session — the intelligence layer)
      └───────┬────────┘
              │
      ┌───────▼────────┐
      │ Infrastructure │         (Bun/TypeScript — deterministic plumbing)
      └────────────────┘
```

- **Agents** are just Claude with role-specific skills. They receive tasks via channels, work, and stop when done.
- **Orchestrator** is a Claude session that routes work, checks on agents, manages the board, and talks to you.
- **Infrastructure** handles channel wiring, board persistence, and agent lifecycle.

## Quick Start

### Prerequisites
- [Bun](https://bun.sh) (v1.3+)
- Claude Code with channels support

### Install
```bash
cd jean && bun install
```

### Run the infrastructure service
```bash
JEAN_BOARD=/path/to/your/dojo/.jean/board.json bun run src/infra/server.ts
```

### Connect an agent
In the agent's worktree, create `.mcp.json`:
```json
{
  "mcpServers": {
    "jean": {
      "command": "bun",
      "args": ["run", "--cwd", "/path/to/jean/src/channel", "--shell=bun", "--silent", "start"],
      "env": {
        "JEAN_AGENT": "scratch",
        "JEAN_INFRA_URL": "ws://127.0.0.1:8700/ws"
      }
    }
  }
}
```

Then start Claude with the channel:
```bash
cd /path/to/worktree && claude --dangerously-load-development-channels server:jean
```

### Send a message to an agent
```bash
curl -X POST http://127.0.0.1:8700/send \
  -H 'content-type: application/json' \
  -d '{"to":"scratch","from":"you","text":"investigate this bug"}'
```

### CLI
```bash
bun run src/cli/jean.ts board     # show the kanban board
bun run src/cli/jean.ts status    # infrastructure status
bun run src/cli/jean.ts send scratch "message"  # send to agent
```

## Development

```bash
bun install               # install dependencies
bun test                  # run tests (24 tests)
bun run src/infra/server.ts   # start the infra service
bunx tsc --noEmit         # type check
```

## Design

See [docs/concepts.md](docs/concepts.md) for the full architecture and design decisions.
