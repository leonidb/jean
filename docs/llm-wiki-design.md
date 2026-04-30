# LLM Wiki for Jean — Design

## Source and intent

Adapted from Andrej Karpathy's "LLM Wiki" pattern ([gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), April 2026). Goal: stay as close as possible to Karpathy's spec so the artifact is reusable and postable; augment only where Jean's multi-agent + event-sourced architecture genuinely needs it.

**Non-goals**: embeddings, vector DBs, external memory services (Mem0, Letta, etc.), human-in-loop per ingest. Pure index-first navigation over plain markdown, sensei is the LLM.

---

## Part 1 — Karpathy's pattern (verbatim shape)

### Three layers
1. **Raw sources** — immutable documents you curate. The LLM reads but never modifies.
2. **The wiki** — LLM-generated markdown. Summaries, entity pages, concept pages, cross-references. The LLM owns this layer entirely.
3. **The schema** — a config doc (e.g. `CLAUDE.md`) describing wiki structure, conventions, and the workflows the LLM follows for ingest / query / lint.

### Two anchor files
- **`index.md`** — content-oriented catalog. Every page listed with a link, a one-line summary, optional metadata (date, source count). Organized by category (entities, concepts, sources, themes). Updated on every ingest.
- **`log.md`** — append-only operational record. Suggested format `## [YYYY-MM-DD] operation | title`. Timeline of the wiki's evolution.

### Three workflows
- **Ingest** — read source → discuss key takeaways → write a summary page → update `index.md` → update related entity / concept pages → append to `log.md`. *"A single source might touch 10–15 wiki pages."*
- **Query** — search index → read relevant pages → synthesize with citations. Good answers can be filed back as new pages.
- **Lint** — periodic health check. Find contradictions, stale claims, orphan pages, missing cross-references, important concepts lacking dedicated pages, data gaps.

### Conventions
- Wiki-links: `[[Page Name]]`
- YAML frontmatter optional
- Citations required (format unspecified — Karpathy leaves it open)
- Wiki = a git repo of markdown

### Scaling
- Index-only navigation works at *"~100 sources, ~hundreds of pages"*.
- Beyond that, optional CLI tools like `qmd` (BM25 + vector + LLM rerank) layer in.

### Karpathy's framing principle
> *"The tedious part of maintaining a knowledge base is not the reading or the thinking — it's the bookkeeping. Updating cross-references, keeping summaries current, noting when new data contradicts old claims, maintaining consistency across dozens of pages. Humans abandon wikis because the maintenance burden grows faster than the value. LLMs don't get bored, don't forget to update a cross-reference, and can touch 15 files in one pass."*

---

## Part 2 — Jean's adaptations

Each adaptation below either fills a gap (Karpathy is single-user, human-driven) or fits Jean's existing primitives (events, triggers, peek). Where Karpathy is silent, we make a choice and mark it explicitly.

### Adaptation 1 — Event log as the raw inbox (memorize events + completed tasks)

**Karpathy**: human drops files into a `raw/` folder.

**Jean**: two kinds of inputs flow through the event log, both consumed by the librarian:

1. **Explicit `memory` events** — agents call infra `POST /context/memorize` to write a `memory` event to `history.jsonl`. Used for cross-task knowledge that should outlive the task it was discovered in.
2. **Completed tasks** — `task-update` events with `status: done`. The librarian inspects each task's content (description, curated `task-comment` events, final `reply` chain) and decides whether the task contains durable knowledge worth distilling into wiki pages.

The line between them: in-task progress / per-task findings stay in `task-comment` events on the task. Memorize is reserved for knowledge useful in *other* tasks. If you'd want to read it next month while working on something different, memorize it; otherwise it lives on the task.

The event log *is* the raw inbox. Both kinds of input are timestamped, attributed, and append-only.

```
memory event payload:
  { type: "memory", agent: "sensei", role: "sensei" | "worker" | "peer",
    text: "...", scope?: "dojo" | "user", taskId?: "..." }
```

**How agents call it**: via the existing `infra` MCP tool — `infra(method="POST", path="/context/memorize", body={text, scope?, taskId?})`. **No new MCP tool by default.** Adding a dedicated `memorize` tool to the channel plugin (alongside `reply`, `send`, `comment`) is a possible upgrade if direct discoverability matters in practice — defer until we observe agents skipping memorize because it's not visible enough.

