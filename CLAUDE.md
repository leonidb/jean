# Jean — Local Multi-Agent Orchestration Framework

## What This Is

Jean is a framework for multi-agent execution with Claude Code. Agents work in parallel across separate folders, communicate through Claude Code channels, and are orchestrated by a central intelligent agent (the sensei). All state is event-sourced. See `docs/concepts.md` for the full design.

The system is a **domain core** — pure modules that decide, holding no I/O — behind a thin **adapter** that runs the sockets, timers, files and processes. Every decision is a function of facts the adapter composes and hands in; every effect is data the adapter performs.

## Stack

- **Runtime**: Bun (not Node.js)
- **Language**: TypeScript
- **Key dependencies**: `@modelcontextprotocol/sdk` (channel plugins), `@slack/bolt` (Slack bridge)

## Commands

```bash
bun run <file.ts>           # run a file
bun install                 # install dependencies
bun add <package>           # add dependency

# The gate ladder. `bun test` runs everything; these are the rungs, and a
# change is not done until all of them are green.
bun test src/domain         # the core's conformance + composed scenarios
bun test src/adapter        # transport, wiring and executor laws
bun run test                # es, infra transports, channel, cli, scripts
bun run check               # tsc --noEmit && biome
```

## Conventions

- Use Bun APIs: `Bun.serve()` for HTTP/WebSocket, `Bun.file()` for file I/O
- No Express, no Node.js built-ins when Bun has an alternative
- Tests use `bun:test`
- **Decisions live in `src/domain`, I/O lives in `src/adapter`.** A domain
  module that reads a clock or a file has crossed the line; an adapter that
  decides who to nudge has crossed it the other way.
- **A contract and its implementation are written by different hands.** One
  states what the module must do and makes it executable as conformance; the
  other satisfies it. The separation is the point: the reader of a requirement
  and its satisfier catch different mistakes, and each has caught the other's
  repeatedly.
- **Adapter tests assert transport, wiring and executor laws — never a domain
  rule.** The rule belongs to the module that owns it, pinned once.

## Project Structure

```
src/
  domain/           ← The core: what the system DECIDES. No I/O anywhere.
    contracts/      ← Each module's obligations in prose + types, with a
                      conformance suite that holds what types cannot
    tasks/ mailbox/ notifier/ supervisor/ triggers/ playbooks/
    resolution/ knowledge/ agents/ routing/ headless/
    scenarios/      ← The composed domain, wired in-process: end-to-end
                      behaviour with no socket in sight
  adapter/          ← The shell: HTTP/WS, timers, processes, transports.
                      Composes facts for the domain, performs its effects
  infra/            ← The transports the adapter uses as they are:
                      bridge (Telegram/Slack), peers, librarian, config, registry
  es/               ← Event sourcing primitives (store, backends)
  channel/          ← Jean channel plugin (MCP server for Claude Code)
  cli/              ← CLI commands (jean infra, jean board, jean agent, ...)
docs/
  design.md         ← Project overview and core ideas
  concepts.md       ← Full architecture, component design, communication patterns
  guarantees.md     ← What the system promises: the protocol, stated as properties
  domain-design.md  ← How the core is cut, and why each seam falls where it does
  decisions.md      ← Alternatives considered and why they were rejected
  research.md       ← Validated findings (channels, CLI flags, reference code)
  roadmap.md        ← What's done, what's next
```

## Design Docs — Read Order

1. `docs/design.md` — start here for the big picture
2. `docs/concepts.md` — full architecture, component design, communication patterns
3. `docs/guarantees.md` — what the system promises, as properties you can test against
4. `docs/domain-design.md` — how the core is cut, and why each seam falls where it does
5. `docs/decisions.md` — why things are the way they are (alternatives rejected)
6. `docs/research.md` — validated technical findings, reference implementation code
7. `docs/roadmap.md` — what to build and in what order

**The contracts are the ground truth.** `src/domain/contracts/*.ts` carry each
module's obligations in prose beside its types, and the docs describe them
rather than replace them. When a doc and a contract disagree, the contract is
right and the doc is a bug.

## Running

```bash
# Install the jean CLI globally (run once from this repo)
bun link

# Start infrastructure (from dojo root or any subdirectory)
jean infra start                       # auto-selects port, writes .jean/infra.pid
jean infra stop                        # stops the server for this dojo
jean infra status                      # show running state
                                       # the server detaches; its output goes
                                       # to .jean/infra.log, which is where to
                                       # look when something went wrong earlier

# Start an agent
jean agent start <name>                # or manually:
cd <agent-dir> && claude --dangerously-load-development-channels server:jean

# CLI commands (run from anywhere in the dojo tree)
jean board                             # kanban view
jean agent list                        # list agents
jean status                            # infra status + recent events
jean send <agent> "message"            # send message to agent
jean task log <id>                     # task event history
jean playbook list                     # loaded playbooks
jean trigger list                      # scheduled triggers
jean peek <dojo-path>                  # read another dojo's state off disk
```

### Key reference
The fakechat plugin at `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat/server.ts` is the reference implementation. Jean's channel plugin follows the same pattern but connects to the infrastructure service.
