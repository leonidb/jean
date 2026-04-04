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

**Completed** (Apr). `jean agent add/list/tag/remove/start` CLI. Workers default to git worktrees, non-workers to plain directories. Agent identity via `.jean-agent.json` (name, role, tags). Directory-based agent discovery. Tags flow from agent → channel plugin → infra → sensei for routing. Slack integration as a `user` role agent. Context directory (`.jean/context/`) for live project data. Sensei skills migrated from global hub.

---

## Milestone 3: Triggers & Proactive Workflows

**Goal**: Sensei acts on its own — checking PRs, nudging the human, running scheduled flows.

### To build
1. **Periodic triggers in infra** — cron-like scheduler. Config: time + agent + prompt. Stored in `.jean/triggers.json`, managed via `jean trigger add/list/remove`.
2. **PR review workflow** — trigger prompt that tells sensei to check PRs, route reviews to the review agent, and send consolidated summaries to Slack.
3. **Read-only permission profiles** — granular `gh`/`git` permissions (view, diff, list — no merge, push, create). Already started for review agent.

### Deliverable
Daily trigger fires → sensei checks PRs → review agent summarizes each → sensei sends consolidated Slack message. Human wakes up to actionable PR summaries.

---

## Milestone 4: Living Context

**Goal**: The dojo's context auto-maintains itself — agents capture observations, the system consolidates them into structured knowledge.

Inspired by [Karpathy's LLM knowledge bases](https://x.com/karpathy/status/2039805659525644595): raw sources compiled into a wiki of `.md` files, auto-maintained by the LLM. No RAG, no graph database — just markdown and an agent that keeps it coherent.

### Design
- `.jean/context/raw/` — agents write observations here during work (findings, decisions, patterns noticed)
- Consolidation: sensei (or a dedicated agent) periodically reads `raw/`, distills into structured context files (`research/`, `open-threads.md`, etc.), clears processed raw notes
- Index maintenance: auto-generated summaries and cross-references across context files
- Agents reference context for decisions; their work produces new raw observations — a feedback loop

### To build
1. **Raw capture convention** — how agents write to `raw/` (format, naming, via reply tool or direct file write)
2. **Consolidation flow** — trigger or manual prompt that processes `raw/` into structured context
3. **Index/summary generation** — auto-maintained overview of what's in context
4. **Agent instructions** — update skills to tell agents to capture observations in `raw/`

### Deliverable
Agents work → observations accumulate in `raw/` → consolidation distills into structured context → sensei reads better context → makes better decisions. Knowledge compounds over time without manual curation.

---

## Milestone 5: Human Interaction & Polish

**Goal**: The human can interact with the system naturally.

### To build
1. **`jean peek`** — connect to a running agent's terminal
2. **`/jean kick`** — skill for kicking tasks from any Claude session
3. **`/jean ship`** — approve a task in review state
4. **`jean board` polish** — status indicators, timestamps, agent state
5. **Desktop notifications** — notify human when tasks need attention

### Deliverable
Full manual-mode workflow: kick from working session → agent handles → get notified → peek/approve → done.

---

## Milestone 6: Dojo Init & Distribution

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
