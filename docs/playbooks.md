# Jean — Playbooks

## What a playbook is

A playbook is a markdown file (`.jean/playbooks/<name>.md`) with skill-style frontmatter that captures **how a particular kind of work should flow through this dojo**. It is the dojo's *customization layer*: the framework stays generic, and playbooks are how a dojo — or a person — specializes it.

Same authoring surface as the rest of Jean: markdown + frontmatter, like skills and the wiki. One way to write things down across the whole system.

## Why they exist — the universal-dojo bet

The framework is deliberately generic; **playbooks are where all the specificity lives.** The bet is that a single, natural-language-like layer can let one framework cover a very wide span of real use:

- **A personal dojo** — *no Git at all*.
- **A work dojo** — a team codebase: reviews, bug reproduction, issue triage.
- **Hands-off** — dispatch work and let agents run automatically, without watching them.
- **Hands-on** — sit with one worker for a day, iterating on a serious feature.

All of that, on the same infrastructure, selected by which playbooks a dojo has (or doesn't). The autonomy spectrum is itself a playbook choice: a small-task playbook can say "plan, get approval, never push, summarize"; deep interactive feature work may use *no* playbook at all.

Positioning against the neighboring layers:

| Layer | Owns | Shared with |
|---|---|---|
| **Framework** (Jean infra) | generic mechanism — tasks, events, channels, lifecycle primitives | everyone |
| **Project skills / config** (`.claude/`, committed) | *how the project works* | the whole team / repo |
| **Playbooks** (`.jean/playbooks/`) | *how I like to work here* — local/personal conventions | nobody unless shared |
| **Wiki** (`.jean/context/`) | accumulated knowledge | the dojo |

A dojo with **zero playbooks is fully valid.** Playbooks only ever *add* optional structure.

## The contract (anatomy)

The canonical shape, harvested from a work dojo's playbooks (`review`, `reproduce`, `file-issue` — the most advanced usage in any dojo today):

- **Frontmatter** — `name` + a `description` that says *what this is for and when it applies*. The description is **matchable**: it's what the sensei reads to decide whether to attach the playbook to a new task. Make it discriminating.
- **Intent line** — one sentence on the deliverable ("Deliverable: a verdict…", "One task per PR").
- **`## Skills`** — the native (project) skills this playbook composes, and what each provides. **Step 0 of the process loads them** (`Skill(skill="bug-repro")`). Playbooks *reference* skills; they don't contain them.
- **Out of scope** — explicit boundaries.
- **Process** — numbered, concrete steps. "Stuck or unsure? Ask sensei." is the standing soft-consult.
- **Output / human-interaction rules** — where results go (task replies; not Slack/PR directly), who talks to the human (sensei is the only voice on Slack).
- **Git / artifact conventions** — branch naming, "never `git push`", etc. *(Note: push discipline is a playbook convention, never a framework gate — some dojos legitimately push and merge freely.)*
- **Done / lifecycle** — when the task closes, and the nuances (`waiting` vs `done`, task stays alive across iterations, re-opens on follow-up).
- **`## Checklist`** — `- [ ]` *verifiable per-task actions*. This is the reliability mechanism: the sensei pastes it verbatim into every dispatch, the worker answers each `[x]` (done + evidence) or `[ ]` (skipped + reason), and the sensei refuses to close the task until each is addressed. Soft prose becomes a structured contract here.

The checklist is why a work dojo's "commit to a local branch, never push, report via the task" convention holds in practice despite being plain prose.

## The lifecycle: author → discover → attach

These three are one loop, and they all hinge on a good `description`:

- **Author** — the `create-playbook` skill should generate the full contract above (especially the `## Skills` references and a matchable description), encoding the conventions so authoring is guided, not from-scratch.
- **Discover** — `jean playbook list` / `GET /playbooks` is only useful if descriptions crisply say what each playbook is for.
- **Attach** — at task creation the sensei matches the task to a playbook by its description and sets the `playbook` field; thereafter it loads it (`?include=playbook`) and re-reads it before any state transition.

## Optional flow primitives

Beyond surfacing, the infra may offer **optional, composable lifecycle primitives** that a playbook *references* — e.g. publish-a-plan, sensei plan-approval, and plan-change/divergence-consult. Nothing fires unless a playbook invokes it; a "wait for approval before X" behavior is a playbook using the generic approval primitive, never a hardcoded gate. *(Partly future work — captured here so the contract has a place to grow.)*

## Design decisions & compromises

- **Routing stays with tags; playbooks are flow, not routing.** (decisions.md §4.)
- **Bundled → flow-only.** The original plan was a single file bundling orchestrator flow + agent skill + message templates. It became *flow definition that references native skills* — playbooks point at skills rather than embedding them. (decisions.md, Apr 7.)
- **Attach-on-load, not auto-inject.** Auto-injecting the playbook on every status transition was rejected (couples lifecycle to IO, surprising side effects). Instead the sensei pulls it on task load, in the same response as the work — no separate ritual. (See `decisions.md` for the full record.)
- **Soft by design.** Playbooks are prose; prose isn't guaranteed. Reliability comes from three things, not from hard enforcement: the **checklist contract**, **optional primitives** a playbook can lean on, and **reliable surfacing** (attach at creation, load before transitions). The wager is that a flexible, natural-language-like layer is worth the residual softness — and that the remaining gaps are closable.

## Authoring

Use the `create-playbook` skill — it operationalizes this contract (the template, the authoring rules, and the human-in-the-loop checklist step). One rule worth repeating: keep the frontmatter `name` equal to the filename, since the sensei attaches by id (the filename) and a mismatch silently attaches nothing.
