---
name: context
description: >
  The reading map of where data lives in a dojo — four homes (raw_context /
  wiki / the repo the dojo owns / the task), one writer each — and how to use
  the persistent knowledge wiki at `.jean/context/`. Read on session start;
  search it via `/context/search` (default scope=all — an all-scope empty means
  definitively absent), navigate via `index.md`; record durable knowledge via
  `memorize`; never edit the wiki directly. Loaded by sensei and workers.
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

## Finding what the dojo knows — search first

**Reference reflex — verify, don't recall.** When the user names a dojo-specific thing you did NOT establish in THIS conversation — a protocol, "the usual", a proper-noun term, a place/dish/person, "like we discussed X", any callback — SEARCH it before you act. A confident recollection is the trigger to VERIFY, not skip: your in-context memory of a dojo term may be partial or stale, and that's exactly when it bites. Searching is cheap and an all-scope empty is trustworthy, so verifying costs ~nothing — and if it comes back empty, ASK rather than answer from a guess.

Before you browse the index or reach for `grep`, **search**. One call ranks every home of the dojo's memory at once:

```
infra GET /context/search?q=<terms>                    # default scope=all
infra GET /context/search?q=<terms>&topN=15            # widen the cut (default 5)
infra GET /context/search?q=<terms>&scope=knowledge    # narrow to one source on purpose
```

`scope` defaults to `all` — wiki pages + today's unconsolidated memories + task descriptions/comments + the human⇄agent conversation, ranked together (field-boosted BM25 + capped fuzzy). Every hit carries its `source`, the owning `page`/task, that page's description, a snippet centered on the matched line, and `matchedTerms` — which of your query's terms it actually matched. Read `matchedTerms` to reject a weak hit at a glance: a multi-word query can return something that matched only one incidental word.

**Empty on the default (all-scope) is definitive — stop, don't grep.** When an all-scope search returns `empty: true`, the topic is genuinely nowhere in the dojo's memory (wiki, memories, tasks, or conversation). That is the whole point of this tool: it makes one cheap search authoritative so you don't fall back to grepping the raw event log — a grep after an all-scope empty finds nothing the search didn't.

**The definitive-empty guarantee holds only for `scope=all`.** A *narrow*-scope empty rules out only that one source — `scope=knowledge` empty still leaves tasks and channel unsearched; `scope=tasks` empty still leaves the wiki. So: search the default (all); empty *there* → stop. Reach for a narrow scope only when you deliberately want a single source.

Browse the index (below) when you want to read a whole page, or when you don't yet have precise query terms. Reach for `grep` on the raw log essentially never — an all-scope empty has already told you it isn't there.

## Browsing the wiki — when you want to read, not search

Search (above) is how you *find* a fact. Browse the index when you instead want to *read* — orient at session start, read a whole page end-to-end, or when you don't yet have precise query terms:

- `.jean/context/index.md` — master TOC, one line per page (`- [[Page]] — <description>`), organized by category. The description often tells you enough without opening the page. Open the 1–3 pages that bear on your question; follow `[[wiki-links]]` to related pages when relevant. Don't read every file.
- `.jean/context/log.md` — append-only timeline of what changed when.

If the index is missing or empty (fresh dojo), proceed without it — consolidation builds it as memories accumulate.

Note on freshness: the wiki is last night's snapshot, but you don't need a separate tool to see today's memories — **search already includes memorize-events-not-yet-consolidated** (the `knowledge` scope, and therefore `all`). A fact you memorized minutes ago is findable by searching for it, before the nightly librarian run.

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

**Active use closes the loop.** The wiki feels alive when you treat it as one — search early and often, not just at session start:

- Search whenever you reach a "what do we know about X" moment (see "Finding what the dojo knows" above)
- To confirm a write landed: `memorize` returns the event id (proof it was recorded), and the fact is searchable immediately — the knowledge scope includes unconsolidated memories, so you don't wait for nightly consolidation
- When you hit a stale fact, emit a `CORRECTION:` memorize and move on; trust that the librarian renders it

The "I just wrote it, I can't see it" feeling that drives agents to auto-memory is answered twice over: the `memorize` call returns an id, and a follow-up search surfaces the fact within seconds. The wiki is not write-only.

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

- Search the dojo's memory: `infra GET /context/search?q=…` (default scope=all) — the first move for any lookup; an all-scope empty = definitively absent, stop there
- Read wiki: open `.jean/context/index.md`, navigate from there
- Read pending memorize events: `infra GET /context/recent` — what's queued for the next consolidation
- Record knowledge: `memorize` (cross-task, durable)
- Record task progress: `task-comment` (task-scoped)
- Fix stale wiki content: memorize a `CORRECTION:` note; never edit directly
- The four homes: `raw_context/` (frozen captures) · wiki (distilled knowledge) · the repo the dojo owns (full-fidelity durable) · the task (ephemeral)
- Unsure where something belongs? Filing is the sensei's call — workers say so in a `reply`, senseis apply the filing rules in their skill
