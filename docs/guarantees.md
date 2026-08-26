# What a multi-agent Jean must guarantee

**Status: specification. Normative.**

This document says what the system must do when more than one agent is connected
to it. It is not a description of current behaviour. Where the system does not
meet a requirement, that is recorded as non-compliance in §7 — never by weakening
the requirement.

It is written to be read by someone who has never seen this codebase.

## 0. Scope — what is deliberately not promised

The requirements below are asserted within this deployment and no further:

- **One machine.** All dojos are local processes reached over localhost. Nothing
  here has met a network partition, a remote hop, or clock skew.
- **One human**, operating all dojos.
- **A handful of agents per dojo** — an orchestrator, one to three workers, a
  chat identity, a few peer dojos.
- **Cooperative participants.** Every agent is a session the operator launched.
  Nothing here defends against a hostile or spoofed participant.
- **Modest scale.** Largest board ~85 tasks; busiest log in the low tens of
  thousands of events.

**Outside the dojo is out of scope.** Delivery to peer dojos and to the human's
chat bridge is not covered by any requirement below. Those are separate
transports with their own semantics, and this document deliberately makes no
claim about them.

**The orchestrator's own liveness is out of scope.** The orchestrator is the
dojo's only actor; a report about its failure has no in-dojo consumer. Its
health is observed out of band — by the human, who launched it.

The test applied throughout: *a scope bound is something we choose not to
promise.* If the system promises it and fails, that is non-compliance, not a
bound.

## 1. Vocabulary

- **Event** — an immutable, numbered record appended to the dojo's log. Every
  event carries a declared kind, and every kind declares a **resolution
  function**: who this event's recipients are, decided at creation. No event
  exists without a kind; no kind exists without its resolution.
- **Recipients** — the agents an event is addressed to. Possibly several,
  possibly none. An event with recipients is **mail**: each recipient must read
  and clear it. An event resolving to nobody is **history**: a fact in the log
  that nobody must act on — no mailbox, no code, nothing to clear.
  Acknowledgements, announcements, idle transitions, and an agent's own writes
  are all history. History is not a second category of thing; it is the empty
  case of the one rule.
- **Name and role** (ruled 2026-08-18) — an agent's **name** is its identity:
  unique in the dojo's roster, carried on its events, what every lookup keys
  on. A **role** (orchestrator, worker, human, peer) is a shared category,
  never an identity: several agents may hold one role, and no rule may assume
  one agent per role.
- **Observer** — any agent reading an event it is not a recipient of, through a
  read surface. Reading confers nothing (P5), so observation is harmless by
  construction.
- **Pending** — the set of unacknowledged (recipient, event) pairs. This is a
  definition, not a status flag: an event with no recipients is never pending,
  and an event leaves pending when its last recipient clears it.
- **Mailbox** — one agent's unacknowledged pairs: what that agent must act on.
- **Ack code** — a token derived from the event's full content, proving the
  caller has read what it clears. Possession proves reading; it does not confer
  the right to clear — that is authorization, and it is separate (P5).
- **Announcement** — the claim "you have mail," tracked per agent; itself
  history. Distinct from delivery of the events themselves.

**Mail is never addressed to its author.** Author exclusion is part of every
kind's resolution, not a filter applied afterwards.

## 2. The invariant — independent acknowledgement

Every (recipient, event) pair has its own acknowledgement state. **No agent's
acknowledgement can consume another agent's mail.**

The defect this replaces was never the shared event — addressing one message to
several agents is ordinary and useful. It was the shared ack state: one flag on
the event, held by two mailboxes, cleared by whichever holder acted first.
Under independent acknowledgement the race has nothing to race over.

## 3. Requirements

### P1 — Delivery is exact

An event appears in the mailbox of each of its recipients and in no other
mailbox.

Assertable per event, directly against its resolved recipient list. The
resolution is the ground truth a mailbox is checked against.

### P2 — One membership function

Every surface that reports a mailbox derives it through the same single
function.

This is structural, not behavioural: parallel admission logic is non-compliant
even while it happens to agree, because agreement that is merely observed can
silently stop holding. Disagreement between a surface and the mailbox it
reports must be impossible by construction, not asserted by tests.

### P3 — No silent loss

Nothing addressed to an agent disappears before that agent has cleared it.

Under independent acknowledgement this holds by construction: only the
recipient's own acknowledgement clears its pair. Delivery failures do not
consume mail. An agent offline when a message is sent finds it on reconnect.

### P4 — Pending is defined, not policed

Pending is the set of unacknowledged (recipient, event) pairs — a definition,
where the previous model needed a requirement.