**Who can memorize**: all agents — workers, sensei, peer-bridge alike. The event payload's `role` field lets the consolidator distinguish *memories from a worker* (field reports / findings) from *memories from sensei* (decisions / synthesis / orchestrator-level observation) from *memories from peers* (inbound advice from another dojo). Single-writer-per-wiki still holds: sensei is the only *consolidator*; workers and peers are *contributors* to the event log only.

**Why**: agents capture continuously during work. The event log gives free temporal context (timestamp, surrounding events, originating agent and role).

The event log is **the source of truth**. Wiki pages are a derived projection. If the wiki is ever wrong, you can rebuild from the event log; the reverse is not true.

### Adaptation 2 — Trigger-fired ingest, not per-source human-driven

**Karpathy**: *"Personally I prefer to ingest sources one at a time and stay involved."*

**Jean**: a Jean trigger fires a `consolidate-wiki` prompt at sensei nightly. Sensei runs the consolidator skill — reads new memory events since cursor, updates the wiki autonomously. The human reviews after the fact (the wiki is always readable; the log shows what changed).

We diverge from Karpathy here because Jean is multi-agent and operational — agents emit memories during normal work; pausing for human review per memory would defeat the point.

**Cadence**: nightly is the default (e.g. `0 3 * * *`). Per-dojo override via `jean trigger`.

**Catch-up on startup**: when infra starts, it reads `.jean/context/.cursor.json` and checks `lastConsolidatedAt`. If older than the scheduled cadence (e.g. >24h for nightly), it fires consolidator immediately, then resumes the normal schedule. Handles the case where the machine was off when the trigger was supposed to fire. Small addition to the trigger system; not a redesign.

### Adaptation 3 — Cursor for progress tracking

**Karpathy**: `log.md` is informal; no formal cursor over what's been processed.

**Jean**: `.jean/context/.cursor.json`:

```json
{
  "lastEventId": 4231,
  "lastConsolidatedAt": "2026-04-28T09:32:11Z"
}
```

Consolidator reads memory events with `id > lastEventId`, processes them, then advances the cursor *at the end* of a successful run. Restartable — if consolidator crashes mid-run, next run reprocesses from the same cursor.

### Adaptation 4 — Concurrency model

The event log is append-only. New `memorize` events flow in continuously; the cursor moves monotonically. So:

