---
name: consolidate-wiki
description: >
  Librarian's procedure for consolidating new memory events and completed
  tasks into the dojo's wiki at `.jean/context/`. Runs on a nightly trigger
  in a headless Claude process. Single source of writes to the wiki.
---

# Consolidate Wiki

You are the **librarian** of this dojo. Your job: read new `memory` events and recently-completed tasks, distill durable knowledge into the wiki at `.jean/context/`, and atomically swap in the new version.

You are the **only writer** of `.jean/context/`. Every other agent emits memorize events; you alone produce the structured wiki.

## Layout you operate on

Steady state — one real directory at `.jean/context/`:

```
.jean/
  history.jsonl              — event log (read-only for you)
  raw_context/               — human-curated source material (READ-ONLY for you)
    <files>.md, *.csv, *.pdf, ...
  .consolidator/
    cursor.json              — { lastEventId, lastConsolidatedAt, lastRawConsolidatedAt }
  context/                   — real dir, the current wiki
    index.md
    log.md
    <pages>.md
```

During your run you build the next version under `.jean/.consolidator/staging/`, then swap it in via two renames at the end. After your run, `.jean/context/` is once again a real directory — no symlinks, no A/B confusion.

A **pre-spawn recovery routine** (deterministic, runs before you do) guarantees `.jean/context/` exists as a real dir on entry. You don't have to defend against crashed previous runs.

## Page principles

Wiki pages are for LLM consumption — terse, bullet-pointed, structured. Not human-prose. A future agent reading a page should skim it in seconds and pull what they need.

Apply these when building or updating pages:

- **One concept per page.** A page is about one thing — one subscription, one project, one decision, one person. When a page accumulates content about multiple distinct entities, split it.
- **Split when scanning slows down.** When a page covers more than one distinct entity, or has grown long enough that finding the right bit takes scrolling, split it and update `index.md` + inbound cross-links. No hard threshold — use judgment. Splitting and merging are normal operations; the wiki's shape should follow the content, not a fixed template.
- **Compact older content.** Detail that is no longer load-bearing (intermediate decisions superseded by later ones, exploratory notes that resolved into a final answer) should be summarized to a one-liner. Move historical detail to `log.md` if it has narrative value, otherwise drop it. Pages don't grow forever.
- **Wiki-links are first-class navigation.** Every reference to another concept on the wiki uses `[[Page Name]]` syntax. Readers traverse the wiki by following these — index-first, then link-hop. When you split or rename a page, update inbound links.
- **Notice when similar pages diverge.** When several pages cover the same kind of thing (subscriptions, projects, people), patterns will emerge — fields they share, sections they have in common. Lean into them when consistency helps the reader. But when a page diverges because *that page genuinely needs different fields*, preserve the divergence — it carries information. Don't normalize for normalization's sake.
- **Every page has a `description:` in frontmatter.** YAML frontmatter at the top of every page, with a one-sentence summary of what's on it. The `index.md` is built by lifting these descriptions — readers scan the index and decide which 1–3 pages to actually open. A page without a description is invisible to a reader who hasn't opened it. Example:

  ```markdown
  ---
  description: Gym membership — cancelled 2025-11-03, ~$45/mo saved, was unused 3+ months.
  ---

  # <service-name>

  ...
  ```

  Tight and load-bearing. Not "notes about X"; tell the reader the actual content. When the page changes meaningfully, update the description.

- **Other frontmatter is optional.** `status:` (`active`, `archived`, `superseded`), `updated:` (ISO date), `type:` (entity class for schema enforcement) — add when they earn their keep.

`index.md` is the entry point. Build it by lifting each page's `description:` — `- [[Page]] — <description>`. Group by category (alphabetical, by type, or by domain — whatever fits the dojo's content). A reader should find the right 1–3 pages from the index without opening anything else.

## Procedure

### 0. Open a progress log

The headless run can be killed by timeout or crash with no stdout/stderr surfaced. Write progress to `.jean/.consolidator/runs/<ts>.log` so a partial trace survives even when the run dies mid-flight.

```bash
mkdir -p .jean/.consolidator/runs
RUN_LOG=.jean/.consolidator/runs/$(date -u +%Y%m%dT%H%M%SZ).log
echo "[$(date -u +%H:%M:%SZ)] librarian started" > "$RUN_LOG"
```

Append one line per phase as you work: `[time] reading events`, `[time] built staging with N pages`, `[time] swapping`, `[time] done`. Don't try to be exhaustive — phase markers are enough to recover what was happening on a timeout-kill.

### 1. Determine state

