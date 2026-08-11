/**
 * Structural guards for the core boundary (refactor stage 3, commit 2 — task
 * 033; adopted from task 034 D3's recommendation).
 *
 * These read SOURCE, which is unusual and needs justifying. Each one pins a
 * property that is invisible at runtime until the day it costs a production
 * incident, and that no behavioural test can express:
 *
 *  1. REPLAY NEVER PUBLISHES. If someone routes `catchUp()` through the bus
 *     "for uniformity", the notifier re-emits every historical push on every
 *     restart. Nothing goes red — L2 folds start from empty state and never
 *     replay, and the integration tests start from empty dojos.
 *  2. THE CORE IMPORTS NO ADAPTERS. The moment `core/` reaches for the registry
 *     or the store directly, `decide(state, view)` stops being the whole input
 *     and the pure tests stop proving anything.
 *  3. EVERY DELIVERY GOES THROUGH THE PORT. A port that covers a third of the
 *     delivery paths is worse than none, because it reads as complete.
 *  4. TIMER CALLBACKS DON'T BRANCH. Leonid's acceptance check for the
 *     extraction, stated as a rule: "if a timer callback still branches on
 *     state, the extraction is not done."
 *
 * A fifth kind lived here — THE PRE-APPEND WELDS, one per guard 6 and 7 — and
 * retired with the machinery it welded. The foot of this file records that, and
 * the two adapter guards that went with it.
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const CORE_DIR = resolve(import.meta.dir)
const SERVER = resolve(CORE_DIR, '..', 'server.ts')

async function read(path: string): Promise<string> {
  return await Bun.file(path).text()
}

/**
 * Source slice of a function's body, by brace matching.
 *
 * THE PARAMETER LIST IS SKIPPED FIRST, and that is not incidental: `routeSend`
 * declares an inline object type for its argument, so "the first `{` after the
 * anchor" is the parameter type's brace and matching from there returns the
 * SIGNATURE instead of the body. The weld assertion below then searched a
 * region that could not contain what it was looking for — it failed loudly
 * here, but a differently-shaped check would have passed vacuously.
 *
 * Anchors are unambiguous, and drift shows up as a thrown "anchor not found"
 * rather than a quiet pass.
 */
function bodyOf(source: string, anchor: string): string {
  const start = source.indexOf(anchor)
  if (start === -1) throw new Error(`anchor not found: ${anchor}`)
  let i = source.indexOf('(', start)
  for (let parens = 0; i < source.length; i++) {
    if (source[i] === '(') parens++
    else if (source[i] === ')' && --parens === 0) break
  }
  const open = source.indexOf('{', i)
  let depth = 0
  for (let j = open; j < source.length; j++) {
    if (source[j] === '{') depth++
    else if (source[j] === '}' && --depth === 0) return source.slice(open, j + 1)
  }
  throw new Error(`unbalanced braces after ${anchor}`)
}

