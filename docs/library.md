# Jean — Library

## What this is

The **library** is the dojo's durable, agent-readable, file-backed body of **what it has learned** — both about its domain and about how to work in it. It is written by the librarian (the only writer of `.jean/context/`), and read by every other agent that needs to know what the dojo already knows.

The pattern is heavily influenced by **Karpathy's example**: a human-curated immutable input (`raw_context/`), a single librarian that distils inputs into a structured wiki, and a clear read/write separation. The lineage is already named in code — `src/cli/skills/consolidate-wiki.md:143` cites *"Karpathy's immutability rule"* verbatim. This doc exists to keep the design intent and the lineage explicit; the librarian skill itself doesn't need to know.

## Why it exists

Chat context dies on compaction; per-session memory (skills, playbooks, MEMORY.md) is shaped for stable how-to. Neither survives long enough, or appends fast enough, to hold the things a dojo actually learns over weeks and months — findings about its domain, conventions it's been taught, mistakes it shouldn't repeat. The library is that layer.

## What goes there — two sub-kinds

The library holds **durable conclusions**. Two sub-kinds, with different rhythms:

| Sub-kind | What it is | Example | Write rhythm | Admit gate |
|---|---|---|---|---|
| **Domain knowledge** | What the dojo has learned about *its world* | `known-issues`, `market-map`, `bills`, `equity-grants` | Discovery — hypothesis → test → finding | Skeptic / verifier |
| **Convention knowledge** | What the dojo has learned about *how to work here* — user preferences, learned procedures, mistakes-and-fixes | "an external contributor's PR is never stalled"; "snapshot every iteration at its midpoint"; project-management style | Iterative refinement — observation → conversation → durable | Conversation with the user |

