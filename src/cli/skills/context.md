---
name: context
description: >
  The reading map of where data lives in a dojo — four homes (raw_context /
  wiki / the repo the dojo owns / the task), one writer each — and how to use
  the persistent knowledge wiki at `.jean/context/`. Read on session start;
  navigate via `index.md`; record durable knowledge via `memorize`; never
  edit the wiki directly. Loaded by sensei and workers.
---

# Where data lives — and the wiki

This dojo has a persistent knowledge wiki at `.jean/context/`. It accumulates across sessions: lessons learned, conventions, decisions, durable context that future agents (and you) need.

You **read** it freely. You **never edit it directly** — `Edit` and `Write` on `.jean/context/**` are denied at the permission layer. New knowledge enters via `memorize` events; corrections enter via `memorize` events; the librarian (a separate headless process on a nightly trigger) does the actual writing during consolidation.

The wiki is one of **four homes** data lives in. Here is the whole map:

## The reading map — four homes

| home | what it holds | written by |
|---|---|---|
| `.jean/raw_context/` | Frozen captures — received documents, self-captured raw. Immutable once captured; the librarian's input; the dojo's evidence-of-record. | nobody (frozen) — anyone may add new captures |
| wiki (`.jean/context/`) | Distilled durable knowledge — learnings, conventions, decisions, pointers. Lossy by design: the librarian summarizes. | librarian only — everyone contributes via `memorize` |
| the repo the dojo owns | Full-fidelity durable material — systems run on a rhythm, records too rich for the lossy wiki. In some dojos this is the product repo itself (the repo the dojo works on); in others it's `.jean/workspace/`, the sensei's own git repo. `.jean/context/readme.md` says which. | workspace: sensei only · product repo: everyone, via git |
| the task | Working material for the current dispatch — comments, branch work. Ephemeral (with `/tmp`): dies with the task; anything durable must be promoted to a durable home before it closes, or it's lost. | the dispatched worker (comments), the sensei (state) |

Everything is readable by everyone; each home has one writer. Two universal rules:

- **No floating data.** Every artifact has exactly one home — an arbitrary path in the tree is never a home. (Credentials live outside all homes by design — don't "fix" that. And an empty home is not a wrong home.)
- **A worktree is a checkout of a branch, not a private folder.** Uncommitted work is invisible to every other agent. Reference files by repo-relative path from the git root (`food/inventory.md`), never by worktree path (`sensei/food/inventory.md`) — and memorize the pointer, never the payload.

**Filing decisions are the sensei's.** Workers: your output lives as commits on a branch plus the task record (your skill has the details); when you're unsure where something belongs, say so in your `reply` — don't invent a spot. Sensei: your filing rules are in your skill's "Data homes" section.

## Reading the wiki — index-first

On session start (or when you need durable context), read in this order:

```
.jean/context/index.md     — master TOC, one line per page, organized by category
.jean/context/log.md       — append-only operation timeline (what was added/changed when)
.jean/context/<page>.md    — specific pages, opened only after the index says they're relevant
```

**Don't read every file.** The wiki may have hundreds of pages. Read `index.md` first, identify the 1–3 pages that bear on your current question, read those.

**The index carries page descriptions.** Each line is `- [[Page]] — <one-sentence description>`. The description tells you what's on the page; you often don't need to open the page itself to know whether it's relevant. Open only the pages whose descriptions answer your question.

**Follow wiki-links when relevant.** Pages contain `[[Page Name]]` references to related concepts. Treat them as first-class navigation: after the 1–3 pages from the index, follow links when the destination is plausibly relevant to your question. Stop when you have enough — don't traverse transitively forever. The pattern is index → page → link-hop, not index → page only.

If the index is missing or empty (fresh dojo), the wiki hasn't been populated yet — proceed without it; consolidation will build it as memories accumulate.

## Pending memorize events — the gap between memorize and the wiki

The wiki is *yesterday's* snapshot. Memorize events emitted today don't land in `.jean/context/` until the next librarian run (typically nightly). To see what's been memorized but not yet consolidated:

```
recent_memories()                 # everything since the consolidator cursor
recent_memories(since=1180)       # explicit event-id override
recent_memories(limit=20)         # only the tail of N events
```

Returns the consolidator cursor (when the wiki was last updated and through which event id) plus every memorize event since. Two situations want this:

- **Verification after writing.** You memorized something a few minutes ago and want to confirm it landed.
- **Bootstrap as a fresh worker.** When you're dispatched on a task, the wiki gives you durable knowledge as of last night — `recent_memories` gives you facts memorized earlier in the *current* session that aren't in the wiki yet. Read both: wiki for lasting context, `recent_memories` for fresh facts the dispatching sensei (or peers on this task) just wrote.

No agent filter — all memorize events are returned; you pick out the ones relevant to you. The wiki remains authoritative for most questions; reach for `recent_memories` when you suspect the wiki is missing something fresh.

## Recording durable knowledge — `memorize`

When you observe something that should outlive this task, record it via the `memorize` tool. "Durable" is broader than just project facts — anything cross-task, cross-session, and worth surfacing to future agents (or your future self) belongs here:

- **Project facts** — decisions, findings, what changed in the world
- **Behavioral rules and team conventions** — norms the human has expressed about how you (or workers) should operate; collaboration patterns the dojo has settled on
- **Orchestration / sensei lessons** — dispatch shapes that worked, anti-patterns to avoid, when to confirm vs auto-fire
- **Cross-cutting tooling notes** — version-pin rationale, gotchas with external systems, deprecated patterns

```
memorize(text="<observation, finding, decision, rule — full sentence>")
memorize(text="...", scope="user")    # cross-dojo identity facts about the human
memorize(text="...", taskId="042")    # when the memory came up during a task
```

Examples spanning the categories:
- `"Gym membership cancelled 2025-11-03, ~$45/mo saved. Was unused for 3+ months."` *(project fact)*
- `"Convention in this dojo: every refactor needs a perf benchmark before merge."` *(behavioral rule)*
- `"The human prefers I pause and confirm before dispatching design-touching tasks — auto-fire is for mechanical fixes only."` *(orchestration norm)*
- `"Formatter evaluation: <option A> was too slow on save; switched to <option B>."` *(tooling note)*

The librarian reads new memorize events on its consolidation trigger and distills them into the wiki. Behavioral rules typically land under a stable page (e.g. `team-style.md`, `sensei-conventions.md`) so future agents read them on session start via the index.

### Wiki vs Claude Code's auto-memory — **the wiki, every time**

Claude Code maintains its own per-project auto-memory at `~/.claude/projects/<project>/memory/`. Its instructions are loaded into every session and prompt you to save things there. **In a Jean dojo, you do not write to that directory.** Anywhere you feel pulled toward auto-memory — "I should remember this for next time," "this is a fact about the human," "let me jot this down" — that pull is the harness's gravity, and the right answer is `memorize()` instead. Treat `~/.claude/projects/.../memory/` as if it didn't exist; do not Read, Write, or Edit anything under it.

The wiki is the dojo's memory. It's visible to all agents (not just you), durable across reinstalls and machine moves, distilled by the librarian, and corrected via the same `memorize()` channel. Auto-memory is per-Claude-instance, invisible to peers, silently bypasses curation, and creates a parallel knowledge store that defeats the whole point of the wiki design.

**Active use closes the loop.** The wiki feels alive when you treat it as one — read early and often, not just at session start:

- Skim `index.md` whenever you reach a "what do we know about X" moment
- Call `recent_memories()` to see what you (or peers) memorized this session, *immediately* after writing — no need to wait for nightly consolidation to confirm it landed
- When you hit a stale fact, emit a `CORRECTION:` memorize and move on; trust that the librarian renders it

The "I just wrote it, I can't see it" feeling that drives agents to auto-memory is solved by `recent_memories` — your write shows up there within seconds. Use it; the wiki is not write-only.

### What NOT to memorize

- **In-task progress** ("started X", "found Y", "blocked on Z") — these go in `task-comment` on the task itself. The sensei reads task comments; future workers read them. Memorize is for *cross-task* knowledge.
- **Operational chatter** (registers, idle events, ack noise) — not for the wiki, not for memorize. Just don't capture.
- **Session-scoped notes** ("I should remember to do X in 5 minutes") — keep in your own head or in a task TODO. Memorize is forever.

The sharp test: *would I want to read this six months from now while working on a different task?* If yes → memorize. If no → task-comment or ignore.

## Stale data — what to do when you read something wrong

The wiki may say something out of date. Don't fix the wiki yourself (you can't — Edit/Write is denied). **Memorize the correction:**

