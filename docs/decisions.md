# Jean — Design Decisions & Alternatives

Record of design choices made during concept development, with alternatives considered and reasons for rejection.

## 1. Communication: Channels vs alternatives

**Chosen: Claude Code channels**

Alternatives considered:
- **File-based inbox (agent teams pattern)**: Proven, no dependencies. Rejected because: requires agent to poll (agent becomes Jean-aware), it's the old pattern being superseded by channels.
- **tmux send-keys**: Types text into the agent's terminal. Rejected because: requires tmux as hard dependency, fragile, not a proper communication protocol.
- **MCP tools**: Agent calls an MCP tool to check for work. Rejected because: agent must actively call it (not push-based), agent becomes Jean-aware.
- **stdin streaming** (`--input-format stream-json`): Rejected because: headless mode only, can't inject into interactive sessions.

Why channels won: Push-based, agent stays vanilla Claude, bi-directional, wakes idle sessions, officially supported path.

## 2. Orchestrator: Claude session vs dumb service

**Chosen: Claude session (intelligent orchestrator)**

Alternatives considered:
- **Dumb service (deterministic, no LLM)**: Routes messages by rules, manages state. Was the original design. Rejected because: interpreting agent responses ("am I done or stuck?") requires intelligence. Deciding what to do next requires judgment.
- **No orchestrator (direct dispatch)**: User sends tasks directly to agents. Rejected because: no central state management, no flow coordination, no intelligent routing.

Why Claude session won: Needs to interpret agent state, apply playbook logic, make decisions, talk to human. These are LLM tasks. The deterministic parts (channel wiring, board persistence) live in the infrastructure layer underneath.

## 3. Agent communication: Active vs passive

**Chosen: Passive (agent just works and stops)**

Alternatives considered:
- **Active reporting**: Agent has a `send` tool and proactively reports progress, completion, blocks. Was the original design. Rejected because: too flexible (confusing for the agent), requires nudges/instructions, over-engineered for v1.
- **Structured outbound**: Agent calls typed tools (`report_progress`, `request_transfer`). Rejected because: same over-engineering, agent needs to know when to call what.

Why passive won: Simplest model. Agent works with its skills, stops when done/stuck. Stop hook detects idle. Orchestrator pings to check. Agent replies naturally. No special protocols.

## 4. Playbook & skills: Separate vs unified

**Chosen: Unified (playbook contains skill section)**

Alternatives considered:
- **Separate files**: Playbook for orchestrator, SKILL.md for agent, maintained independently. Rejected because: inevitable drift, two files to maintain for one flow.
- **Skills only (no playbook)**: Just install skills, no orchestrator flow definition. Rejected because: orchestrator needs to know the steps, gates, message templates.

Why unified won: Single source of truth. The `## Skill` section is extracted by `jean init` and installed as the agent's SKILL.md. One file defines the entire flow.

## 5. Board storage: JSON vs SQLite

**Chosen: JSON file**

Alternatives considered:
- **SQLite**: Better concurrency (WAL mode), query flexibility. Deferred because: orchestrator is single writer (no concurrency issue), JSON is human-readable and debuggable, simpler to start.

Decision: Start with JSON, move to SQLite if needed for history/queries.

## 6. Project root: Convention vs explicit

**Chosen: Explicit folder**

Alternatives considered:
- **`~/.jean/` global default**: Hidden directory, auto-discovered. Rejected for v1: too magical, harder to debug, conflicts with multi-project setups.
- **Inside a repo**: `.jean/` in the repo root. Rejected because: projects can span multiple repos.

Why explicit won: `jean init ~/projects/myapp` — user decides. No magic paths. Convention (`~/.jean/`) can be added later as sugar.

## 7. Agent lifecycle: Manual vs auto-start

**Chosen: Manual first, auto later**

Alternatives considered:
- **Auto-start from day one**: Orchestrator starts agents when tasks arrive. Deferred because: adds complexity (tmux management, process lifecycle), harder to debug, manual mode is simpler and proves the architecture first.

Plan: v1 is manual (user starts `claude --channels`). Auto mode (orchestrator manages agent lifecycle in tmux) is a later milestone.

## 8. UI: Fixed layout vs building blocks

**Chosen: Building blocks (user arranges)**

Alternatives considered:
- **Fixed tmux layout**: Panes for agent + board. Rejected because: too opinionated, doesn't work for everyone's monitor/window setup.
- **iTerm-specific**: Tab management via AppleScript. Rejected because: vendor lock-in, not everyone uses iTerm.

Why building blocks won: `jean peek`, `jean board` are independent commands. User arranges however they want. `jean ui` as optional preset for those who want the split-pane experience.

## 9. Name: Why "Jean"

Jean-Claude Van Damme reference. Commands like `kick` and `split` are his signature moves. The name is short, memorable, and fun without being forced. People who get the reference grin; the commands make sense even if you don't.

Full acronym: YALLA — Yet Another Lightweight Loom for Agents. "Yalla" means "let's go" in Arabic/Hebrew.
