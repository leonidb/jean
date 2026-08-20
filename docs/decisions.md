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

**Update (Apr 7)**: Playbooks return, but for a different purpose. Tags still handle routing. Playbooks now define *flow logic* — how sensei manages the lifecycle of a review task vs dev task vs research task. Not "which agent handles this?" but "what does sensei do at each stage?" Lives in `.jean/playbooks/` as markdown files. See roadmap M4 and [docs/playbooks.md](playbooks.md) for the full contract and rationale.

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

**Superseded by decision #15** — moving to wrapper directories with worktrees for all agents.

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

## 15. Agent directory structure: Wrapper + work subdirectory

**Chosen: Agent wrapper directory with `work/` subdirectory**

Supersedes decision #11. Every agent gets a wrapper directory that Jean owns, with a `work/` subdirectory that is a git worktree.

```
agent/
  .claude/settings.local.json   ← Jean config (permissions, hooks, MCP)
  .jean-agent.json               ← agent metadata
  work/                          ← git worktree
    CLAUDE.md                    ← repo knowledge (lazy-loaded by Claude Code)
    .claude/skills/              ← repo skills (loaded via --add-dir)
    src/...
```

**Three base assumptions:**
1. Every dojo is backed by a git repo.
2. Every agent gets a worktree in `agent/work/`.
3. `work/` is a subdirectory of the agent wrapper dir.

**Why wrapper:** Jean needs to inject config (`.claude/settings.local.json`, `.mcp.json`, hooks, permissions) into the agent's working directory. If the agent directory IS the repo worktree, Jean's config conflicts with the repo's own `.claude/` files. The wrapper separates concerns: Jean owns the wrapper, the repo owns `work/`.

**How knowledge flows:** Claude Code lazy-loads `work/CLAUDE.md` when the agent accesses files in `work/` (subdirectory CLAUDE.md convention). Repo skills in `work/.claude/skills/` are loaded via `--add-dir work`. No env vars needed for CLAUDE.md.

**Dojo-level shared skills:** Live in `.jean/.claude/skills/`, loaded via `--add-dir ../../.jean` (or equivalent path to `.jean/`). Role-specific skills live in `.jean/roles/<role>/.claude/skills/`.

**Git as artifact layer:** Agents commit results to git. Branches are referenceable from task events — sensei and other agents can inspect any branch. Branch naming strategy (per-agent, per-task, etc.) is project-specific, defined by playbooks.

**Why worktrees over clones:** Industry research (Apr 2026) showed cloud systems use VMs/containers, local systems use worktrees. Nobody uses full clones for multi-agent setups. Worktrees are lighter (shared object store), faster to create, and provide instant branch visibility. Clones sit in an awkward middle — heavier than worktrees, less isolated than containers. If isolation needs grow beyond worktrees, the upgrade path is containers.

**Launch:** `cd <agent> && claude --add-dir work --add-dir ../../.jean --add-dir ../../.jean/roles/<role> ...`

## 16. Agent tool surfaces: role-scoped MCP toolsets

**Chosen: per-role tool lists — sensei and workers get different MCP tools, not the same set.**

- Sensei: `send` + `comment` + `infra` (no `reply`).
- Worker/user: `reply` + `comment` + `infra` (GET-only, no `send`).

Prior state: both roles shared `reply`; sensei also shelled out via `Bash(curl:*)` for state changes.

Alternatives considered:
- **Keep sensei's `reply` and auto-route it**: rejected because `reply` has no recipient, so routing requires inference ("reply to who?"). Previous implementation silently recorded a fake `send` event with `delivered: true` but no actual delivery — the Slack black hole.
- **Workers get full `infra` including writes**: rejected. Workers orchestrating state changes violates the "sensei orchestrates, workers do" boundary. Workers can request changes via `reply` to the sensei.
- **Sensei uses curl, no MCP tools**: rejected. Curl hits Claude Code's sandbox heuristics ("expansion obfuscation") on JSON heredocs, blocking autonomous/triggered flows with permission prompts.

Why role-scoped MCP won: each role's available actions match its responsibilities. Send forces an explicit recipient (no more black holes). Workers get lookup without write authority. Tool schemas are role-aware at `ListTools` time — GET-only enum for workers is declared in the schema, enforced at runtime too.

## 17. Task event tiers: `task-comment` (curated) vs `reply`/`send` (chat)

**Chosen: two distinct event types with separate `?include=` flags.**

- `task-comment` events: worker- or sensei-emitted deliberate notes. Surfaced via `?include=comments`.
- `reply` + `send` events: conversational, higher-volume. Surfaced via `?include=messages`.

Prior state: everything was `reply`/`send`; task histories mixed substantive findings with chatter.

