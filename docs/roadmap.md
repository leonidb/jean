# Jean — Development Roadmap

## Milestone 1: Channel Communication (proof of concept)

**Goal**: Two Claude sessions communicate through a custom Jean channel plugin.

### Steps
1. **Build the Jean channel plugin** — fork fakechat's architecture
   - Bun/TypeScript MCP server with `claude/channel` capability
   - HTTP endpoint for receiving messages from external processes
   - WebSocket for real-time communication with infrastructure
   - `reply` tool for agent → infrastructure communication
   - Test: install as dev channel, start Claude with `--dangerously-load-development-channels`, send a message via `curl`, verify it arrives

2. **Build minimal infrastructure service** — Bun HTTP/WebSocket server
   - Accepts connections from channel plugins
   - Routes messages between connected sessions
   - Test: two Claude sessions connected, message from session A reaches session B

3. **Test the stop hook** — verify the mechanism
   - Configure a stop hook in a test worktree
   - Verify it fires when Claude goes idle
   - Verify it can notify the infrastructure service (HTTP POST)

### Deliverable
Two Claude sessions (one "orchestrator", one "agent") where:
- Orchestrator sends a task via channel → agent receives it
- Agent works, finishes, goes idle → stop hook fires → orchestrator gets notified
- Orchestrator pings agent → agent replies with status

---

## Milestone 2: Board & Task State

**Goal**: Tasks have persistent state that survives across events.

### Steps
1. **Board JSON schema** — define and implement
   - Task fields: id, title, description, status, playbook, queue, timestamps
   - Read/write functions in the infrastructure layer

2. **Orchestrator reads/writes the board**
   - On every event: read board, decide action, update board
   - Board is the source of truth, not conversation memory

3. **`jean board` CLI command**
   - Reads board.json, renders kanban view in terminal
   - Instant — just reads a file

### Deliverable
End-to-end: kick a task → board shows it as inbox → orchestrator assigns → board shows active → agent finishes → board shows review.

---

## Milestone 3: Playbooks & Skills

**Goal**: Define a flow once, Jean handles the rest.

### Steps
1. **Playbook format** — implement the markdown parser
   - Parse YAML frontmatter (queue, model, budget, gates)
   - Extract `## Skill` section
   - Extract `## Flow` and `## Message Template` for orchestrator

2. **`jean init agent` command**
   - Takes a folder path and playbook name
   - Extracts skill section, writes to `.claude/skills/jean-<playbook>/SKILL.md`
   - Registers channel plugin config
   - Configures stop hook

3. **Write the `bug-repro` playbook**
   - First real playbook, based on existing `issue-repro` skill
   - Test end-to-end with the work-dojo scratch worktree

### Deliverable
`jean init agent scratch --playbook bug-repro` sets up an agent. User starts Claude with `--channels`. Kick a bug task → agent reproduces it following the skill → orchestrator manages the flow.

---

## Milestone 4: Human Interaction

**Goal**: The human can interact with the system naturally.

### Steps
1. **`jean peek`** — connect to an agent or orchestrator session
2. **`/jean kick`** — skill for kicking tasks from any Claude session
3. **`/jean ship`** — approve a task in review state (orchestrator acts on it)
4. **`jean board` polish** — status indicators, timestamps, agent state
5. **Desktop notifications** — notify human when tasks need attention

### Deliverable
Full manual-mode workflow: kick from working session → agent handles → get notified → peek/approve → done.

---

## Milestone 5: Polish & Publish

**Goal**: Ready for other people to use.

### Steps
1. **`jean init` project command** — scaffolds a new Jean project
2. **Documentation** — setup guide, playbook authoring guide, architecture overview
3. **Second playbook** — `code-review` or `investigation` to prove generality
4. **Blog post** — "Jean: Yet Another Lightweight Loom for Agents"

---

## Future (not scoped)
- Auto mode: orchestrator starts agents when tasks arrive
- Manager agent: summarizes state, answers on behalf of human
- Multiple agents per queue (concurrent worktrees)
- `jean ui` opinionated layout preset
- SQLite board for history and queries
