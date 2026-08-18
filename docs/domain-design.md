# The Domain Layer — Design

**Task 075. Written as a design, and approved before any of it was built.**
Inputs: the guarantees spec (`docs/guarantees.md`, the behavioural
contract this layer must serve), task 073's audit (the inventory of judgement
stranded in the adapter), the 31 spec reds on `jean/builder-064-spec` (the
semantic instrument), and the 11 pins on `jean/builder-074` (the structural
instrument). The 073 rulings are folded in as constraints: core never returns
JSON; connection events are domain facts; decoupling is prioritized ahead of
repairing the reds.

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
names what does enforce it** — the conformance suite, a weld, a fixture rule.
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
- The `target/` shim directory retires with the migration it served.
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
  law of the executor's unit contract (§6), not an adjacency convention. The
  074 welds pin today's adjacency form and retire, each with a note, as
  §11's dissolutions land.
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
`stamp` are not independent (you stamp what a deliver carried), and the 074
welds are exactly "if you do A, B must match" pair-properties spread across
bag members, which is why behaviour alone could never pin them. The executor
contracts in `contracts/` are therefore units: the order and agreement laws
are stated in the contract and held by its conformance suite where behaviour
*can* see them. The source welds hold today's adjacency form for the residue
behaviour cannot see (the microtask-sized breaks 074 measured) — and retire
as §11's dissolutions remove the adjacency itself.

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
  requirements; the 064 suite is the seed and the test bed.
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
  Bun's routing, the reconnect announce, and the behavioural halves of the 074
  pins (deliberately through the real server — that is their design). All of
  it is testing Bun and the welds, not Jean's decisions — and the weld halves
  retire as §11's dissolutions land. Everything else runs
  without a service — which is the requirement, met rather than approximated.

## 8. The 870 existing tests

**They are explicitly not a constraint** (ruled, 2026-08-18): the new modules
are not obliged to keep the old suite satisfied, and each module gets its
contract and its tests written fresh. That dissolves the ballast problem —
a test pinning the current structure never gets a vote on the new one.

It leaves one real danger, and naming it is this section's job: **a large
share of those tests are where Leonid's rulings live.** H7's "the Stop hook is
not activity," the loud-400 grammar, idempotent ack, the role-precedence
order, S1's no-double-telling — dozens of decided behaviours are pinned
nowhere else. A fresh build that ignores the old suite can silently lose a
ruling and every test would be green.

So the old suite's role changes from constraint to **rulings ledger**: stage 0
mines each behavioural test for the ruling it pins, and the ruling — not the
test — goes into the owning module's SPEC.md. A module's fresh tests then
assert its spec, and the old test retires when its module's surface cuts over.
Classification for the mining pass: behavioural-against-the-contract (ruling
extracted, test retired at cutover), behavioural-against-the-old-model
(superseded by the spec — retired with its semantics, the 064 suite is the
replacement), structural pins of the old layout (nothing to mine; deleted).
Exact counts are stage 0's deliverable, not this document's guess.

## 9. Combined or separate — the answer

**Recommendation: one plan, staged, with the heart born on the spec's model.
Neither "all separate" nor "one enormous change."**

Reasoning. The attention rewrite changes the domain model itself — pairs,
declared resolutions, pending-as-definition. The modules those changes live in
(mailbox, attention) are the heart of the layer. Building them **separately**
means building the predicate model into new modules and then rebuilding them
on pairs — the layer's hardest parts done twice, with the second pass churning
the first pass's tests. Building **everything combined at once** is one
enormous change with two failure sources. But the failure sources are exactly
what the two instruments discriminate: the 31 reds detect semantic movement,
the 11 pins (weld + behavioural halves) detect structural breakage. So stages
can be single-purpose and independently verifiable:

