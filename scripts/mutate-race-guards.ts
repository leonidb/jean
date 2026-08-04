/**
 * Mutation harness for the race-guard tests (refactor stage 3, task 033).
 *
 *   bun run scripts/mutate-race-guards.ts
 *
 * For each documented race guard: break it surgically in server.ts, run ONLY the
 * test that claims to cover it, and require that test to FAIL. A guard test that
 * passes against a broken guard is decoration, and there is no way to tell the
 * two apart by reading. Every row must print CAUGHT.
 *
 * IT EARNS ITS KEEP. On its first run two rows came back MISSED — and in both
 * cases the MUTATION was too weak rather than the test, which is a distinction
 * you cannot make without running it. Guard 1's first mutation moved the
 * `hadBlockingBefore` capture to just after the append, which is still before
 * the projection apply, so the captured value never changed. Guard 7's stubbed
 * the entry snapshot to `null` — i.e. "never auto-clear" — while the test
 * asserts nothing is auto-cleared. When a row reads MISSED, suspect the mutation
 * first.
 *
 * WRITING A NEW MUTATION: it must produce the ACTUAL historical bug, not merely
 * a different program. "Delete the guard" is usually right; "disable the feature
 * the guard protects" usually is not.
 *
 * The harness restores server.ts from its own in-memory copy after every case,
 * including on setup failure, so an interrupted run leaves the file intact —
 * verify with `git status` regardless.
 */
const SERVER = 'src/infra/server.ts'

type Mutation = {
  guard: string
  what: string
  filter: string // -t pattern selecting the covering test
  from: string
  to: string
}

const MUTATIONS: Mutation[] = [
  {
    guard: 'guard 1',
    what: 'capture hadBlockingBefore AFTER the projection apply (i.e. not before at all)',
    filter: 'burst coalescing',
    from: `    const hadBlockingBefore = hasBlockingPending()
    const event = await store.append({ stream, type, data })
    boardProjection.apply(event)
    pendingProjection.apply(event)`,
    to: `    const event = await store.append({ stream, type, data })
    boardProjection.apply(event)
    pendingProjection.apply(event)
    const hadBlockingBefore = hasBlockingPending()`,
  },
  {
    guard: 'guard 3',
    what: 'delete the 30s duplicate-wake guard',
    filter: 'burst coalescing',
    from: `    if (blockingWakeCount > 0 && ports.now() - lastBlockingWakeAt < 30_000) return`,
    to: `    // MUTATED: duplicate-wake guard removed`,
  },
  {
    guard: 'guard 2',
    what: 'decide enteredPending by length-compare instead of by id',
    filter: 'enteredPending is checked by id',
    from: `    const enteredPending = pendingProjection.state.some((e) => e.id === event.id)`,
    to: `    const enteredPending = pendingProjection.state.length > mutantLenBefore`,
  },
  {
    guard: 'guard 5',
    what: 'advance the episode bookkeeping BEFORE the idle gate',
    filter: 'idle gate is checked BEFORE',
    from: `    const sensei = findSensei()
    // The idle gate is checked BEFORE any episode bookkeeping: a suppressed-`,
    to: `    const sensei = findSensei()
    for (const e of pendingProjection.state) {
      if (e.id > maxNudgedPendingId) maxNudgedPendingId = e.id
    }
    // The idle gate is checked BEFORE any episode bookkeeping: a suppressed-`,
  },
  {
    guard: 'guard 6',
    what: 'drop the in-flight reservation from recordAck',
    filter: 'claims ids synchronously',
    from: `    const claimed = [...new Set(eventIds)].filter((id) => pendingIds.has(id) && !ackInFlight.has(id))`,
    to: `    const claimed = [...new Set(eventIds)].filter((id) => pendingIds.has(id))`,
  },
  {
    guard: 'guard 7',
    what: 'compute the auto-clear candidate at the TAIL instead of at entry',
    filter: 'snapshots the auto-clear candidate at ENTRY',
    from: `    if (delivered && autoClearId !== null) {
      const stillBlocking = pendingProjection.state.filter(
        (e) => isBlockingEvent(e) && (e.data as { agent?: unknown }).agent === args.to,
      )
      if (stillBlocking.length === 1 && (stillBlocking[0] as StoredEvent).id === autoClearId) {
        await recordAck([autoClearId], 'auto-clear')
      }
    }`,
    to: `    if (delivered) {
      const mutantSenderRole = agents.get(args.from)?.role ?? (senseiNames.has(args.from) ? 'sensei' : undefined)
      const stillBlocking = pendingProjection.state.filter(
        (e) => isBlockingEvent(e) && (e.data as { agent?: unknown }).agent === args.to,
      )
      if (mutantSenderRole === 'sensei' && agents.get(args.to)?.role === 'user' && stillBlocking.length === 1) {
        await recordAck([(stillBlocking[0] as StoredEvent).id], 'auto-clear')
      }
    }`,
  },
  {
    guard: 'scenario 6',
    what: 'reuse a cached inbox instead of rebuilding it at emission',
    filter: 'fresh counts',
    from: `  function nudgeSenseiIfIdle() {`,
    to: `  let mutantCachedInbox: ReturnType<typeof senseiInboxNow> | undefined
  function nudgeSenseiIfIdle() {`,
  },
]

