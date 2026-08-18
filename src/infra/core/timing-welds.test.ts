/**
 * THE TWO TIMING WELDS — pinned before the decoupling moves the code (task 074).
 *
 * Both record behaviour that is CORRECT TODAY and untested, and both share the
 * property that earns a structural guard (boundary.test.ts's bar): if either
 * breaks, nothing goes red — the whole suite stays green while the system
 * quietly starts lying. These are the two places a behaviour-preserving
 * refactor can fail invisibly, which is why they are pinned BEFORE task 073's
 * extraction rather than during it.
 *
 * ── WELD 1: THE LEDGER TAKE AND THE ACK APPEND ARE SYNCHRONOUS-ADJACENT ──
 *
 * `recordAck` (server.ts) takes the delivery ledger at call entry and appends
 * the ack event two lines down. The ledger's READING rule is first-in-log
 * (core/codes.ts, ruling 3): the authoritative ack for an id is the first one
 * appended, and it must be the one carrying the delivery mark. Those coincide
 * only because nothing asynchronous sits between the take and the append —
 * whoever takes the entry is still the running task when the append is
 * enqueued, so take order IS append order. The header's own words: "nothing
 * local enforces it — if that ever changes, this is the line that breaks."
 * This file is the local enforcement.
 *
 * If an extraction inserts an await in that window (`const ledger = await
 * core.decideAck(...)` is the natural shape), two concurrent ackers can
 * interleave between take and append: the second ack in log order carries the
 * mark while the first — the authoritative one — carries none, and
 * `deliveredViaFor` answers "delivery unknown" for an event that was
 * demonstrably delivered. The wiring half (timing-invariants.wiring.test.ts)
 * pins the observable consequence under real concurrency; it CANNOT pin the
 * window itself, because a microtask-sized await preserves ordering under
 * bun's scheduler almost always — the break would ship green and fail in
 * production under load. Only reading the source pins the window.
 *
 * ── WELD 2: ANNOUNCEMENT IS SYNCHRONOUS INSIDE record() — THE WHOLE CHAIN ──
 *
 * `core/supervision.ts`, verbatim: the probe's survivability "rests on
 * announcement being synchronous" — an `agent-probe` is held JOINTLY by its
 * subject and the sensei (either can ack it), and that is survivable only
 * because the subject's wake is pushed before `record()` returns, so it is
 * woken "before the sensei could possibly have cleared the payload out from
 * under it. MAKE ANNOUNCEMENT ASYNCHRONOUS AND THIS SILENTLY MANUFACTURES
 * FALSE DOWN-REPORTS."
 *
 * The guarantee is a CHAIN, and every link must be synchronous for it to hold:
 *
 *   supervisor emit ─→ record() ─→ bus.publish ─→ 'notify' subscriber ─→
 *   notifier run ─→ exec.deliver
 *
 * Each link is asserted separately below, because the decoupling will move
 * exactly these seams and an async boundary at ANY of them severs the
 * guarantee. No behavioural test can see this: a microtask- or timer-deferred
 * announcement still lands milliseconds later, long before any test's second
 * HTTP request arrives — green in every suite, false down-reports in
 * production the first time a sensei drains its queue at the wrong moment.
 *
 * ── WHAT THESE ARE NOT ──
 *
 * Not spec assertions (those live on jean/builder-064-spec and stay red), and
 * not design preferences. Both pin what IS. If 073's extraction needs to break
 * either weld, that is a design decision to make loudly — this file turning
 * red is the mechanism that makes it loud — with the invariant re-established
 * by other means before the weld test is rewritten.
 */

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const CORE_DIR = resolve(import.meta.dir)
const SERVER = resolve(CORE_DIR, '..', 'server.ts')
const BUS = resolve(CORE_DIR, 'bus.ts')
const NOTIFY = resolve(CORE_DIR, 'notify.ts')

async function read(path: string): Promise<string> {
  return await Bun.file(path).text()
}

/** Source slice of a function's body, by brace matching — copied from
 *  boundary.test.ts, including its lesson: the parameter list is skipped
 *  FIRST, so an inline parameter type's brace doesn't get mistaken for the
 *  body's. Anchors are unambiguous; drift throws "anchor not found" rather
 *  than passing vacuously. */
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

/** Strip comments before looking for code — also from boundary.test.ts, and
 *  doubly load-bearing here: the words "await" and "async" appear throughout
 *  the prose these welds sit under, and a guard that trips on its own
 *  documentation gets loosened until it guards nothing. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** The async constructs that would sever a synchronous link. `await` and the
 *  deferral spellings; `async` is checked separately where a signature is in
 *  scope. */
