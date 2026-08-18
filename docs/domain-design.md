# The Domain Layer — Design

**Task 075. Written as a design, and approved before any of it was built.**
Inputs: the guarantees spec (`docs/guarantees.md`, the behavioural
contract this layer must serve), task 073's audit (the inventory of judgement
stranded in the adapter), and the 073 rulings folded in as constraints: core
never returns JSON; connection events are domain facts. Ruled 2026-08-18:
the build this design feeds is a REWRITE (§9) — the old system, its tests,
and the instrument suites built against it go with it.

---

## 1. What a domain is, here

This system's domain is **the dojo**: agents and their membership, tasks and
their lifecycle, mail and its acknowledgement, attention (announcement,
reminders, supervision), triggers' schedules, playbooks, and the dojo's
knowledge. All of it is expressed one way — **facts in an event log, and
decisions over those facts.**

The classifier, for a reader meeting a piece of code they have never seen. Code
is domain **iff it can be written as a function from typed values to typed
values** — `(facts, state, instant) → decision` — and passes three questions:

1. **Does it read anything it was not passed?** (a clock, an env var, a file, a
   projection it reached for) — if yes, not domain until the read becomes a
   parameter.
2. **Does it do anything besides return?** (append, deliver, push, write) — if
   yes, not domain: the domain *describes* effects as data; the shell performs
   them.
3. **Does its vocabulary name a carrier?** (HTTP, header, URL, socket, JSON,
   Slack, Bun, filesystem) — if yes, not domain. `caller` is domain; the
   `x-jean-agent` header is not. "This agent connected" is domain; the
   WebSocket that carried it is not.

Applied to the audit's terms: **judgement is domain, translation and execution
are adapter.** The `StoredEvent` record and the fold (`Reducer`) are domain
vocabulary — the store engine, snapshots, and JSONL backends (`es/`) are
infrastructure the shell wires in. Serialization is never domain: **JSON does
not cross the boundary in either direction** (ruled, 073). The domain accepts
typed values the adapter parsed, and returns typed values the adapter
serializes.

**The standing pattern — decide/execute — already exists and works.**
`core/notify.ts` is a pure machine returning `Decision = { next, effects }`
with effects as data, executed behind a `NotifyExecutor`; `core/supervision.ts`
has the same shape; `liveness.ts` states "Pure: no registry, no clock of its
own, no I/O. Callers pass what they observed." This design is not an invention
— it generalizes the shape the attention modules already have to the rest of
the system, and retires the parts of the system that never got it.

## 2. The model the layer is cut against

**The spec's model, not today's.** Kinds declare resolution functions;
recipients are decided at creation; pending is the set of unacknowledged
(recipient, event) pairs, a definition rather than a status; history is the
empty-resolution case of the one rule; mail is never addressed to its author
(guarantees.md §1–§2). The module structure below is shaped for that model.
Where today's code implements the predicate model instead, the module is *born
on the spec* rather than built twice — §9 sequences exactly where that happens
and which reds each such stage flips.

## 3. The module structure

```
src/domain/
  contracts/          THE PUBLIC SURFACE, PHYSICALLY SEPARATED (ruled):
    vocabulary.ts     event kinds + data types, streams, roles, ids — names, no logic
    resolution.ts     the resolution contract (spec §4's shape)
    mailbox.ts        one contract file per module: its types, its port
    tasks.ts          contracts, its function signatures — with a SPEC.md
    agents.ts …       beside it wherever the contract needs prose
  resolution/         implementations — one directory per module. Each exports
  mailbox/            a single object typed by its contract
  tasks/              (`export const mailbox: MailboxContract = { … }`),
  agents/             so conformance is a compile-time structural check —
  attention/          TS's native protocol-plus-implementations, no
  triggers/           `implements`, no class
  routing/
  knowledge/
```

Contract files carry prose as well as types: where the type system cannot
state an invariant (a round-trip law, an ordering), the contract says so **and
names what does enforce it** — the conformance suite, an executor law, a
fixture rule.
A contract that admits its own limits is load-bearing; one that implies
enforcement it doesn't have is comment-versus-code drift waiting to be found
(adopted from a field review).

