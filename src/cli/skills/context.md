---
name: context
description: >
  How to use this dojo's persistent knowledge layer at `.jean/context/`. Read
  it on session start; navigate via `index.md`; record durable knowledge by
  emitting `memorize` events; never edit the wiki directly. Loaded by sensei
  and workers.
---

# Wiki — `.jean/context/`

This dojo has a persistent knowledge wiki at `.jean/context/`. It accumulates across sessions: lessons learned, conventions, decisions, durable context that future agents (and you) need.

You **read** it freely. You **never edit it directly** — `Edit` and `Write` on `.jean/context/**` are denied at the permission layer. New knowledge enters via `memorize` events; corrections enter via `memorize` events; the librarian (a separate headless process on a nightly trigger) does the actual writing during consolidation.

## Wiki vs Repo — what goes where

This is the question to ask first when you have something to record.

| Goes in repo (committed code/docs) | Goes in wiki (`.jean/context/`) |
|---|---|
| Code, configs, schemas, package.json | Process notes, decisions, learnings |
| README, public-facing docs, ADRs | "We tried X, it didn't work because Y" |
| Issues / roadmap items others read | "Tomorrow check whether Z is still relevant" |
| Stable design decisions affecting public API | Decisions about *how we work* (priorities, postponements) |

**Default to wiki** for working/process notes. **Promote to repo** only when content is stable, polished, and relevant to people outside this dojo (contributors, users, future maintainers).

**Edge cases:**
- **Knowledge dojos** (e.g. life-OS, planning, research): no real "repo" exists. The wiki *is* the deliverable. Don't invent a repo/wiki split where there isn't one.
- **Code dojos** with active development: repo holds artifacts; wiki holds the *process* of building them — including dead ends, considered alternatives, why current choices were made.
- **Sensei strategy** (orchestration, what worked, agent feedback): always wiki.
- **Anything ephemeral or task-scoped**: not the wiki — use `task-comment` on the task itself.

## Reading the wiki — index-first

On session start (or when you need durable context), read in this order:

```
.jean/context/index.md     — master TOC, one line per page, organized by category
.jean/context/log.md       — append-only operation timeline (what was added/changed when)
.jean/context/<page>.md    — specific pages, opened only after the index says they're relevant
```

**Don't read every file.** The wiki may have hundreds of pages. Read `index.md` first, identify the 1–3 pages that bear on your current question, read those.

If the index is missing or empty (fresh dojo), the wiki hasn't been populated yet — proceed without it; consolidation will build it as memories accumulate.

## Recording durable knowledge — `memorize`

When you observe something that should outlive this task — a pattern, a decision, a finding worth surfacing in future tasks — emit a `memory` event:

```
infra(method="POST", path="/memorize", body={
  agent: "<your name>",
  role: "<your role>",
  text: "<observation, finding, decision — full sentence>",
  scope: "dojo",        // or "user" for cross-dojo identity facts
  taskId: "<task-id>"   // optional, when the memory came up during a task
})
```

Some examples:
- `"Gym membership cancelled 2025-11-03, ~$45/mo saved. Was unused for 3+ months."`
- `"Convention in this dojo: every refactor needs a perf benchmark before merge."`
- `"Formatter evaluation: <option A> was too slow on save; switched to <option B>."`

The librarian reads new `memory` events on its consolidation trigger and distills them into the wiki.

### What NOT to memorize

- **In-task progress** ("started X", "found Y", "blocked on Z") — these go in `task-comment` on the task itself. The sensei reads task comments; future workers read them. Memorize is for *cross-task* knowledge.
- **Operational chatter** (registers, idle events, ack noise) — not for the wiki, not for memorize. Just don't capture.
- **Session-scoped notes** ("I should remember to do X in 5 minutes") — keep in your own head or in a task TODO. Memorize is forever.

The sharp test: *would I want to read this six months from now while working on a different task?* If yes → memorize. If no → task-comment or ignore.

## Stale data — what to do when you read something wrong

The wiki may say something out of date. Don't fix the wiki yourself (you can't — Edit/Write is denied). **Memorize the correction:**

```
memorize text="CORRECTION: bills.md says 'gym membership active' — actually cancelled 2025-11-03, see task #042."
```

The librarian picks up corrections on the next consolidation, updates the page, and logs the change in `log.md`. You don't have to do anything else.

This rule applies regardless of how you noticed the staleness — running into it during work, comparing two pages, or the user telling you in conversation. Always: memorize, move on.

## What the librarian does (FYI)

- Reads new `memory` events since its cursor
- Reads completed tasks and decides which contain durable knowledge worth distilling into the wiki
- Updates `.jean/context/` pages, the `index.md`, the `log.md`
- Performs an atomic swap so readers never see a half-written wiki
- Emits a `wiki-consolidated` event when done; sensei picks it up via the normal nudge cycle

You don't invoke the librarian directly. It runs on a schedule (default nightly).

## Quick reference

- Read wiki: open `.jean/context/index.md`, navigate from there
- Record knowledge: `memorize` (cross-task, durable)
- Record task progress: `task-comment` (task-scoped)
- Fix stale wiki content: memorize a `CORRECTION:` note; never edit directly
- Repo vs wiki: ships → repo, process → wiki, default to wiki when in doubt
