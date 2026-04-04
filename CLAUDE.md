# Jean — Local Multi-Agent Orchestration Framework

## What This Is

Jean is a framework for multi-agent execution with Claude Code. Agents work in parallel across separate folders, communicate through Claude Code channels, and are orchestrated by a central intelligent agent (the sensei). All state is event-sourced. See `docs/concepts.md` for the full design.

## Stack

- **Runtime**: Bun (not Node.js)
- **Language**: TypeScript
- **Key dependencies**: `@modelcontextprotocol/sdk` (channel plugins), `@slack/bolt` (Slack bridge)

## Commands

```bash
bun run <file.ts>           # run a file
bun test                    # run tests
bun install                 # install dependencies
bun add <package>           # add dependency
```

## Conventions

- Use Bun APIs: `Bun.serve()` for HTTP/WebSocket, `Bun.file()` for file I/O
- No Express, no Node.js built-ins when Bun has an alternative
- Tests use `bun:test`

## Project Structure

```
src/
  channel/          ← Jean channel plugin (MCP server for Claude Code)
  infra/            ← Infrastructure layer (HTTP/WS server, event store, projections, Slack)
  es/               ← Event sourcing primitives (store, projections, backends)
  cli/              ← CLI commands (jean board, jean agent, jean send, jean status)
docs/
  design.md         ← Project overview and core ideas
  concepts.md       ← Full architecture, component design, communication patterns
  decisions.md      ← Alternatives considered and why they were rejected
  research.md       ← Validated findings (channels, hooks, CLI flags, reference code)
  roadmap.md        ← What's done, what's next
```

## Design Docs — Read Order

1. `docs/design.md` — start here for the big picture
2. `docs/concepts.md` — full architecture, component design, communication patterns
3. `docs/decisions.md` — why things are the way they are (alternatives rejected)
4. `docs/research.md` — validated technical findings, reference implementation code
5. `docs/roadmap.md` — what to build and in what order

## Running

```bash
# Start the infrastructure service
bun run src/infra/server.ts

# Start an agent (from its directory)
cd <agent-dir> && claude --dangerously-load-development-channels server:jean

# CLI commands
bun run src/cli/jean.ts board          # kanban view
bun run src/cli/jean.ts agent list     # list agents
bun run src/cli/jean.ts status         # infra status + recent events
bun run src/cli/jean.ts send <agent> "message"
```

### Key reference
The fakechat plugin at `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat/server.ts` is the reference implementation. Jean's channel plugin follows the same pattern but connects to the infrastructure service.
