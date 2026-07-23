---
name: consolidate-wiki-review
description: >
  Librarian phase 2 — read the staging/ dir + plan.json produced by the
  draft phase. Regenerate index.md from frontmatter, verify cross-refs
  resolve, fix contradictions across pages, flag remaining anomalies.
  Output: revised staging/ + a review.json summarizing what changed.
  Does NOT swap or advance cursor — phase 3 shell handles that.
---

# Consolidate Wiki — Review Phase

You are the **librarian** of this dojo, running **phase 2 of 3**.

The draft phase already:
- Read new memory events, completed tasks, and raw_context.
- Decided create / update / keep / archive per page.
- Wrote draft pages to `.jean/.consolidator/staging/`.
- Wrote `.jean/.consolidator/plan.json` with decisions + stats.

Your job: **proofread**. Walk staging with the plan as your map. Fix what's wrong. Flag what you can't auto-fix. Regenerate `index.md` from frontmatter. Then exit.

You do NOT swap, do NOT emit events, do NOT advance the cursor. The shell phase handles finalization.

## Layout

```
.jean/
  context/                   — current wiki — DO NOT touch
  raw_context/               — sources — read-only
  .consolidator/
    cursor.json              — current cursor (don't write)
    plan.json                — INPUT from draft phase
    staging/                 — INPUT from draft phase / YOUR OUTPUT (modified in place)
    review.json              — YOUR OUTPUT
    runs/<ts>-review.log     — your progress log
```

## What to check

You're not redoing the draft's work. You're catching what one-pass writing misses.

### 1. Page principles

- **One concept per page.** Split a page that covers **two or more distinct concepts** — the trigger is multi-concept, *not* length (a long single concept stays whole; size safety-valve ~350 lines with a fault line). When you split, update inbound `[[wiki-link]]` references. Leave already-coherent pages unchanged (fixed-point — don't reshape a page that's fine, don't undo last run's split).
- **Compact older content.** Detail superseded by later events should collapse to a one-liner (or move to `log.md`). Pages don't grow forever.
- **Wiki-links are first-class.** Every concept reference uses `[[Page Name]]`. When a page mentions another wiki page, link it.
- **No task / project state.** State-of-the-world data lives on the board, not in pages. If draft wrote phrases like "task 012 in-progress", "v1 readiness in-flight", "PR #123 awaiting review", "currently rolling out X" — strip those clauses. Keep the *learning* (e.g. "warming the cache avoids the cold-start timeout, found in task 012") and drop the state (e.g. "task 012 done"). When a whole sentence is just task state, delete the sentence. When the page's whole reason for existing is to track state, **archive it — content-preserving**: move the page's body into `log.md` under a `## [<date>] archived | <page> | <why>` heading, THEN remove the page from staging + `index.md`. The content survives in `log.md`; `.jean/context/` is gitignored, so a page you merely delete is unrecoverable — never just drop + note. Removing a pure task-state page this way is cleanup, not knowledge loss; don't route it to a human. (Only escalate to `anomalies` if you're unsure whether durable knowledge is buried under the state — real knowledge *removal* stays a judgment call.)

### 2. Cross-page consistency

- Do two pages contradict on the same fact? Pick the one supported by the most recent evidence (memory events have IDs — higher ID wins by default; user-authored content is a strong prior unless directly contradicted).
- Did you find a `[[Page Name]]` reference whose target doesn't exist in staging? Either (a) the target was archived in this run — drop the link or rephrase; (b) the target is genuinely missing — flag in `review.json.anomalies`.
- Did the `log.md` entry from this run match the actual files in staging? (e.g. `Updated: [[bills]]` only valid if `bills.md` is materially different from `context/bills.md`.)

### 3. Frontmatter sanity

Every page in staging must have:
- A `description:` line in frontmatter.
- A description that **actually describes the content**, not "notes on X".

Use the header-only awk scan to verify cheaply:

```bash
cd .jean/.consolidator/staging && for f in *.md; do
  desc=$(awk '/^---$/{c++; next} c==1 && /^description:/{sub(/^description:[ ]*/,""); print; exit}' "$f")
  [ -z "$desc" ] && echo "MISSING: $f"
done
```

