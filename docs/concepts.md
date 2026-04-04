# Jean — Concepts & Design Notes

Working document. Last updated: 2026-04-04.

---

## What Jean Is

A framework for multi-agent execution where autonomous coding agents work in parallel, communicate through channels, and are orchestrated by a central intelligent agent. Agents can be idle waiting for work, actively executing tasks, or paused waiting for human input. All task state is traceable.

---

## Architecture

```
┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
│ Agent A  │     │ Agent B  │     │ Agent C  │     │  Slack   │
│ (scratch)│     │ (review) │     │(research)│     │ (user)   │
│          │     │          │     │          │     │          │
│ Jean     │     │ Jean     │     │ Jean     │     │ Bolt SDK │
│ plugin   │     │ plugin   │     │ plugin   │     │          │
└────┬─────┘     └────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │                  │
  channel          channel          channel            channel
     │                │                │                  │
     └────────────────┼────────────────┼──────────────────┘
                      │
              ┌───────▼────────┐
              │  Sensei        │
              │  (Claude)      │
              │                │
              │  - routes tasks│
              │    by tags     │
              │  - checks on   │
              │    idle agents │
              │  - manages     │
              │    board/state │
              │  - reads .jean/     │
              │    context/        │
              │  - talks to    │
              │    human       │
              └───────┬────────┘
                      │
              ┌───────▼────────┐
              │ Infrastructure │
              │ (Bun/TS)       │
              │                │
              │ - channel svr  │
              │ - event store  │
              │   (JSONL)      │
              │ - projections  │
              │   (board,      │
              │    pending)    │
              │ - stop hook rx │
              │ - SSE stream   │
              │ - Slack bridge │
              └────────────────┘
```

### Components

**Agents** — Claude sessions, each in its own folder/worktree, each with a role.
- Receive work via channels (pushed by sensei)
- Work until they finish or get stuck, then stop
- Don't know about each other — only the sensei talks to them
- Human can connect and interact directly at any time
- Each has a **Jean plugin** installed: channel + skills + stop hook
- Declare capabilities via **tags** (e.g. `bug-repro`, `code-review`) — sensei routes by tags

**Sensei (orchestrator)** — an always-running Claude session that manages the flow.
- Pushes tasks to agents via channels, routing by agent tags
- Gets notified when agents go idle (via stop hook → infrastructure)
- Checks on idle agents ("what's your status?") and interprets the response
- Updates the board via infrastructure HTTP API
- Reads `.jean/context/` for project data — team roster, open threads, sprints
- Human can talk to it directly (`jean peek sensei`)
- Stateless per-event: reads the board on every signal. Catches up on history after restart via `GET /history`.

**Infrastructure layer** — deterministic Bun/TypeScript process.
- Channel server: WebSocket connections from channel plugins, transport-agnostic agent registry
- Event store: append-only JSONL log, all state changes are events
- Projections: board (task state) and pending (events for sensei to act on), derived from event stream
- Stop hook receiver: agents' stop hooks signal here, forwarded to sensei
- SSE endpoint: `GET /stream` for real-time event broadcast
- Slack bridge: optional, registers Slack channel as a `user` role agent
- No LLM — fast, reliable plumbing

**Jean plugin** — installed per agent via `jean agent add`. Three things:
- **Channel**: receives tasks and questions pushed by sensei
- **Skills**: role-specific capabilities, installed as SKILL.md files
- **Stop hook**: notifies infrastructure when agent goes idle (back at `>` prompt)

The agent is just Claude with skills. It doesn't have special outbound tools or communication protocols. When the sensei pings ("what happened?"), the agent replies naturally.

---

## Abstractions

### Task
A unit of work. Has a title, description, queue, optional agent assignment.
States: `inbox → active → blocked | review → done | cancelled`.
Task descriptions contain the work itself — not agent environment details. The sensei routes tasks by matching agent tags to task requirements.

### Event
All state changes are events, stored in an append-only JSONL log. Event types: `task-created`, `task-status`, `task-updated`, `reply`, `send`, `agent-idle`, `register`, `ack`, `nudge`, `start`. Each event has an ID, stream, type, timestamp, and data payload.

