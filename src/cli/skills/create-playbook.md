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
```

## Writing guidelines

- **Start with the trigger**: what causes this workflow to start?
- **Define phases**: sequential, concrete steps.
- **Specify output rules**: where do results go? (task replies, Slack, files)
- **Define done**: when is the workflow complete?
- **Human interaction points**: when should the agent pause and ask?
- **Keep it short**: agents scan playbooks quickly, not read essays.
- **No agent-specific instructions**: playbooks define the workflow, not which agent runs it.

## Verifying

After writing a playbook file, verify it loaded via `GET /playbooks`.
