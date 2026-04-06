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

## Milestone 3: Triggers & Proactive Workflows ✓

**Goal**: Sensei acts on its own — checking PRs, nudging the human, running scheduled flows.

**Completed** (Apr 4–6). Event-sourced triggers with cron and one-off scheduling. Croner-based scheduler syncs from trigger projection. Full CRUD API + fire-on-demand. CLI commands: `jean trigger add/list/remove/fire`. PR review workflow operational: daily trigger fires → sensei checks PRs → review agent reviews → results sent to Slack. Morning brief trigger running daily.

### What was built
1. ✓ **Event-sourced triggers** — `trigger-created`, `trigger-updated`, `trigger-removed`, `trigger-fired` events on a `triggers` stream. State derived via projection.
2. ✓ **Croner-based scheduler** — long-lived `Cron` instances managed in a `Map`, synced from projection. Handles cron and one-off triggers. Startup catch-up fires missed one-off triggers.
3. ✓ **Trigger API + CLI** — CRUD endpoints, fire-on-demand (`POST /triggers/:id/fire`), CLI for all operations.
4. ✓ **PR review workflow** — `review-pending-prs` cron trigger at 9:00 weekdays. Morning brief at 9:30.
5. ✗ **Permission profiles** — deferred, moved to M3.5 (now urgent based on operational feedback).

---

## Milestone 3.5: Task Lifecycle & Agent Autonomy

**Goal**: Tasks have meaningful lifecycles. Agents don't block on permissions for routine operations.

### To build
1. **Task states** — add `waiting` state: `todo → assigned → in-progress ↔ waiting → done`. Tasks can still go `in-progress → done` for simple work. The key: tasks don't have to close after one exchange.
2. **Task event log CLI** — `jean task <id> log` showing full event history for a task. Endpoint exists (`/history?taskId=X`), needs CLI formatting.
3. **Permission profiles** — pre-configured per role via `jean agent add`. Workers get `Bash(git:*)`, `Edit`, `Write`, `Read`. Review gets `Bash(gh:*)`. Sensei gets `Bash(curl:*)`, `Bash(gh api:*)`. Eliminates the 76-permission-request problem.

### Deliverable
Tasks stay open through multi-round work. Agents operate without permission friction for routine operations. Human can see full task conversation history via CLI.

---

## Milestone 4: Playbooks & Interaction Logging

**Goal**: Sensei follows defined processes for different work types. Human-agent interactions are visible in the event log.

### Design

**Playbooks** — flow definitions that tell sensei how to handle a type of work. Not routing (tags handle that), but process: what to do at each stage, what to verify, when to ask the human, when to close.

Live in `.jean/playbooks/`. Each playbook is a markdown file describing the flow. Sensei loads them at startup. Examples:
- `review.md` — review task follows PR lifecycle. Design review first, then iterative rounds. Wait for assigned reviewer unless asked for preliminary review. Track PR comments. Task closes when PR is merged/approved/explicitly closed by human.
- `dev.md` — dev task follows work lifecycle. May involve multiple repos. Lifecycle customizable (until PR merged, or until human says done). Human often works directly with agent.
- `research.md` — scout/investigate tasks. Single-shot or recurring via triggers. Quality assessed by human feedback.

**Interaction logging** — when an agent has a direct interaction with the human (outside the task system), the agent posts a summary to the task. Sensei mentions this expectation during task handoff. These summaries are events with a dedicated type (`human-interaction`), searchable and usable for self-reflection.

### To build
1. **Playbook format** — markdown with structured sections: lifecycle states, sensei behavior at each transition, verification requirements, tracking expectations
2. **Playbook loading** — sensei reads `.jean/playbooks/` on startup, references playbook when dispatching tasks
3. **Sensei handoff instructions** — when dispatching a task, sensei includes playbook-derived instructions (e.g. "log any direct interactions with the human")
4. **Interaction summary events** — `human-interaction` event type. Agent posts summary when it detects multi-turn direct interaction ended
5. **Idle pattern detection** — multiple rapid idle events from a worker suggest human is working with it. Sensei can use this signal to prompt the agent for a summary

### Deliverable
Sensei follows consistent processes for reviews and dev work. Direct human-agent iterations are captured as events. Task history shows the full picture, not just the sensei-mediated exchanges.

---

## Milestone 5: Quality Feedback & Living Context

**Goal**: The dojo learns from its own work. Quality feedback drives self-improvement through shared context.

Combines the original M4 (Living Context) with the quality feedback loop concept from the operational review.

### Design
- **Quality feedback events** — `task-feedback` event type. From human (explicit rating/comment) or sensei (assessment). Captures whether the outcome was good, what could improve.
- **Context distillation** — periodic process reads quality feedback, human interaction summaries, and task outcomes. Distills into `.jean/context/` as structured learnings.
- **Permission profile suggestions** — based on permission-request events, system suggests new allow rules for agents that repeatedly need the same permissions.
- **Sensei assertiveness from day 1** — baked into skill/playbook defaults: verify deliverables, ask pointed questions, don't accept vague "done" signals.

### To build
1. **`task-feedback` event type** — API endpoint + CLI command (`jean task <id> feedback`)
2. **Raw observation capture** — agents write findings to `.jean/context/raw/` during work
3. **Consolidation flow** — trigger that processes raw observations + feedback into structured context
4. **Permission suggestion CLI** — `jean permissions suggest` analyzes permission-request events and proposes updates
5. **Sensei defaults** — update sensei skill with assertive verification behavior

### Deliverable
Work produces feedback → feedback feeds context → context improves future work. Permission friction decreases over time. Sensei verifies deliverables by default.

---

## Milestone 6: Human Interaction & Polish

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

## Milestone 7: Dojo Init & Distribution

**Goal**: Ready for other people to use.

### To build
1. **`jean dojo init`** — scaffolds a new dojo (`.jean/`, `.bare/`, first agent)
2. **Package jean as installable CLI** — `npx jean` or similar
3. **Documentation** — setup guide, architecture overview
4. **Simplify channel setup** — reduce per-agent boilerplate (`.mcp.json`, settings)

---

## Future (not scoped)

- Auto mode: orchestrator starts agents when tasks arrive
- SQLite event store backend (replace JSONL) — enables query layer for self-reflection
- Monitoring/meta agent: observes events, proposes improvements to skills and configs
- Idle/busy reconciliation: agent state should reflect actual activity, not just board state
- Multiple agents per queue (concurrent worktrees)
- Permission proxy: explore if sensei can approve permissions on behalf of human
- `jean ui` opinionated layout preset
- Programmatic context compaction for long-running agents