- Consolidator reads up to `maxEventId` at start of run.
- New memorize events keep landing in the log during the run — they get the *next* run.
- Cursor advances at successful end. If the run fails, cursor stays put; next run retries the same range.
- Trigger overlap: if a `consolidate-wiki` trigger fires while sensei is still running the previous one, sensei is busy — the second nudge queues naturally (Jean's existing behavior). No explicit lock needed.

**No locking required**. The append-only event log + monotonic cursor + single-writer-per-dojo (sensei) gives this for free.

### Adaptation 5 — Recall (read), and read-write asymmetry

**Karpathy**: human queries the LLM, which reads index → pages → synthesizes.

**Jean MVP**: same — sensei (or any agent) reads `.jean/context/index.md` and navigates via the `Read` tool. No `recall()` tool needed at first. Framework `context` skill instructs on the navigation pattern.

**Read-write asymmetry — the load-bearing rule.** Reading is open; writing is single-source.

| Role | Read wiki | Memorize | Update wiki |
|---|---|---|---|
| Worker | ✓ | ✓ | ✗ |
| Sensei | ✓ | ✓ | ✗ |
| Librarian (new role) | ✓ | ✓ | ✓ |

Permissions enforcement:
- All roles get `Read(<dojo>/.jean/context/**)` in `defaultPermissions`.
- Sensei + worker get explicit `deny` on `Edit/Write(<dojo>/.jean/context/**)`.
- Librarian role gets allow on `Edit/Write(<dojo>/.jean/context/**)` (or, equivalently, exclusive access to the `wiki_update` MCP tool that goes through infra).

This means **direct edits are blocked at Claude Code's permission layer for sensei + workers** — not soft skill discipline. The deny is enforced before the tool call resolves.

**Planned framework feature — `recall(query)` MCP tool**: wraps the index-first navigation as a single tool call. Key value prop: **cheaper-model summarization**. The recall tool calls out to a smaller/cheaper model (e.g. Haiku) for the read+summarize step, while the calling agent stays on Sonnet/Opus. Faster and cheaper than having the parent model load every wiki page into its own context. This is a user-visible product feature for any framework consumer running a multi-agent setup, not a personal optimization — a multi-agent system that recalls efficiently is materially cheaper to operate than one that doesn't. Slated for v2.

### Adaptation 6 — Lint as scheduled trigger

Same shape as ingest: a Jean trigger fires `lint-wiki` (e.g. weekly). Librarian (not sensei) runs the lint skill; reads index + all pages; looks for Karpathy's checklist (contradictions, stale claims, orphans, missing cross-refs); reports findings into `log.md` and (optionally) sends a summary `reply` to sensei so it surfaces in the next nudge.

### Adaptation 7 — Librarian as headless Claude + atomic symlink swap

**Why headless, not a persistent agent.** Sensei in normal mode handles events, dispatches tasks, talks to the human. Consolidation/lint can be long (read all events since cursor + read every wiki page + write 10–15 pages). If sensei did this work, it'd be blocked for the duration. So consolidation runs in a dedicated *headless* librarian process — ephemeral, started by the `consolidate-wiki` trigger, exits when done.

**Headless** means `claude -p "<prompt>"` (or via the Claude Agent SDK) — no interactive terminal, no WebSocket registration with infra, no idle state, no worktree directory. The librarian process is spawned by infra, does its work, exits. Compared to a persistent registered agent: lower resource cost (one process for minutes/day instead of always-on), no duplicate-session guard needed (fresh session each run), doesn't appear in `jean agent list`.

**How a consolidation run works:**
1. `consolidate-wiki` trigger fires. Infra spawns a headless Claude:
   ```bash
   claude -p "$(consolidator-prompt)" \
     --allowed-tools "Read,Edit,Write,Bash" \
     --mcp-config <jean-mcp-config-for-librarian>
   ```
   With librarian-role permission config (read/write on `.jean/context-*/**`, deny everywhere else).
2. Headless Claude loads the `consolidate-wiki` skill, reads cursor at `.jean/.consolidator/cursor.json`, fetches new memory events.
3. Builds the next wiki version in `.jean/context-B/` (or `-A/`, whichever is currently inactive — built from a copy of the active version with edits applied).
4. On success: atomic symlink swap (below); writes new cursor; emits a `wiki-consolidated` event via infra HTTP with a summary (`{ pagesUpdated: N, corrections: M, tasksDistilled: K, anomalies: [...] }`). Sensei picks it up in its normal event-processing nudge cycle. No special librarian→sensei channel.
5. Exits with code 0. Infra captures stdout/stderr for logging.

**Staging + two-rename swap.** Steady state is dirt-simple: one real `.jean/context/` directory. The librarian builds the next version under `.jean/.consolidator/staging/` and swaps it in via two renames at the end of a run:

```
Steady state:
.jean/
  context/                  # real dir — what users edit, what readers see
  .consolidator/
    cursor.json             # bookkeeping (last processed event id)

During a librarian run:
.jean/
  context/                  # unchanged until the swap; readers see the old version
  .consolidator/
    cursor.json
    staging/                # librarian's working copy + edits

Swap (end of run):
  mv .jean/context           .jean/.consolidator/old-<ts>
  mv .jean/.consolidator/staging  .jean/context
  rm -rf .jean/.consolidator/old-<ts>
```

This is **not strictly atomic** — there's a microsecond gap between the two renames where `.jean/context/` doesn't exist. A concurrent reader would get `ENOENT` and need to retry. In practice this is invisible (reads are rare; nightly runs only) and the steady-state simplicity is worth the trade. We picked this over a persistent symlink + A/B dir layout because:
- Users see exactly one normal directory at `.jean/context/`. No symlinks, no `ls .jean/` clutter.
- `vim .jean/context/foo.md` just works; no editor weirdness on save.
- `git diff` is clean; no symlink quirks.
- Cross-platform without Windows symlink-permission caveats.

The crash-mid-swap window is the one real concern. Mitigation: a deterministic **recovery routine** runs before every librarian invocation. It checks for orphan `staging/` or `old-*/` directories and either restores or cleans them up before the librarian's LLM ever runs. See "Recovery" below.

**Recovery from mid-swap crash.** If the librarian crashes between the two renames, the dojo is in one of these states:

- `context/` missing, `staging/` present → librarian had built the new version but hadn't swapped yet. Recovery: `mv staging → context`. New version wins.
- `context/` missing, `old-<ts>/` present → first rename succeeded, second hadn't. Recovery: `mv old-<ts> → context`. Restore the previous good version.
- Both `context/` and `old-<ts>/` present → swap was already complete; the rm-rf hadn't run. Recovery: `rm -rf old-<ts>/`.

The recovery routine runs **before** every librarian spawn (in `src/infra/librarian.ts`, deterministically, no LLM involvement). After recovery, `.jean/context/` is guaranteed to exist as a real directory with intact content.

**Manual user edits — valid and welcome, but NOT immortal.** The wiki is a projection of events; user edits are a *strong prior*, not an unkillable veto. Rules:
- User edits get carried forward on the next run when the librarian copies `.jean/context/` to `staging/`.
- **The librarian may update them** if new memory events or completed-task evidence contradicts the user's content. Wiki content goes stale; the librarian's job is to keep the projection current.
- Where new evidence is silent, the user's framing is preserved (don't rewrite unprompted).
- The preferred way to update wiki state isn't direct file editing — it's telling sensei. Sensei memorizes the change and (optionally) fires the consolidate-wiki trigger immediately. That keeps the event log as the canonical record of what changed and why.
- Soft convention: don't edit while librarian is mid-run (a few minutes, once a night). If you do, your edit might be in `.jean/context/` while librarian builds `staging/` from an earlier snapshot — your edit gets carried forward in the *next-next* run rather than this one. Practically harmless.

