---
name: wiki-sweep
description: >
  Periodic sensei review of `.jean/context/`. Two judgments per page —
  factual currency vs current state, and content placement vs the wiki's
  purpose. Emits `memorize` events with verbs CORRECTION / ARCHIVE / REMOVE
  for the librarian to consolidate.
---

# Wiki Sweep

You are sensei, running a periodic wiki review pass. Read every page in `.jean/context/`, judge it on the two dimensions below, emit `memorize` events for anything that needs to change.

You read the wiki freely; you never edit it (denied at the permission layer). All output flows through `memorize` — same channel as during normal task work; see the `context` skill for the mechanics.

## Two judgments per page

### 1. Is the content factually current?

Look for time-bound or external-state claims:

- **PR / issue numbers** (`#NNN`) — merged, closed, abandoned? Assignee changed?
- **Time-bound period references** (iterations, sprints, weekly cycles, milestones) — current, completed, archived?
- **People by name** — still active? Still in the role described?
- **Decisions with dates** — superseded by a later one?
- **"Active", "in flight", "waiting for X"** language — is X still the blocker?
- **Tooling / migration references** — adoption complete or still in flight?

Skip claims that are stable historical fact (a past finding doesn't go stale unless re-evaluated).

### 2. Is this content properly placed — AND is it covered elsewhere?

The wiki is for **durable cross-task knowledge** — patterns, conventions, decisions, learnings, lasting findings. Some categories *would* fit better elsewhere:

- **Anything structured the dojo maintains** (rosters, periodic snapshots, configs, schemas) → the dojo's project-state area, as files where scripts can parse them.
- **In-flight checklists, action items** → the task board (`infra GET /tasks`).
- **Behavioral / role rules** ("be assertive", "always check X before Y") → skills.
- **Procedural policy** (state-transition rules, lifecycle constraints) → playbooks.
- **Material canonical elsewhere** (commits, PRs, issues, external system state) → don't duplicate.

These are **candidates** for REMOVE — not automatic removals. The wiki captures knowledge that emerges from work; not all such knowledge has been formalized into its "proper" home yet. A page may *look* like playbook material and *still* be the only documentation that exists. Verify before REMOVE (below).

## How to verify (judgment 1)

Cheaper and more local first:

1. **The board** — `infra(GET /tasks)`; `infra(GET /tasks/<id>?include=replies,comments)` for outcome detail.
2. **Project state** — read the dojo's structured-data files (rosters, configs, period snapshots).
3. **External-system queries** (only when relevant) — `gh` CLI for code/issue trackers, etc.:
   - `gh pr view <N> --json state,mergedAt,closedAt`
   - `gh issue view <N> --json state,closedAt,assignees`
4. **Recent task replies** — search task history for outcome notes.

Skip claims you can't verify cheaply; note them in the summary.

## How to express findings — three verbs

Be specific. The librarian needs to know which page, which sentence, what to do.

### CORRECTION — fact is wrong

```
infra(method="POST", path="/context/memorize", body={
  agent: "sensei",
  role: "sensei",
  scope: "dojo",
  text: "CORRECTION: <page>.md says <specific claim>. As of <today>: <current truth>. Verified via <source>."
})
```

### ARCHIVE — content is correct but historical

```
text: "ARCHIVE: <page>.md is now historical (no longer references current work as of <date>). Consolidator should mark `status: archived` or move to `.archive/`. Reason: <why>."
```

For completed cycles, superseded decisions, finished initiatives. Page stays readable, demoted in `index.md`.

### REMOVE — content does not belong in the wiki

```
text: "REMOVE: <page>.md — content belongs in <where>. Specifically: <what to remove and why>. Verified canonical location at <path or reference> already contains <evidence>."
```

Use only when judgment 2 identifies a category mismatch AND verification (below) confirms the canonical location has the content. Don't use REMOVE for stale-but-real-knowledge — that's ARCHIVE.

## Verify before REMOVE — the wiki is the fallback

Before emitting REMOVE, confirm the canonical location actually has the content:

| REMOVE rationale | Verify by reading |
|---|---|
| "Belongs in a playbook" | `.jean/playbooks/*.md` — find a playbook covering this workflow/policy |
| "Belongs in project state" | The dojo's structured-data files in its project-state area |
| "Belongs in a skill" | The relevant skill file (framework or dojo-custom) |
| "Belongs in tasks / board" | `infra GET /tasks` |
| "Belongs in an external system" | A targeted query (`gh` etc.) |

**If the canonical location does NOT have the content, do NOT REMOVE.** Flag it informationally in the summary instead:

```
text: "...Notable: `<page>.md` contains <type of content> that's not currently captured in <expected canonical location>; consider formalizing."
```

The human reads this in `log.md` after consolidation and decides whether to formalize. Once formalized, a future sweep can REMOVE.

## What NOT to do

- **Don't edit pages.** Even typos. Emit a CORRECTION.
- **Don't reorganize.** Splitting / merging / renaming is the librarian's job.
- **Don't duplicate verbs.** If you've emitted REMOVE for a page, don't also emit CORRECTION for claims on it — the page is going away.
- **Don't speculate.** "I think this PR might be merged by now" is not a CORRECTION. Verify or skip.
- **Don't REMOVE without verification.** Leaving slightly-misplaced content is much cheaper than erasing knowledge that exists nowhere else.

## When you're done

Emit one summary memorize event:

```
text: "Wiki sweep complete (YYYY-MM-DD): reviewed N pages. Emitted A corrections, B archival, C removal. Skipped verification on: <list + reason>. Notable: <one-line summary, if any>."
```

This serves as audit trail. Whether to surface results to a human is a dojo concern (Slack bridge, wrapping playbook, etc.) — not handled by this skill.
