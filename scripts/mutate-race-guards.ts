/**
 * Mutation harness for the race guards and the structural boundary guards
 * (refactor stage 3, tasks 033).
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
 * Mutations may span several files, because after commit 2 the guards do:
 * guard 1 is the capture in server.ts's record(), guards 2/3/5 are decisions in
 * core/attention.ts, guard 4 is the single commit-iff-landed line in
 * core/attention-listener.ts, and guards 6/7 stayed in server.ts. Every touched
 * file is restored from its own in-memory copy after each case, including on
 * setup failure, so an interrupted run leaves the tree intact — verify with
 * `git status` regardless.
 */

const SERVER = 'src/infra/server.ts'
const ATTENTION = 'src/infra/core/attention.ts'
const LISTENER = 'src/infra/core/attention-listener.ts'
const PRE_APPEND = 'src/infra/core/pre-append.ts'

const RACE_GUARDS = 'src/infra/race-guards.test.ts'
const CORE_TESTS = 'src/infra/core/attention.test.ts'
const PRE_APPEND_TESTS = 'src/infra/core/pre-append.test.ts'
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
// Before the extraction "a refused delivery advances nothing" was three
// separate `if (!landed) return` lines, one per push path. Folding them into
// one line in the listener is the point of the refactor — but it must not
// weaken the evidence, so the same break is run against each path's test
// separately. Three rows, three independent detections.
const DROP_LANDED_GUARD: Edit = {
  file: LISTENER,
  from: `      if (!landed) continue`,
  to: `      // MUTATED: commit-iff-landed guard removed`,
}

