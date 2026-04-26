---
name: create-playbook
description: >
  Guide for creating and updating playbooks — workflow definitions
  that control how work flows through the dojo.
---

# Create Playbook

Create or update a playbook — a workflow definition that guides how a type of work flows through the dojo.

## Format

Playbooks are markdown files in `.jean/playbooks/`. The infrastructure watches this directory — changes are picked up automatically.

```markdown
---
name: <short-name>
description: >
  One or two sentences. What this workflow is for and when it applies.
---

# <Title>

<Body: phases, rules, output expectations, done criteria>

## Checklist

- <verifiable per-task action>
- <verifiable per-task action>
- ...
```

## Writing guidelines

- **Start with the trigger**: what causes this workflow to start?
- **Define phases**: sequential, concrete steps.
- **Specify output rules**: where do results go? (task replies, Slack, files)
- **Define done**: when is the workflow complete?
- **Human interaction points**: when should the agent pause and ask?
- **Keep it short**: agents scan playbooks quickly, not read essays.
- **No agent-specific instructions**: playbooks define the workflow, not which agent runs it.
- **Optional `## Checklist` section**: bullet items every task using this playbook must address. Items should be *verifiable per-task actions* (loaded the X skill, saved artifacts to a local branch, did not push, etc.) — not advice. Items become a structured contract: sensei pastes them verbatim into every dispatch, the worker addresses each with `[x]` (done + brief evidence) or `[ ]` (skipped + reason), and sensei refuses to close until each item is addressed. Author the checklist with the human in the loop — propose a draft, let them edit, then commit. Skip the section entirely if the playbook is short enough that prose phases are checklist-equivalent.

## Verifying

After writing a playbook file, verify it loaded via `GET /playbooks`.