The old model derived mailbox membership by predicate, so an event could sit in
pending while matching nobody's mailbox: unfetchable, unclearable, inflating
every count forever. Two such orphans shipped and were fixed by hand, and a
floor — "every admitted event is in at least one mailbox" — stood guard against
the third. Under the pair definition the floor has nothing to guard: an event
that resolves to nobody never enters pending at all, and an event that resolves
to somebody is in exactly those mailboxes. The orphan is impossible by
construction, which is why the floor could go.

### P5 — Read before clear, authorized to clear

An acknowledgement clears a pair only when both hold: **the code matches**, and
**the caller is a recipient** of the event. A pair failing either clears
nothing.

The code is derived from the event's full content — deliberately. A derived
code is stable, needs no storage, is in the log by construction, and survives a
crash between fetch and ack for free. That any reader can recompute it is
harmless: recomputing a code does not make the reader a recipient.
Authorization, not confidentiality, is the guard.

*Limit, definitional rather than a shortfall:* the code establishes that the
content passed through the caller's context. That the caller attended to it is
not checkable by any mechanism and is not claimed.

### P6 — Accountable clearing

The clearing record names the agent that cleared each pair.

One mechanism with P5, deliberately: the ack path resolves the caller once, to
authorize and to record. A clearing that cannot be attributed cannot be
audited, and a loss that cannot be attributed cannot be diagnosed.

Acknowledgement is idempotent per recipient: repeating one reports
already-clear and is not an error. The record still shows who cleared what,
and when.

### P7 — Progress only by acknowledgement

Being shown an event never clears it. Acknowledgement is the only clearing
path.

### P8 — Announcement liveness

An agent with unhandled mail is told, and told again until it acts:

- the first announcement follows the mail within a bounded interval;
- repeat gaps follow a ladder that never shrinks and is bounded above;
- any activity by the agent resets the ladder;
- the ladder never terminates while mail is unhandled.

The bounds are named configuration, not numbers in this document. Nothing asks
whether an agent is busy: busy and unreachable are one case.

**What is deliberately not promised: that any single announcement becomes a
turn.** A session can miss any one wake — that is baseline behaviour for
agents, not a defect to diagnose. The system's obligation is repetition until
the agent acts.

### P10 — Freshness

Every surface reports the queue as of the moment it responds, never a stored
snapshot — including the falling case, where an agent asking whether it is
finished must not receive a count assembled before the events it just cleared.

### Retired requirements

- **P9** (announcements become turns) — folded into P8. Single-wake success is
  not promisable; repetition is.
- **P11** (observations carry their time) — demoted to §6. The system cannot
  validate a participant's prose claims about state; it can only make fresh
  state cheap.
- **P12** (reads are recoverable) — deleted. Under independent acknowledgement
  and P6, "I was told I have mail and my read returned nothing" is adjudicable
  from the log alone: the only agent that can have cleared your mail is you,
  and that ack is attributed.

Numbering is kept stable so existing tickets and comments stay correct.

## 4. Resolution — who each kind addresses

This table is normative: a new kind must declare its resolution before it can
be emitted.

| Kind | Recipients |
|---|---|
| Message to a named agent (dispatch, peer-to-named, `jean send`) | that agent |
| Worker reply | orchestrator |
| Human message | orchestrator, or the named agent if addressed |
| Peer inbound, dojo-addressed | orchestrator |
| Task created / status / comment | everyone involved with the task, minus the author |
| Task reminder (blocker cadence) | orchestrator |
| Trigger firing targeting X | X |
| Idle-liveness ping | the pinged worker |
| Agent down, worker status (including recovery) | orchestrator |
| Agent register, agent disconnect — one pair, resolved alike | orchestrator, minus the subject: an agent is never told of its own arrival or its own departure |
| Acknowledgement, announcement, idle transition, memorize | nobody — history |

The task row is a resolution, not an address: a task created unassigned by the
orchestrator resolves to nobody and is emitted as history. Today the resolution
usually yields one agent; when several agents work one task it already works,
with no new kinds and no paired notifications.

**Liveness, the whole of it:**

- An agent **with pending mail** needs no probe: the ladder announcing its
  existing mail is the probe. Liveness is inferred from what its silence does
  next, not from a dedicated exchange.
- An **idle worker** — no task, no pending mail — is pinged after a
  configurable silence (default 24 hours): ordinary addressed mail whose
  acknowledgement resets the clock. Edge-triggered: never re-emitted while one
  is outstanding, so nothing accumulates in a down worker's mailbox.
- **Down keys on absence of activity, never on absence of acknowledgement.** An
  agent mid-task with unread mail is busy, not down — a verdict keyed on
  unacked mail would convert every absorbed agent into a false down-report.
- **Infra does not supervise the orchestrator** (§0).
- **One event, not a pair.** A status report is a single addressed event, never
  a general record plus a follow-up to handle — in an event-sourced log the
  cleared event *is* the record, and a pair reintroduces the forgot-to-route
  hazard one level up.
