/**
 * Mutation harness for the race guards and the structural boundary guards
 * (refactor stage 3, task 033; retargeted at the transition, task 045).
 *
 *   bun run scripts/mutate-race-guards.ts
 *
 * For each guard: break it surgically, run ONLY the test that claims to cover
 * it, and require that test to FAIL. A guard test that passes against a broken
 * guard is decoration, and there is no way to tell the two apart by reading.
 * Every row must print CAUGHT.
 *
 * IT EARNS ITS KEEP. On its first run two rows came back MISSED — and in both
 * cases the MUTATION was too weak rather than the test, which is a distinction
 * you cannot make without running it. Guard 1's first mutation moved the
 * `hadBlockingBefore` capture to just after the append, which is still before
 * the projection apply, so the captured value never changed. Guard 7's stubbed
 * the entry snapshot to `null` — i.e. "never auto-clear" — while the test
 * asserts nothing is auto-cleared. When a row reads MISSED, suspect the
 * mutation first.
 *
 * WRITING A NEW MUTATION: it must produce the ACTUAL historical bug, not merely
 * a different program. "Delete the guard" is usually right; "disable the feature
 * the guard protects" usually is not.
 *
 * ── TWENTY ROWS, THEN NINE: RETIREMENT, NOT EROSION (task 045) ──
 *
 * A shrinking mutation harness is indistinguishable from a rotting one unless it
 * says which happened, so it says. NINE ROWS LEFT WITH THEIR GUARDS, because the
 * machinery each one broke no longer exists:
 *
 *   guard 3        the 30s duplicate-wake check — no episode to de-duplicate in
 *   guard 5        the idle gate — nothing asks whether an agent is busy (E3)
 *   guard 6 i/p/d  the ack claim — fold-decides appends unconditionally (041)
 *   guard 7 i/p/x  auto-clear-on-reply — `{id, code}` pairs are the only path (S5)
 *   weld 6, weld 7 the two pre-append welds, with the guards they welded
 *
 * ELEVEN REMAIN, and four of them are NEW rather than carried: the guards
 * themselves moved into `core/notify.ts`, so the mutations had to be rewritten
 * against the mechanism that holds the property now — an `announcedThroughId`
 * comparison instead of a captured pre-append flag. A retargeted row proves the
 * same thing about a different implementation, which is the only honest way to
 * carry a guard across a rewrite. The eleventh (`announce`) guards the canon fix
 * from task 046's audit and is not a race guard at all; it lives here because
 * this is where properties that no behavioural test can see are held.
 *
 * TWELVE, at the delivery unification (the fix round, 2026-08-11): `unify`
 * reintroduces the sensei-only adapter — the exact gap three reviews missed
 * because the pure per-agent decisions were green while nothing drove them —
 * and `boundary C` retargeted to the sweep line the timer now holds.
 *
 * Every touched file is restored from its own in-memory copy after each case,
 * including on setup failure, so an interrupted run leaves the tree intact —
 * verify with `git status` regardless.
 */

const SERVER = 'src/infra/server.ts'
const NOTIFY = 'src/infra/core/notify.ts'

const RACE_GUARDS = 'src/infra/race-guards.test.ts'
const NUDGE_BACKOFF = 'src/infra/attention-nudge-backoff.test.ts'
const S03 = 'src/scenarios/s03-threshold.core.test.ts'
const S07 = 'src/scenarios/s07-nag.core.test.ts'
const BOUNDARY = 'src/infra/core/boundary.test.ts'

type Edit = { file: string; from: string; to: string }

type Mutation = {
  guard: string
  what: string
  /** Test file to run. */
  test: string
  /** -t pattern selecting the covering test within it. */
  filter: string
  edits: Edit[]
}

// ── Guard 4's mutation is ONE edit proven by THREE tests ──────────────
//
// "A refused delivery advances nothing" is a single line in the notifier, and
// folding the old three push paths into one is the point of the refactor — but
// it must not weaken the evidence, so the same break is run against three
// independent covers: the pure notifier decision, the pure supervision decision
// (a different machine with the same rule), and the live-socket case that only
// the integration level can reach.
const DROP_LANDED_GUARD: Edit = {
  file: NOTIFY,
  from: `      if (!landed) continue`,
  to: `      // MUTATED: commit-iff-landed guard removed`,
}