/**
 * Strip comments before looking for code.
 *
 * Written for the weld checks, which searched for the word `await` in the most
 * heavily commented lines of the file — the first version failed on its own
 * explanatory prose ("NO AWAIT may appear between..."), and the tempting fix,
 * loosening the pattern, is how a guard quietly stops guarding.
 *
 * The welds are retired (see the foot of this file) and this now serves the
 * publish-call count, which had the same latent hole from the other direction:
 * `bus.publish(` written in a comment would have counted as a call site, and the
 * one thing that guard must be able to say is exactly how many there are.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('core boundary', () => {
  test('bus.publish is reachable only from record() — replay must never publish', async () => {
    const source = code(await read(SERVER))
    const all = [...source.matchAll(/bus\.publish\(/g)]
    // One call site. Not a style preference: every additional one is a place
    // where somebody could publish a REPLAYED event.
    expect(all.length).toBe(1)

    const record = bodyOf(source, 'async function record(')
    expect(record).toContain('bus.publish(')

    // And the catch-up block is still six bare `await X.catchUp()` lines with
    // nothing interleaved — the projections fold history directly, as they
    // always have. A publish smuggled into this sequence is what the hazard
    // looks like in practice.
    const block = /(?: {2}await \w+\.catchUp\(\)\n)+/.exec(source)?.[0] ?? ''
    const lines = block.trim().split('\n')
    expect(lines.length).toBe(6) // one per subscriber; a seventh projection needs a seventh line
    for (const line of lines) expect(line.trim()).toMatch(/^await \w+\.catchUp\(\)$/)

    // Belt and braces on the other side of the call: the projection primitive
    // itself has no notion of a bus to publish to.
    const projection = await read(resolve(CORE_DIR, '..', '..', 'es', 'projection.ts'))
    expect(projection).not.toContain('publish')
  })

  test('core/ imports nothing from the adapter layer', async () => {
    // The allowlist is deliberately tiny and each entry earns its place: `es/`
    // is the event-store vocabulary, `inbox.ts` is pure rendering over pending
    // events, `reducers.ts` and `board.ts` are the domain types. Nothing here
    // reaches the registry, the projections, the clock or the network. If you
    // are adding to this list, that is the moment to ask whether the thing
    // belongs in core/.
    //
    // `board.ts` was added at the transition (task 045) and the question above
    // was answered in writing rather than by habit: it is pure domain
    // vocabulary with zero I/O — task/status types and the transition DAG —
    // exactly the class as the already-allowlisted `reducers.ts`, and there was
    // never a principled reason for one to be here and not the other beyond
    // nothing in core/ having needed it yet. `core/supervision.ts` needs
    // `TaskStatus`. The alternative considered and REJECTED (ruled 2026-08-05)
    // was to keep supervision outside core/ to avoid touching this line at all;
    // that would have made "core/ is all the pure decisions" quietly false, and
    // the hazard this guard exists for is an UNEXAMINED widening, not a
    // justified one.
    const allowed = [
      /^\.\.\/\.\.\/es\//,
      /^\.\/[\w-]+\.ts$/,
      /^\.\.\/inbox\.ts$/,
      /^\.\.\/reducers\.ts$/,
      /^\.\.\/board\.ts$/,
    ]

    const offenders: string[] = []
    for (const file of readdirSync(CORE_DIR)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const source = await read(resolve(CORE_DIR, file))
      for (const match of source.matchAll(/from '([^']+)'/g)) {
        const spec = match[1] as string
        if (!allowed.some((re) => re.test(spec))) offenders.push(`${file} → ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('every delivery goes through the deliver port — no path reaches an entry directly', async () => {
    // Codex's finding, made mechanical. The port's claim is "it captures ALL
    // delivery paths", and a port covering a third of delivery is worse than
    // none because it reads as complete. Prose in a doc comment cannot hold
    // that; a grep that runs on every commit can.
    // Matched by ALLOWLIST, not by parsing the receiver. The first version of
    // this test pulled the receiver out with `(\w+(?:\.\w+)*)\.deliver\(` and
    // exempted `ports` — which the mutation harness immediately walked through
    // via `agents.get(sender)?.deliver({`, because an optional-chained call on
    // a method result matches no such pattern. A guard that only catches the
    // tidy spellings of the thing it forbids is not a guard.
    const source = await read(SERVER)
    const offenders = source
      .split('\n')
      .filter((line) => line.includes('.deliver('))
      .filter((line) => !line.includes('ports.deliver('))
      // The ONE permitted direct call: the default implementation of the port
      // itself, which is what every other site now routes through.
      .filter((line) => !line.includes('return entry.deliver(msg)'))
      .map((line) => line.trim())
    expect(offenders).toEqual([])
  })

  test('UNTESTED-4 — activity evidence is messaging-system events only: nothing consults git', async () => {
    // Canon FOUNDATIONS, verbatim: "activity evidence is messaging-system events
    // only (no commits — Jean isn't code-only)". Task 046's audit found it
    // untested, and it is exactly the class this file exists for: invisible at
    // runtime until the day it decides something, and inexpressible as a
    // behavioural test (a test that "no commit was consulted" has nothing to
    // observe).
    //
    // The sentence is not a style note. Jean orchestrates work that leaves no
    // commits at all — research, conversation, triage — so an agent judged live
    // by `git log` is an agent whose non-code work reads as death, and S11 then
    // reports a perfectly healthy worker as broken. The parenthetical says so.
    //
    // Checked over the DECISION LAYER, which is where it could actually bite:
    // core/ decides who is quiet, who is nagged and who is broken.
    for (const file of readdirSync(CORE_DIR)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue
      const source = code(await read(resolve(CORE_DIR, file)))
      expect(source).not.toMatch(/\bgit\b|\bspawn\b|execSync|mtime|statSync/)
    }
    // …and the views the adapter hands them carry no such field either, so the
    // decisions could not consult one if they wanted to. `lastActivityAt` is fed
    // from `touchAgent`, which fires on inbound frames and HTTP calls — messaging
    // events, by construction.
    const server = code(await read(SERVER))
    const view = bodyOf(server, 'function notifyView(')
    expect(view).not.toMatch(/\bgit\b|mtime|statSync/)
  })

  test('both timer callbacks are a single core call with no branching', async () => {
    const source = await read(SERVER)
    const callbacks = [...source.matchAll(/setInterval\((\(\) => [^,]+),/g)].map((m) => m[1] as string)
    expect(callbacks.length).toBe(2)
    // OLD: both callbacks were `() => attention.tick(senseiView(ports.now()))`,
    // and the assertion was a string equality against that one line. There are
    // two DIFFERENT machines on the two timers now — the notifier reads
    // mailboxes, the supervisor reads tasks and liveness — so equality to a
    // single literal is no longer the property. The property never was "these
    // are the same call"; it was Leonid's acceptance check for the extraction,
    // stated as a rule: "if a timer callback still branches on state, the
    // extraction is not done." That is what is checked, and it is checked of
    // both.
    //
    // `sweep` joined `tick` at the delivery unification (ruled 2026-08-11):
    // the notifier's timer drives EVERY dojo agent's mailbox, and the
    // per-agent fan-out lives in core — `sweep(views)` is a tested loop over
    // the same `run` — precisely so this callback could stay a single call
    // with no body. Admitting a third name here should hurt: it means another
    // entry point grew adapter-side semantics.
    for (const cb of callbacks) {
      // One call, one clock read, nothing else. A `{` here would mean a body,
      // and a body is where branching on state comes back.
      expect(cb).toMatch(/^\(\) => \w+\.(tick|sweep)\(\w+\(ports\.now\(\)\)\)$/)
    }
  })
})

// ── FOUR STRUCTURAL GUARDS RETIRED (task 045) ──────────────────────────
//
// The first two were PRE-DECLARED (task 043 part 3, `core/boundary.test.ts`:
// "GUARD 6 WELD, GUARD 7 WELD"). The last two were NOT, and are recorded as
// amendments — the list could not have contained them because both depended on
// details of the replacement design that did not exist when it was written.
//
// `GUARD 6 WELD — no await between claiming ack ids and reserving them`.
// PRE-DECLARED. There is no claim to weld: fold-decides (task 041, ruled) has
// `recordAck` append unconditionally, because the pending reducer's ack case was
// already idempotent and the claim was a redundant second layer. The window the
// weld protected does not exist, and neither do `claimAckIds` or `ackInFlight`.
//
// `GUARD 7 WELD — no await between routeSend entry and the auto-clear snapshot`.
// PRE-DECLARED. Auto-clear-on-reply is deleted whole (S5), so `routeSend` takes
// no snapshot and there is nothing for an await to get between.
//
// `the register handler hands the mailbox over when the sensei name changes` —
// AMENDMENT. This was wiring for `attention.adoptMailbox`, whose job was to
// carry an ARMED CLOCK from an old sensei name to a new one: a rename mid-stall
// otherwise stranded the clock on a key nothing read, and the watchdog was
// delayed by a full window. The transition removes the need rather than the
// wiring. Episodes are keyed by agent name and `episodeOf` answers `freshEpisode()`
// for a name it has never seen — `announcedThroughId: 0`, `nudgeCount: 0` — so a
// renamed sensei's first decision finds the whole mailbox unannounced and pushes
// AT ONCE. The failure mode inverted from "silent for a window" to "re-announces
// immediately", which is the safe direction and needs no handover to achieve.
// Verifiable from `core/notify.ts` without running anything, which is why the
// structural guard has nothing left to hold.
//
// `GUARD 6/7 WELD` and the adopt-mailbox row also leave the mutation harness;
// see its header, which says the same thing in the same words.