// guard 2 and scenario 6 need a companion edit to be well-formed.
const COMPANIONS: Record<string, { from: string; to: string }> = {
  'guard 2': {
    from: `    const hadBlockingBefore = hasBlockingPending()`,
    to: `    const hadBlockingBefore = hasBlockingPending()
    const mutantLenBefore = pendingProjection.state.length`,
  },
  'scenario 6': {
    from: `    const inbox = senseiInboxNow()
    const landed = sensei.deliver({
      type: 'deliver',
      from: 'infra',
      // Full inbox on wakes (docs/attention.md §2): triage needs zero fetches.
      text: inbox ? renderInboxWake(inbox) : 'Events pending. Check the board.',`,
    to: `    mutantCachedInbox ??= senseiInboxNow()
    const inbox = mutantCachedInbox
    const landed = sensei.deliver({
      type: 'deliver',
      from: 'infra',
      text: inbox ? renderInboxWake(inbox) : 'Events pending. Check the board.',`,
  },
}

const results: string[] = []

for (const m of MUTATIONS) {
  const original = await Bun.file(SERVER).text()
  let mutated = original
  const companion = COMPANIONS[m.guard]
  if (companion) {
    if (!mutated.includes(companion.from)) {
      results.push(`${m.guard.padEnd(11)} | SETUP FAILED (companion anchor not found)`)
      continue
    }
    mutated = mutated.replace(companion.from, companion.to)
  }
  if (!mutated.includes(m.from)) {
    results.push(`${m.guard.padEnd(11)} | SETUP FAILED (anchor not found)`)
    await Bun.write(SERVER, original)
    continue
  }
  mutated = mutated.replace(m.from, m.to)
  await Bun.write(SERVER, mutated)

  const proc = Bun.spawn(['bun', 'test', 'src/infra/race-guards.test.ts', '-t', m.filter], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  const text = out + err
  const failed = /(\d+) fail/.exec(text)
  const passed = /(\d+) pass/.exec(text)
  const nFail = failed ? Number(failed[1]) : -1
  const nPass = passed ? Number(passed[1]) : -1
  const caught = nFail > 0
  results.push(
    `${m.guard.padEnd(11)} | ${caught ? 'CAUGHT  ' : 'MISSED !'} | ${nPass} pass ${nFail} fail | ${m.what}`,
  )

  // restore
  await Bun.write(SERVER, original)
}

console.log('\n=== MUTATION RESULTS — every row must read CAUGHT ===')
for (const r of results) console.log(r)