**Failure handling.** If librarian crashes mid-run: the symlink still points at the previous good version (production unchanged); the scratch directory may have garbage that gets cleaned on next run's start. Cursor doesn't advance, so retried. No corruption window.

**Stale data — what an agent does when it reads something wrong.** Don't fix the wiki — emit a memorize event noting the discrepancy:

```
memorize("CORRECTION: bills.md says 'gym membership active' — actually cancelled 2025-11-03, see task #042")
```

Librarian picks it up next consolidation, updates the page, logs the correction. Same primitive, no new verb needed. Framework `context` skill says this explicitly so workers and sensei know the protocol.

### Adaptation 8 — Schema = framework `context` skill

**Karpathy**: a `CLAUDE.md` per wiki, co-evolved with the LLM.

**Jean**: a *framework* `context` skill at `src/cli/skills/context.md`, shipped with Jean and synced into every dojo's sensei. The skill encodes:
- File structure (`index.md`, `log.md`, page conventions)
- Wiki-link + frontmatter + citation conventions
- The three workflows (ingest, query, lint) — what to do, when, what to update
- The cursor protocol

This means the schema is *generic* across dojos — different dojos have different content, but the same conventions. work-dojo's existing `context` skill is the best reference; we lift the generalizable parts.

Per-dojo schema specialization (if needed) goes in the dojo's own playbook or a thin wrapper skill that loads the framework one. Default: no per-dojo specialization required.

### Adaptation 9 — `raw_context/` folder for human-curated source material

**Karpathy's original** had a `raw/` folder for "articles, papers, images, data files" — immutable sources the LLM reads but never modifies. We deferred this in MVP because Jean's primary input is the event log (memorize + completed tasks). But there's a real gap: source material that doesn't fit an event payload (PDFs, CSVs, screenshots, exported data, long pre-existing docs) has nowhere to live without being reinvented as `<dojo>/sources/`-style ad-hoc folders.

**Layout** (`raw_context/` as a sibling to `context/`, NOT nested):

```
.jean/
  raw_context/                      # human-curated, librarian reads, never writes
    payments-export.csv
    sources/                        # subdirs ok — Karpathy-style
      bills-archive.pdf
      ...
  context/                          # librarian-managed wiki
```

**Lifecycle (matches Karpathy)**: files in `raw_context/` are **permanent and immutable** from the librarian's perspective. Humans curate (add, edit, occasionally remove). The librarian reads but never moves, deletes, or modifies them.

**Tracking what's been processed — mtime cursor:** symmetric to the existing event cursor.

```jsonc
// .jean/.consolidator/cursor.json
{
  "lastEventId": 710,
  "lastConsolidatedAt": "2026-04-30T03:00:00Z",
  "lastRawConsolidatedAt": "2026-04-30T03:00:00Z"  // NEW
}
```

On each librarian run:
```bash
find .jean/raw_context -type f -newermt "$LAST_RAW_CONSOLIDATED_AT"
```
Only files modified since the last run get reprocessed. After a successful run, advance `lastRawConsolidatedAt` to the run's start time. This handles re-edits naturally (a user updating a CSV with a new month triggers reprocessing).

