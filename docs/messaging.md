# Messaging

Every agent has a mailbox. Substantial work reaches it as a task (see [Running Jean](running.md) for creating one through the sensei); a plain message reaches it directly.

**Talking to an agent you're looking at** — the sensei's or a worker's own terminal, opened with `jean agent start` — is an ordinary Claude Code conversation. Type into it directly.

**Reaching an agent you are not looking at** goes through the sensei. Ask it, in its own terminal, to pass the message on, and it dispatches into the same mailbox everything else uses. Work entering the dojo through one place is what lets that place hold the record of who was asked for what.

## What a mailbox guarantees

A message is not a best-effort ping. The dojo's infrastructure holds it until the agent it was addressed to has actually taken it.

- **It lands in that agent's mailbox and in no other.** When something goes to several agents, each gets its own entry — so one agent acting on it never consumes another's copy.
- **Only the recipient clears it.** Nothing is cleared by having been sent, delivered, or even read. The agent acknowledges it explicitly, and until then it is still outstanding.
- **A closed session loses nothing.** Mail waits for an agent that is not running and is announced when it reconnects. Being away never costs a message.
- **The agent is reminded until it acknowledges.** An announcement is the dojo telling an agent it has mail. If the agent does not act, it is told again, and again: the gap widens — roughly two minutes, then five, then ten — but the reminders do not stop while the message is unhandled, and any activity by the agent resets the ladder to its first rung. What is promised is the repetition, not that any one reminder lands. A session can miss a wake; it will be told again.

An agent answers in two ways. A **reply** is how it talks back to the sensei, always, regardless of who or what sent the original message. A **comment** is a durable note left on a task, for whoever reads that task later.

Next: [Agents](agents.md), for what a sensei and a worker each are, and what else a role can be.