Alternatives considered:
- **Save only explicit updates, no correspondence**: rejected. Losing diagnostic value is a one-way door — when a task goes sideways you want the full chatter available.
- **Save everything undifferentiated (prior behavior)**: rejected. Signal-to-noise was poor; the sensei had to filter.
- **Filter at read time via heuristics (length, keywords)**: rejected as fragile.

Why explicit tiering won: workers decide which tier an event belongs to at emission. Default path (`reply`) is zero-friction; deliberate path (`comment`) is explicit. Both layers are captured; the sensei reads `comments` by default and opts into `messages` for diagnostics. Maps to real-world patterns (GitHub PR comments vs status checks, Slack messages vs pinned decisions).

**Naming note:** `?include=comments` used to mean reply+send (the chat tier). That was renamed to `?include=messages`; the new `?include=comments` means curated task-comment events. Semantic swap was safe because no dojos had reconnected since the prior meaning landed.

## 18. Reply attribution: taskId flows with the message thread

**Chosen: `ReplyMsg` carries optional `taskId`; the channel plugin attaches it from the most recent `deliver`. Agent can override explicitly.**

Prior state: server inferred `taskId` from board state — "first in-progress task assigned to this worker."

Alternatives considered:
- **Keep server-side inference** (prior behavior): rejected. Long-lived workers hold multiple in-progress tasks simultaneously; inference picks wrong whenever there's >1 candidate. Observed: replies about task 020 got stamped with task 018 because 018 was iteration-first. Task 018's history became a misleading catch-all.
- **Require agent to always specify `taskId`**: rejected as ergonomically heavy. In the common case (one deliver → one reply) the correlation is obvious.
- **Enforce single-in-progress task per worker** to eliminate ambiguity at the state layer: rejected. Constrains legitimate patterns (workers context-switching across related tasks), and state-based attribution has its own races.

Why message-thread attribution won: the `taskId` is already known at deliver time (sensei set it when dispatching). The plugin carries it forward through to the reply. Explicit override handles multi-task cases cleanly.

**Superseded on the fallback (2026-08-20, task 116):** the legacy inference is REMOVED, not awaiting rollout — a stream audit showed it was 100% guesswork in practice (workers never tag) and corrupted task records at scale. An untagged reply records to the agent's own stream; explicit `taskId` stays honored; `comment` is the durable task-writing verb.

## 19. Autonomous sensei wake-ups: always on; noise control at the event source

**Chosen: no config flag. Any event that enters `pending` wakes an idle sensei; any trigger targeting the sensei delivers.**

Prior iteration introduced `autoNudge: boolean` (default `false`) to suppress autonomous wake-ups, on the theory that an unreliable sensei does net damage when woken too often.