### Board
A projection derived from the event stream. Task state is computed by applying board-related events in order (task-created, task-status, task-updated). Snapshots are taken periodically for fast startup. The board is not a file you edit — it's computed state.

### Pending Events
A second projection tracking events the sensei needs to act on: replies from agents, new tasks, agent-idle signals. Events are removed from pending when acknowledged. This is how the sensei knows what needs attention.

### Queue
Groups tasks by folder/worktree. One queue = one folder = one active agent.
Multiple queues run in parallel.

### Context
Live project data at `.jean/context/` — team info, open threads, sprint data, scripts, research, design docs. The sensei reads this for decision-making. Separate from skills (skills = how agents work, context = what they should know about the project).

---

## Communication

### Sensei → Agent
Channel push notification. Task descriptions, follow-up questions ("what's your status?"). Agent receives immediately, even when idle at `>` prompt. Validated Mar 27.

### Agent → Sensei
Passive. Agent works until it stops. Stop hook notifies infrastructure → infrastructure creates `agent-idle` event → sensei gets nudged → sensei pings agent via channel → agent replies naturally. The sensei is always the active party.

### Human → Sensei
Slack messages (bridged as `user` role agent), CLI commands (`jean board`, `jean send`), or direct interaction (`jean peek sensei`).

### Human → Agent
Connect directly (`jean peek`) and interact. It's just a Claude session.

---

## Setup & Lifecycle

### Dojo structure

A **dojo** is the root folder for a Jean project. It contains:

```
work-dojo/                        ← dojo root
  .jean/                          ← dojo data
    board.json                    ← board snapshot (computed from events)
    board-snapshot.json           ← periodic projection snapshot
    history.jsonl                 ← append-only event log
    context/                      ← live project context
      team.yaml                   ← team structure
      open-threads.md             ← current work items
      scripts/                    ← automation scripts
      sprints/                    ← sprint data
      design/                     ← design docs
      research/                   ← research notes
      projects/                   ← project context
  .bare/                          ← bare git clone (optional, for worktree agents)
  scratch/                        ← worker agent (git worktree)
    .jean-agent.json              ← agent identity: name, role, tags
    .mcp.json                     ← channel plugin config
    .claude/settings.local.json   ← permissions, stop hook
  review/                         ← worker agent (git worktree)
    .jean-agent.json
    .mcp.json
    .claude/skills/review/        ← role-specific skill
    .claude/settings.local.json
  sensei/                         ← orchestrator (plain directory)
    .jean-agent.json
    .mcp.json
    .claude/skills/jean-sensei/   ← orchestrator skill
    .claude/skills/context/       ← project context gateway skill
    .claude/settings.local.json
```

The dojo is identified by `.jean/`. The `.bare/` directory is only needed for agents that use git worktrees.

### Agent identity

Each agent has a `.jean-agent.json` file in its root:

```json
{ "name": "scratch", "role": "worker", "tags": ["bug-repro", "investigation"] }
```

- **name**: agent identifier (matches folder name by convention)
- **role**: `worker`, `sensei`, or `user`
- **tags**: capabilities used by the orchestrator for routing tasks

Tags are sent to the infrastructure service when the agent connects. The orchestrator sees tags via `GET /agents` and routes tasks to agents with matching capabilities.

### Agent management

```bash
# Create a worker (gets a git worktree by default)
jean agent add review --tags code-review

# Create a non-worker (plain directory by default)
jean agent add sensei --role sensei

# Override defaults
jean agent add monitor --role worker --no-worktree
jean agent add sensei --role sensei --worktree

# Configure an existing folder as an agent
jean agent add --existing ./my-folder --role worker --tags investigation

# List all agents (discovered by scanning dojo directories)
jean agent list

# Manage tags
jean agent tag scratch testing --remove
jean agent tag scratch code-changes

# Remove an agent
jean agent remove review           # fails if dirty
jean agent remove review --force   # removes anyway
jean agent remove review --keep    # removes jean config, keeps directory
```

