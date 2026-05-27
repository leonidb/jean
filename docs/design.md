# Jean

A framework for multi-agent execution where autonomous coding agents work in parallel, communicate through channels, and are orchestrated by a central intelligent agent. You describe a task — a bug to reproduce, a PR to review, code to investigate — and an orchestrator routes it to the right agent. Agents work in separate folders, each with role-specific skills. When an agent finishes or gets stuck, the orchestrator checks in, updates the board, and notifies you. You batch-review results when you're ready: approve, redirect, or connect to any agent and talk to it directly. The layer between "I noticed something" and "it's handled" — without breaking your flow.

**Status:** Working prototype. Channel communication, event-sourced board, agent management CLI, Slack integration, and a live dojo all operational.

## Commands

```
/jean kick "repro Validator crash"    # kick off a task
/jean send scratch "investigate X"    # freeform task to a specific agent
jean board                            # see the kanban
jean peek scratch                     # connect to an agent
jean peek orchestrator                # talk to the orchestrator
/jean ship 003                        # approve and publish
```

## Core Ideas

- **Channels**: Agents communicate through Claude Code channels. The orchestrator pushes tasks, checks on idle agents, and interprets results. Validated — channels wake idle sessions.
- **Orchestrator (sensei)**: An always-running Claude session at the center. Routes work by agent tags, manages the event-sourced board, talks to the human. Stateless per-event — reads the board on every signal.
- **Agents are just sessions behind an adapter**: Each agent is a session with role-specific skills. No special protocols. When it finishes, it stops; the orchestrator notices and checks in. Claude Code is the reference runtime, not a built-in assumption — the WS protocol is runtime-neutral and other runtimes (e.g. Codex) can join through their own adapter. See [Runtime Neutrality](runtime-neutrality.md).
- **Tags over playbooks**: Agents declare capabilities via tags. The orchestrator routes tasks to agents with matching tags. Skills are installed per-agent, not extracted from playbook files.
- **Event sourcing**: All state changes are events (JSONL). Board and pending-events projections are derived from the event stream. History is queryable and streamable (SSE).
- **Interactive**: Agents are full sessions you can connect to and talk to. Not fire-and-forget headless processes.
- **Infrastructure**: A Bun/TypeScript process handles channel wiring, event persistence, and message routing. Deterministic, no LLM.

## Design Docs

| Doc | Status |
|-----|--------|
| [Concepts](concepts.md) | Architecture, components, communication patterns |
| [Playbooks](playbooks.md) | The customization layer — what a playbook is, its contract, author→discover→attach |
| [Runtime Neutrality](runtime-neutrality.md) | Why agents aren't assumed to be Claude; the adapter boundary |
| [Decisions](decisions.md) | Why things are the way they are |
| [Roadmap](roadmap.md) | What's done, what's next |
| [Research](research.md) | Validated technical findings |

## Origin

Grew out of a real day-to-day engineering workflow. The pattern is general — applicable to any multi-repo development workflow with Claude Code.
