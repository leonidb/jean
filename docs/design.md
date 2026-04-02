# Jean

A framework for multi-agent execution where autonomous coding agents work in parallel, communicate through channels, and are orchestrated by a central intelligent agent. You describe a task — a bug to reproduce, a PR to review, code to investigate — and an orchestrator routes it to the right agent. Agents work in separate folders, each with role-specific skills. When an agent finishes or gets stuck, the orchestrator checks in, updates the board, and notifies you. You batch-review results when you're ready: approve, redirect, or connect to any agent and talk to it directly. The layer between "I noticed something" and "it's handled" — without breaking your flow.

**Status:** Concept development (started 2026-03-26)

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
- **Orchestrator**: An always-running Claude session at the center. Routes work, manages the board, applies playbooks, talks to the human. The intelligence layer.
- **Agents are just Claude**: Each agent is a Claude session with role-specific skills. No special protocols. When it finishes, it stops. The orchestrator notices and checks in.
- **Playbooks**: Single markdown files defining a flow — orchestrator steps, agent skills, message templates. The skill section is extracted and installed into the agent. One source of truth.
- **Interactive**: Agents are full sessions you can connect to and talk to. Not fire-and-forget headless processes.
- **Infrastructure**: A Bun/TypeScript process handles channel wiring, board persistence, and stop hook signals. Deterministic, no LLM.

## Design Docs

| Doc | Status |
|-----|--------|
| [Concepts](concepts.md) | Solid — all design questions resolved |

## Origin

Grew out of a real day-to-day engineering workflow. The pattern is general — applicable to any multi-repo development workflow with Claude Code.