Discovery scans all subdirectories of the dojo root for `.jean-agent.json`. If `.bare/` exists, branch info from `git worktree list` is shown alongside agents that are worktrees.

### Starting an agent

```bash
cd scratch && claude --dangerously-load-development-channels server:jean
```

The channel plugin reads `.jean-agent.json` and registers with the infrastructure service, including tags. Skills and stop hook load from `.claude/`.

### Two modes

**Manual** (current): User starts the agent, controls the terminal. Orchestrator communicates via channel.

**Auto** (future): Orchestrator starts agents when work arrives. User can `jean peek` to connect.

### Task flow
```
Human kicks task (via Slack or board)
  → Task added to board (inbox)
  → Orchestrator picks agent based on tags
  → Orchestrator pushes task to agent via channel
  → Board updated (active)
  → Agent works using its skills
  → Agent finishes or gets stuck → goes idle
  → Stop hook fires → infrastructure notifies orchestrator
  → Orchestrator pings agent: "what's your status?"
  → Agent replies (done / stuck / needs input)
  → Orchestrator updates board
  → If more inbox tasks: push next task to agent
```

---

## User Experience

```
# Kick a task from any Claude session
/jean kick "Validator crashes on None in categories"

# Freeform task to a specific agent
/jean send scratch "investigate why caching is slow"

# See the board
$ jean board

# Connect to an agent
$ jean peek scratch

# Connect to the orchestrator
$ jean peek orchestrator

# Approve a completed task
/jean ship 003
```

---

## Decisions

| Decision | Answer |
|----------|--------|
| Communication | Channels (validated: wakes idle sessions, bi-directional) |
| Sensei → agent | Channel push (tasks, status checks) |
| Agent → sensei | Passive: stop hook signals idle, sensei pings, agent replies |
| Sensei | Always-running Claude session. Stateless per-event (reads board). Catches up via history. |
| Infrastructure | Bun/TypeScript. Event store, projections, channel server, stop hook receiver, SSE. |
| Agent plugin | Channel + skills + stop hook. No outbound tools except `reply`. |
| Agent identity | `.jean-agent.json` per agent: name, role, tags. Discovered by scanning dojo dirs. |
| Agent creation | `jean agent add` — workers get worktrees by default, non-workers get plain dirs. |
| Agent start | User runs Claude with `--channels` flag. Skills/hook load from `.claude/`. |
| Task routing | Sensei routes by agent tags, not by name or queue. |
| State storage | Event-sourced (JSONL). Board and pending are projections. Snapshots for fast startup. |
| External comms | Slack bridge: channel registered as `user` role agent. Optional. |
| Project context | `.jean/context/` — live project data. Sensei reads, separate from skills. |
| Dojo root | Identified by `.jean/` directory. `.bare/` optional (for worktree agents). |
| UI | Building blocks: `jean peek`, `jean board`. Optional `jean ui` preset. |
| Agent lifecycle | Manual first (user starts). Auto later (sensei starts). |
| Stack | Bun/TypeScript for infrastructure and channel plugins. |

---

## Validated (Mar 27)

### Channels
- Tested with `fakechat@claude-plugins-official` on Claude Code v2.1.85
- **Inbound**: push notification → Claude session. Wakes idle sessions (no active turn constraint).
- **Outbound**: Claude → `reply` tool → channel plugin. Works unprompted.
- Plugin architecture: Bun/TypeScript MCP server with `experimental: { 'claude/channel': {} }`
- Custom plugins: `--dangerously-load-development-channels` flag
- Bun v1.3.11 runtime required
- Auth: works on claude.ai Max. Other auth methods untested.

---

## References

- Fakechat source: `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat/server.ts`
- Claude Code channels docs: `code.claude.com/docs/en/channels`, `code.claude.com/docs/en/channels-reference`
- Claude Code agent teams: file-based JSON inbox at `~/.claude/teams/`, `flock()` for concurrency
- Feature request for message injection: `github.com/anthropics/claude-code/issues/24947`
- Stop hook: `code.claude.com/docs/en/hooks` — fires when Claude finishes responding
