/**
 * SCENARIO 5 — READ-BEFORE-ACK, and the death of every other clearing path.
 * LEVEL: projection (events in → pending out; pure).
 *
 * CANON (013 REFERENCE DESIGN S5, verbatim): "The ack code exists only in a
 * fetch response. Acking is explicit `{id, code}` pairs — THE ONLY CLEARING
 * PATH. Nothing like `upToId` exists."
 *
 * O2 (039): ack codes survive restart — durable or content-derived. The
 * assertions below are written so BOTH mechanisms satisfy them, and so that
 * neither a counter nor a random token can.
 *
 * STATUS: RED — `codeFor`, `issueCodes`, `applyAck`, `targetPendingReducer`
 * all throw.
 *
 * ── THIS FILE IS THE REPLACEMENT FOR A WHOLE CASUALTY ──
 *
 * 043's casualty list retires `src/infra/attention-autoclear.test.ts` entirely
 * and names this file as what replaces it. So the death of auto-clear-on-reply
 * has to be PINNED here, not merely implied by the other file's absence — and
 * the strongest form is the one below: the ack event's data shape has no `auto`
 * field to carry an infra-generated clear, checked at the type level so
 * `tsc --noEmit` catches a regression before any test runs.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../es/index.ts'
import { renderInboxWake } from '../infra/inbox.ts'
import { pendingReducer } from '../infra/reducers.ts'
import { applyAck, codeFor, issueCodes, type TargetAckData } from '../infra/target/codes.ts'
import { ev, humanSays, workerSays } from './harness.ts'

const HUMAN = 'chat-human'

function queue(): StoredEvent[] {
  return [humanSays(HUMAN, 'ship it?'), workerSays('builder', 'branch pushed'), workerSays('builder', 'tests green')]
}

const pairsFor = (events: readonly StoredEvent[]) => events.map((e) => ({ id: e.id, code: codeFor(e) }))
const ids = (q: readonly StoredEvent[]) => q.map((e) => e.id)

describe('S5 — {id, code} clears, and nothing else does', () => {
  test('a matching pair clears exactly its event', () => {
    const pending = queue()
    const target = pending[1] as StoredEvent
    expect(ids(applyAck(pending, pairsFor([target])))).toEqual(ids(pending.filter((e) => e !== target)))
  })

  test('a WRONG code does not clear — this is the whole point of the code', () => {
    // Without this the code is decoration and read-before-ack is a convention.
    const pending = queue()
    const target = pending[0] as StoredEvent
    expect(ids(applyAck(pending, [{ id: target.id, code: 'not-the-code' }]))).toEqual(ids(pending))
  })

  test('ANOTHER event’s code does not clear this one', () => {
    // The sharper version of the case above: the agent holds a real, issued
    // code — just not for this id. If codes were per-response rather than per
    // event, this would pass by accident and the whole batch would be clearable
    // with one token.
    const pending = queue()
    const a = pending[0] as StoredEvent
    const b = pending[1] as StoredEvent
    expect(ids(applyAck(pending, [{ id: a.id, code: codeFor(b) }]))).toEqual(ids(pending))
  })

  test('an unknown id is a structural no-op — no error, no effect', () => {
    const pending = queue()
    expect(ids(applyAck(pending, [{ id: 999_999, code: 'whatever' }]))).toEqual(ids(pending))
  })

  test('duplicate pairs and an empty list are both inert', () => {
    // Fold-decides (041): the write site appends, the fold assigns meaning, so
    // nothing upstream has to coordinate or validate.
    const pending = queue()
    const target = pending[2] as StoredEvent
    const once = applyAck(pending, pairsFor([target]))
    const twice = applyAck(pending, [...pairsFor([target]), ...pairsFor([target])])
    expect(ids(twice)).toEqual(ids(once))
    expect(ids(applyAck(pending, []))).toEqual(ids(pending))
  })

  test('a partly-wrong batch clears the right half and leaves the rest', () => {
    // Fail-soft per pair, not per batch. An agent that mistyped one code must
    // not lose the nine acks it got right, and must not be told the batch
    // succeeded either — which is what the returned queue says.
    const pending = queue()
    const good = pending[0] as StoredEvent
    const bad = pending[1] as StoredEvent
    const after = applyAck(pending, [
      { id: good.id, code: codeFor(good) },
      { id: bad.id, code: 'wrong' },
    ])
    expect(ids(after)).toEqual(ids(pending.filter((e) => e !== good)))
  })
})

describe('S5 — codes exist only in a fetch response', () => {
  test('issueCodes covers exactly the events it was given', () => {
    const pending = queue()
    const subset = pending.slice(0, 2)
    const issued = issueCodes(subset)
    expect([...issued.keys()].sort()).toEqual(ids(subset).sort())
  })

  test('the issued code IS the authoritative code — issuing is not minting', () => {
    // If `issueCodes` produced a per-response token rather than surfacing the
    // event's own code, two fetches would hand out two different codes for one
    // event and the first would silently stop working.
    const pending = queue()
    const issued = issueCodes(pending)
    for (const e of pending) expect(issued.get(e.id)).toBe(codeFor(e))
  })
})

describe('O2 — codes survive restart', () => {
  test('the same event yields the same code, twice from scratch', () => {
    // This is what a counter or a random token fails, and it is the property
    // both candidate mechanisms share: content-derived codes are stable because
    // the content is; durable codes are stable because they were stored.
    const pending = queue()
    const first = issueCodes(pending)
    const second = issueCodes(pending)
    for (const e of pending) expect(second.get(e.id)).toBe(first.get(e.id) as string)
  })

  test('a code issued before a restart still clears after one', () => {
    // The scenario in full: the agent fetched, infra went down, the agent acks
    // with the code it is still holding. Modelled as "the code was taken from
    // one fold and applied to a freshly-rebuilt one" — which is exactly what a
    // restart is.
    const log = queue()
    const rebuilt = log.reduce<StoredEvent[]>((s, e) => pendingReducer(s, e) as StoredEvent[], [])
    const held = { id: (log[0] as StoredEvent).id, code: codeFor(log[0] as StoredEvent) }
    expect(ids(applyAck(rebuilt, [held]))).toEqual(ids(rebuilt.slice(1)))
  })

  test('distinct events get distinct codes', () => {
    const pending = queue()
    expect(new Set(pending.map(codeFor)).size).toBe(pending.length)
  })
})

describe('S5 — the paths that no longer exist', () => {
  test('TYPE-GUARD — the ack data shape admits NO upToId and NO auto, checked at the type level', () => {
    // COMPILE-TIME ASSERTIONS. `@ts-expect-error` fails `tsc --noEmit` if the
    // error it expects ever stops happening — so re-adding either field breaks
    // the typecheck gate rather than quietly restoring a clearing path.
    const pairs = [{ id: 1, code: 'c' }]

    // @ts-expect-error — S5: "Nothing like upToId exists."
    const withUpToId: TargetAckData = { pairs, upToId: 3 }
    // @ts-expect-error — S5: {id, code} is the ONLY clearing path; infra never
    // generates a clear on an agent's behalf (auto-clear-on-reply retires).
    const withAuto: TargetAckData = { pairs, auto: 'reply' }

    // Referenced so the bindings are not dead code; the assertion above is the
    // real one and it already happened at compile time.
    expect(withUpToId.pairs).toHaveLength(1)
    expect(withAuto.pairs).toHaveLength(1)
  })

  test('the wake text no longer teaches an ack form that does not exist', () => {
    // RED AGAINST LIVE CODE, and the direct replacement for `inbox.test.ts:184`
    // (043's casualty list: it asserts the wake contains `ack({upToId`). Every
    // woken agent reads this string, so leaving `upToId` in it after S5 would
    // teach a call that has been removed — a failure that surfaces as an agent
    // getting a 400 in the middle of triage.
    const wake = renderInboxWake({
      blocking: [{ ids: [1], from: HUMAN, waitedMs: 60_000, count: 1, preview: 'ship it?', kinds: { text: 1 } }],
      queued: { count: 0, byType: {}, oldestMs: 0 },
    })
    expect(wake).not.toContain('upToId')
    expect(wake).not.toMatch(/auto-clear|automatically clears|auto clears/i)
  })

  test('CHARACTERIZATION — a send has never cleared anything in the fold', () => {
    // Auto-clear-on-reply lived in the ADAPTER: the server observed the sensei
    // answering a human and APPENDED an ack event. The fold was never party to
    // it, and this pins that it stays that way — a clearing path that rides on
    // another event's back is precisely what the explicit-acts principle (041's
    // first amendment) forbids. Green today; must stay green after auto-clear's
    // machinery is deleted.
    const human = humanSays(HUMAN, 'are you there?')
    const send = ev('send', `agent-${HUMAN}`, { agent: HUMAN, from: 'sensei', text: 'yes', delivered: true })
    const folded = [human, send].reduce<StoredEvent[]>((s, e) => pendingReducer(s, e) as StoredEvent[], [])
    expect(ids(folded)).toEqual([human.id])
  })
})
