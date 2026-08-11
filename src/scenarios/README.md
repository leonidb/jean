# `src/scenarios/` — the red end-test suite for the one-commit transition

Written **before** the transition, against the design rather than against the
code. Every test here states a requirement from the canon — `docs/canon.md`,
the 013 REFERENCE DESIGN as amended by the 2026-08-11 rulings (task 046) —
the ruling chain on tasks 034/035/039/040/041, or the five deviations found by
the 042 conformance audit. Task 044 built it; task 043 designed it; the fix
round (task 045, 2026-08-11) extended it with the ruled amendments and the
delivery unification.

## Running it

```bash
bun run test            # the MERGE GATE — everything except this directory. Must be green.
bun run test:scenarios  # THIS suite. Red is its job.
bun run test:all        # both, for when you want the whole picture
```

The suite is excluded from the merge gate on purpose: it is red by construction
until the transition lands, and a gate that is permanently red gates nothing. The
exclusion is mechanical, not conventional — `bun run test` names the directories
it runs. A bare `bun test` runs everything, including this.

## What "red" means here, and the three kinds of test

The board comment on task 044 is the authoritative count. In the files, each test
declares its kind in its own title when it is not simply red:

- **RED** (the default, 161 of 169) — the requirement is not met. Two flavours,
  and the difference matters when you are deciding what to build next:
  - *red by stub*: it calls a `src/infra/target/` surface that throws
    `NotImplemented: <surface> — required by <scenario>`. The failure names the
    surface, so a red run reads as a to-do list.
  - *red by assertion*: it runs against LIVE code and fails on a real assertion.
    These are the sharpest — nothing is waiting on a design, only on the change.
    All of `s01`, `ack-concurrency`, and most of `s09-digest.wiring` are here.
- **CHARACTERIZATION** — green on arrival, and must STAY green. These pin
  behaviour the transition must not lose. They are not progress; counting them as
  coverage of new behaviour is the specific mistake this suite is built to avoid.
- **TYPE-GUARD** — the assertion is a `@ts-expect-error` and therefore already
  happened at compile time; the test body passes at runtime. `bun run typecheck`
  is where these actually fail. Used for the two requirements that are absences
  (`AttentionView` has no `idle`; the ack shape has no `upToId` and no `auto`).

## Levels

`043` mapped every requirement to the cheapest level that can express it, per
Leonid's guidance ("some should be at the PROJECTION level — those can express
and validate most of it"). The level is in the filename.

| level | what it drives | what it proves |
|---|---|---|
| `.projection.` | reducers and pure functions — events in, state or a view out | most of the design. No server, no clock, no sockets. |
| `.core.` | the target listener / supervisor through a recording executor | *when to push*, with `now` as data rather than wall time |
| `.wiring.` | the real in-process factory over HTTP/WS | that the adapter actually carries what the core decides |

E2E beyond this is deliberately deferred: the seven surviving spawn files plus
the live smoke in the transition's evaluation gate cover it.

## The target API

`src/infra/target/` holds the surfaces the transition must build: types with
throwing bodies. The rule that keeps these tests from needing a rewrite the day
the transition lands is:

> **Scenario tests import from `src/infra/target/` for anything the transition
> changes, and from live modules only where the test is characterization of
> behaviour that does not change.**

The stubs pin the design's *requirements*, not an implementation. The executor
takes appended events as `(type, data)` with a single pinned field
(`pendingCount`, which scenario 6 has nothing to assert without), so the
transition can choose its own event names and payloads without any test moving.