**Permissions:**
- All roles: `Read(.jean/raw_context/**)` allow (humans + agents read freely).
- Sensei + workers: no special deny on `raw_context/` (they're free to drop files there as part of normal work).
- Librarian: `Read(.jean/raw_context/**)` only — never writes there. The deny on `Edit/Write(.jean/raw_context/**)` is enforced explicitly to prevent the librarian from modifying source material.

**Binary file handling — deferred.** Markdown / plain-text files in `raw_context/` are processed natively (librarian uses `Read`). Binaries (PDFs, XLSX, PNGs, CSVs) need conversion tooling (`pdftotext`, `xlsx2csv`, OCR). For MVP:
- Librarian *lists* binary files in the wiki (`raw_context/sources/bills-archive.pdf — referenced source`)
- Librarian doesn't try to extract content from them
- If the user wants binary content distilled, they convert to markdown manually before dropping into `raw_context/`, or wait for a future "raw-extract" capability

**Detection of deletions/renames:** mtime cursor doesn't catch them. If a user deletes a file referenced in the wiki, the librarian flags it as an orphan reference on next lint pass, but doesn't auto-act. Acceptable trade for MVP.

**Skill changes** — `consolidate-wiki.md` step 2 (Read inputs) gains a sub-step: "find new/modified `raw_context/` files since cursor; for each, decide whether to update wiki." Step 7 (cursor advance) updates `lastRawConsolidatedAt` along with `lastEventId`.

**Migration story for an existing dojo:** `<dojo>/sources/*.{pdf,csv,png,xlsx}` → `.jean/raw_context/sources/`. Then librarian on next run will see them as new (mtime > cursor) and reference them in the wiki. The two prose docs `digital/audit-notes.md` + `digital/cleanup-notes.md` are different — they're authored knowledge, belong directly in `.jean/context/` as user-edited pages.

### Adaptation 10 — Cross-dojo composition (free via peek)

`memory` events are events; `jean peek <other-dojo>` already reads them. Consolidated wiki pages are markdown; also peek-friendly. So an overseer dojo can read another dojo's wiki and event log without further work.

User-layer memory (facts about *you* that should span all dojos) is a separate, deferred design. Sketch: tag `memorize` events with `scope: "user"`; a top-level consolidator reads those across all peek-able dojos and writes to `~/.jean/identity/`. Out of scope for this design.

---

## Part 3 — How it works together

### Memory lifecycle

1. Sensei (or any agent, but mostly sensei) observes something worth keeping during a task. Calls `memorize("Gym membership cancelled, ~$45/mo saved", scope: "dojo")`.
2. Channel plugin → infra `POST /context/memorize` → infra writes a `memory` event to `history.jsonl`.
3. Time passes; more `memory` events accumulate.
4. `consolidate-wiki` trigger fires (e.g. nightly). Sensei nudge arrives.
5. Sensei runs the consolidator skill: reads `.jean/context/.cursor.json`, reads memory events with `id > lastEventId` from `history.jsonl`.
6. For each new event, optionally reads the surrounding events (within ±N events or ±M minutes) to add temporal context — the LLM uses this when deciding which page(s) to update.
7. Sensei updates / creates entity / concept pages in `.jean/context/`, updates `index.md`, appends an entry to `log.md`, advances the cursor.
8. Next time sensei needs to recall something, it reads `index.md` first, navigates to relevant pages, synthesizes.

### Recall lifecycle (today, no tool)

1. Human asks sensei "what did we do about subscriptions?"
2. Sensei reads `.jean/context/index.md`.
3. Identifies relevant pages (e.g. `[[Subscriptions]]`, `[[Gym membership]]`, `[[Bills]]`).
4. Reads them.
5. Replies with synthesis + citations to wiki pages.

### Lint lifecycle

1. Weekly trigger fires `lint-wiki`.
2. Sensei reads `index.md` + every linked page.
3. Reports issues (contradictions, orphans, stale, missing cross-refs) into `log.md` under `## [YYYY-MM-DD] lint | findings`.
4. Optionally flags critical issues for the human in the next nudge.

---

## Part 4 — File structure

```
.jean/
  history.jsonl                          # event log — memory events live here, mixed with operational
  .consolidator/                         # implementation detail (hidden from default file listings)
    cursor.json                          # last processed memory event id (bookkeeping, NOT knowledge)
    staging/                             # exists only during a librarian run; copy of context + edits
    old-<ts>/                            # exists only briefly mid-swap; cleaned up at end of run
  context/                               # real dir, the wiki — what users and agents read
    index.md                             # master TOC (Karpathy)
    log.md                               # operation timeline (Karpathy)
    <pages>.md                           # entity / concept / source pages (Karpathy)
```

User-facing path is just `.jean/context/` — a normal directory containing `index.md`, `log.md`, and pages (the standard Karpathy layout). No symlinks visible; `cd .jean/context && pwd -P` returns the expected path.

The `.consolidator/` directory holds bookkeeping (cursor) and transient working state (`staging/`, `old-<ts>/`). It's empty between runs except for `cursor.json`. Leading-dot hides it from default file listings.

Bookkeeping lives outside the wiki so the deny rule on `.jean/context/**` stays clean: bookkeeping is not knowledge.

**No `raw/` folder in MVP.** The event log is the single source of truth for inputs to consolidation. We diverge from Karpathy here because the dominant Jean use case is "agents capture in-flight observations" (event-log-shaped) rather than "human imports articles/PDFs" (file-shaped).

`raw/` becomes useful when you want to import long external documents — articles, reports, PDFs, exports — that are too big to fit a memorize event. **Defer until needed.** When added later: `raw/` lives alongside `index.md` / `log.md`; consolidator reads both event log (since cursor) and unprocessed files in `raw/` (tracked separately, e.g. by file move or a `.processed/` subfolder).

Karpathy uses `raw/` because most of his ingest flow is "clip an article, drop it in." Our default is "agent observed something, called memorize." Different shapes, different defaults.

---

## Part 5 — Open questions / what's missing

### Decided (before code)

1. **Trigger cadence**: nightly default, per-dojo override via `jean trigger`.
2. **Catch-up on startup**: if `lastConsolidatedAt` older than cadence, fire on infra start, then resume schedule.
3. **Who can memorize**: all agents (workers, sensei, peer-bridge). `role` field on event lets librarian weight differently.
4. **Who consolidates**: a *headless Claude* librarian process — NOT sensei, NOT a persistent registered agent. Spawned by trigger, exits when done. Avoids blocking sensei during long consolidations and avoids always-on resource cost.
5. **memorize tool surface**: no dedicated MCP tool in MVP — agents call via existing `infra` tool with `POST /context/memorize`. Upgrade only if discoverability bites.
6. **`raw_context/` folder**: not in MVP; event-log-only. Design for the future implementation lives in Adaptation 9.
7. **Recall reads only the consolidated wiki**, never the raw event log directly.
8. **Read-write asymmetry**: workers + sensei get `Read` on `.jean/context/`, deny on `Edit/Write`. Librarian is the only writer. Permissions enforced at Claude Code's permission layer, not skill discipline.
9. **Stale-data protocol**: if any agent reads the wiki and sees something wrong, emit a `memorize` event flagging the discrepancy. Librarian reconciles on next consolidation. No special "correction" primitive.
10. **Swap pattern**: `.jean/context/` is a real directory in steady state. Librarian builds the next version under `.jean/.consolidator/staging/`, then swaps via two renames (`mv context old-<ts>; mv staging context; rm -rf old-<ts>`). Brief microsecond gap between renames is acceptable for once-a-night use. A pre-spawn recovery routine handles mid-swap crashes deterministically before any librarian LLM runs.
11. **Manual user edits**: valid and encouraged. Librarian preserves them across consolidations, treats unattributed content as human-authored, runs a conservative lint that only "fixes" things traceable to memorize events or clear contradictions.

### Still open

1. **What gets memorized**: policy lives in the framework `context` skill.
   - **In-scope** (memorize): cross-task knowledge — patterns, conventions, decisions, durable findings. The kind of thing you'd want to read next month while working on something different.
   - **Out of scope** (use task-comment instead): in-task progress, per-task findings, status updates. These live on the task.
   - **Out of scope** (don't capture at all): operational chatter — registers, acks, idle events.
2. **Bootstrap**:
   - If `.jean/context-A/` doesn't exist: librarian creates it with starter `index.md` and `log.md`.
   - If `.jean/context` symlink doesn't exist: create pointing at `context-A/`.
   - If `.jean/context/` already exists with content (e.g. work-dojo's populated wiki): preserve existing pages, run a one-time scan on first run to build/refresh `index.md` from them, then proceed normally.
   - Behavior is idempotent — every run checks state and fills gaps.
3. **Schema clarification**: Karpathy's "schema" = the conventions of this particular wiki (file structure, wiki-link format, frontmatter fields, citation style, page categories, workflows). In Jean it's the framework `context` skill itself — the skill prose IS the schema. Per-dojo customization for MVP: edit the dojo's copy of the skill. Wrapper-skill mechanism only if multiple dojos genuinely diverge.
4. **Recall as MCP tool vs direct read**: deferred. Direct-read for now; upgrade trigger spelled out in Adaptation 5.
5. **Cross-dojo user-memory layer**: separate design, sketch noted in Adaptation 10.
6. **Librarian failure recovery**: if librarian crashes mid-run, the inactive `context-X/` dir may have garbage; the symlink still points at the previous good version (production untouched). Cleanup-on-next-run is sufficient for MVP.

---

## Part 6 — What's shared with Karpathy vs what's Jean-specific

| Layer | Karpathy | Jean |
|---|---|---|
| Three layers (raw / wiki / schema) | ✓ | ✓ |
| `index.md` + `log.md` | ✓ | ✓ |
| Wiki-link + frontmatter conventions | ✓ | ✓ |
| Three workflows (ingest / query / lint) | ✓ | ✓ |
| Wiki = git repo of markdown | ✓ | ✓ |
| Index-first navigation, no embeddings | ✓ | ✓ |
| Raw inbox = files dropped in `raw/` | ✓ | optional secondary path |
| Raw inbox = event log + `memorize` tool | — | ✓ (primary) |
| Human-driven ingest, per-source review | ✓ (Karpathy's preference) | — |
| Trigger-fired autonomous ingest | — | ✓ |
| Formal cursor over event stream | — | ✓ |
| Single-writer concurrency model | — | ✓ (sensei only) |
| Schema = per-wiki `CLAUDE.md` | ✓ | replaced by framework `context` skill |
| Cross-dojo composition | — | ✓ (via peek) |
| Single writer = sensei | — | ✓ but sensei is *contributor*, librarian is the writer |
| Librarian as headless Claude (not persistent agent) | — | ✓ |
| Swap on consolidation | — | ✓ (staging + two-rename; pre-spawn recovery for mid-swap crash) |
| Read-deny on wiki for non-librarian | — | ✓ (Claude Code permission layer) |
| Manual user edits to the wiki | ✓ (always allowed) | ✓ (preserved across consolidations) |

---

## Part 7 — Postability (what to share)

Anyone who wants to apply this without Jean takes Part 1 verbatim — that's pure Karpathy. Anyone with an event-sourced multi-agent framework can lift Parts 2–4 — those are Jean's adaptations. Part 5's open questions surface as live design notes; Part 6 is the diff for someone deciding whether Jean's adaptations apply to their framework. The whole document doubles as a blog post / forum post when ready.

---

## Implementation sequence (proposed)

1. **Memorize endpoint**: add `POST /context/memorize` to infra; emit `memory` event with `agent`, `role`, `text`, `scope`, `taskId`. ~30 min.
2. **Permissions**: extend `defaultPermissions(role)` — sensei + worker get `Read(<dojo>/.jean/context/**)` allow + `Edit/Write` deny. Librarian-role permission set (used by the headless spawn) gets full read/write on `.jean/context/**` and `.jean/.consolidator/**`. ~30 min.
3. **Librarian-spawn capability in infra**: code path that, on `consolidate-wiki` trigger, spawns headless Claude (`claude -p`) with librarian-role permissions + the consolidate-wiki skill loaded. Captures stdout/stderr for logging. **Infra-owned; no user-facing command.** ~1–1.5 hours.
4. **Framework `context` skill** at `src/cli/skills/context.md`: Karpathy conventions + memorize-vs-task-comment protocol + stale-correction protocol + the navigation/recall pattern. Loaded by sensei + workers. ~1–2 hours.
5. **Consolidator skill** at `src/cli/skills/consolidate-wiki.md`: the librarian's procedure — read cursor, fetch new memory events + completed-task events, distill into wiki pages, lint, atomic symlink swap, advance cursor, emit `wiki-consolidated` event with summary. ~2–3 hours.
6. **Catch-up logic in trigger system**: on infra start, fire missed `consolidate-wiki` trigger if cadence exceeded. ~1 hour.
7. **Trigger config in the first dojo**: `jean trigger create consolidate-wiki ...` nightly. ~5 min.
8. **Test in the first dojo**: run for 1–2 weeks. Cleaner test bed than work-dojo (no existing dojo-specific `context` skill to reconcile, no populated wiki). Observe wiki growth, lint findings, recall quality, librarian run duration.
9. **Iterate** the framework skills based on what we learn.

(work-dojo's existing dojo-specific `context` skill is left as-is for now; reconciliation will happen later, after the framework skill has settled in the first dojo. At that point the choice is to rename work-dojo's to disambiguate, or replace it by lifting useful bits into the framework.)

Lint comes for free from the consolidator skill — it's a step in the same procedure (read all pages, look for issues, edit them in the inactive `context-X/` before symlink swap).

Total first-cut: ~1 day of focused implementation, then live use to tune.

Each step's "done" criterion is **Layer-1/2 tests pass + skill works on one canned example** (see Test plan below).

---

## Test plan

Four layers, each catching different failure modes. Layers 1 and 4 ship alongside the corresponding implementation step; Layer 2 ships with the consolidator skill; Layer 3 begins after Layer 1+2 are green.

### Layer 1 — Mechanical, automated (Bun test suite)

Code-level, no LLM. Lives next to existing tests; runs in default `bun test`.

- **`POST /context/memorize`**: verify event payload shape (`agent`, `role`, `text`, `scope`, `taskId`); event lands in `history.jsonl`; returns event id.
- **Permissions deny**: sensei agent attempting `Edit` on `.jean/context/index.md` is denied. Same for worker. Librarian-role permission set allows it.
- **Atomic symlink swap**: tight-loop reader vs. swap-in-progress; reader never sees a missing file or partial page.
- **Cursor mechanics**: cursor advances only on successful run; crash-during-run leaves cursor unchanged.
- **Bootstrap states**:
  - empty (no `.consolidator/`) → librarian creates wiki-a + symlink + starter `index.md`/`log.md`
  - existing-populated (wiki-a has pages, no index) → preserved, index regenerated
  - half-state (wiki-a exists, no symlink) → repaired
  - symlink to missing dir → repaired
- **Trigger catch-up**: fake `lastConsolidatedAt` 25h ago; on infra start, `consolidate-wiki` fires immediately.
- **Manual-edit preservation**: write a page directly into wiki-a; run a no-op consolidator; new active dir contains the page unchanged.

Approx 5–8 tests.

### Layer 2 — LLM-in-loop, scripted

The consolidator + recall flows need a real LLM but should still be regression-testable.

- **Skill-level smoke test**: run the consolidator skill in headless Claude with a known set of memorize events. Assert *structurally* (not on content): index.md exists and lists all pages; log.md has a new entry; every page referenced in index.md exists; no orphan files.
- **Fixture replay**: `tests/fixtures/wiki/` holds canned `(events, expected structure)` pairs. Each fixture: a list of memorize events + completed-task events + an expected output structure (page count, index entries, no orphans). Snapshot-test the index. Skip content equality (LLM is non-deterministic; structural checks catch regressions without flaking on prompt changes).

Lives in a separate target — `bun run test:wiki` — because each run is a real LLM call ($cost, ~minutes). Not in default `bun test`.

### Layer 3 — Real-use observation

Validates the things only real use exposes. Track week-over-week in `docs/wiki-test-log.md`:

- **Wiki content quality**: read 5 random pages weekly. Are they accurate? Useful? Synthesized vs paste-job?
- **Recall feels useful**: when sensei reads `index.md` to answer a real question, does it find the right pages? (observe live sessions)
- **Lint catches real issues**: read what lint flags. Accurate or noise?
- **No surprise data loss**: manual edits survive; no pages mysteriously disappear; no garbage `wiki-b/` left over.
- **Trigger reliability**: `wiki-consolidated` event in `history.jsonl` every night.
- **Run duration & cost**: how long does each consolidation take? Tokens per run?

Stop the test if any of the above regresses. Iterate the consolidator skill if quality issues show up.

### Layer 4 — Failure-mode tests (Bun, explicit)

Things that go wrong, that we should prove handle gracefully:

- Librarian crashes mid-consolidation (`kill -9`) → next run cleans up, retries from same cursor; production wiki untouched.
- Two librarian processes spawn simultaneously → second exits cleanly or waits; no double-write.
- Symlink already exists pointing nowhere (corrupted state) → repair on startup.
- `wiki-b/` left over from previous failed run → cleared at start of next run.
- Memorize event with garbage text (empty / whitespace-only) → consolidator skips, doesn't crash.
- Disk full mid-write → consolidator fails cleanly; cursor untouched; retries next trigger.

These ship alongside the librarian-spawn capability (Step 3) and consolidator skill (Step 5).

### Test ordering vs implementation steps

| Step | Layer 1 tests | Layer 2 tests | Layer 4 tests |
|---|---|---|---|
| 1. Memorize endpoint | ✓ payload, event recording | — | — |
| 2. Permissions | ✓ deny enforcement | — | — |
| 3. Librarian-spawn | ✓ spawn + capture | — | ✓ crash, race, corrupted state |
| 4. Framework `context` skill | — | — | — |
| 5. Consolidator skill | ✓ atomic swap, cursor, bootstrap, manual-edit | ✓ smoke + fixture replay | ✓ garbage events, disk full |
| 6. Trigger catch-up | ✓ catch-up firing | — | — |
| 7. Trigger config | — | — | — |
| 8. Test in the first dojo | — | — | Layer 3 begins here |