```
memorize text="CORRECTION: bills.md says '<service> active' — actually cancelled 2025-11-03, see task #042."
```

The librarian picks up corrections on the next consolidation, updates the page, and logs the change in `log.md`. You don't have to do anything else.

This rule applies regardless of how you noticed the staleness — running into it during work, comparing two pages, or the user telling you in conversation. Always: memorize, move on.

**Optional: trigger an immediate consolidation.** When the user asks for the wiki to reflect a change *now* (rather than waiting for the nightly run), after memorizing the correction you can fire the consolidate-wiki trigger:

```
infra(method="POST", path="/triggers/consolidate-wiki/fire")
```

The fire endpoint returns immediately (the spawn is detached). The librarian runs Sonnet, integrates the new memorize event, swaps the wiki. ~2–5 minutes wall-clock for a small update. The `wiki-consolidated` event lands in your event stream when done. Use this when:
- The user wants to immediately see the wiki reflect a state change they just made
- A correction is load-bearing (e.g. bills/savings updates with money implications)

Don't fire the librarian for every memorize — let the nightly run handle routine updates.

## What the librarian does (FYI)

- Reads new `memory` events since its cursor
- Reads completed tasks and decides which contain durable knowledge worth distilling into the wiki
- Updates `.jean/context/` pages, the `index.md`, the `log.md`
- Performs an atomic swap so readers never see a half-written wiki
- Emits a `wiki-consolidated` event when done; sensei picks it up via the normal nudge cycle

You don't invoke the librarian directly. It runs on a schedule (default nightly).

## Quick reference

- Read wiki: open `.jean/context/index.md`, navigate from there
- Read pending memorize events: `infra GET /context/recent` — what's queued for the next consolidation
- Record knowledge: `memorize` (cross-task, durable)
- Record task progress: `task-comment` (task-scoped)
- Fix stale wiki content: memorize a `CORRECTION:` note; never edit directly
- The four homes: `raw_context/` (frozen captures) · wiki (distilled knowledge) · the repo the dojo owns (full-fidelity durable) · the task (ephemeral)
- Unsure where something belongs? Filing is the sensei's call — workers say so in a `reply`, senseis apply the filing rules in their skill