Both are durable, agent-readable, compactable, and indexed in `index.md`. The schema of an entry varies by dojo (see [Per-dojo variants](#per-dojo-variants)).

## What is NOT library

- **Transient working state** (current-iteration snapshots, open-PR lists, in-flight implementation plans) — goes stale; library entries are durable. Lives on the board, or in the project repo.
- **The dojo's own produced artifacts / documents** — code, plans, written deliverables — live in the **git repo** (possibly on an unpushed or non-`main` branch when you don't want them shared). A non-code dojo should still be a git repo: the docs *are* the project, and git makes them versioned and safe.
- **Custom, dojo-managed solutions** (scripts, integrations that import external state) — live in the [workspace](#workspace--the-escape-hatch) escape hatch; the library only *points at* them.
- **Raw data** (datasets, PDFs, screenshots) — referenced *from* a library entry but not stored *as* one. Lives in `raw_context/` (when the dojo ingests it) or external (e.g. Drive).
- **Static skills / playbooks** that were authored deliberately, not learned from work — stay in their layer (see [`playbooks.md`](playbooks.md)). A library entry that *clarifies* an ambiguous skill is fine; one that *replaces* a skill isn't.

## User-facing surface

The `.jean/` tree is implementation. The user surface is:

- **Reading:** *"What do we know about bills?"* → sensei. Or `jean library list / show <topic>` (mirroring `jean playbook list`; not yet built — see [Open](#open)).
- **Writing:** Conversation with sensei. The sensei skill encodes the gates — for findings, route through the skeptic; for conventions/preferences, **discuss with the user first, then memorise**. No `status: proposed`, no staging — the conversation *is* the gate.
- **Ingesting external documents:** *"Look at the docs at /path/foo"* → dojo internalises them. The user doesn't need to know about `raw_context/`; that's where the dojo stashes the source. If the user happens to drop files directly there (because they know the path), the librarian still processes them — convenience, not the intended workflow. Agents do the bookkeeping.

## Two write paths

| Path | Trigger | Mechanism |
|---|---|---|
| **Direct write** | Sensei observes during work — a finding, an emerging convention, a user preference | Discuss-first for conventions, skeptic-first for findings; sensei emits memory events (and/or the librarian on its nightly run) writes the entry |
| **raw_context ingest** | Human shares external documents | Dojo internalises into `.jean/raw_context/`; librarian reads new/changed files on its run; extracts conclusions into library entries; raw files stay as evidence-of-record |

Both paths converge in the same library; entries don't distinguish provenance beyond linking back to the source.

## `raw_context/` — the ingest inbox

Optional, per-dojo. Populated only when a dojo has external documents to digest. A personal-records dojo is the typical case — bank statements, payment-provider CSVs, an option-grant PDF — each traceable into a library entry (`bills`, `savings`, `equity-grants`). Dojos with nothing to digest have an empty `raw_context/` and that's correct, not a gap.

Two properties:

- **Immutable to the librarian** — read-only by design (Karpathy). Files are evidence-of-record. Enforced at `src/cli/skills/consolidate-wiki.md:143`.
- **Tracked by its own cursor** (`lastRawConsolidatedAt`) — independent of memory-event consolidation timing.

The librarian today reads text files (`.md`, `.txt`) directly and *references* binaries (PDFs, XLSX, images) from a library page — a future *raw-extract* capability is noted in the skill but not built.

## Workspace — the sensei's own repo (`.jean/workspace/`)

*(Reframed 2026-07-16 after interviewing three live dojos. The original "residual escape hatch, reached rarely" framing was calibrated for Jean-owned repos and undersold the slot; the shipped model lives in the `context` skill — the shared reading map — and the `jean-sensei` skill's "Data homes — the filing rules".)*

A **git repository of its own** under `.jean/`, created at dojo init, written by the **sensei alone** (all agents read; workers hand artifacts up for promotion). Own git repo because historyless state re-creates the exact fragility the model exists to prevent: uncommitted = no history = invisible.

Two admission classes, nothing else:

- **Systems the sensei runs** — state updated on a rhythm, procedures, machinery fed by data: trigger cursors, iteration snapshots, management scripts, tracking logs. One folder per function.
- **Records the sensei wrote** — authored durable documents too detailed for the lossy wiki: research writeups, design explorations, rejected-variants appendices. (Empirically the *largest* category in code dojos — bigger than machinery.)

Structural rules, unchanged from the original design:

- **The librarian ignores it.** Not read as authority, not rewritten, not compacted. (Contrast: librarian *writes* `context/`, *reads* `raw_context/`.)
- **The wiki points at it, per purpose.** Every system gets a **memorised functional pointer** — "for `<functionality>`, the solution lives in `workspace/<x>/`; here's how it works"; every record gets its distilled learning memorised plus a pointer to the full document. The *why* of every folder is always reconstructable from the wiki. This doubles as the admission test: if there's nothing to memorise about it, it doesn't belong.

**How central the slot is depends on the dojo's repo.** In a dojo that owns its repo outright, maintained state lives in the repo itself and workspace stays nearly empty. In a dojo whose product repo has an *audience* — an employer's codebase, a published plugin whose git history ships to users — the product repo is off-limits for agent state, and workspace is the **primary** maintained-state home, not a residual. The unifying rule is one sentence: *maintained state goes to the repo you own*; the dojo's creation-time answers (ownership, audience — satori asks) decide which repo that is.

**The cases that proved it:** a team dojo's iteration management (scripts pulling team PR/issue state + per-iteration snapshots — can't grow from the wiki, mustn't enter the employer's repo); a plugin dojo's launch assets (7 weeks homeless, squatting untracked in the product worktree because no legitimate home existed) and its outreach archive (an append-only log wearing a task costume, whose latest comment was load-bearing trigger state — a workspace log + machine-readable cursor file, misfiled).

## Implementation today

The library *is* `.jean/context/`. The librarian is the sole writer, runs as a headless agent on a nightly trigger, and follows the procedure in `src/cli/skills/consolidate-wiki.md` (with its `-draft` / `-review` siblings). Cursor state lives in `.jean/.consolidator/cursor.json`. Atomic-swap via staging dir → two renames ensures readers never see a half-written wiki.

Per-dojo customisation lives in playbooks and the project's own skills — not in this layer.

## Per-dojo variants

What's **invariant** ships in infra: the location, the single-writer rule, the cursor, the immutability of `raw_context/`, the consolidation trigger, the index-by-description pattern, atomic swap.

What **varies** per dojo (via playbook or project skill):

- **Entry schema** — `claim / evidence / status / action-implied` (discovery) vs. `known-issue / repro / fix` (SWE) vs. `topic / state / next` (personal).
- **Partition** — one file, by theme, by component, by date.
- **Compaction cadence** — nightly, weekly, on-demand.
- **Convention-knowledge style** — how operational learnings get phrased and where they sit relative to the domain pages.

A dojo can also use the library for purposes Jean didn't anticipate (a decisions log, an interviews library, lessons-from-incidents). Infra doesn't enforce; it surfaces.

## Built-in provisioning — the librarian as infra

The consolidation trigger is **infrastructure, not user content**, and must be provisioned and owned by Jean — never hand-authored by the sensei. Evidence: on 2026-06-02 a sensei asked to "make consolidation run" improvised a trigger with `kind: agent` instead of `kind: headless`; it fired into a void (no headless librarian was ever spawned — the librarian is headless/on-demand by design), and 13 sound memorize events sat unconsolidated. Anything an agent must *guess* at, it eventually gets wrong.

The shape (sharpening the "Framework-default triggers" backlog item with that live failure — the fix is not "print a better command" but to take the trigger away from the agent entirely):

- **`FRAMEWORK_TRIGGERS` registry** (analogous to `FRAMEWORK_SKILLS`) declares the infra triggers every wiki-having dojo needs, each with its *correct kind baked in*: `consolidate-wiki` (`kind: headless`, agent `librarian`, daily, model `sonnet`) and `wiki-sweep` (`kind: agent`, sensei, weekly).
- **Config override** — a `librarian` block in `jean.config.json` (`enabled` / `cron` / `model`) overrides the defaults; the managed trigger is *regenerated from config*, never hand-edited. This is what makes it a configurable, built-in named trigger rather than a guess. (The flat `CONFIG_SCHEMA` in `config.ts` needs a small extension for nested/boolean keys.)
- **Provision at `init`, reconcile on `infra start`** — init seeds the managed triggers; every `infra start` reconciles them against config (create missing, update drift, remove disabled). Zero-ceremony retrofit: existing dojos — and a dojo's currently-broken hand-made trigger — self-heal on next start, mirroring the dojo-registry's self-register pattern.
- **`jean library consolidate`** — one-off headless consolidation on demand (clean surface over the headless spawn). **`jean trigger sync-defaults`** — explicit repair, like `sync-skills` / `sync-permissions`.
- **Guardrails** — managed ids are reserved; `trigger remove` of a managed trigger redirects to `enabled:false`; `trigger list` marks `(managed)`. Validate `librarian.model` against the known set (reuse the headless-trigger model check).
- **Sensei skill** — *remove* any "create the consolidation trigger" instruction; the sensei just knows consolidation is scheduled (config knob) and can `jean library consolidate` on demand. Retire `jean librarian setup` (which only *prints* the command) into `sync-defaults`.

Different reliability profiles to respect: the headless `consolidate-wiki` spawns on demand so it never misses; the `kind: agent` `wiki-sweep` to an intermittently-running sensei inherits the missed-trigger-while-offline problem (see the "Missed-trigger replay" backlog item). Same mechanism, two profiles.

## Open

- **Convention sub-kind in the librarian skill.** The current `consolidate-wiki` skill doesn't separately treat convention entries from domain entries. Whether it should (a schema hint, a separate index section) is open — the librarian may not need to know; the sensei skill alone may be enough.
- **Library CLI surface.** `jean library list / show` would mirror `jean playbook list`. Default: defer until friction proves real.
- **Binary extraction in `raw_context/`.** Today binaries become *referenced* from a page, not extracted. Future raw-extract capability would change that.
- **A personal knowledge dojo as the reference case.** Closest to a "second-brain" library — durable topics, periodic refresh, raw_context ingest exercised. Use it as the empirical baseline when refining.

## Related

- [`playbooks.md`](playbooks.md) — the dojo's customisation layer; library is its sibling on the read-side.
- `src/cli/skills/consolidate-wiki.md` — the librarian's procedure, the implementation of everything above.