Modules own: **resolution** — the function per kind, author exclusion;
**mailbox** — pairs, membership, the three views, selectors, ack (codes,
`applyAck`, `acknowledgedCount`), priority, the delivery ledger; **tasks** —
board fold, transition DAG + actor gates, revert fold, parking/snooze,
staleness, id allocation; **agents** — membership (join by register, leave by
explicit act), roles, activity rules, session classification,
duplicate-session policy; **attention** — notifier ladder, reminder clocks,
supervision; **triggers** — validation, schedule planning, catch-up policy;
**routing** — dojo-queue vs adapter-target vs unknown-warn; **knowledge** —
memory admission, retrieval ranking.

**Dependency direction** (arrows mean "may import the *contract* of"):

```
vocabulary ← resolution ← mailbox ← attention
vocabulary ← tasks      ← attention
vocabulary ← agents     ← {mailbox, attention, routing}
vocabulary ← {triggers, knowledge}
```

No cycles — and stronger than an index-file rule: **implementations never
import other implementations.** A module reaches a dependency only through its
contract, so a test substitutes a fake satisfying the same contract and the
compiler checks both. The guard is the existing mechanism generalized:
`core/boundary.test.ts`'s allowlist becomes "each implementation imports only
`contracts/` and its own directory," read from this table.

**How the strays resolve:**

