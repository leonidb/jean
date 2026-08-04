/**
 * SCENARIO 4 — TRIAGE.
 * LEVEL: projection (a pending list, three views, a fold; no server, no clock).
 *
 * CANON (013 REFERENCE DESIGN S4, verbatim): "An agent with many pending events
 * can read the summary view without fetching bodies, then fetch and ack any
 * subset as a group."
 *
 * STATUS: RED — `viewsFor` and `applyAck` throw.
 *
 * ── THE SCENARIO IS A WORKFLOW, SO THE TESTS ARE A WORKFLOW ──
 *
 * Read cheap → decide → pull only what you decided to handle → clear exactly
 * that. Each case below is one joint in that chain, and the joints are where it
 * breaks: a summary that needs bodies, a fetch that clears on read, an ack that
 * takes more than the agent chose, or a subset fetch that hands out codes for
 * events the agent never looked at.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../es/index.ts'
import { applyAck } from '../infra/target/codes.ts'
import type { RuleContext } from '../infra/target/mailbox-rules.ts'
import { viewsFor } from '../infra/target/views.ts'
import { ev, humanSays, workerSays } from './harness.ts'

const SENSEI = 'sensei'
const HUMAN = 'chat-human'

const ROLES: Record<string, string> = { [SENSEI]: 'sensei', builder: 'worker', [HUMAN]: 'user' }
const ctx: RuleContext = { roleOf: (n) => ROLES[n], taskOwner: () => undefined }

/** "Many pending events" — the state S4 is about. Mixed shapes so triage has
 *  something to discriminate on. */
function bigQueue(): StoredEvent[] {
  const events: StoredEvent[] = [humanSays(HUMAN, 'can you ship today?\nthe demo is at 4')]
  for (let i = 0; i < 12; i++) events.push(workerSays('builder', `step ${i} done`))
  events.push(ev('trigger-fired', 'triggers', { triggerId: 'nightly', agent: SENSEI, prompt: 'sweep' }))
  return events
}

describe('S4 — read the summary, fetch a subset, ack that subset', () => {
  test('the summary answers "what is waiting" for the WHOLE queue without a single fetch', () => {
    const pending = bigQueue()
    const v = viewsFor(pending, SENSEI, ctx)

    const lines = v.summary()
    expect(lines).toHaveLength(pending.length)
    // Enough to triage on: who it is from, and how it ranks. If either were
    // missing the agent would have to fetch to decide, which is the cost S4
    // exists to remove.
    for (const line of lines) {
      expect(typeof line.from).toBe('string')
      expect(line.from.length).toBeGreaterThan(0)
      expect(typeof line.priority).toBe('number')
    }
  })

  test('counts is strictly cheaper than summary and still answers "how much"', () => {
    const pending = bigQueue()
    const v = viewsFor(pending, SENSEI, ctx)
    const total = Object.values(v.counts()).reduce((a, b) => a + b, 0)
    expect(total).toBe(pending.length)
    // And it says how the load splits, which is the decision counts exists for:
    // "is anything urgent waiting, or is this thirteen worker pings?"
    expect(Object.keys(v.counts()).length).toBeGreaterThan(1)
  })

  test('FETCH IS NOT ACK — pulling bodies clears nothing', () => {
    // Read-before-ack (S5) makes reading a precondition of clearing. It must not
    // become a cause of it: an agent that fetches to decide, then decides to
    // leave an event alone, must still find it pending.
    const pending = bigQueue()
    const v = viewsFor(pending, SENSEI, ctx)
    v.fetch()
    expect(viewsFor(pending, SENSEI, ctx).summary()).toHaveLength(pending.length)
  })

  test('fetch a SUBSET, ack that subset as a group — exactly those clear', () => {
    const pending = bigQueue()
    const v = viewsFor(pending, SENSEI, ctx)

    // Triage from the summary: handle the human plus the first two worker
    // pings, leave the rest.
    const chosen = v
      .summary()
      .slice(0, 3)
      .map((l) => l.id)
    const fetched = v.fetch(chosen)
    expect(fetched.map((f) => f.id)).toEqual(chosen)

    const after = applyAck(
      pending,
      fetched.map((f) => ({ id: f.id, code: f.code })),
    )
    expect(after.map((e) => e.id)).toEqual(pending.filter((e) => !chosen.includes(e.id)).map((e) => e.id))
  })

  test('a subset fetch hands out codes for THAT subset only', () => {
    // The leak this forbids: a fetch that returns the requested bodies but
    // issues codes for the whole mailbox. The agent could then clear events it
    // never read, and read-before-ack would hold only by convention.
    const pending = bigQueue()
    const v = viewsFor(pending, SENSEI, ctx)
    const chosen = [pending[0]?.id as number]
    const fetched = v.fetch(chosen)
    expect(fetched.map((f) => f.id)).toEqual(chosen)
  })

  test('acking a group is order-insensitive and tolerates repeats', () => {
    // "As a group" means the agent hands back what it read, in whatever order
    // it happens to hold it. Nothing about the batch may depend on that order —
    // the fold decides (041), so a shuffled or duplicated batch is inert.
    const pending = bigQueue()
    const v = viewsFor(pending, SENSEI, ctx)
    const fetched = v.fetch()
    const pairs = fetched.slice(0, 4).map((f) => ({ id: f.id, code: f.code }))
    const straight = applyAck(pending, pairs)
    const shuffled = applyAck(pending, [...pairs].reverse().concat(pairs[0] as (typeof pairs)[number]))
    expect(shuffled.map((e) => e.id)).toEqual(straight.map((e) => e.id))
  })

  test('the queue the agent triaged is the queue it acked — no snapshot in between', () => {
    // S6's requirement seen from S4's side. Views are built from the list at the
    // moment they are asked; a cached view would let an agent ack against a
    // queue that has since changed, clearing an id it never saw.
    const pending = bigQueue()
    const before = viewsFor(pending, SENSEI, ctx).summary().length
    const grown = [...pending, humanSays(HUMAN, 'still there?')]
    expect(viewsFor(grown, SENSEI, ctx).summary().length).toBe(before + 1)
  })
})