const DEFERRAL = /\bawait\b|queueMicrotask|setTimeout|setImmediate|\.then\(/

describe('weld 1 — the ledger take and the ack append', () => {
  test('recordAck: no await before takeFor, and the append is the FIRST await after it', async () => {
    const body = code(bodyOf(await read(SERVER), 'async function recordAck('))

    const take = body.indexOf('deliveryLedger.takeFor(')
    const append = body.indexOf('await record(')
    expect(take, 'recordAck must take the ledger — has takeFor moved or been renamed?').toBeGreaterThan(-1)
    expect(append, 'recordAck must append via record()').toBeGreaterThan(-1)
    // Take BEFORE append. Reversed, the appended event cannot carry the ledger
    // it has not taken yet.
    expect(take, 'the take must precede the append').toBeLessThan(append)

    // Nothing asynchronous before the take: the take must happen while the
    // caller's task is still the running one, or two callers' take order stops
    // matching their call order.
    expect(body.slice(0, take)).not.toMatch(/\bawait\b/)

    // And nothing asynchronous BETWEEN take and append — this is the window
    // the weld exists for. Equivalent statement, asserted directly: the first
    // `await` in the whole body is the append itself.
    const firstAwait = body.search(/\bawait\b/)
    expect(
      body.slice(firstAwait, firstAwait + 'await record('.length),
      'an await has appeared between taking the ledger and appending the ack — ' +
        'take order and log order are no longer the same thing (see the weld header)',
    ).toBe('await record(')
  })

  test('takeFor has exactly one call site — one taker is what pairs take order with append order', async () => {
    const source = code(await read(SERVER))
    const sites = [...source.matchAll(/deliveryLedger\.takeFor\(/g)]
    // A second taker would be a second place the in-memory mark can be
    // consumed, and only one of them can be adjacent to the append.
    expect(sites.length).toBe(1)
  })
})

describe('weld 2 — announcement is synchronous inside record(), link by link', () => {
  test('link 1: both machines emit straight into record() — no queue, no defer', async () => {
    const source = code(await read(SERVER))
    // The supervisor's executor and the notifier's executor: each `emit` is a
    // synchronous arrow into record(). The probe (weld 2's whole reason) enters
    // the chain through the first of these.
    const emits = [...source.matchAll(/emit: \(type, data\) => void record\(type, SYSTEM_STREAM, data\)/g)]
    expect(emits.length, 'the two executors (notifier, supervisor) emit directly into record()').toBe(2)
  })

  test('link 2: record() publishes synchronously after the append — nothing between, nothing deferred', async () => {
    const body = code(bodyOf(await read(SERVER), 'async function record('))
    const append = body.indexOf('await store.append')
    const publish = body.indexOf('bus.publish(event)')
    expect(append).toBeGreaterThan(-1)
    expect(publish, 'record() must publish — announcement rides this call').toBeGreaterThan(-1)
    expect(append, 'append first, then publish').toBeLessThan(publish)
    // The window between them: no second await, no deferral. `slice` starts
    // after the append's own `await` keyword so it does not match itself.
    const between = body.slice(append + 'await'.length, publish)
    expect(
      between,
      'something asynchronous now sits between the append and the publish — ' +
        'an event can be durable and unannounced while other requests run',
    ).not.toMatch(DEFERRAL)
  })

  test('link 3: bus.publish runs every subscriber synchronously, in a plain loop', async () => {
    const body = code(bodyOf(await read(BUS), 'publish(event)'))
    expect(body, 'the subscriber loop is the announcement path').toContain('sub.apply(event)')
    // The bus contract, verbatim: "publish() runs every subscriber, in
    // registration order, to completion, before it returns." An async
    // construct anywhere in this body is that contract breaking.
    expect(body).not.toMatch(DEFERRAL)
    expect(body).not.toMatch(/\basync\b/)
  })

  test('link 4: the notify subscriber is a bare synchronous sweep', async () => {
    const source = code(await read(SERVER))
    const at = source.indexOf("name: 'notify'")
    expect(at, "the 'notify' subscriber must exist — it IS delivery-on-record").toBeGreaterThan(-1)
    // The registration is compact once comments are stripped; the closing
    // brace of the subscribe call bounds the slice.
    const registration = source.slice(at, source.indexOf('})', at) + 2)
    expect(registration).toMatch(/apply: \(\) => notifier\.sweep\(notifyViews\(ports\.now\(\)\)\)/)
    expect(registration).not.toMatch(DEFERRAL)
    expect(registration).not.toMatch(/\basync\b/)
  })

  test('link 5: the notifier decides and delivers in one synchronous run', async () => {
    const body = code(bodyOf(await read(NOTIFY), 'function run('))
    expect(body, 'run() is where the push leaves core').toContain('exec.deliver(')
    expect(body).not.toMatch(DEFERRAL)
    expect(body).not.toMatch(/\basync\b/)
  })
})