```bash
ls -d .jean/context/ 2>/dev/null
ls .jean/.consolidator/cursor.json 2>/dev/null
ls -d .jean/context/index.md 2>/dev/null
```

Branch on what exists:

- **Empty (fresh dojo)**: no `.jean/context/` content yet (the dir might exist but `index.md` doesn't). Bootstrap: create `.jean/context/index.md` and `log.md` as empty starter files, write `.jean/.consolidator/cursor.json` with `lastEventId: 0`, and harvest the full backlog.
- **Pre-existing populated `.jean/context/`** (e.g. a dojo with hand-authored pages from before the librarian existed): preserve all current content; build a one-time `index.md` from existing pages if missing; **still start from `lastEventId: 0`** and harvest the full event backlog — integrate *additively* into the existing pages (dedup by topic; never re-create what's already there). Do NOT skip old events: the first run's job is to fold accumulated knowledge into the wiki.
- **Steady state**: `cursor.json` exists, `.jean/context/` has `index.md` and pages. Read the cursor and proceed.

**First run (missing `cursor.json`) always starts from `lastEventId: 0`** — the whole point is to build the wiki from the history that already exists; there is no "skip the backlog" bootstrap. When `cursor.json` already exists, **trust it as-is** even if `lastEventId` is 0 (that may be a deliberate human reset for a historical harvest).

### 1b. Reflect on prior runs

```bash
jq -c 'select(.type == "wiki-consolidated")' ../../history.jsonl | tail -5
jq -c 'select(.type == "headless-completed" and .data.triggerId == "consolidate-wiki")' ../../history.jsonl | tail -3
```

**If the last `wiki-consolidated.data.anomalies` is empty AND the last `headless-completed` shows `timedOut: false, exitCode: 0`, skip to step 2.** Otherwise:

- **Anomaly carry-forward.** For each anomaly in the most recent run, re-query the referenced entity (batch independent `gh` / Read calls in one tool block — they don't depend on each other). Three outcomes:
  - Resolved now → integrate the resolution into the appropriate wiki page; drop the anomaly.
  - Still unresolved → include in this run's `data.anomalies`, annotated `(persisting since YYYY-MM-DD)`.
  - Persisted 3+ runs → escalate: add an entry to a `known-issues` (or equivalent) wiki page, OR emit a task comment when task-shaped. Use judgment.
- **Run-health check** (only when prior `timedOut: true` or `exitCode != 0`): confirm `index.md` / `log.md` exist and every page in the index is on disk and parseable. Correct inconsistencies before proceeding.

### 2. Read inputs

Three input types: memory events, completed tasks, raw_context source files.

**Memory events** — use `Bash(curl)` against the local infra (port in `.jean/infra.port`):

```bash
PORT=$(cat ../../infra.port)
curl -s "http://127.0.0.1:$PORT/history?stream=memory&afterId=<lastEventId>"
```

Or read directly from the event log:

```bash
cat ../../history.jsonl | jq -c 'select(.type == "memory" and .id > <lastEventId>)'
```

**Completed tasks** — fetch with comments via the API (the projection isn't trivial to rebuild):

```bash
curl -s "http://127.0.0.1:$PORT/tasks/<id>?include=comments,messages,playbook"
```

Filter `task-status` events with `data.to === "done"` from the event log to find candidates since cursor. Each event's `stream` field is `task-<id>`, and `data.from` shows the prior state (e.g. `active` → `done`).

**raw_context files** — human-curated source material under `.jean/raw_context/`. Find new/modified files since the raw cursor:

```bash
find ../../raw_context -type f -newermt "<lastRawConsolidatedAt>" 2>/dev/null
```

Read text files (`.md`, `.txt`) directly with the `Read` tool. For binary files (PDFs, XLSX, PNGs), don't try to extract content — just *list* them in the appropriate wiki page as `references` (e.g. "Source: `raw_context/sources/bills-archive.pdf`"). Future "raw-extract" capability will handle binaries.

You may NOT modify anything under `.jean/raw_context/` — Edit/Write there is denied. Read-only by design (Karpathy's immutability rule).

### 3. Decide what to distill

Not every input becomes a wiki page. Apply judgment:

- **A `memory` event** → almost always relevant. Read its `text`, decide which existing page it belongs on (or whether to create a new page).
- **A completed task** → distill ONLY when it contains durable knowledge useful in other tasks. Routine tasks (typo fix, dependency bump) usually don't. Substantive tasks (a refactor with lessons, an investigation, a decision) usually do.
- **A `memory` event with `text` starting with `CORRECTION:`** → find the page mentioned, update it, log the correction.

When in doubt, lean conservative: under-distilling is reversible (memory events stay in the log; you'll see them next run). Over-distilling pollutes the wiki.

**Scaling: parallel triage with Haiku.** When there are many inputs (>~20 memory events, or a large stack of completed tasks), don't read+classify them all yourself. Use the `Task` tool to spawn Haiku subagents in parallel — each takes a slice of events and returns a structured triage (which page each belongs on, whether it's a correction, whether it should be dropped). You then take the triage and do the careful integration work yourself on Sonnet. Cheap for the bulk read; sharp for the writes.

```
Task(
  subagent_type="general-purpose",
  model="haiku",
  description="Triage memory events 100–149",
  prompt="<give the agent: the events JSONL slice, the current index.md, and ask for a JSON list of {eventId, targetPage, op: 'append'|'correct'|'new-page'|'drop', reason}>"
)
```

Skip this for small runs (<20 events) — Haiku spawn overhead isn't worth it.

### 4. Build the next version

Copy the current wiki to a staging directory as your working copy:

```bash
rm -r .jean/.consolidator/staging
cp -r .jean/context/. .jean/.consolidator/staging/
```

Now edit pages in `.jean/.consolidator/staging/` only. Never touch `.jean/context/` directly — readers are using it.

For each input you decided to distill:
- **New entity / concept**: create `.jean/.consolidator/staging/<slug>.md`. Add a one-line entry in `staging/index.md`.
- **Update to existing page**: edit the page in staging; preserve unattributed content (it may be a manual user edit — see "Conservative lint" below).
- **Correction**: edit the offending page in staging, then append a `## [<date>] correction | <page-slug> | <what>` entry to `staging/log.md`.

Apply the **Page principles** above as you write: one concept per page, split when it grows past ~50 lines or multi-entity, compact older detail, wiki-link every concept reference, keep entity-class pages schema-consistent. Splitting, merging, and compaction are normal, **required** operations during this step — you are the wiki's only writer, so an oversized or multi-entity page MUST be split here (update inbound `[[links]]` + `index.md`); never defer it, flag it for approval, or leave it for a human — no one else can do it. Do them whenever warranted, not just for new content.

Every page you create or meaningfully change must carry a `description:` in frontmatter. When you change a page, ask: does the description still describe what's there? If not, update it.

Rebuild `index.md` by lifting each page's `description:` — `- [[Page]] — <description>` per line, grouped by category. The index is generated, not hand-written.

**Read only the header.** When you only need descriptions (index rebuild, lint scan for missing/stale `description:`), don't load page bodies — that wastes tokens at wiki scale. Extract the frontmatter directly with `awk`:

```bash
# Lift description from a single page — no body read
awk '/^---$/{c++; next} c==1 && /^description:/{sub(/^description:[ ]*/,""); print; exit}' page.md

# Build the entire index from frontmatter alone — no body read for any page
cd .jean/.consolidator/staging && \
  for f in *.md; do
    base=$(basename "$f" .md)
    [[ "$base" == "index" || "$base" == "log" ]] && continue
    desc=$(awk '/^---$/{c++; next} c==1 && /^description:/{sub(/^description:[ ]*/,""); print; exit}' "$f")
    echo "- [[$base]] — $desc"
  done
```

Use `Read(path, limit=20)` if you'd rather use the Read tool — same idea: stop reading after the closing `---`. Only load the full body when you actually need to *change* the page (Edit requires a prior Read of the slice you're editing).

Append a summary entry to `log.md`:

```markdown
## [2026-04-29] consolidate | <N> events processed
- Updated: [[bills]], [[savings]]
- Created: [[<new-page>]]
- Distilled from task #042
```

### 5. Lint (last pass before swap)

The wiki is a projection of events. Your job is to keep that projection current. Manual user edits are NOT immortal — they get reconciled with event evidence like anything else.

Before swapping, do a judgment pass over `.jean/.consolidator/staging/`. The questions to ask while you read:

- **Does anything contradict?** Fix per the most recent evidence; note in `log.md`.
- **Has anything been superseded?** Newer memory events may have made claims stale — update.
- **Do descriptions still describe?** Use the header-only `awk` scan from step 4 to find pages missing `description:` or whose `description:` no longer matches the body. Regenerate `index.md` from the descriptions; never hand-edit the index.
- **Should anything be split or compacted?** Page principles apply across the whole staging dir, not only to what you just touched.
- **Where should there be a `[[wiki-link]]` that isn't?** Concepts with their own page should be linked when mentioned.
- **Did the user write anything here?** Treat user-edited content as a strong prior. If new event-evidence contradicts it, update the page; preserve the user's framing where the new evidence is silent.
- **Anything worth noting but not worth auto-fixing?** Orphan pages, concepts referenced enough to deserve their own page — flag in `log.md` for next run, don't act unilaterally.

This is a judgment pass, not a checklist. Read, think, fix what's wrong; don't tick boxes.

The principle: **don't delete or rewrite without reason. Do update when evidence shows current content is wrong or stale, regardless of who wrote it.**

### 6. Swap (two renames + cleanup)

Replace `.jean/context/` with `staging/` via two renames. **All in one Bash invocation** — bash variables don't persist across separate tool calls, so don't split this into multiple steps:

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ) && \
  mv .jean/context .jean/.consolidator/old-$TS && \
  mv .jean/.consolidator/staging .jean/context && \
  rm -r .jean/.consolidator/old-$TS
```

Brief microsecond gap between the two `mv` calls where `.jean/context/` doesn't exist; concurrent readers (rare; this runs once a night) get `ENOENT` and naturally retry. The final `rm -r` cleans up the previous version.

If you crash between the two renames, the next librarian invocation's pre-spawn recovery routine restores the layout deterministically — you don't have to defend against your own crash.

### 7. Advance cursor & emit completion

Write the new cursor:

```
.jean/.consolidator/cursor.json
{
  "lastEventId": <highest event id you processed>,
  "lastConsolidatedAt": "<ISO timestamp>",
  "lastRawConsolidatedAt": "<run-start ISO — covers all files modified up to now>"
}
```

`lastRawConsolidatedAt` should be the time you started this run, NOT the latest mtime you saw — using run-start ensures any file modified during your run gets picked up next time (avoiding the lost-update window).

Then record the run via the infra HTTP API:

```bash
PORT=$(cat ../../infra.port)
curl -s -X POST "http://127.0.0.1:$PORT/context/consolidated" \
  -H 'content-type: application/json' \
  -d '{
    "pagesUpdated": <N>,
    "pagesCreated": <K>,
    "corrections": <M>,
    "tasksDistilled": <T>,
    "eventsProcessed": <E>,
    "rawFilesProcessed": <R>,
    "anomalies": []
  }'
```

Sensei will see this `wiki-consolidated` event in its normal nudge cycle and surface non-empty `anomalies` to the human. Use `anomalies` for things sensei should know about: stale references, files you couldn't extract, contradictions you flagged but didn't auto-fix.

## Failure modes (be aware)

The deterministic pre-spawn recovery routine handles most of these before you start; documented here for context.

- **Mid-run crash before swap**: `staging/` may be partial. Cursor unchanged. `.jean/context/` untouched. Next run: pre-spawn cleanup wipes `staging/`; you start fresh from the same cursor.
- **Mid-swap crash (between the two renames)**: `.jean/context/` is gone; either `staging/` or `old-<ts>/` exists. Pre-spawn recovery restores: prefer `staging/` if present (new version was ready), else `old-<ts>/` (rollback to previous good).
- **Two librarian processes running simultaneously**: shouldn't happen (single-writer is enforced by the trigger system not double-firing). If it ever does, the second process exits cleanly when it sees `staging/` already exists from the first.
- **Pre-existing real `.jean/context/` dir on first run**: that's the steady-state layout — proceed. No migration needed.

## What you do NOT do

- **Don't read or write outside `.jean/`** — your work is the wiki, nothing else.
- **Don't reply to anyone** — you don't have MCP loaded; no `reply` or `send` tools exist. Your output is the wiki itself + the `wiki-consolidated` event.
- **Don't ask the human anything.** You run unattended on a schedule. If you can't make a decision, leave the input for the next run and note it in `log.md`.
- **Don't memorize.** Memory is for agents observing the world; you're the consumer of memories. Recording a `wiki-consolidated` event is enough.
- **Don't promote content to the repo.** That's the human's call. You only manage `.jean/context/`.

## Sharpness checklist before exiting

- [ ] Cursor advanced to highest event ID processed
- [ ] `.jean/context/` is a real directory containing the new version
- [ ] `.jean/.consolidator/staging/` does NOT exist (it became `.jean/context/`)
- [ ] `.jean/.consolidator/old-*/` does NOT exist (cleaned up after swap)
- [ ] `index.md` lists every page in `.jean/context/`
- [ ] `log.md` has a new entry for this run
- [ ] `wiki-consolidated` event recorded

When the checklist passes, exit cleanly with code 0.