- **Every down gets a matching return.** A worker reported down produces a
  recovery report when it comes back, whether or not it still holds work. An
  episode that produced a report ends with a report; an episode that produced
  none ends silently.
- **`disconnect` remains a kind while a transport connection exists**; when the
  transport retires, it merges into the liveness kinds by deletion, which is
  safe because both are identically addressed.

**No kind is anycast.** "One of them will handle it" is claim machinery, built
and deleted once already, and it would move a routing decision into infra.
Multi-recipient mail is the opposite: every recipient clears independently.
Send-to-all-without-ack needs no kind at all — it is an empty-resolution event
read through the surfaces.

## 5. Fixtures

Any test of these requirements is built so that **no two agents' answers can
coincide by accident, and no agent's answer coincides with the dojo-wide
total** — and asserts that non-coincidence explicitly. A fixture whose numbers
can coincide passes under both a correct and a broken implementation.

**Every test asserts that what it compares is present.** A check that A differs
from B passes trivially when both are absent.

**Tests that depend on ordering control it explicitly** rather than observing
whatever the scheduler does.

On top of those three rules:

- **Randomized, scaled runs.** Five to ten fixture agents, randomized traffic,
  with the expected mailbox state tracked alongside as ground truth.
- **Typed behavioural roles.** Fixture agents are tagged from setup —
  responsive, busy, unresponsive, failing-at-a-rate — with expected
  orchestrator-visible behaviour defined per role. The failing role is how P8's
  ladder is tested: a mock that drops wakes at a configured rate, with the
  assertion that repetition recovers.
- **A replay-based invariant checker.** The full log of a randomized run is
  walked event by event in hindsight, applying the invariant at each point:
  every pair cleared only by its own recipient (P3), independently of the
  event's other recipients (§2), with the clearing attributed (P6).
- **At least one multi-recipient event**, with the explicit assertion that one
  recipient's acknowledgement leaves the event in every other recipient's
  mailbox, and that a non-recipient's acknowledgement clears nothing.

## 6. Limits — what no mechanism can enforce

- **Acknowledged means read, not attended to.** The code proves content passed
  through the recipient's context; nothing can prove attention.
- **A participant can report a stale read as current.** Any read is stale the
  moment it is taken, and infra cannot validate prose claims about state. The
  mitigation is structural, not behavioural: fresh state rides every response,
  so reaching for the current answer is always cheaper than trusting memory.
- **A single wake can be missed.** Sessions are sometimes unreliable; that is
  the baseline this system is built on, and P8's ladder is the response.

## 7. Non-compliance

Where the system does not currently meet a requirement. This register is the
defect list; the requirements above are not weakened to accommodate it.

| # | Requirement | What the system does instead | Ticket |
|---|---|---|---|
| 1 | **§2, P1, P3** | Membership is derived by predicate, not resolved at creation. One event can enter two mailboxes with one shared ack flag; either holder's ack clears it for both, and the other is not told. Confirmed live three times; the race window is the other holder's response latency (6s–987s measured). | 068 |
| 2 | **P6** | The clearing record names the events cleared and not the agent that cleared them. Every diagnosis of a vanished event so far has required hand-correlating two sessions' timestamps. | 068 |
| 3 | **P5** | The ack path performs no authorization: any caller presenting a correct code clears the event, recipient or not. The caller's identity is resolvable in that handler today (`callerFromHeader`, unused there) — rows 2 and 3 are one missing mechanism. | 068 |
| 4 | **§1, P4** | Events are untyped and kinds declare no resolution; membership is recomputed by predicate on every read. Nothing structurally prevents a kind that reaches pending and no mailbox. | 068 |
| 5 | **P2** | Surfaces apply parallel admission logic: two inspection surfaces use one clause where mailbox reads apply two. Agreement is observed, not structural. | unfiled |
| 6 | **P1/P2** | The client plugin returns early for non-orchestrator agents on socket-path tools, so a worker gets no inbox line on the two tools it uses most. Independent client-side bug; moot if the plugin retires for MCP. | unfiled |
| 7 | **§4** | A worker's return from down is reported only while it still holds its work: re-routed and idle workers recover silently, so the orchestrator's availability picture goes stale in the direction that matters for dispatch. Ruled 2026-08-15: every down gets a matching return. | unfiled |
| 8 | **§4** | The shipped supervision (069) probes every silent agent with a dedicated `agent-probe` kind, including agents with pending mail, and tests pin that design. The spec narrows the probe to idle-empty workers and makes the ladder the probe for agents with mail. Implementation work; the probe pins want rewriting, not repairing. | unfiled |

Rows 1–4 are the pre-revision model and land together with 068. Full
derivations and measurements live on 068.
