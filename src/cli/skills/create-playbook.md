---
name: create-playbook
description: >
  Guide for creating and updating playbooks — the markdown flow
  definitions that customize how a type of work moves through the dojo.
---

# Create Playbook

Create or update a playbook: a markdown file in `.jean/playbooks/` that defines how one kind of work flows through this dojo. Playbooks are the dojo's **customization layer** — the framework stays generic; playbooks specialize it. A dojo with no playbooks is fully valid.

This skill is the how-to. For the full design, contract, and rationale, see `docs/playbooks.md`.

## Format

Playbooks are markdown with skill-style frontmatter. The infrastructure watches `.jean/playbooks/` — changes are picked up automatically.

```markdown
---
name: <short-name>
description: >
  What this is for and WHEN it applies. The sensei matches on this line
  to attach the playbook to a task — make it discriminating, not generic.
---

# <Title>

One-line deliverable: what a task using this playbook produces.

## Skills

Native (project) skills this playbook composes, and what each provides:
- **`<skill-name>`** — what it covers (branch naming, filing mechanics, …).

## Out of scope

What this playbook explicitly does NOT do — the boundaries.

## Process

0. Load the skill(s): `Skill(skill="<skill-name>")`.

**Stuck or unsure? Ask sensei.** Reply with the question rather than guess.

1. <concrete step>
2. <concrete step>

## Output

Where results go (task replies, not Slack/PR directly) and who talks to the human.

## Done

When the task closes — and the lifecycle nuance: deliver-then-`waiting` vs `done`,
whether the task stays alive across iterations, when it re-opens.

## Checklist

- [ ] <verifiable per-task action>
- [ ] <verifiable per-task action>
```

## What makes a good playbook

- **Reference skills, don't embed them.** Playbooks define the *flow*; native skills (in the repo, loaded with `Skill(skill="…")`) carry the *mechanics*. Name them in `## Skills` and load them in step 0.
- **A matchable description.** It's the one line the sensei reads to decide whether this playbook fits a new task. State what it's for and when it applies — avoid generic phrasing that matches everything or nothing.
- **Start with the trigger** — what kind of work starts this flow.
- **Concrete numbered phases, not advice.** Mark the human-interaction points (when to pause and ask sensei).
- **Output + Done rules** — where results land, and the exact close condition (including `waiting` vs `done`, and whether the task stays alive across iterations).
- **Keep it short** — agents scan playbooks, they don't read essays.
- **No agent-specific instructions** — a playbook defines the workflow, not who runs it.

## The checklist is the contract

An optional `## Checklist` of **verifiable per-task actions** (loaded skill X, saved artifacts to a local branch, did not push, …) — not advice. It's the reliability mechanism: the sensei pastes the items verbatim into each dispatch and won't close the task until the worker has addressed each with `[x]`/`[ ]` (full mechanics in `docs/playbooks.md`). Author it with the human in the loop, and skip the section only if the prose phases are already checklist-equivalent.

## Verifying

After writing the file, confirm it loaded via `GET /playbooks` and that its `description` reads well in the list (that's what the sensei matches on). Keep the frontmatter `name` equal to the filename: the sensei attaches a playbook by its **id** (the filename without `.md`), so a mismatch makes attachment silently fail. Only `name` and `description` are read from frontmatter — other keys are ignored.