const MUTATIONS: Mutation[] = [
  {
    guard: 'guard 1',
    what: 'announce beyond what the push actually carried',
    test: RACE_GUARDS,
    filter: 'each arrival is pushed exactly ONCE',
    // RETARGETED. The old row broke guard 1 by recomputing `hadBlockingPending`
    // downstream; there is no such fact any more. The equivalent lie in the new
    // mechanism is marking events announced that the payload never contained —
    // "I told you", of something never sent. Announcing everything forever makes
    // the second arrival invisible, so the burst produces one push instead of
    // two and the case sees it.
    edits: [
      {
        file: NOTIFY,
        from: `            announcedThroughId: Math.max(episode.announcedThroughId, maxId(view.pending)),`,
        to: `            announcedThroughId: Number.MAX_SAFE_INTEGER, // MUTATED: announce what was never sent`,
      },
    ],
  },
  {
    guard: 'guard 2',
    what: 'decide "anything new?" by length-compare instead of by id',
    test: RACE_GUARDS,
    filter: 'tracked by id, not by length',
    // RETARGETED, and it is the SAME historical bug: an ack that shrinks the
    // queue while an append is in flight leaves the length unchanged, so a
    // length-compare concludes "nothing entered" and skips the dispatch. The
    // memo has to live in the notifier closure — the one place that sees every
    // decision in order — which is exactly where the old code read it from.
    edits: [
      {
        file: NOTIFY,
        from: `  let state = initialState()

  function run(view: NotifyView): void {
    const decision = decide(state, view)
    state = decision.next`,
        to: `  let state = initialState()
  let mutantLastLen = 0

  function run(view: NotifyView): void {
    const decision = decide(state, view)
    state = decision.next
    // MUTATED: the unconditional state advance still lands; only the dispatch is
    // skipped — which is precisely what the length-compare bug did.
    if (view.pending.length <= mutantLastLen) return
    mutantLastLen = view.pending.length`,
      },
    ],
  },
  {
    guard: 'guard 4a',
    what: 'drop commit-iff-landed — the notifier decision (pure)',
    test: S03,
    filter: 'REFUSED push is not a push',
    edits: [DROP_LANDED_GUARD],
  },
  {
    guard: 'guard 4b',
    what: 'drop commit-iff-landed — the supervision decision (pure, same rule)',
    test: S07,
    filter: 'landed:false advances nothing',
    edits: [
      {
        file: 'src/infra/core/supervision.ts',
        from: `    if (!exec.deliver(to, text)) return`,
        to: `    exec.deliver(to, text) // MUTATED: commit-iff-landed guard removed`,
      },
    ],
  },
  {
    guard: 'guard 4c',
    what: 'drop commit-iff-landed — a live socket whose transport refuses',
    test: NUDGE_BACKOFF,
    filter: 'FAILED DELIVERY DOES NOT CONSUME',
    edits: [DROP_LANDED_GUARD],
  },
  {
    guard: 'announce',
    what: 'let carriage discharge nothing — the canon drift, reintroduced',
    test: S03,
    filter: 'CORRECTED',
    // NEW AT THE CANON FIX (task 046's audit). The rule this breaks is the one
    // that satisfies S1, S3 and the foundations simultaneously: a push fires
    // only for what the agent has not been SHOWN, by any route. Stubbing
    // `carried` restores exactly the drifted reading the audit found — a push
    // per qualifying event, and an agent told twice about the same news.
    //
    // It gets a row because it was verified by hand (stashing the wiring) while
    // being written, and a guard proven once by hand is a guard nobody proves
    // again. Two of the three CORRECTED cases fail under it.
    edits: [
      {
        file: NOTIFY,
        from: `      if (ids.length === 0) return`,
        to: `      if (ids.length >= 0) return // MUTATED: carriage discharges nothing`,
      },
    ],
  },
  {
    guard: 'scenario 6',
    what: 'cache the rendered inbox instead of rebuilding it per decision',
    test: RACE_GUARDS,
    filter: 'fresh counts',
    edits: [
      {
        file: SERVER,
        from: `  function renderPush(view: NotifyView): string {
    const inbox = view.agent ? inboxNow(view.agent) : null`,
        to: `  let mutantCachedInbox: ReturnType<typeof inboxNow> | undefined
  function renderPush(view: NotifyView): string {
    const inbox = view.agent ? (mutantCachedInbox ??= inboxNow(view.agent)) : null`,
      },
    ],
  },

  // ── The structural guards, held to the same standard ─────────────────
  //
  // boundary.test.ts reads SOURCE rather than behaviour, which makes it exactly
  // the kind of test that can quietly stop asserting anything (a regex that no
  // longer matches passes vacuously). So it gets mutated too.
  {
    guard: 'boundary A',
    what: 'publish a replayed event from the catch-up path',
    test: BOUNDARY,
    filter: 'bus.publish is reachable only from record',
    edits: [
      {
        file: SERVER,
        from: `  await boardProjection.catchUp()`,
        to: `  for (const e of await store.read({})) bus.publish(e)
  await boardProjection.catchUp()`,
      },
    ],
  },
  {
    guard: 'boundary B',
    what: 'import an adapter module into core/',
    test: BOUNDARY,
    filter: 'core/ imports nothing from the adapter layer',
    edits: [
      {
        file: NOTIFY,
        from: `import type { StoredEvent } from '../../es/index.ts'`,
        to: `import type { StoredEvent } from '../../es/index.ts'
import type { Bridge } from '../bridge.ts'`,
      },
    ],
  },
  {
    guard: 'boundary C',
    what: 'put branching back into a timer callback',
    test: BOUNDARY,
    // RETARGETED at the delivery unification: the timer drives `sweep` over
    // every dojo agent's views now, so the anchor moved with it. The mutation
    // is the same historical bug — state-dependent behavior hiding in a timer
    // callback where no test level can see it.
    filter: 'timer callbacks are a single core call',
    edits: [
      {
        file: SERVER,
        from: `  const notifyTick = setInterval(() => notifier.sweep(notifyViews(ports.now())), NOTIFY_TICK_MS)`,
        to: `  const notifyTick = setInterval(() => {
    if (pendingProjection.state.length > 0) notifier.sweep(notifyViews(ports.now()))
  }, NOTIFY_TICK_MS)`,
      },
    ],
  },
  {
    guard: 'unify',
    what: 'drive the notifier for the sensei only — the pre-unification adapter, back',
    test: 'src/scenarios/unification.wiring.test.ts',
    filter: 'driven per-agent',
    // NEW AT THE DELIVERY UNIFICATION (ruled 2026-08-11). The historical gap,
    // in s01's own words: "no view is ever built for any other agent, so
    // thresholdFor('worker') decides nothing in production" — canon E6 held
    // for the pure decisions and not for the adapter that drives them, and
    // three reviews read the green core tests as coverage. This row
    // reintroduces exactly that adapter and demands the wiring level see it.
    edits: [
      {
        file: SERVER,
        from: `      if (entry.role === 'sensei' || entry.role === 'worker') owners.add(name)`,
        to: `      if (entry.role === 'sensei') owners.add(name) // MUTATED: sensei-only driving`,
      },
    ],
  },
  {
    guard: 'boundary D',
    what: 'bypass the deliver port and reach an agent entry directly',
    test: BOUNDARY,
    filter: 'every delivery goes through the deliver port',
    edits: [
      {
        file: SERVER,
        from: `    ports.deliver(sender, {`,
        to: `    agents.get(sender)?.deliver({`,
      },
    ],
  },
]

