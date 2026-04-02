# Jean — Concepts & Design Notes

Working document. Last updated: 2026-03-28.

---

## What Jean Is

A framework for multi-agent execution where autonomous coding agents work in parallel, communicate through channels, and are orchestrated by a central intelligent agent. Agents can be idle waiting for work, actively executing tasks, or paused waiting for human input. All task state is traceable.

---

## Architecture

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Agent A  │     │ Agent B  │     │ Agent C  │
│ (scratch)│     │ (review) │     │(research)│
│          │     │          │     │          │
│ Jean     │     │ Jean     │     │ Jean     │
│ plugin   │     │ plugin   │     │ plugin   │
└────┬─────┘     └────┬─────┘     └────┬─────┘
     │                │                │
  channel          channel          channel
     │                │                │
     └────────────────┼────────────────┘
                      │
              ┌───────▼────────┐
              │  Orchestrator  │
              │  (Claude)      │
              │                │
              │  - pushes tasks│
              │  - checks on   │
              │    idle agents │
              │  - manages     │
              │    board/state │
              │  - applies     │
              │    playbooks   │
              │  - talks to    │
              │    human       │
              └───────┬────────┘
                      │
              ┌───────▼────────┐
              │ Infrastructure │
              │ (Bun/TS)       │
              │                │
              │ - channel svr  │
              │ - board persist│
              │ - stop hook rx │
              │ - agent start  │
              │   (auto mode)  │
              └────────────────┘
```

### Components

**Agents** — Claude sessions, each in its own folder/worktree, each with a role.
- Receive work via channels (pushed by orchestrator)
- Work until they finish or get stuck, then stop
- Don't know about each other — only the orchestrator talks to them
- Human can connect and interact directly at any time
- Each has a **Jean plugin** installed: channel + skills + stop hook

**Orchestrator** — an always-running Claude session that manages the flow.
- Pushes tasks to agents via channels
- Gets notified when agents go idle (via stop hook → infrastructure)
- Checks on idle agents ("what's your status?") and interprets the response
- Updates the board, notifies human when needed
- Applies playbook logic (which steps to follow, when to gate for human input)
- Human can talk to it directly (`jean peek orchestrator`)
- Stateless per-event: reads the board on every signal. Survives context compaction.

**Infrastructure layer** — deterministic Bun/TypeScript process.
- Channel server: manages channel connections between orchestrator and agents
- Board persistence: reads/writes JSON task state
- Stop hook receiver: agents' stop hooks signal here, forwarded to orchestrator
- Agent lifecycle: starts/stops agent sessions in auto mode (later)
- No LLM — fast, reliable plumbing

**Jean plugin** — installed per agent via `jean init agent`. Three things:
- **Channel**: receives tasks and questions pushed by orchestrator
- **Skills**: role-specific capabilities, extracted from the playbook
- **Stop hook**: notifies infrastructure when agent goes idle (back at `>` prompt)

The agent is just Claude with skills. It doesn't have special outbound tools or communication protocols. When the orchestrator pings ("what happened?"), the agent replies naturally.

---

## Abstractions

### Task
A unit of work. Has a title, description, optional context, optional playbook type.
States: `inbox → active → blocked | review → done | cancelled`.
Can be freeform (no playbook) or structured (follows a playbook).

### Playbook
Single markdown file (YAML frontmatter + body). The source of truth for a flow. Contains:
- **Frontmatter**: queue, model, budget, gates
- **`## Skill` section**: extracted and installed as the agent's SKILL.md by `jean init`
- **`## Flow` section**: steps the orchestrator follows
- **`## Message Template`**: what the orchestrator sends the agent

Examples: `bug-repro`, `code-review`, `investigation`, `write-tests`.

Tasks without a playbook are freeform — the orchestrator routes them and the agent works based on the message content alone.

### Queue
Groups tasks by folder/worktree. One queue = one folder = one active agent.
Multiple queues run in parallel. Designed for future concurrency (N agents per queue).

### Board
JSON file. Single source of truth for task state. The orchestrator is the single writer (via infrastructure layer). `jean board` reads it for display.

---

## Communication

### Orchestrator → Agent
Channel push notification. Task descriptions, follow-up questions ("what's your status?"). Agent receives immediately, even when idle at `>` prompt. Validated Mar 27.

### Agent → Orchestrator
Passive. Agent works until it stops. Stop hook notifies infrastructure → infrastructure signals orchestrator → orchestrator pings agent via channel → agent replies naturally. The orchestrator is always the active party.

### Human → Agent
Connect directly (`jean peek`) and interact. It's just a Claude session.

### Human → Orchestrator
CLI commands (`jean board`, `jean kick`, `jean ship`) or direct interaction (`jean peek orchestrator`).

---

## Setup & Lifecycle

### Project init (once)
```
jean init ~/projects/myapp
```
Creates the project folder with `config.yaml`, `board.json`, `playbooks/`.

### Agent init (once per folder)
```
jean init agent scratch ~/work/app-scratch --playbook bug-repro
```
- Extracts `## Skill` from the playbook, installs as `.claude/skills/jean-bug-repro/SKILL.md`
- Registers the Jean channel plugin config
- Configures the stop hook

### Starting an agent
User starts Claude in the folder with the `--channels` flag pointing to the Jean channel plugin. Skills and stop hook load automatically from the folder's `.claude/` config.

### Two modes
**Manual** (v1): User starts the agent, controls the window. Orchestrator communicates via channel.

**Auto** (later): Orchestrator starts agents when work arrives. User can `jean peek` to connect.

### Task flow
```
Human kicks task (or orchestrator creates one)
  → Task added to board (inbox)
  → Orchestrator picks agent based on queue/playbook
  → Orchestrator pushes task to agent via channel
  → Board updated (active)
  → Agent works using its skills
  → Agent finishes or gets stuck → goes idle
  → Stop hook fires → infrastructure notifies orchestrator
  → Orchestrator pings agent: "what's your status?"
  → Agent replies (done / stuck / needs input)
  → Orchestrator updates board, follows playbook logic
  → If gate: notify human, wait for approval
  → If more inbox tasks: push next task to agent
```

---

## Project Structure

```
~/projects/myapp/                 ← project root (explicit folder)
  config.yaml                     ← agent registry, queue mapping
  board.json                      ← task state
  playbooks/
    bug-repro.md                  ← playbook (flow + skill, one file)
    code-review.md
    investigation.md
```

Agent folders are registered paths, not subfolders. A project can span multiple repos.

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
| Orchestrator → agent | Channel push (tasks, status checks) |
| Agent → orchestrator | Passive: stop hook signals idle, orchestrator pings, agent replies |
| Orchestrator | Always-running Claude session. Stateless per-event (reads board). |
| Infrastructure | Bun/TypeScript. Channel server, board persistence, stop hook receiver. |
| Agent plugin | Channel + skills (from playbook) + stop hook. No outbound tools. |
| Agent start | User runs Claude with `--channels` flag. Skills/hook load from `.claude/`. |
| Playbook format | Single markdown: YAML frontmatter + `## Skill` + `## Flow` + `## Message Template`. Skill extracted on init. |
| Board storage | JSON file, single writer (orchestrator). |
| Project root | Explicit folder, user creates it. |
| UI | Building blocks: `jean peek`, `jean board`. Optional `jean ui` preset. |
| Agent lifecycle | Manual first (user starts). Auto later (orchestrator starts). |
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
