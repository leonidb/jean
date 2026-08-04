/**
 * Structural guards for the core boundary (refactor stage 3, commit 2 — task
 * 033; adopted from task 034 D3's recommendation).
 *
 * These read SOURCE, which is unusual and needs justifying. Each one pins a
 * property that is invisible at runtime until the day it costs a production
 * incident, and that no behavioural test can express:
 *
 *  1. REPLAY NEVER PUBLISHES. If someone routes `catchUp()` through the bus
 *     "for uniformity", the attention listener re-emits every historical wake
 *     on every restart. Nothing goes red — L2 folds start from empty state and
 *     never replay, and the integration tests start from empty dojos.
 *  2. THE CORE IMPORTS NO ADAPTERS. The moment `core/` reaches for the registry
 *     or the store directly, `decide(state, view)` stops being the whole input
 *     and the pure tests stop proving anything.
 *  3. TIMER CALLBACKS DON'T BRANCH. Leonid's acceptance check for the
 *     extraction, stated as a rule: "if a timer callback still branches on
 *     state, the extraction is not done."
 *  4. THE PRE-APPEND WELDS (stage 4). Guards 6 and 7 are pure functions now,
 *     and moving them did NOT move the property that makes them guards: no
 *     `await` may separate the decision from the write it protects. That is the
 *     entire risk of stage 4, it is invisible to every behavioural test in the
 *     suite — the integration tests run a transport that never interleaves at
 *     that granularity — and it is a two-line source check.
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
 * The weld checks search for the word `await`, and the welds are the most
 * heavily commented lines in the file — the first version of this test failed
 * on its own explanatory prose ("NO AWAIT may appear between..."). Left
 * unstripped, the check would have been permanently red for a reason that has
 * nothing to do with the property, and the tempting fix — loosening the
 * pattern — is how a guard quietly stops guarding.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('core boundary', () => {
  test('bus.publish is reachable only from record() — replay must never publish', async () => {
    const source = await read(SERVER)
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
    // events, `reducers.ts` is the domain types. Nothing here reaches the
    // registry, the projections, the clock or the network. If you are adding to
    // this list, that is the moment to ask whether the thing belongs in core/.
    const allowed = [/^\.\.\/\.\.\/es\//, /^\.\/[\w-]+\.ts$/, /^\.\.\/inbox\.ts$/, /^\.\.\/reducers\.ts$/]

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

  test('GUARD 6 WELD — no await between claiming ack ids and reserving them', async () => {
    const body = code(bodyOf(await read(SERVER), 'async function recordAck('))
    const from = body.indexOf('claimAckIds(')
    const to = body.indexOf('ackInFlight.add')
    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)
    // If anything awaits in this window, two writers can both see an id as
    // unclaimed and both write an ack for it — the 20-way interleave that
    // produced 20 ack events. The pure function cannot enforce this; only its
    // caller can, so this is where it is checked.
    expect(body.slice(from, to)).not.toMatch(/\bawait\b/)
  })

  test('GUARD 7 WELD — no await between routeSend entry and the auto-clear snapshot', async () => {
    const body = code(bodyOf(await read(SERVER), 'async function routeSend('))
    const decision = body.indexOf('decideAutoClear(')
    expect(decision).toBeGreaterThan(-1)
    // Everything before the snapshot must be synchronous, so that only an event
    // already visible when the reply was INITIATED can be cleared. An await
    // here lets a message that arrived mid-flight — and was never seen — be
    // acked as though it had been answered.
    expect(body.slice(0, decision)).not.toMatch(/\bawait\b/)
  })

  test('both timer callbacks are a single core.tick call with no branching', async () => {
    const source = await read(SERVER)
    const callbacks = [...source.matchAll(/setInterval\((\(\) => [^,]+),/g)].map((m) => m[1] as string)
    expect(callbacks.length).toBe(2)
    for (const cb of callbacks) {
      // One call, one clock read, nothing else. A `{` here would mean a body,
      // and a body is where branching on state comes back.
      expect(cb).toBe('() => attention.tick(senseiView(ports.now()))')
    }
  })
})