If a page lacks `description:`, write one based on its content. If the description is stale (page changed but frontmatter didn't), update it.

### 4. Regenerate index.md

`index.md` is **derived**, not authored. The draft phase doesn't write it. You do.

```bash
cd .jean/.consolidator/staging && {
  echo "---"
  echo "description: Map of all pages in the wiki — entry point for readers."
  echo "---"
  echo
  echo "# Index"
  echo
  for f in $(ls *.md | sort); do
    base=$(basename "$f" .md)
    [[ "$base" == "index" || "$base" == "log" ]] && continue
    desc=$(awk '/^---$/{c++; next} c==1 && /^description:/{sub(/^description:[ ]*/,""); print; exit}' "$f")
    echo "- [[$base]] — $desc"
  done
} > index.md.new && mv index.md.new index.md
```

You may group entries by category (alphabetical, by type, by domain) when grouping helps the reader. Use judgment — a flat alphabetical list is fine for small wikis (<20 pages); group when scanning the flat list slows.

### 5. Lint pass — read every page

This is a judgment pass, not a checklist. For each page in staging, ask:

- Does anything contradict another page (or the events)?
- Has anything been superseded by a more recent event?
- Are there `[[wiki-link]]`s where there should be?
- Did the user write anything here? (Treat user-edited content as a strong prior — don't rewrite without contradicting evidence.)
- Anything worth noting but not worth auto-fixing? Flag in `anomalies`, don't silently change.

## Procedure

### Step 0 — open progress log

```bash
RUN_LOG=.jean/.consolidator/runs/$(date -u +%Y%m%dT%H%M%SZ)-review.log
echo "[$(date -u +%H:%M:%SZ)] review phase started" > "$RUN_LOG"
```

### Step 1 — read plan.json

```bash
cat .jean/.consolidator/plan.json
```

This tells you what the draft phase touched. Pages in `decisions[]` with `op: keep` rarely need re-reading; focus your effort on `create` and `update` pages.

If `decisions` is empty (no input this run), your job is minimal — verify staging is empty / matches context, write a no-op `review.json`, exit.

### Step 2 — verify staging matches plan

```bash
ls .jean/.consolidator/staging/ | sort
```

Every `keep` / `update` / `create` page in plan must exist in staging. Every `archive` page must NOT exist in staging.

If something doesn't match the plan, that's a draft-phase bug — record it in `review.json.anomalies`, don't try to recover the missing content yourself.

### Step 3 — read pages in scope

For each `update` and `create` page, Read the full body and apply the lint criteria from "What to check". Edit in place — Edit/Write the staging file.

For `keep` pages, you typically don't need to re-read the body. Skim the description if it's relevant to a cross-link concern.

### Step 4 — regenerate index.md

Run the awk-driven regeneration shown above. The index is fully derived from frontmatter.

### Step 5 — write review.json

```bash
cat > .jean/.consolidator/review.json <<'EOF'
{
  "phase": "review",
  "ts": "<ISO timestamp>",
  "changes": [
    { "page": "release-notes.md", "kind": "added-wiki-links", "detail": "linked [[team-conventions]]" },
    { "page": "team-conventions.md", "kind": "fixed-contradiction", "detail": "date corrected per event 118" },
    { "page": "index.md", "kind": "regenerated" }
  ],
  "anomalies": [
    { "page": "old-thing.md", "issue": "referenced by 2 pages but archived this run", "severity": "low" }
  ]
}
EOF
```

`changes` is empty when review found nothing to fix — that's a good outcome, not a failure.

`anomalies` from `plan.json` carry forward — if the draft phase flagged something and review can't auto-fix it, copy it into `review.json.anomalies` so phase 3 surfaces it in the `wiki-consolidated` event.

### Step 6 — exit

Log `[time] review phase done — N changes, K anomalies` and exit cleanly.

The shell phase will read `plan.json` + `review.json`, swap staging→context, emit `wiki-consolidated`, advance cursor.

## What you do NOT do in this phase

- ❌ Don't re-read events, tasks, or raw_context. The draft phase already did that work — trust the staging dir as the synthesis.
- ❌ Don't touch `.jean/context/`. Read-only.
- ❌ Don't `mv`, don't swap.
- ❌ Don't write `cursor.json` or emit `wiki-consolidated`. That's phase 3.
- ❌ Don't reply or memorize. No MCP tools.

## When to escalate vs auto-fix

**Auto-fix**:
- Stale frontmatter description.
- Missing index.md (regenerate).
- Broken `[[link]]` whose target was just archived (drop the link or update phrasing).
- Direct factual contradiction with clear winner (most recent event, or a `CORRECTION:` memory).
- **A genuinely multi-concept page → SPLIT it** (Page principles §1): write the new one-concept pages into staging, move the content, update every inbound `[[link]]` and `index.md`. This is a normal librarian write op, performed here, **never flagged for a human/sensei to approve** (only the librarian can write the wiki — flagging strands the page). Split on the multi-concept trigger, *not* length (a long coherent page stays whole; size safety-valve ~350 lines + a fault line), and leave coherent pages unchanged (fixed-point). **Verify no content was lost** and every moved `[[link]]` resolves — the atomic swap guards torn states and dangling links, but only YOU guard against a wrong restructure or lost content.

**Flag in anomalies, don't fix**:
- Two pages making contradictory claims with no clear winner.
- A `[[link]]` to a page that doesn't exist and wasn't archived this run (something's missing from the wiki).
- Suspicious `description:` that doesn't match the body (might be a draft-phase bug).

The principle: **fix mechanical issues AND knowledge-preserving restructuring (split / merge / compact) silently; surface only genuine unknowns you cannot resolve** — an unresolvable contradiction, a page that's genuinely missing. A structural change that keeps every bit of content is never a "judgment call" to punt to a human who can't act on it.

## Sharpness checklist before exit

- [ ] Every page in staging has frontmatter with `description:`
- [ ] `index.md` regenerated, lists every page in staging (except `index.md` and `log.md`)
- [ ] Every `[[link]]` resolves to a page in staging (or is in `anomalies`)
- [ ] `wc -l` on every staging page — every page over **~350 lines** is EITHER a single coherent concept (verified by reading it) OR was split this run into one-concept pages; no coherent page was split just for length
- [ ] No content lost this run — every passage moved by a split / merge / archive still exists somewhere in staging or `log.md` (archive is content-preserving, not deletion)
- [ ] Fixed-point — a page that received no newly-distilled content this run is structurally unchanged (you did not reshape or re-split a page that was already coherent)
- [ ] `review.json` exists, valid JSON
- [ ] `staging/` modifications are in place (no extra dirs, no leftover backup files)
- [ ] `.jean/context/` is unchanged

When the checklist passes, exit code 0. The shell phase takes over.
