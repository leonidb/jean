# Running Jean

## Install

You need [Bun](https://bun.sh), [Claude Code](https://claude.com/claude-code), and Git.

```
bun add -g github:leonidb/jean
```

That puts a `jean` executable on your `PATH`. There is no build step — the
command runs from TypeScript source.

Then register the channel:

```
jean setup
```

That is what lets a Claude Code session reach a dojo, and it is machine-wide —
you do it once, here, and every dojo you make afterwards uses the same
registration.

## Your first session

A **dojo** is the project directory a sensei and its workers share. `jean dojo
init` creates one; `jean satori` then sets it up for you, and it is the path the
CLI recommends. Satori opens an interactive session that speaks first, asks a
handful of questions about what the dojo is for, and proposes a roster. Approve
it and Satori runs `jean agent add` for each agent, writes a summary of the dojo
and that roster to `.jean/context/readme.md`, and drafts a playbook stub under
`.jean/playbooks/` for each workflow you described. Then it reports what it made
and stops: it does not start infrastructure or launch the agents, so you pick up
at step 4 below.

The walkthrough takes the manual path instead, naming the two agents itself, so
that nothing appears without you having typed it. Either way you end with a
**sensei** handing work to a **worker** and getting it back.

1. **Create the dojo.**
   ```
   jean dojo init --git my-dojo
   cd my-dojo
   ```
   `--git` gives it a bare git repository at `.jean/.bare/`, so the agents you add next get real worktrees on real branches.

2. **Check the channel is registered.** `jean setup` is a once-per-machine step from [Install](#install) above — if you have run it before, on this machine, there is nothing to do here.

3. **Add a sensei and a worker.** Two ways, and the CLI recommends the first.

   **3.1 — Guided.** `jean satori` does what the section above describes: intake, a proposed roster, then the agents, `.jean/context/readme.md` and the playbook stubs once you approve.
   ```
   jean satori
   ```

   **3.2 — Manual.** Name the agents yourself:
   ```
   jean agent add sensei --role sensei
   jean agent add worker
   ```
   `worker` is the default role, so the second command needs no `--role`. See [Agents](agents.md) for what a role determines.

   The rest of this guide follows 3.2, so the names below are the ones you just typed.

4. **Start the dojo's infrastructure:**
   ```
   jean infra start
   ```
   It detaches — leave it running.

5. **Start the sensei**, in its own terminal:
   ```
   cd my-dojo
   jean agent start sensei
   ```
   Every `jean` command finds the dojo by looking upward from the directory you are in, so each new terminal needs that `cd` first.
   This is an ordinary Claude Code session. Talk to it directly.

   You will see it start with `--dangerously-load-development-channels`. While channels are in research preview that flag is the only way Claude Code loads one, and the channel is what gives the agent its Jean tools — without it the session comes up with no way to reach the dojo. What it loads stays on your machine: the channel server registered by `jean setup`, run from your own installation, talking to this dojo's infrastructure over `127.0.0.1`. That address binds loopback only, so the dojo is reachable from this machine and nowhere else. Starting an agent publishes nothing.

   The flag does not touch file permissions. Those come from the `settings.local.json` that `jean agent add` wrote for the agent's role, and loading the channel neither widens them nor skips a prompt.

6. **Start the worker**, in another terminal:
   ```
   cd my-dojo
   jean agent start worker
   ```
   It has nothing to do yet, and waits until the sensei sends it something.

7. **Ask the sensei for something.** In its terminal:
   > Give the worker a task: introduce itself and report back.

   The sensei creates a task and sends it to the worker. Watch the worker's terminal pick it up, do it, and reply — then check back with the sensei, which has the result.

8. **Read the record back**, from any terminal in the dojo:
   ```
   jean board
   jean task log <id>
   ```
   `board` shows the task; `task log` shows what happened, in order — created, sent, replied.

When you're done, `Ctrl-D` exits each Claude Code session, and `jean infra stop` shuts down the infrastructure.

Next: [Messaging](messaging.md), for what carried that task to the worker and the reply back.
