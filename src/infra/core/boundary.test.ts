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
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const CORE_DIR = resolve(import.meta.dir)
const SERVER = resolve(CORE_DIR, '..', 'server.ts')

async function read(path: string): Promise<string> {
  return await Bun.file(path).text()
}

/** Source slice of `functionName`'s body, by brace matching from its opening
 *  `{`. Good enough here: the anchor is unambiguous and any drift shows up as a
 *  loud "anchor not found" rather than a quiet pass. */
function bodyOf(source: string, anchor: string): string {
  const start = source.indexOf(anchor)
  if (start === -1) throw new Error(`anchor not found: ${anchor}`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1)
  }
  throw new Error(`unbalanced braces after ${anchor}`)
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

  test('both timer callbacks are a single core.tick call with no branching', async () => {
    const source = await read(SERVER)
    const callbacks = [...source.matchAll(/setInterval\((\(\) => [^,]+),/g)].map((m) => m[1] as string)
    expect(callbacks.length).toBe(2)
    for (const cb of callbacks) {
      // One call, one clock read, nothing else. A `{` here would mean a body,
      // and a body is where branching on state comes back.
      expect(cb).toBe('() => attention.tick(viewNow(ports.now()))')
    }
  })
})