const results: string[] = []

for (const m of MUTATIONS) {
  const touched = [...new Set(m.edits.map((e) => e.file))]
  const originals = new Map<string, string>()
  for (const file of touched) originals.set(file, await Bun.file(file).text())

  const restore = async () => {
    for (const [file, text] of originals) await Bun.write(file, text)
  }

  const next = new Map(originals)
  let setupFailed: string | null = null
  for (const edit of m.edits) {
    const current = next.get(edit.file) as string
    if (!current.includes(edit.from)) {
      setupFailed = `anchor not found in ${edit.file}`
      break
    }
    next.set(edit.file, current.replace(edit.from, edit.to))
  }
  if (setupFailed) {
    results.push(`${m.guard.padEnd(11)} | SETUP FAILED (${setupFailed})`)
    await restore()
    continue
  }
  for (const [file, text] of next) await Bun.write(file, text)

  const proc = Bun.spawn(['bun', 'test', m.test, '-t', m.filter], { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  const text = out + err
  const nFail = Number(/(\d+) fail/.exec(text)?.[1] ?? -1)
  const nPass = Number(/(\d+) pass/.exec(text)?.[1] ?? -1)
  // A mutation that makes the file unparseable, or selects zero tests, is a
  // BROKEN CASE rather than a caught guard — say so instead of scoring it.
  //
  // THE THIRD WAY TO BE BROKEN, added at the transition after it bit: a `-t`
  // filter that matches nothing produces no summary line at all, so both counts
  // parse as -1 and the row scored MISSED — a retargeted guard reading as an
  // uncovered one, which is the exact confusion this harness exists to prevent.
  // (The filter was `A REFUSED push…` against a test named `a REFUSED push…`.)
  const unparsed = nPass < 0 && nFail < 0
  const caught = nFail > 0
  const zeroSelected = nPass === 0 && nFail === 0
  const verdict = unparsed ? 'NO OUTPUT' : zeroSelected ? 'NO TESTS' : caught ? 'CAUGHT  ' : 'MISSED !'
  results.push(`${m.guard.padEnd(11)} | ${verdict} | ${nPass} pass ${nFail} fail | ${m.what}`)

  await restore()
}

console.log('\n=== MUTATION RESULTS — every row must read CAUGHT ===')
for (const r of results) console.log(r)
