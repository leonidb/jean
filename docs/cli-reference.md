# CLI reference

## CLI

### `jean dojo init [path] [--git | --git-from <repo>] [--no-librarian]`
Makes `path` (default: the current directory) a dojo: creates its `.jean/` subdirectory, where the dojo's own state lives — agents get their own directories beside it, at `<dojo>/<name>/`. `--git` gives it a fresh bare git repository at `.jean/.bare/`; `--git-from <repo>` clones an existing one bare instead. Either gives every `jean agent add` worktree something to branch from. The port is allocated automatically. `--no-librarian` skips scheduling the nightly wiki-consolidation trigger.

### `jean setup`
Registers Jean as a Claude Code MCP server, once per machine. Every dojo's agents load the same registration.

### `jean satori`
Opens an interactive setup session in the current dojo: it asks what the dojo is for, proposes a roster, writes the dojo's context and playbook stubs, and runs `jean agent add` for each agent once you approve. Setup only — it does not create the dojo, start infrastructure, or launch agents.

### `jean agent add <name> [--role sensei|worker|user] [--tags <tags...>] [--no-worktree]`
Creates an agent: a directory inside the dojo — a git worktree on branch `jean/<name>` by default — with the permissions and skills its role needs. Default role: `worker`. `--no-worktree` gives it a plain directory instead.

### `jean agent add --existing <path> [--role sensei|worker|user] [--tags <tags...>]`
Configures a directory that's already there as an agent, rather than creating one.

### `jean agent start <name>`
Launches `<name>` as a Claude Code session wired to the dojo. Requires the channel registered (`jean setup`) and the dojo's infrastructure running (`jean infra start`).

### `jean infra start` / `jean infra stop`
Starts or stops the dojo's infrastructure — the event log, the mailbox and the HTTP API behind every agent connection, `jean board` and `jean task log`. `start` binds the dojo's port (allocated at `jean dojo init`, overridable with `JEAN_PORT`) and detaches; `stop` reads its PID file and signals it directly.

### `jean board`
Lists every task, grouped by status.

### `jean task log <id>`
Shows one task's event history — created, assigned, sent, replied — in order. Comments are not among the event types it prints.
