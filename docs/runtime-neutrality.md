# Jean — Runtime Neutrality

## Principle

**Jean orchestrates agents over a runtime-neutral protocol. The infrastructure must not assume its agents are Claude Code.** Claude is the *reference runtime*, not a built-in assumption.

This is a design principle, not a feature request. It is the lens for evaluating infra work: anything that reaches from `src/infra/` into a Claude-specific mechanism is a smell. The payoff is not "we can run Codex" — it's that the orchestration core stays honest, and we are steered away from per-runtime hacks that would otherwise accrete invisibly.

This generalizes an earlier core idea — *"agents are just Claude."* The truer statement is: **agents are just sessions behind an adapter** — Claude is simply the first adapter we wrote.

## The boundary already exists

The WebSocket protocol between infra and the channel plugin **is** the abstraction boundary. Infra speaks a small message protocol (`register` / `reply` / `send` / `task-comment` inbound; `deliver` / `registered` / `error` outbound — `src/infra/protocol.ts`), and that **agent protocol** carries no Claude assumptions — role-based tool gating, the pending-as-sensei-inbox model, nudging, the board, and event sourcing are all runtime-neutral. This is the good news: the core didn't need to be designed for this; it already is.

## The Claude couplings

Two, and both are isolatable — the agent *protocol* stays neutral.

**1. Inbound push (the channel adapter) — essentially one line:**

- `src/channel/server.ts:98` — declares the `experimental: { 'claude/channel': {} }` capability.
- `src/channel/server.ts:303` — inbound push: an infra `deliver` becomes `notifications/claude/channel`, which Claude Code injects into the running session as a new turn.

(Documented mechanism: `docs/research.md` § Claude Code Channels.) Everything else in the plugin — the outbound WS, the MCP tool definitions (`reply`/`comment`/`memorize`/`ack`/`infra`), registration — is neutral. The channel plugin is best understood as **one runtime adapter**, not infrastructure.

**2. The headless-trigger spawner.** `src/infra/server.ts` runs one-shot `claude -p` for triggers (e.g. librarian consolidation) via `spawnHeadless` + `probeAnthropicAPI` — genuinely Claude-specific code living in `src/infra/`. It's a *second* coupling, in trigger execution rather than the agent-membership path; a non-Claude trigger runtime would need its own spawner here. Naming it honestly: the agent protocol is neutral, but trigger execution is not yet.

## The runtime-adapter contract

To host a Jean agent, a runtime needs an adapter providing:

1. **Register + outbound** — open the WS, send `register`, expose the Jean tools. *MCP-native runtimes get this nearly free.*
2. **Inbound push** — turn an infra `deliver` into a new turn in the running session. *The hard part.* Claude = `claude/channel`; Codex = drive the conversation via its app-server (the codex plugin ships `app-server-broker.mjs` + `app-server-protocol.d.ts`).
3. **Idle signal** — report turn-end to `POST /agent-idle`. Claude = Stop hook; Codex = session-lifecycle hook.
4. **Instructions** — deliver the role's skill content. Claude = `SKILL.md`; Codex = `AGENTS.md` / system prompt. Content ports; delivery differs.
5. **Approval / permissions** — per-runtime config, outside the protocol. Claude = `settings.local.json`; Codex = sandbox / auto-approve.

Only #1–#3 are load-bearing for orchestration; #4–#5 are setup. #2 is where almost all the real work lives.

## Codex as the second runtime (the validation case)

Two integration depths, very different commitments:

- **(A) Delegation** — a *Claude* worker stays the Jean-connected member and shells out to `codex:rescue` for heavy lifting. **Zero infra change.** Codex is a *tool*, invisible to the board.
- **(B) Membership** — Codex is a first-class agent with its own Jean identity, inbox, and board presence. Requires the adapter above (hard 20% = inbound push via app-server). The swarm becomes genuinely **heterogeneous** (Claude + GPT-5 workers side by side).

(B) is the milestone that *proves* the boundary and forces the implicit adapter contract to become explicit. Not committed — captured here so the principle is on the record and future infra work can be measured against it. Start with a worker, not a sensei: sensei's value is orchestration judgment and its nudge/inbox loop is the most Claude-tuned, least-understood surface.

## How the principle guides

- New infra features route through the WS protocol, never reach into Claude specifics.
- Claude-only assumptions (channels, Stop hook, `settings.local.json`, `SKILL.md`) belong in the adapter layer — never in `src/infra/`. When one shows up there, isolate it.
- Prefer **adopting** mature agent runtimes as members over **building** an agent runtime — Codex (or any other) as a member is adoption, in the spirit of the rest of Jean's infra stance.
