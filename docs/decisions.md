# Jean — Design Decisions & Alternatives

Record of design choices, with alternatives considered and reasons for rejection.

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

## 4. Task routing: Tags vs playbooks

**Chosen: Tags (agent capabilities) — playbooks deferred**

Original plan: Playbooks as single markdown files containing orchestrator flow + agent skill + message templates. `jean init agent` would extract the skill section and install it.

What happened: In practice, skills are installed manually per agent and work well standalone. The orchestrator (sensei) routes tasks by matching agent tags to task requirements. Communication is lightweight — sensei sends freeform task descriptions, not templated messages. The playbook parser was never built because the simpler tags + skills model proved sufficient.

Alternatives considered:
- **Playbook-based routing**: Task specifies a playbook, playbook maps to a queue/agent. Rejected because: adds indirection, sensei can make better routing decisions by looking at agent tags + availability directly.
- **Queue-based routing**: One queue = one agent. Rejected because: too rigid, doesn't handle agents with multiple capabilities.

Why tags won: Simple, declarative, flexible. Agent says "I can do code-review and investigation." Sensei matches tasks to capabilities. No parser, no extraction step, no template language.

**Update (Apr 7)**: Playbooks return, but for a different purpose. Tags still handle routing. Playbooks now define *flow logic* — how sensei manages the lifecycle of a review task vs dev task vs research task. Not "which agent handles this?" but "what does sensei do at each stage?" Lives in `.jean/playbooks/` as markdown files. See roadmap M4.

## 5. State storage: Event sourcing (JSONL)

**Chosen: Event sourcing with JSONL backend**

All state changes are events appended to `history.jsonl`. The board and pending-events views are projections — computed by replaying events through reducers. Snapshots are taken periodically for fast startup.

Alternatives considered:
- **Direct JSON file**: Read/modify/write a board.json file. Was the original plan. Rejected because: no history, no audit trail, concurrent writes risk corruption, no way to derive different views of state.
- **SQLite**: Better concurrency (WAL mode), query flexibility. Deferred because: JSONL is simpler to debug and the `StoreBackend` interface supports swapping later.

Why event sourcing won: History comes free (every event is logged). Board state is always reconstructable. Adding new projections (like pending events) is just a new reducer — no schema migration. SSE streaming is trivial since events are the native unit.

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

## 10. Agent discovery: Central registry vs filesystem scan

**Chosen: Filesystem scan (directory-based discovery)**

Alternatives considered:
- **Central registry file**: A JSON file listing all agents. Rejected because: drifts from reality (agent folder deleted but registry not updated), single point of failure, extra maintenance.
- **Git worktree list only**: Discover agents from `git worktree list`. Rejected because: not all agents are worktrees — sensei is a plain directory.

Why filesystem scan won: The `.jean-agent.json` file in each directory is both the identity and the discovery mechanism. Scanning subdirectories of the dojo root finds all agents, regardless of whether they're worktrees or plain dirs. Git worktree info is enrichment (adds branch info), not the primary discovery path.

## 11. Agent creation: Worktrees vs plain directories

**Chosen: Role-based defaults with overrides**

Workers default to git worktrees (they need isolated code copies). Non-workers (sensei, user) default to plain directories. Both can be overridden with `--worktree` / `--no-worktree`.

Why: Workers need to edit code without conflicting with each other. The orchestrator doesn't edit code — it manages state. Making the common case automatic while allowing overrides covers edge cases without forcing a one-size-fits-all approach.

## 12. External communication: Slack integration

**Chosen: Transport-agnostic agent registry with Slack as a `user` role agent**

The infrastructure maintains a transport-agnostic agent registry — each agent has a `deliver` function regardless of whether it's connected via WebSocket (Claude agents) or Slack (human). Slack messages arrive via `@slack/bolt` socket mode and are routed through the same event/delivery pipeline.

Why: Treating Slack as just another agent (with `user` role) means the sensei doesn't need special Slack-handling logic. It sends messages to "slack" the same way it sends to "scratch". The plumbing handles transport differences.

## 13. Project context: Dojo-level vs agent-level

**Chosen: Shared context at `.jean/context/`, sensei reads it**

Alternatives considered:
- **Per-agent context**: Each agent has its own knowledge files. Rejected because: duplication, drift, agents need project-wide context not agent-specific data.
- **Global skill with context**: A global Claude skill that loads in every session. Rejected because: confuses workers with irrelevant context (e.g. team management data in a code review agent).

Why dojo-level won: Project context belongs to the project, not to individual agents. The sensei reads context for routing and communication decisions. Workers get task descriptions that contain what they need — they don't need to browse the context themselves.

## 14. Agent workspaces: Persistent directories vs ephemeral

**Chosen (current): Persistent directories with git worktrees**

Each agent has a permanent directory (worktree for workers, plain dir for sensei). Skills, permissions, and the working directory persist across tasks.

**Alternative considered: Ephemeral workspaces with persistent roles**

Roles (skills + permissions + tags) defined in `.jean/roles/`, workspaces created per task (worktree on a task branch), destroyed when done. Agents have no cross-task state — all continuity lives in the event log, sensei, git, and `.jean/context/`.

Conceptually cleaner: an agent is really just a role stamped onto a temporary workspace. No stale files between tasks, no branch conflicts, natural scaling (spin up N agents for N tasks). Sensei stays persistent as the exception.

**Why not adopted yet**: Environment setup cost. Real projects have fragile setups (wrong Python version, missing deps, Poetry quirks). With persistent directories, you fix once. With ephemeral workspaces, you pay setup cost per task — a 5-minute dep install to answer a quick Slack question is unacceptable.

**Revisit when**: Fast, reliable workspace provisioning is solved — e.g. containerized environments, cached dependency layers, or project-specific setup scripts that work first try.
