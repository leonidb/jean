---
name: consolidate-wiki-draft
description: >
  Librarian phase 1 — read new memory events, completed tasks, raw_context;
  decide what to create / update / keep / archive in the wiki; write the
  drafted version to staging/ + a plan.json. Does NOT swap or advance cursor.
  A separate "review" phase reads this output and finalizes; a deterministic
  shell phase performs the swap.
---

# Consolidate Wiki — Draft Phase

You are the **librarian** of this dojo, running **phase 1 of 3**.

Your job in this phase:
1. Read inputs: new memory events, completed tasks, raw_context.
2. Decide which wiki pages to **create**, **update**, **keep**, or **archive**.
3. Write the drafted next-version wiki to `.jean/.consolidator/staging/`.
4. Write a structured `plan.json` recording your decisions.
5. Exit cleanly.

You do NOT swap, do NOT emit events, do NOT advance the cursor. The review phase + shell phase handle finalization.

## Layout

```
.jean/
  history.jsonl              — event log (read-only)
  raw_context/               — human-curated source material (READ-ONLY for you)
  context/                   — current wiki — READ ONLY in this phase
  .consolidator/
    cursor.json              — { lastEventId, lastConsolidatedAt, lastRawConsolidatedAt }
    staging/                 — YOUR OUTPUT: drafted next version
    plan.json                — YOUR OUTPUT: decisions + stats
    runs/<ts>.log            — your progress log
```

A pre-spawn recovery routine guarantees `staging/` does NOT exist when you start. Don't defend against partial state.

## Page principles (apply when drafting)

Wiki pages are for LLM consumption — terse, bullet-pointed, structured. Skim-in-seconds.

- **One concept per page.** Subscription, project, decision, person — one each.
- **Compact older content.** Superseded detail collapses to a one-liner. Move narrative to `log.md` if worth keeping; drop otherwise.
- **Wiki-links.** Every concept reference uses `[[Page Name]]` syntax.
- **Frontmatter on every page.** YAML at top with `description:` (one-sentence summary used in `index.md`). Optional: `status:`, `updated:`, `type:`.
  ```markdown
  ---
  description: Gym membership — cancelled 2025-11-03, ~$45/mo saved.
  ---
  ```
- **`index.md` is the one exception** to "every page has frontmatter you write" — don't write it at all in this phase. The review phase regenerates it from each other page's `description:`. Skip index.md when you cp/Edit/Write staging files.

## Procedure

### Step 0 — open progress log

```bash
mkdir -p .jean/.consolidator/runs
RUN_LOG=.jean/.consolidator/runs/$(date -u +%Y%m%dT%H%M%SZ)-draft.log
echo "[$(date -u +%H:%M:%SZ)] draft phase started" > "$RUN_LOG"
```

Append `[time] <phase>` lines as you progress. One per phase, not per tool call.

### Step 1 — read state

```bash
cat .jean/.consolidator/cursor.json
ls .jean/context/
```

Branch:
- **`cursor.json` missing**: bootstrap. Set `lastEventId` to current max. The next phase has nothing to consolidate.
- **`cursor.json` exists**: trust as-is. `lastEventId: 0` may be a deliberate human reset — don't override.

### Step 2 — read inputs

Three input types. Do them in parallel where independent.

**Memory events since cursor:**
```bash
cat .jean/history.jsonl | jq -c 'select(.type == "memory" and .id > <lastEventId>)'
```

**Completed tasks since cursor:**
```bash
# Find candidates
cat .jean/history.jsonl | jq -c 'select(.type == "task-status" and .id > <lastEventId> and .data.to == "done")'
# For each, fetch full task with comments
PORT=$(cat .jean/infra.port)
curl -s "http://127.0.0.1:$PORT/tasks/<id>?include=comments,messages,playbook"
```

Distill ONLY tasks with durable cross-task knowledge — refactor lessons, decisions, investigations. Routine fixes (typo, bump) drop.

**raw_context files newer than `lastRawConsolidatedAt`:**
```bash
find .jean/raw_context -type f -newermt "<lastRawConsolidatedAt>"
```

For text files (`.md`, `.txt`): read directly. For binaries (PDFs, images, XLSX): list the path on the relevant page as `Source: raw_context/<file>` — don't try to extract.

You may NOT modify anything under `raw_context/` — Edit/Write there is denied.

### Step 3 — read current wiki (headers only)

You don't need page bodies yet. Build a map of `slug → description` from frontmatter:

```bash
cd .jean/context && for f in *.md; do
  base=$(basename "$f" .md)
  desc=$(awk '/^---$/{c++; next} c==1 && /^description:/{sub(/^description:[ ]*/,""); print; exit}' "$f")
  echo "$base|$desc"
done
```

This gives you the page inventory cheaply. Read full page bodies later, only for pages you'll **update**.

### Step 4 — decide ops

For each input event/task/file, decide one of:

- **`create`** — new entity / concept not on any existing page. Pick a slug, draft a new page.
- **`update`** — augments an existing page. Read that page's full body; produce a new body.
- **`keep`** — page unchanged this run.
- **`archive`** — page is superseded / no longer load-bearing. Drop from staging (not copied over). Note in `log.md`.