Why that was reverted (2026-04-18): with the gate off, the sensei never saw Slack inbound (`reply` from the Slack channel-agent), never saw worker join/leave (added to `pending` by decision #75), never saw trigger fires that targeted it. Every legitimate signal was also blocked. The gate had no way to distinguish "noisy" from "needed."

The actual noise source was agent-idle Stop-hook firings. Those were removed from `pending` at the reducer level (decision #21) — the noise is gone, so the gate is guarding nothing useful.

Alternatives re-examined:
- **Keep `autoNudge` but change default to `true`**: rejected. The knob still lets users re-break themselves with a config mistake; no real signal would come from leaving it off.
- **Gate per-event-type (e.g. wake on `register` but not on `reply`)**: rejected as premature. No evidence that any pending-eligible event is the wrong wake source today. If replies become noisy again, the right fix is debouncing (batch within N seconds), not a binary kill switch.

What stays: the set of events that enter `pending` is the policy. Adding an event to pending means "sensei should see this." Removing one means "diagnostic only" (the agent-idle treatment). No global override.

## 20. Task reverts: `task-reverted` event, not DAG backward edges

**Chosen: new `task-reverted` event type bypasses `canTransition`. DAG stays forward-only.**

`boardReducer` applies reverts unconditionally (no canTransition check). History shows corrections as a distinct event type, not as "another status change."

Prior state: no revert mechanism. The sensei marking `done` prematurely was sticky damage — only way back was a chain of sideways transitions that corrupted history.

Alternatives considered:
- **Widen `canTransition` to allow `done → in-progress`, `cancelled → waiting`, etc.**: rejected. Blurs the semantic of terminal states. If `done` has outgoing edges, `done` is just another status, not "this work is closed." Also loses the audit distinction between "forward progress" and "correction."
- **Generic `force-status` mechanism**: rejected as too permissive. Revert is specifically "go back to a prior state," not "set to anything."
- **Per-endpoint revert** (separate endpoints for each kind of backward transition): rejected as ceremony.

Why `task-reverted` as a distinct event won: small DAG stays comprehensible (`todo → assigned → in-progress ↔ waiting → done/cancelled`). Reverts are first-class in history (auditable). Bypassing `canTransition` is the event type's defining feature, not a special case.

**Semantics: stack-pop.** Handler rebuilds the status stack from the task's event stream and reverts to one level below current. Repeated calls unwind further. Cannot re-reach already-popped states (would be "redo," not undo).

## 21. Idle events are diagnostic; `waiting` ≠ busy

**Chosen: `agent-idle` events record to history only, not to the pending bucket. `waiting` status no longer counts as busy.**

Two coupled changes:
1. Register-time `hasActiveTask` check counts only `in-progress` tasks (not `waiting`).
2. `agent-idle` removed from `pendingProjection` filter + reducer.

Prior state: `waiting` tasks blocked workers from registering idle; every Stop-hook firing entered pending (318/1134 events = 28% noise) and triggered nudges.

Alternatives considered:
- **Dedupe idle events** (transition-only recording): rejected. If idle is purely diagnostic, every Stop-hook firing IS a lifecycle event worth preserving. Dedup would save storage but lose signal.
- **Emit idle events but mark them low-priority for the sensei**: rejected as indirection — nothing downstream reads priority.
- **Keep `waiting` as busy**: rejected. `waiting` means "paused for external input" — the worker's session isn't occupied, it can take other work.

Why this won: audit of the code showed **no sensei decision reads `worker.idle`**. The real signal ("worker has something to say") flows through `reply` and `task-comment` events, which do enter pending. Demoting idle to diagnostic preserves observability (still in `/history` for retrospectives) while cutting the pending-noise that was driving 28% of nudges. `waiting` fix was a latent bug: the register handler was marking workers busy on status they weren't actively holding.

## 22. Canonical task load: `?include=comments,playbook` attaches the playbook

**Chosen: `GET /tasks/<id>?include=comments,playbook` is the default task-load call. Playbook content ships alongside task data.**

Prior state: playbooks lived behind a separate `GET /playbooks/<id>`. The sensei had to remember to fetch the playbook for any task it was working on.

Alternatives considered:
- **Auto-inject playbook on every status transition**: rejected. Couples lifecycle to IO, surprising side effects.
- **Sensei is trusted to fetch the playbook when needed**: rejected by observation. The sensei closed task 033 despite its playbook's "wait for PR merged" rule because it never re-read the playbook. No amount of skill wording fixed this reliably.
- **Skill says "always load the playbook"**: tried, ineffective. A habit the sensei has to remember vs. a field that arrives in the response.

Why attach-on-load won: if the playbook is in the same response as the conversation, there's no separate ritual to forget. `?include=comments,playbook` makes the playbook arrive with the context the sensei is already reading. Low-cost endpoint extension, high behavioral effect.

## 23. `infra` tool response: strip status prefix on success

**Chosen: on 2xx, return the raw body. On 4xx/5xx, prepend `${status} ${statusText}` and set `isError`.**

Prior state: every response wrapped as `${status} ${statusText}\n${body}`.

Alternatives considered:
- **Always envelope as JSON `{status, statusText, body}`**: rejected. Adds indirection on every call. For success responses the body IS the message; wrapping makes the agent peel off `.body` every read. Also awkward when body is non-JSON (fallback handling).
- **Never include status, rely only on `isError`**: rejected. Empty 5xx bodies or malformed 4xx would lose the status-code signal entirely. Status line has real info when body doesn't.

Why strip-on-success won: our server returns structured JSON on both paths (`{tasks: [...]}` vs `{error: "..."}`), so the body already carries everything the agent needs on 2xx. Status-line prefix adds tokens and one mental skip-past step per call. On error, the status line is kept because empty/unhelpful bodies aren't uncommon and the status carries signal the body might miss. The MCP `isError` flag still tells the agent which mode to parse in.

## 24. Multi-agent attention contract: superseded by the guarantees spec (2026-08-15)

**Chosen: `docs/guarantees.md` (task 065) is the authority on mailbox, acknowledgement, and supervision semantics.** Where an earlier entry in this log describes those mechanisms differently, the earlier entry records what was true when it was decided, and the spec records what is required now.

What changed relative to the world earlier entries describe: pending is no longer the sensei's queue but per-agent mailboxes — the set of unacknowledged (recipient, event) pairs, with acknowledgement state independent per recipient (no agent's ack can consume another's mail); ack requires the content-derived code AND that the caller is a recipient, and the clearing record names the acker; every event kind declares a resolution function for its recipients, possibly empty (an empty resolution is history, not mail); supervision probes before any verdict, reports to the sensei only (machines never message the human, per task 069), and every down-report gets a matching recovery report.

Entries this touches rather than voids: #3 (workers now actively report via `reply`/`comment` — the passive model was retired with the Events API transition), #19 ("any event that enters pending wakes an idle sensei" — the set-of-events-as-policy idea survives, but the mailbox is per-agent now and resolution functions carry the policy), #21 (agent-idle as diagnostic — unchanged, and now stated in the spec's resolution table as an empty-resolution kind).