- **Stages that move no behaviour** (builds, and cutovers of families the
  spec doesn't touch — the majority, honouring the ruled priority):
  acceptance = the live suite unchanged, **all 31 reds red failing
  identically**, all pins green. A red flipping is a stop signal.
- **Semantic cutovers** (the deliberate spec repairs): acceptance = **the
  named red set flips green, no other red moves**, pins green, plus the
  declared test retirements from §8's ledger.

**In place, or in parallel?** (raised 2026-08-18, evaluated here.) Two ways
to execute the staging:

- **In place** — transform `server.ts` and `core/` stepwise, each step keeping
  the old suite green. Its cost is now visible as three things: every step
  renegotiates old tests (the ballast tax, paid per step); the mechanical work
  is transforming a thousand-line closure, the riskiest kind of edit in the
  tree; and the contracts/implementations separation (ruled) would be
  retrofitted rather than the starting shape.
- **In parallel** — build `src/domain/` as a clean package: contracts first,
  then each module fresh with its SPEC.md and its own tests, the old code
  untouched while modules grow; then cut the shell over surface family by
  surface family, and delete. The old suite stays green on the old path until
  each family's cutover retires its tests per the §8 ledger. The risk is two
  systems in the tree — bounded by three rules: build stages are short and
  module-sized; **once a module's contract lands, no new behaviour enters the
  old path for that module** (the freeze that prevents drift); and a teardown
  stage deletes the old path rather than leaving it to rot.

**Recommendation: in parallel.** It is the ruled contracts-first structure as
the starting shape rather than the end state; fresh module tests beat
transformed ones; the highest-risk mechanical work (closure surgery)
disappears almost entirely; and §8's ruling makes it licit. The instruments
keep their roles: during build stages the 31 reds sit unchanged on the live
wiring (nothing moved); each cutover stage is where a named red set flips —
or none, for families the spec doesn't touch — and the 11 pins must hold
through every cutover.

**The stages:**

| # | Stage | Kind | Instrument acceptance |
|---|---|---|---|
| 0 | Rulings ledger mined from the old suite (§8); per-module SPEC.md seeded; pins already landed (074) | prep | ledger reviewed; baseline recorded |
| 1 | `contracts/` — vocabulary, resolution, all nine module contracts; the spec-§5 fixture built | build | compiles; fixture green on resolution; reds untouched |
| 2 | Mailbox built fresh on pairs (per-pair pending, one membership function, `caller` in the ack seam) | build | module suite green incl. the ported core-half 064 assertions; live reds untouched |
| 3 | Tasks, agents, triggers, routing, knowledge built fresh against their ledgers | build | module suites green; live reds untouched |
| 4 | Attention rebuilt on the spec's liveness block over new mailbox/agents | build | module suite green; live reds untouched |
| 5 | Cutover: mailbox surfaces (`/events*`, ack, inbox header) onto the new modules | **semantic cutover** | flips the named P1/P2/P4/P5/P6 + row-1/2/3/5 reds; no other red moves; pins green; family tests retired per ledger |
| 6 | Cutover: tasks, triggers, routing, knowledge surfaces | cutover | reds unchanged; pins green; family tests retired |
| 7 | Cutover: attention timers + outbound listener adapters on effects | **semantic cutover** | flips rows 7/8 + liveness reds; pins green |
| 8 | Teardown: old `core/`, `target/`, `reducers.ts` remnants deleted; boundary tests generalized to §3's table; 059 guard socketless | teardown | no dual path remains; boundary suite green |

Order rationale: contracts before any module because they are the ruled
starting shape; mailbox before attention because resolution and pairs are
attention's ground truth; the mailbox cutover carries authorization and
attribution with it because the seam exists from birth — splitting them would
be re-staging the old model on purpose.

**What would change my mind.** If a freeze on the old path is intolerable —
active feature work needing to land in exactly the surfaces mid-build — the
parallel plan forks the work and in-place staging wins for those families.
If a cutover family proves too coarse to flip at once (stage 5 is the
candidate), it splits by surface, at the price of temporary shims between old
and new membership. And if Leonid wants attention semantics live urgently,
stages 2/5 compress to mailbox-only and attention runs first inside today's
structure — knowingly paying the re-cut. Plan adjustments, not design changes.

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
- **The order welds are not permanent — they are symptoms, and each
  dissolves** (ruled, 2026-08-18; the earlier draft claimed they could never
  move into the domain, and that fatalism was rejected — rightly). **A weld is
  an implicit ordering convention standing in for a missing store guarantee**:
  both of ours exist because the shell reads a separate mutable structure *at
  write time*, so two calls must stay adjacent. Worked through:
  - **Ledger-take-then-append** dissolves entirely. The take exists because
    the ledger is consulted during the write. When the domain's decision
    carries the delivery mark *as data* — the ledger becoming state folded
    from the log like everything else, not a side-structure mutated mid-write
    — the shell performs **one** append and there is no order to preserve.
    The first-in-log reading rule already arbitrates racing ackers, so a
    second append carrying a duplicate mark changes no answer.
  - **Announcement-synchronous-in-`record()`** dissolves into an explicit
    law. Today announcement is a subscriber reacting to an append — inherently
    a second step, adjacent by convention. When one decision returns the
    append *and* the announcement as its effect list, the atomicity moves
    into the decision. **The honest residue**: the executor must not
    interleave one decision's effects with another decision's reads — but
    that is a stated, conformance-testable law of the executor's unit
    contract (§6), not a comment-and-adjacency convention, and that is the
    difference that matters.
  - **The store contract gains check-and-set**, designed in rather than
    reacted to: append conditional on the log's head, failing loudly when the
    head moved. It converts the implicit convention into an explicit store
    guarantee — trivial for today's single-writer file backend, native to a
    real database, so it lands exactly on the `es/` contract and serves the
    future-database goal at the same time.

  The 074 pins hold each weld while it exists and retire with a note saying
  what replaced it, when its dissolution lands.
- Nothing else failed contact. The 073 finding stands, now unqualified: no
  decision in this system needs to know a transport exists.