const MUTATIONS: Mutation[] = [
  {
    guard: 'guard 1',
    what: 'recompute hadBlockingPending in the listener instead of capturing it before the append',
    test: RACE_GUARDS,
    filter: 'burst coalescing',
    // This is not a strawman — it is the design alternative that was actually
    // considered and rejected. The listener is serialized by publish order, so
    // by the time it runs the event is already in the queue and every blocking
    // arrival reads "blocking was already pending", suppressing its own wake.
    edits: [
      {
        file: SERVER,
        from: `    apply: (e, ctx) => attention.onEvent(e, senseiView(ports.now()), ctx.hadBlockingPending),`,
        to: `    apply: (e) => attention.onEvent(e, senseiView(ports.now()), hasBlockingPending()),`,
      },
    ],
  },
  {
    guard: 'guard 3',
    what: 'delete the 30s duplicate-wake guard',
    test: RACE_GUARDS,
    filter: 'burst coalescing',
    edits: [
      {
        file: ATTENTION,
        from: `    if (episode.blockingWakeCount > 0 && view.now - episode.lastBlockingWakeAt < 30_000) {
      return { next: state, effects: [] }
    }`,
        to: `    // MUTATED: duplicate-wake guard removed`,
      },
    ],
  },
  {
    guard: 'guard 2',
    what: 'decide enteredPending by length-compare instead of by id',
    test: RACE_GUARDS,
    filter: 'enteredPending is checked by id',
    // The length has to be captured inside the SAME record() call, before its
    // own append — a listener-level tracker would be updated by the interleaved
    // ack and would not reproduce the bug. So the mutation threads it exactly
    // where the real code once read it.
    edits: [
      {
        file: SERVER,
        from: `    const hadBlockingBefore = hasBlockingPending()
    const event = await store.append({ stream, type, data })`,
        to: `    const hadBlockingBefore = hasBlockingPending()
    const mutantLenBefore = pendingProjection.state.length
    const event = await store.append({ stream, type, data })`,
      },
      {
        file: SERVER,
        from: `    bus.publish(event, { hadBlockingPending: hadBlockingBefore })`,
        to: `    bus.publish(event, { hadBlockingPending: hadBlockingBefore, mutantLenBefore } as never)`,
      },
      {
        file: SERVER,
        from: `    apply: (e, ctx) => attention.onEvent(e, senseiView(ports.now()), ctx.hadBlockingPending),`,
        to: `    apply: (e, ctx) =>
      attention.onEvent(e, senseiView(ports.now()), ctx.hadBlockingPending, (ctx as never as { mutantLenBefore: number }).mutantLenBefore),`,
      },
      {
        file: LISTENER,
        from: `    onEvent(event, view, hadBlockingPending) {
      run(decideEventApplied(state, view, event, hadBlockingPending))
    },`,
        to: `    onEvent(event, view, hadBlockingPending, mutantLenBefore?: number) {
      const decision = decideEventApplied(state, view, event, hadBlockingPending)
      // The unconditional resets still land; only the dispatch is skipped —
      // which is exactly what the length-compare bug did.
      if (mutantLenBefore !== undefined && view.pendingIds.length <= mutantLenBefore) {
        state = decision.next
        return
      }
      run(decision)
    },`,
      },
    ],
  },
  {
    guard: 'guard 5',
    what: 'let a suppressed-because-busy nudge consume the content-changed signal',
    test: RACE_GUARDS,
    filter: 'idle gate is checked BEFORE',
    edits: [
      {
        file: ATTENTION,
        from: `  if (!view.agent || !view.deliverable || !view.idle) return { next: state, effects: [] }`,
        to: `  if (!view.agent || !view.deliverable) return { next: state, effects: [] }
  if (!view.idle) {
    const busy = episodeOf(state, view.agent)
    return {
      next: withEpisode(state, view.agent, {
        ...busy,
        maxNudgedPendingId: Math.max(busy.maxNudgedPendingId, maxId(view.pendingIds)),
      }),
      effects: [],
    }
  }`,
      },
    ],
  },
  {
    guard: 'guard 4a',
    what: 'drop commit-iff-landed — blocking wake path',
    test: CORE_TESTS,
    filter: 'blocking wake: nothing is committed',
    edits: [DROP_LANDED_GUARD],
  },
  {
    guard: 'guard 4b',
    what: 'drop commit-iff-landed — machine nudge path',
    test: CORE_TESTS,
    filter: 'machine nudge: the episode is not consumed',
    edits: [DROP_LANDED_GUARD],
  },
  {
    guard: 'guard 4c',
    what: 'drop commit-iff-landed — stall watchdog path',
    test: CORE_TESTS,
    filter: 'stall watchdog: the window is not re-armed',
    edits: [DROP_LANDED_GUARD],
  },
  // ── THE TWO-ROW RULE (035) ────────────────────────────────────────
  //
  // Guards 6 and 7 moved into pure functions in stage 4. A moved guard with one
  // row proves LESS than it did before the move: the integration row shows the
  // wiring still holds, the pure row shows the rule itself is still right, and
  // neither implies the other. Both rows stay for as long as the guards live.
  {
    guard: 'guard 6 (i)',
    what: 'drop the in-flight reservation — integration row',
    test: RACE_GUARDS,
    filter: 'claims ids synchronously',
    edits: [
      {
        file: PRE_APPEND,
        from: `  return [...new Set(requested)].filter((id) => pendingIds.has(id) && !inFlight.has(id))`,
        to: `  return [...new Set(requested)].filter((id) => pendingIds.has(id))`,
      },
    ],
  },
  {
    guard: 'guard 6 (p)',
    what: 'drop the in-flight reservation — pure row',
    test: PRE_APPEND_TESTS,
    filter: 'drops ids another writer already owns',
    edits: [
      {
        file: PRE_APPEND,
        from: `  return [...new Set(requested)].filter((id) => pendingIds.has(id) && !inFlight.has(id))`,
        to: `  return [...new Set(requested)].filter((id) => pendingIds.has(id))`,
      },
    ],
  },
  {
    guard: 'guard 6 (d)',
    what: 'drop the local input dedupe — the half no caller currently exercises',
    test: PRE_APPEND_TESTS,
    filter: 'DEDUPES ITS INPUT',
    edits: [
      {
        file: PRE_APPEND,
        from: `  return [...new Set(requested)].filter((id) => pendingIds.has(id) && !inFlight.has(id))`,
        to: `  return requested.filter((id) => pendingIds.has(id) && !inFlight.has(id))`,
      },
    ],
  },
  {
    guard: 'guard 7 (i)',
    what: 'compute the auto-clear candidate at the TAIL instead of at entry — integration row',
    test: RACE_GUARDS,
    filter: 'snapshots the auto-clear candidate at ENTRY',
    // Still expressed at the CALL SITE, because that is where the entry-vs-tail
    // property lives — the pure function cannot be wrong about a position it
    // does not control.
    edits: [
      {
        file: SERVER,
        from: `    if (delivered && autoClearId !== null && confirmAutoClear(autoClearId, blockingPendingFrom(args.to))) {
      await recordAck([autoClearId], 'auto-clear')
    }`,
        to: `    if (delivered) {
      const mutantTail = decideAutoClear({
        senderRole: agents.get(args.from)?.role ?? (senseiNames.has(args.from) ? 'sensei' : undefined),
        targetRole: agents.get(args.to)?.role,
        blockingFromTarget: blockingPendingFrom(args.to),
      })
      if (mutantTail !== null) await recordAck([mutantTail], 'auto-clear')
    }`,
      },
    ],
  },
  {
    guard: 'guard 7 (p)',
    what: 'let the tail check confirm a DIFFERENT id than the entry candidate — pure row',
    test: PRE_APPEND_TESTS,
    filter: 'never clears a DIFFERENT event',
    edits: [
      {
        file: PRE_APPEND,
        from: `  return blockingFromTarget.length === 1 && blockingFromTarget[0] === candidate`,
        to: `  return blockingFromTarget.length === 1`,
      },
    ],
  },
  {
    guard: 'guard 7 (x)',
    what: 'drop the exactly-one rule — auto-clear a burst',
    test: PRE_APPEND_TESTS,
    filter: 'THE EXACTLY-ONE RULE',
    edits: [
      {
        file: PRE_APPEND,
        from: `  return view.blockingFromTarget.length === 1 ? (view.blockingFromTarget[0] as number) : null`,
        to: `  return view.blockingFromTarget.length >= 1 ? (view.blockingFromTarget[0] as number) : null`,
      },
    ],
  },
  {
    guard: 'scenario 6',
    what: 'cache the inbox in the view builder instead of rebuilding it per decision',
    test: RACE_GUARDS,
    filter: 'fresh counts',
    edits: [
      {
        file: SERVER,
        from: `  function viewFor(agent: string | undefined, now: number): AttentionView {
    const live = findSensei()`,
        to: `  let mutantCachedInbox: ReturnType<typeof senseiInboxNow> | undefined
  function viewFor(agent: string | undefined, now: number): AttentionView {
    const live = findSensei()`,
      },
      {
        file: SERVER,
        from: `      inbox: deliverable ? inboxFor(pending, taskOwner, { now, roleOf }) : null,`,
        to: `      inbox: deliverable ? (mutantCachedInbox ??= inboxFor(pending, taskOwner, { now, roleOf })) : null,`,
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
        to: `  for (const e of await store.read({})) bus.publish(e, { hadBlockingPending: false })
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
        file: ATTENTION,
        from: `import type { StoredEvent } from '../../es/index.ts'`,
        to: `import type { StoredEvent } from '../../es/index.ts'
import type { Bridge } from '../bridge.ts'`,
      },
    ],
  },
  {
    guard: 'weld 6',
    what: 'slip an await between the ack claim and the reservation',
    test: BOUNDARY,
    filter: 'GUARD 6 WELD',
    // The failure stage 4 exists to not cause. No behavioural test in the suite
    // sees this — the integration tests run a transport that never interleaves
    // at this granularity — so the structural check is the only witness.
    edits: [
      {
        file: SERVER,
        from: `    if (claimed.length === 0) return [] // already cleared, or another writer owns it
    for (const id of claimed) ackInFlight.add(id)`,
        to: `    if (claimed.length === 0) return []
    await Promise.resolve()
    for (const id of claimed) ackInFlight.add(id)`,
      },
    ],
  },
  {
    guard: 'weld 7',
    what: 'slip an await before the auto-clear entry snapshot',
    test: BOUNDARY,
    filter: 'GUARD 7 WELD',
    edits: [
      {
        file: SERVER,
        from: `    const autoClearId: number | null = decideAutoClear({`,
        to: `    await Promise.resolve()
    const autoClearId: number | null = decideAutoClear({`,
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
  {
    guard: 'boundary C',
    what: 'put branching back into a timer callback',
    test: BOUNDARY,
    filter: 'timer callbacks are a single core.tick call',
    edits: [
      {
        file: SERVER,
        from: `  const stallTick = setInterval(() => attention.tick(senseiView(ports.now())), Math.min(STALL_NUDGE_AFTER_MS, 60_000))`,
        to: `  const stallTick = setInterval(() => {
    if (pendingProjection.state.length > 0) attention.tick(senseiView(ports.now()))
  }, Math.min(STALL_NUDGE_AFTER_MS, 60_000))`,
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
  const caught = nFail > 0
  const zeroSelected = nPass === 0 && nFail === 0
  results.push(
    `${m.guard.padEnd(11)} | ${zeroSelected ? 'NO TESTS' : caught ? 'CAUGHT  ' : 'MISSED !'} | ${nPass} pass ${nFail} fail | ${m.what}`,
  )

  await restore()
}

console.log('\n=== MUTATION RESULTS — every row must read CAUGHT ===')
for (const r of results) console.log(r)