A `memory` event whose text starts with `CORRECTION:` always maps to `update` of the page it names.

When uncertain whether a memory is wiki-worthy, lean **conservative — drop it**. Memory events stay in the log; they'll surface again next run if relevant. Over-distilling pollutes the wiki.

#### Dojo board task state stays on the board, not in the wiki

The dojo's own tasks (anything in `infra GET /tasks`) carry state — `active` / `blocked` / `done`, comments, replies, history — and the board IS the canonical source. Don't copy that state into wiki pages.

- ❌ Don't write `task 077 in-progress`, `task 080 done`, `v1 readiness in-progress`, `tasks 074–077 still in-progress`, or similar status restatements into pages or `log.md`.
- ❌ Don't track per-task milestones, branch tips, or PR/commit state on a wiki page if those are already on the task itself or in the task's playbook output.
- ✅ Reference a task by ID when distilling **durable knowledge** from it (`approach validated in task 042`, `pattern established in task 006`). The task ID is a citation, not a status announcement.
- ✅ Per-task progress, blockers, and decisions belong in **task comments** (`infra POST /tasks/<id>/comment`) — not the wiki.

**External-system task references are different.** GitHub PRs/issues by number, real-world checklist items, third-party project state — these are NOT in the local board and the wiki is the right home for durable knowledge about them. The rule is "don't duplicate the local board"; cross-system state isn't duplication.

When in doubt: if you'd find the answer faster by calling `infra GET /tasks/<id>` than by reading the wiki, the wiki shouldn't carry that information.

### Step 5 — build staging

```bash
mkdir -p .jean/.consolidator/staging
```

For each decision:
- **`keep`**: `cp .jean/context/<page>.md .jean/.consolidator/staging/<page>.md`
- **`create`** or **`update`**: `Write` the new content directly to `.jean/.consolidator/staging/<page>.md`. Include frontmatter with `description:`.
- **`archive`**: skip (don't copy).

Always copy `log.md` over (or create if missing) and **append** an entry for this run:

```markdown
## [2026-05-09] consolidate | <N> events processed
- Updated: [[bills]], [[savings]]
- Created: [[<new-page>]]
- Distilled from task #042
```

Don't write `index.md` in this phase — the review phase regenerates it from frontmatter.

### Step 6 — write plan.json

This is the structured handoff to phase 2. Be precise.

```bash
cat > .jean/.consolidator/plan.json <<'EOF'
{
  "phase": "draft",
  "ts": "<ISO timestamp>",
  "newCursor": <highest event id you read>,
  "newRawCursor": "<run-start ISO>",
  "decisions": [
    { "op": "create", "page": "release-notes.md",    "reason": "new project from event 104" },
    { "op": "update", "page": "team-conventions.md", "reason": "cross-dojo lessons (events 115, 118)" },
    { "op": "keep",   "page": "bills.md" },
    { "op": "archive", "page": "old-thing.md", "reason": "superseded by event 101" }
  ],
  "stats": {
    "eventsProcessed": <E>,
    "tasksDistilled": <T>,
    "rawFilesProcessed": <R>,
    "pagesCreated": <K>,
    "pagesUpdated": <N>,
    "pagesArchived": <A>
  },
  "anomalies": []
}
EOF
```

**`newCursor` must be the max id of memory + task-status events you read** (NOT the current max event id — non-memory events shouldn't advance the cursor). If there were zero new events, set `newCursor` to the previous cursor.

**`anomalies`**: free-form list of things you noticed but couldn't auto-fix — stale references, missing source files, contradictions you flagged. The review phase + sensei will see these.

### Step 7 — exit

Log `[time] draft phase done — N create, K update, A archive` and exit cleanly.

The review phase will pick up from `staging/` + `plan.json`. Phase 3 shell will swap.

## Failure modes

- **Empty input**: zero memory events, zero completed tasks, zero new raw_context. Skip building staging. Write `plan.json` with empty decisions array and `newCursor` = previous cursor. Phase 3 sees this and skips swap.
- **Mid-run crash**: pre-spawn recovery removes `staging/` and `plan.json` before next run. Cursor unchanged.

## What you do NOT do in this phase

- ❌ Don't touch `.jean/context/` — read-only this phase.
- ❌ Don't swap, don't `mv`.
- ❌ Don't write `index.md` — review phase regenerates it.
- ❌ Don't emit `wiki-consolidated` event.
- ❌ Don't advance `cursor.json`.
- ❌ Don't reply or memorize. You have no MCP tools.

## Sharpness checklist before exit

- [ ] `staging/` exists with all `keep` + `update` + `create` pages
- [ ] Every page in staging has frontmatter with `description:`
- [ ] `staging/log.md` has an entry for this run
- [ ] `plan.json` exists, valid JSON, `decisions` matches what's in staging
- [ ] `plan.json.newCursor` ≥ previous cursor
- [ ] `.jean/context/` is unchanged

When the checklist passes, exit code 0. The review phase takes over.
