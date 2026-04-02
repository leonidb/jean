# Jean — Local Multi-Agent Orchestration Framework

## What This Is

Jean is a framework for multi-agent execution with Claude Code. Agents work in parallel across separate folders, communicate through Claude Code channels, and are orchestrated by a central intelligent agent (the orchestrator). See `docs/concepts.md` for the full design.

## Stack

- **Runtime**: Bun (not Node.js)
- **Language**: TypeScript
- **Key dependency**: `@modelcontextprotocol/sdk` (for channel plugins)

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
  infra/            ← Infrastructure layer (channel server, board, stop hook receiver)
  cli/              ← CLI commands (jean board, jean peek, jean init)
docs/
  concepts.md       ← Full architecture and design decisions
  decisions.md      ← Alternatives considered and why they were rejected
  research.md       ← Validated findings (channels, hooks, CLI flags, reference code)
  design.md         ← Project overview and core ideas
  roadmap.md        ← Development milestones
```

## Design Docs — Read Order

1. `docs/design.md` — start here for the big picture
2. `docs/concepts.md` — full architecture, component design, communication patterns
3. `docs/decisions.md` — why things are the way they are (alternatives rejected)
4. `docs/research.md` — validated technical findings, reference implementation code
5. `docs/roadmap.md` — what to build and in what order

## Development Guide

### Where to start
Milestone 1 in `docs/roadmap.md`: build the Jean channel plugin. Fork from fakechat's architecture. Reference code is in `docs/research.md`.

### Key reference
The fakechat plugin at `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat/server.ts` is the reference implementation to fork from. It's a working channel plugin with HTTP + WebSocket + MCP notification. Jean's plugin follows the same pattern but connects to the infrastructure service instead of a web UI.

### Testing channels
```bash
# Test with fakechat first to verify channels work
claude --channels plugin:fakechat@claude-plugins-official
# Open http://localhost:8787, send a message — it should appear in the Claude session

# Test custom channel plugin
claude --dangerously-load-development-channels server:jean
```