- `board.ts` → `domain/tasks` (it already is this module's vocabulary half).
- `inbox.ts` → `domain/mailbox` (it is the views' rendering half).
- `reducers.ts` — **should not exist in this shape.** 917 lines holding every
  kind's data type, four unrelated folds, and `toApiEvent` — an API serializer
  living in the domain's densest file. It splits four ways: data types →
  `contracts/vocabulary.ts`; each fold → its module (`boardReducer` → tasks,
  `pendingReducer` → mailbox, trigger/playbook folds → triggers/knowledge);
  `toApiEvent` → the adapter, where serializers live.
- `protocol.ts`'s `AgentRole` → `contracts/vocabulary.ts`; protocol
  re-exports. The WS
  protocol file stays adapter vocabulary.
- `core/`'s eleven files map across: notify/supervision → attention;
  mailbox-rules/views/queue/codes/ledger/priority → mailbox;
  triggers → triggers; core/vocabulary → mailbox (it renders the views'
  glyphs); **bus.ts → the shell** — it wires delivery and decides nothing.
- `liveness.ts` → `domain/agents`. `retrieval.ts` ranking → `domain/knowledge`;
  `retrieval-corpus.ts` splits (ranking input types are domain; the filesystem
  walk that builds the corpus is adapter).
- `src/infra/target/` goes with the old system. It was itself an earlier
  fresh-location attempt that stopped at signatures (§9 says what is
  different this time), and it was cut against a different transition's
  shape. Nothing builds on it.
- `src/infra/core/` as a name retires. **The layer is `src/domain/`; the shell
  keeps `src/infra/`.** "Core" was earned structurally; "domain" is the honest
  claim this design makes checkable.

**The agents module's vocabulary, precisely** (corrected 2026-08-18 — an
earlier draft called this a "fork" between two identities, which overstated
it). There are three things, and only one is an identity:

- **`name`** — THE identity. `builder`, `architect`, `sensei`: set at launch,
  carried on every event, what every lookup keys on. It already exists;
  nothing needs inventing.
- **`role`** — a shared CATEGORY, not an identity: `sensei` | `worker` |
  `user` | `peer`. Two workers both have role `worker`; tomorrow several
  `dev` agents share role `dev`. Nothing may assume one agent per role.
- **`connected`** — a BOOLEAN fact: is there a live session for this name
  right now.

There is one identity with **two sources of fact about it**: the persisted
record (the log's register history) says who exists and with what role; the
live map says who has a session at this instant. Mailbox rules consult the
first, the inbox header the second — *the sources* are what must stay
separate, and they cross every seam as separate fields. Whether the
inbox-header gate keys on the persisted record or the live session is
a pending ruling; the design carries both so the extraction cannot
settle it silently. The module also hosts, as its natural
extension point, whatever is ruled on never-connected agents and mailbox
existence (the P3 revision under discussion): recipient-universe membership is
this module's question — join on first register, leave by explicit act, never
by inference.

## 4. Where every stranded rule lands

073's inventory, assigned. Line refs are main as of the task-065 spec commit.

| Stranded rule (adapter today) | Lands in |
|---|---|
| Status-gate role resolution (server.ts:2190) | agents |
| Transition DAG + actor gates (2177–2194) | tasks |
| `blockedOn` required on `waiting`; snooze-date-must-parse *rule* (2200, 2214) | tasks |
| Revert status-stack fold (2239–2254) | tasks |
| Board staleness (3044–3052); task-id allocation (790); `inferTaskId` (781) | tasks |
| Comments/messages projection of a task stream (2138–2159) | tasks |
| Selector contract: at-most-one, selector-requires-reader, selection inside the mailbox, loud `missing` (2780–2835) | mailbox |
| Ack: empty-pairs-fail-loud (2978); `applyAck` + `caller` seam; attribution carrier | mailbox |
| Delivery-ledger reading rule + stamp scoping (core/ledger.ts; 2847) | mailbox |
| `touchAgent`'s "what counts as activity" incl. H7's exclusions (3151; 2481) | agents |
| Agent-idle: stale-session, disconnected, stream choice (2447–2491) | agents (verdict) + tasks (stream choice) |
| Duplicate-session keep-incumbent (3184–3245) | agents — connection events are domain facts (ruled) |
| Trigger validation family: cron-xor-at, kind rules, model/retries gating, role check, immutability, unknown-field rejection (2550–2610) | triggers |
| Trigger fire-now planning; catch-up policy | triggers |
| Queue-vs-warn on send (830–840, routeSend) | routing |
| Memory admission (memorize validation *rules*) | knowledge |
| `/status` aggregation incl. pollGap aging (3120) | shell (it reports transport health — adapter's own subject) |

The last row is deliberate: bridge health is a fact *about a transport*, so the
domain never sees it. That is the classifier working, not an exception.

## 5. The adapter's finished shape — both legs

**Adapters have two legs, and they get equal billing** (ruled, 2026-08-18).
The inbound leg handles a call; the outbound leg *listens to the domain*. A
send arrives over HTTP, the domain decides, and the consequences reach *other*
agents through adapters that were never handling any request — a WS push, a
bridge message, a wake. The HTTP reply to the original sender is a receipt,
not the result. Some adapters have no inbound leg at all: they exist only to
carry domain output.

**The inbound leg** — one pattern for every endpoint: **parse → resolve
context → call domain → execute effects → serialize.**

- **Parse**: query/body/header grammar → typed values. The 400s live here
  (malformed ids, bad JSON), stated as grammar, not policy.
- **Context**: `{ name?, role?, connected }` from header/`?for=`/body + the
  agents module's two facts; per-family views built from projections (the
  `notifyView`/`supervisionView` precedent).
- **Call**: one domain function. The handler makes no decision.
- **Execute**: the shell performs the returned effects — append, deliver,
  stamp, discharge — **in the order the decision lists them**, as an explicit
  law of the executor's unit contract (§6), stated and conformance-tested
  from birth. The new shell never has the old one's adjacency welds (§11).
- **Serialize**: rename-only `(DomainResult) → body`. A serializer that reads
  anything but its argument is the 059 shape, and in a file where nothing else
  reads state it is visible on sight. JSON exists only in this step. Wire and
  storage shapes are the adapter's own: contract types are defined by the
  domain, never by what a row or a payload happens to hold.

**The outbound leg — listener adapters.** The domain's decisions carry their
consequences as effects — `{ kind: 'deliver', to, text, … }` and its kin — and
a listener adapter is a subscriber that translates one effect family onto one
carrier: the WS adapter turns `deliver` into a channel push, the bridge turns
it into a Slack message, the piggyback turns an inbox fact into a response
header. Subscription is the executor mechanism that already exists: the shell
hands each decision's effects to the registered executors, in order (this is
where the delivery-port rule — "every delivery goes through the port, no
exceptions" — becomes the *only* possible shape rather than a guarded one).
Listener adapters are the *easy* testing case, and the document owes them
that statement: feed the adapter a list of effects, assert what it emitted —
no server, no clock, no domain.

What the shell keeps, in full: `Bun.serve` + routing, WS lifecycle and frames,
timers (still single branch-free calls — the pinned rule), store/projection
wiring and replay, the bus, effect executors, env → dials, filesystem
(cursor, wiki walk, runtime files), headless spawning, bridge/peers/channel
transports, `crypto.randomUUID` behind an id port.

How thin is "thin": every handler follows the five-step pattern in roughly ten
lines, and the file contains **no conditional that isn't dispatching on route
or method.** Honest size estimate: server.ts 3520 → an adapter of ~1000–1300
lines (routing table, parsers, serializers, executors, wiring) plus the domain
modules. The thousand-line closure does not survive; `createInfraServer`
shrinks to wiring.

## 6. The five properties, and the TS mechanism that delivers each

Not Java transliterated. TS interfaces erase; privacy is "don't export"; the
codebase's own DI convention already works. Per property:

1. **Understandable alone** → one `index.ts` per module as the whole public
   surface, with the contract stated in the header doc comment (the
   house style already does this well). The exports *are* the interface.
2. **Fully testable alone** → pure functions over values, effects as data.
   Honest limit, stated plainly: modules share *types* (vocabulary) and
   fixtures; "without other modules" means without their **behaviour** — a
   test injects fakes of the ports, never imports another module's logic.
3. **Dependencies injected** → the plain ports object, passed as a parameter
   (`createNotifier(exec)`, `createSupervisor(exec)` — the working precedent).
   No framework, no decorators, no containers. **This is where a declared
   type earns its keep**, and the evidence is already in the tree:
   `export type NotifyExecutor = { deliver: (to, text) => boolean; emit:
   (type, data) => void; stamp: (via, ids) => void }` — production passes one
   object, tests pass another. That is protocol-plus-multiple-implementations
   expressed structurally: TS checks every implementation against the
   declared shape with no `implements` and no class. The contracts/ package
   (§3) is this same mechanism promoted to the module level. Whether spelled
   `type` or `interface` is indifferent; the codebase says `type`, keep it.
4. **Internals private** → don't export, and **enforce structurally**: the
   generalized boundary test reads each module's imports against §3's table.
   Language privacy (`private`, `#`) adds nothing a non-export doesn't already
   give a function-and-closure codebase.
5. **No transport knowledge** → the same boundary test (no adapter imports, no
   carrier vocabulary), plus the two seam rules: values in, values out; JSON
   never crosses.

**Classes: not needed, argued rather than assumed.** The two stateful machines
(notifier, supervisor) already get privacy and injection from closure
factories, *stronger* than class privacy (nothing to reflect on at runtime,
nothing exported to subclass). Everything else is stateless functions, where a
class is pure ceremony. Where an `interface` would be declared only to have
"an interface" — on modules of pure functions — it is ceremony too: the module
surface is already the contract.

**Port design rule — bag or unit** (adopted from a field review).
A bag of independent functions is the right port shape for ambient
capabilities with no invariants *between* them — clock, id factory, log. **The
moment members must agree with each other, the contract is a unit**: it states
the agreement, so a suite can test it as one thing. By that test,
`NotifyExecutor` is already a unit wearing a bag's clothes — `deliver` and
`stamp` are not independent (you stamp what a deliver carried), and the old
shell's order welds were exactly "if you do A, B must match" pair-properties
spread across bag members — which is why behaviour alone could never pin
them there. The executor contracts in `contracts/` are therefore units: the
order and agreement laws are stated in the contract and held by its
conformance suite from birth, where behaviour *can* see them (§11 explains
why the new shell has no welds to inherit).

Two more review rules adopted as standing: **a shape earns its keep only if a
caller uses it as designed — establish that by reading the callers**, and
distrust port-versus-leaf speculation arguments specifically, because that is
the argument shape that lets unused abstractions survive; and **derive a
contract type from its writer, never from an observed sample** — a field
inferred from one payload is a record of that sample, not of the producer.

## 7. The testing story

**"Testable alone" is a floor, not a ceiling** (ruled, 2026-08-18). Every
module *can* be tested without standing up the world — that is the property
§6 delivers. It does not mean a module may *only* be tested that way:
**multi-module and end-to-end tests over the domain are first-class, and
multi-agent ones especially**, because that is where most meaning lives. A
send is only meaningful when the test can assert it landed in a particular
agent's mailbox — routing, mailbox and agents composed, with a registered
mock agent. The fixture below is exactly that composition; module-alone tests
are the floor beneath it, not a substitute for it.

**Every composed test carries two kinds of assertion**, and the first is the
easy one to forget: **generic validity** — the event state as a whole still
satisfies the invariants (the replay checker's shape, applied beyond the
randomized runs: pairs consistent, no orphans, resolution honoured) — and the
**specific outcome** the test exists for. A test that asserts only its own
outcome can pass over a corrupted world. The generic half is not hygiene —
it is a detector in its own right: run over long randomized multi-agent
traffic, it is what surfaces a P2-class divergence (a second membership path
someone adds later) that no single-purpose test was written to catch (§11).

- **Decision tests per module**: table-driven, values in / decision out. No
  clock (instants are inputs), no sleeps, no sockets. This is most of the
  suite's future shape.
- **The fixture** (spec §5, already normative): a typed cast of agents —
  including the failing-at-a-rate role — an event log, a deterministic clock,
  capturing executors. Non-coincidence asserted, anti-vacuity asserted.
  Mailbox and attention are tested *through the fixture* against the spec's
  requirements. Written fresh from the spec — not seeded from any prior
  suite (§8).
- **One conformance suite per contract, N implementations.** The test double
  is not a mock — it is a **second real implementation** held to the same
  contract by the same suite (a pattern `es/` already half-has:
  `memoryBackend` beside `jsonlBackend`). A fake proven by the production
  suite can never merely agree with the test author's assumptions. The sharp
  edge, adopted with the pattern: a limit one implementation has and the
  other doesn't is invisible to the shared suite by construction —
  **adapter-specific limits need adapter-specific tests.**
- **Adapter tests without a server**: parsers and serializers are plain
  functions — including the 059 guard, which becomes a value test. Listener
  adapters are the easy case (§5): effects in, emissions asserted.
- **What genuinely needs a live service, complete list**: the WS upgrade path,
  Bun's routing, the reconnect announce — plus the sanctioned end-to-end
  suite (§9), which runs against the live new server by design rather than by
  necessity. The necessity list is testing Bun, not Jean's decisions.
  Everything else runs
  without a service — which is the requirement, met rather than approximated.

## 8. The 870 existing tests

**They go with the old system** (ruled, 2026-08-18). They are the previous
implementation's tests — not a constraint on the new modules, not ballast to
retire carefully, and **not a source to mine**. An earlier version of this
section proposed mining them for the rulings they pin; that was considered
and ruled against: being anchored on old and accidental decisions is a
larger risk than forgetting something useful in there.
The asymmetry is the reason: a behaviour that genuinely matters announces
itself the moment something breaks, and is then decided deliberately; an
anchored accidental decision never announces itself and quietly shapes
everything downstream. Losing something useful is a risk accepted
knowingly.

Where behaviour comes from, refined (ruled 2026-08-18): the spec
(`docs/guarantees.md` — the attention protocol) and this design (structure)
are the authorities, **and where they speak, no old-system behaviour drags
in.** But they do not define everything: task lifecycle, triggers, routing,
knowledge, board views, playbooks are barely touched by the spec, and there
**the old code is the requirements source** — read as extraction, not
adoption: deliberate behaviour is extracted and written down as a
requirement in the module's contract; accidents are left behind; and where
the two cannot be told apart, that is a question for the project owner — flagged, never
silently carried or silently dropped. The amended Events API canon
(requirement-shaped, since retired) was a further *input* on task behaviour — not a
third authority; where it collided with the spec, the spec won and the
collision was reported. The old *tests* remain out of scope as a source in
all cases.

## 9. The build — a rewrite, in parallel, with one switch

**Ruled 2026-08-18: this is a REWRITE, not a migration.** (An earlier version
of this section was written in migration vocabulary — cutover, freeze, named
red sets flipping per stage — while the rewrite decision was still soft. It
caused real drift downstream and is replaced whole.) The old system is being
replaced, not carried forward. What that excludes, explicitly:

- **No tripwire** proving the old behaviour "did not move." The old behaviour
  is not the reference — the spec and this design are.
- **No freeze** on the old path: nobody is adding to it, so there is no rule
  to police.
- **No staged cutover** with per-stage red flips, and no teardown choreography
  of the old tests. **The old system's tests go with the old system** (§8).
- **No mining** of old code or old tests for unrecorded behaviour (ruled —
  §8 records the reasoning).

**What survives from the earlier recommendation: the parallel build.**
`src/domain/` is built fresh — contracts first, each module with a
conformance suite and an implementation — while the old system keeps serving,
untouched. A new thin adapter (§5's two legs) is then built on the domain, an
end-to-end suite is written from the spec, and the system switches **once**.

**The one thing carried is the log.** Old code goes; old events remain. Every
dojo's state *is* its event log, so the vocabulary module must fold the
existing event shapes — **data compatibility is a requirement precisely where
code compatibility is none.**

**Reading and satisfying are separated.** For each module, the contract and
its conformance suite are authored from the spec and this design by one hand
(architect), and the implementation by another (builder), with codex review
on both. With the old tests gone, this separation is what keeps an
implementer's misreading of a requirement from grading itself.

**Why this fresh-location attempt ends differently than `target/`.**
`src/infra/target/` (tasks 043/044) was already a fresh-location attempt, and
it stopped exactly at signatures: types with no bodies, no conformance
suites, no consumers, no dispatch plan — a destination with no road, cut
against a different transition's shape besides. It goes with the old system.
The difference here is the unit of progress: **a module exists only as
contract + conformance suite + dispatched implementation together** — never
as a signature awaiting a body — and the adapter, the end-to-end suite, and
the switch are tasks in the same plan as the modules they depend on.

**The switch.** One switch, not nine. The `jean infra` entrypoint moves to
the new server when: every module's conformance suite is green; the
end-to-end suite — written from the spec, multi-agent, against the live new
server — is green; and a shakedown on a real dojo has run. **Fallback**: the
entrypoint reverts to the old server, which still reads the same log. **The
one-way door to watch**: events the new system writes during shakedown that
the old fold cannot read — enumerated per kind before the switch, so the
fallback window's cost is known rather than discovered.

Task sequencing lived in a build tracker that turned this section into
dispatchable tasks; it is retired now that the build is done.

## 10. Scope

**The domain layer covers infra's decision surface — the dojo model. Nothing
else.** Explicitly:

- **In**: everything `src/infra/server.ts` currently decides, `core/`'s
  modules, the strays (§3), retrieval ranking.
- **Out, as adapters/clients by design**: the channel plugin (the runtime
  adapter — `docs/runtime-neutrality.md` already names it so), the bridge
  (Slack transport; it consumes routing's decisions), peers, the CLI (an HTTP
  client), the librarian (an agent, not infra), `es/` (infrastructure
  library), `config.ts` (env/file parsing → typed dials handed in),
  `registry.ts` (machine-global dojos.json — not even dojo-scoped).

They touch the domain only through vocabulary types. An unstated scope is how
this sprawls; this is the stated one.

## 11. Where the requirement meets the code — honest limits

- **"Fully testable without other modules"** holds for behaviour, not for
  types: vocabulary is shared by design. Stated in §6.2; not a defect.
- **Privacy is convention plus a test**, not a language guarantee — TS has no
  runtime module privacy. The boundary test is the enforcement; it has held
  for `core/` since task 033.
- **P2 is enforced by construction, detected by the fixture** (rewritten,
  ruled 2026-08-18 — the earlier "verifiable only by construction"
  understated §7's own instrument). The strict half stays true: no test
  proves the absence of a second code path. But the useful question is
  whether a divergent second path gets *found*, and there the answer is the
  fixture: 059 survived 859 tests because every one ran a single agent
  holding everything, so the two paths agreed **by coincidence of the
  fixture** — and §7's non-coincident, randomized multi-agent runs invert
  that: two rules that differ must produce different answers as soon as
  traffic distinguishes them, and randomization plus duration erodes
  agreement-by-luck toward zero. So the structural rule prevents, and the
  randomized run is the detector that catches a second path added in a year
  when the rule has been forgotten. The boundary, kept deliberately: this
  works because both paths see the *same* traffic — a divergence only one
  implementation can reach is the adapter-specific-limit class and needs its
  targeted test.
- **The new shell inherits no order welds** (ruled, 2026-08-18; an earlier
  draft claimed the old shell's welds could never move into the domain, and
  that fatalism was rejected — rightly). **A weld is an implicit ordering
  convention standing in for a missing store guarantee**: the old shell had
  two because it read a separate mutable structure *at write time*, so two
  calls had to stay adjacent, enforced by a comment. The new design removes
  the cause rather than honouring the symptom:
  - **Delivery evidence travels as decision data.** The delivery mark is part
    of what the domain decides, folded from the log like all other state —
    never a side-structure consulted mid-write. One append; no order to
    preserve. The first-in-log reading rule arbitrates racing ackers, so a
    second append carrying a duplicate mark changes no answer.
  - **Announcement is an effect of the same decision as its append**, not a
    subscriber reacting to it — the atomicity lives in the decision. **The
    honest residue**: the executor must not interleave one decision's effects
    with another decision's reads. That is a stated, conformance-testable law
    of the executor's unit contract (§6), not a comment-and-adjacency
    convention, and that is the difference that matters.

  **Check-and-set at the store (append conditional on the log's head) is an
  idea, not a decision** — it was floated, and it may never be needed.
  Nothing in this design depends on it. If an
  executor law someday turns out to need a store guarantee, that surfaces as
  a contract question and gets decided then.
- Nothing else failed contact. The 073 finding stands, now unqualified: no
  decision in this system needs to know a transport exists.
