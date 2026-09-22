# Agents

Every agent is a name Jean tracks, with a role attached. The **sensei** orchestrates: it turns requests into tasks and routes them to workers. A **worker** carries out the tasks it's given.

## Adding an agent

```
jean agent add <name> [--role sensei|worker|user] [--tags <tags...>]
```

creates the agent's own directory inside the dojo — a git worktree on branch `jean/<name>` — and gives it the permissions and skills its role needs. Default role: `worker`.

## Starting an agent

```
jean agent start <name>
```

launches `<name>` as an ordinary Claude Code session wired to the dojo: it can load Jean's tools, and Jean can reach it. Starting requires the channel to be registered (`jean setup`, once per machine) and the dojo's infrastructure to be running (`jean infra start`). Jean checks both, and says which one is missing.

## The channel

Jean reaches a running agent through a channel: an MCP server, loaded with `--dangerously-load-development-channels server:jean`. `jean setup` registers it once per machine; every dojo and every agent then shares that one registration.

Next: [CLI reference](cli-reference.md), for the exact syntax behind every command here.
