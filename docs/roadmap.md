# Jean — Development Roadmap

## Milestone 1: Channel Communication ✓

**Goal**: Two Claude sessions communicate through a custom Jean channel plugin.

**Completed** (Mar 27). Channel plugin built and validated. Infrastructure service routes messages between connected agents. Stop hook fires on agent idle and notifies infrastructure.

---

## Milestone 2: Board & Task State ✓

**Goal**: Tasks have persistent state that survives across events.

**Completed** (Mar–Apr). Event-sourced board with JSONL backend. Board is a projection derived from events (task-created, task-status, task-updated). Pending events projection tracks what sensei needs to act on. Full HTTP API for task CRUD, status transitions, event acknowledgment. `jean board` CLI renders kanban view. SSE endpoint (`GET /stream`) for real-time event broadcast. History endpoint with filtering.

---

## Milestone 2.5: Agent Management & Dojo Setup ✓

**Goal**: Streamlined agent creation and dojo structure.

**Completed** (Apr). `jean agent add/list/tag/remove/start` CLI. Workers default to git worktrees, non-workers to plain directories. Agent identity via `.jean-agent.json` (name, role, tags). Directory-based agent discovery. Tags flow from agent → channel plugin → infra → sensei for routing. Slack integration as a `user` role agent. KB directory (`.jean/kb/`) for shared project knowledge. Sensei skills migrated from global hub.

---

## Milestone 3: Human Interaction & Polish

**Goal**: The human can interact with the system naturally.

### To build
1. **`jean peek`** — connect to a running agent's terminal
2. **`/jean kick`** — skill for kicking tasks from any Claude session
3. **`/jean ship`** — approve a task in review state
4. **`jean board` polish** — status indicators, timestamps, agent state
5. **Desktop notifications** — notify human when tasks need attention
6. **Broader default permissions** — role-based permission profiles so workers don't block on approvals

### Deliverable
Full manual-mode workflow: kick from working session → agent handles → get notified → peek/approve → done.

---

## Milestone 4: Dojo Init & Distribution

**Goal**: Ready for other people to use.

### To build
1. **`jean dojo init`** — scaffolds a new dojo (`.jean/`, `.bare/`, first agent)
2. **Package jean as installable CLI** — `npx jean` or similar
3. **Documentation** — setup guide, architecture overview
4. **Simplify channel setup** — reduce per-agent boilerplate (`.mcp.json`, settings)

---

## Future (not scoped)

- Auto mode: orchestrator starts agents when tasks arrive
- SQLite event store backend (replace JSONL)
- Knowledge base agent: dedicated agent for recording/retrieving findings across the dojo
- Monitoring/meta agent: observes events, proposes improvements to skills and configs
- Idle/busy reconciliation: agent state should reflect actual activity, not just board state
- Multiple agents per queue (concurrent worktrees)
- Permission proxy: explore if sensei can approve permissions on behalf of human
- `jean ui` opinionated layout preset
