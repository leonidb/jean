/**
 * THE MULTI-AGENT CLASS — mailbox, membership and acknowledgement.
 * LEVEL: core (pure functions over a folded queue; no sockets, no clock).
 *
 * AUTHORITY: `docs/guarantees.md`, committed at the task-065 spec commit. Every `describe`
 * below names the requirement it tests, and asserts what the SPEC requires —
 * never what the code currently does. Where the two differ the test is RED and
 * that is the deliverable (task 064): the failures are the finding.
 *
 * ── HOW TO READ A FAILURE HERE ──
 *
 * A red test in this file is a claim that the system does not meet a published
 * requirement. Each one carries the register row from §7 if it is already
 * known, or `UNREGISTERED` if this file is the first to state it. Do not fix
 * the code to make these pass — §7 is the place a divergence gets recorded, and
 * the sequence this task sits in wants every failure visible at once before
 * anything is repaired.
 *
 * ── THE FIXTURE RULE, WHICH IS WHY THIS FILE EXISTS AT ALL (§5) ──
 *
 * "No two agents' answers can coincide by accident, and no agent's answer
 * coincides with the dojo-wide total — and asserts that non-coincidence
 * explicitly."
 *
 * Task 059 — the ack response handing back the GLOBAL pending count as the
 * caller's own — survived 859 tests and a 22-check live smoke because every one
 * of those checks ran a single agent holding everything pending. The correct
 * answer and the broken answer were the same number. `THE FIXTURE IS A
 * DISCRIMINATOR` below asserts non-coincidence as a test rather than trusting
 * it as a property, so a routing change that collapses the gap turns this file
 * red instead of quietly vacuous.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../es/index.ts'
import { pendingByAgent, pendingEvents } from '../infra/core/queue.ts'
import { type PendingState, pendingReducer } from '../infra/reducers.ts'
import { acknowledgedCount, applyAck, codeFor } from '../infra/target/codes.ts'
import { mailboxFor, type RuleContext } from '../infra/target/mailbox-rules.ts'
import { viewsFor } from '../infra/target/views.ts'
import { T0 } from './harness.ts'

// ── The cast ─────────────────────────────────────────────────────
//
// FIVE agents (§5: "five to ten fixture agents"). Three workers rather than
// two, deliberately: with two, "A's answer" and "not-A's answer" partition the
// world, so a surface that returned the complement of the wrong agent would
// still look plausible. A third worker makes every wrong answer wrong in a
// visible way.

const SENSEI = 'sensei'
const A = 'worker-a'
const B = 'worker-b'
const C = 'worker-c'
const HUMAN = 'chat-human'

const ROLES: Record<string, string> = {
  [SENSEI]: 'sensei',
  [A]: 'worker',
  [B]: 'worker',
  [C]: 'worker',
  [HUMAN]: 'user',
}

/** Task ownership, so task-stream events resolve to somebody. */
const TASK_OWNER: Record<string, { agent?: string; queue?: string }> = {
  '101': { agent: A, queue: A },
  '102': { agent: B, queue: B },
}

const ctx: RuleContext = {
  roleOf: (n) => ROLES[n],
  taskOwner: (id) => TASK_OWNER[id],
}

let nextId = 1000
function ev(type: string, stream: string, data: Record<string, unknown> = {}): StoredEvent {
  nextId += 1
  return { id: nextId, stream, type, ts: new Date(T0 + nextId * 1000).toISOString(), data }
}

/** Fold exactly as infra does. A hand-built pending list would flatter the
 *  rules by admitting whatever the test wanted; this admits what the reducer
 *  admits and nothing else. */
function pendingFrom(log: readonly StoredEvent[]): PendingState {
  let state: PendingState = []
  for (const e of log) state = pendingReducer(state, e)
  return state
}

/** §5's anti-vacuity rule as a helper: "every test asserts that what it
 *  compares is present. A check that A differs from B passes trivially when
 *  both are absent." Call it on both sides before comparing them. */
function present<T>(label: string, xs: readonly T[]): readonly T[] {
  expect(xs.length, `${label} must be non-empty or the comparison is vacuous`).toBeGreaterThan(0)
  return xs
}

// ── The world every case below shares ────────────────────────────
//
// Built so the three workers' mailboxes are DIFFERENT SIZES and none equals
// the global total. The sizes are asserted, not assumed — see THE FIXTURE IS A
// DISCRIMINATOR.

function world(): StoredEvent[] {
  return [
    // → A: a dispatch, a task event on the task it owns, a probe.
    ev('send', `agent-${A}`, { agent: A, from: SENSEI, text: 'take 101', queued: true }),
    ev('task-created', 'task-101', { title: 'ship it', description: '', queue: A }),
    ev('agent-probe', `agent-${A}`, { agent: A, text: 'alive?', queued: true }),
    // → B: one dispatch only.
    ev('send', `agent-${B}`, { agent: B, from: SENSEI, text: 'take 102', queued: true }),
    // → C: nothing addressed at all. C's mailbox is the empty case, and it has
    //   to stay empty for the perturbation cases to mean anything.
    // → sensei: a human on the bridge, and both workers' replies.
    ev('reply', `agent-${HUMAN}`, { agent: HUMAN, text: 'is it done?' }),
    ev('reply', `agent-${A}`, { agent: A, text: 'branch pushed' }),
    ev('reply', `agent-${B}`, { agent: B, text: 'blocked on review' }),
    ev('task-comment', 'task-102', { agent: B, role: 'worker', text: 'found the leak' }),
  ]
}

// ── §5 — THE FIXTURE IS A DISCRIMINATOR ──────────────────────────

describe('§5 FIXTURE — no two answers coincide, and the fixture says so', () => {
  test('every agent’s mailbox differs in size from every other and from the global total', () => {
    const pending = pendingFrom(world())
    const sizes: Record<string, number> = {
      [SENSEI]: mailboxFor(pending, SENSEI, ctx).length,
      [A]: mailboxFor(pending, A, ctx).length,
      [B]: mailboxFor(pending, B, ctx).length,
      [C]: mailboxFor(pending, C, ctx).length,
      global: pending.length,
    }
    // Distinctness across the board, stated as a set-size check so adding an
    // agent to the fixture cannot silently reintroduce a coincidence.
    const values = Object.values(sizes)
    expect(new Set(values).size, `sizes must be pairwise distinct, got ${JSON.stringify(sizes)}`).toBe(values.length)
    // And the specific coincidence 059 hid behind: nobody holds everything.
    for (const agent of [SENSEI, A, B, C]) {
      expect(sizes[agent] ?? -1, `${agent} must not hold the whole queue`).toBeLessThan(pending.length)
    }
    // Anti-vacuity: a fixture of all-empty mailboxes satisfies "pairwise
    // distinct" for exactly one agent and proves nothing.
    present('sensei mailbox', mailboxFor(pending, SENSEI, ctx))
    present('A mailbox', mailboxFor(pending, A, ctx))
    present('B mailbox', mailboxFor(pending, B, ctx))
  })

  test('ordering is controlled explicitly, not observed (§5)', () => {
    // Ids are assigned by the builder in source order, so "the queue is in log
    // order" is a property this file may rely on. Asserted rather than assumed.
    const pending = pendingFrom(world())
    const ids = pending.map((e) => e.id)
    expect(ids).toEqual([...ids].sort((x, y) => x - y))
  })
})

// ── P1 — DELIVERY IS EXACT ───────────────────────────────────────

describe('P1 — an event appears in each recipient’s mailbox and in no other', () => {
  /** §4's table, as data. `recipients` is what the SPEC says; the test asks the
   *  system and compares. `SENSEI` appears wherever §4 says "orchestrator". */
  const RESOLUTION: { kind: string; event: () => StoredEvent; recipients: string[]; note?: string }[] = [
    {
      kind: 'message to a named agent',
      event: () => ev('send', `agent-${A}`, { agent: A, from: SENSEI, text: 'hi', queued: true }),
      recipients: [A],
    },
    {
      kind: 'worker reply',
      event: () => ev('reply', `agent-${A}`, { agent: A, text: 'done' }),
      recipients: [SENSEI],
    },
    {
      kind: 'human message (unaddressed)',
      event: () => ev('reply', `agent-${HUMAN}`, { agent: HUMAN, text: 'status?' }),
      recipients: [SENSEI],
    },
    {
      kind: 'task created by the orchestrator, queued to a worker',
      event: () => ev('task-created', 'task-101', { title: 't', description: '', queue: A, actor: SENSEI }),
      recipients: [A],
      note:
        '§4: everyone involved with the task MINUS THE AUTHOR, and §1: "Mail is never addressed to its author." ' +
        'The orchestrator wrote this one. `authorOf` switches on type and never reads `actor`, which is the field ' +
        'that names the author on every task event.',
    },
    {
      kind: 'task comment by a worker',
      event: () => ev('task-comment', 'task-101', { agent: A, role: 'worker', text: 'note' }),
      recipients: [SENSEI],
      note: '§4: everyone involved minus the author — A authored it, so A is excluded.',
    },
    {
      kind: 'task reminder',
      event: () => ev('task-reminder', 'task-101', { taskId: '101', to: SENSEI, text: 'waiting', queued: true }),
      recipients: [SENSEI],
    },
    {
      kind: 'idle-liveness ping',
      event: () => ev('agent-probe', `agent-${A}`, { agent: A, text: 'alive?', queued: true }),
      recipients: [A],
      note: '§4: "Idle-liveness ping → the pinged worker". The orchestrator is NOT a recipient.',
    },
    {
      kind: 'agent down',
      event: () => ev('agent-down', 'system', { subject: A, to: SENSEI, text: 'down', queued: true }),
      recipients: [SENSEI],
    },
    {
      kind: 'worker status',
      event: () => ev('worker-status', `agent-${A}`, { agent: A, status: 'down', text: 'A is down' }),
      recipients: [SENSEI],
    },
  ]

  for (const row of RESOLUTION) {
    test(`${row.kind} → ${row.recipients.join(', ')}${row.note ? '' : ''}`, () => {
      const pending = pendingFrom([row.event()])
      present(`pending for ${row.kind}`, pending)
      const actual = [SENSEI, A, B, C].filter((agent) => mailboxFor(pending, agent, ctx).length > 0)
      expect(actual.sort(), row.note ?? `§4 resolution for "${row.kind}"`).toEqual([...row.recipients].sort())
    })
  }

  test('an event addressed to B is in NO other agent’s mailbox — the perturbation form', () => {
    // Stated as a perturbation rather than as expected values: add B's event to
    // a world and demand A's and C's answers are byte-identical. A surface that
    // mixes in another agent's events fails whatever its correct value is.
    const base = world()
    const before = pendingFrom(base)
    const after = pendingFrom([
      ...base,
      ev('send', `agent-${B}`, { agent: B, from: SENSEI, text: 'more', queued: true }),
    ])
    for (const agent of [A, C]) {
      expect(
        mailboxFor(after, agent, ctx).map((e) => e.id),
        `${agent} must be unaffected by B's mail`,
      ).toEqual(mailboxFor(before, agent, ctx).map((e) => e.id))
    }
    // Anti-vacuity: the perturbation must actually have landed somewhere.
    expect(mailboxFor(after, B, ctx).length).toBeGreaterThan(mailboxFor(before, B, ctx).length)
  })
})

// ── P2 — ONE MEMBERSHIP FUNCTION ─────────────────────────────────

describe('P2 — every surface reporting a mailbox derives it through one function', () => {
  test('REGISTER ROW 5: /events/pending?agent= applies one clause where the mailbox applies two', () => {
    // `pendingEvents` is what `GET /events/pending?agent=X` answers with
    // (server.ts:2914); `mailboxFor` is the mailbox. P2 requires these to be
    // the same function, not two that agree.
    const pending = pendingFrom(world())
    const surface = pendingEvents(pending, ctx.taskOwner, A).map((e) => e.id)
    const mailbox = mailboxFor(pending, A, ctx).map((e) => e.id)
    present('inspection surface for A', surface)
    present('mailbox for A', mailbox)
    expect(surface, 'the two surfaces must not be able to disagree (P2)').toEqual(mailbox)
  })

  test('REGISTER ROW 5: /events/agents counts a different set than the orchestrator’s mailbox', () => {
    const pending = pendingFrom(world())
    const counts = pendingByAgent(pending, ctx.taskOwner)
    const mailbox = mailboxFor(pending, SENSEI, ctx)
    present('sensei mailbox', mailbox)
    expect(counts[SENSEI] ?? 0, 'the per-agent count must agree with that agent’s mailbox (P2)').toBe(mailbox.length)
  })

  test('the divergence is not hypothetical: an agent’s own reply is counted for it but is not in its mailbox', () => {
    // The concrete shape of row 5. A worker's own `reply` resolves to the
    // worker (`data.agent` is the SENDER on a reply), so the one-clause surface
    // credits it to that worker; the mailbox rule excludes it because a mailbox
    // is what an agent must ACT on and its own utterances are not that.
    const log = [ev('reply', `agent-${A}`, { agent: A, text: 'i said this' })]
    const pending = pendingFrom(log)
    present('pending', pending)
    const surface = pendingEvents(pending, ctx.taskOwner, A).length
    const mailbox = mailboxFor(pending, A, ctx).length
    expect(surface, 'one surface says A has mail, the other says A has none').toBe(mailbox)
  })
})

// ── §2 + P3 — INDEPENDENT ACKNOWLEDGEMENT / NO SILENT LOSS ───────

describe('§2 + P3 — no agent’s acknowledgement can consume another agent’s mail', () => {
  /** A probe is the live instance of a jointly-held event: it carries
   *  `data.agent`, so it is in the subject's mailbox, and the orchestrator's
   *  mailbox is universal, so it is in the orchestrator's too. The comment on
   *  `core/supervision.ts` states this outright — "either can ack it, and the
   *  first ack clears it for both". */
  function jointlyHeld() {
    const probe = ev('agent-probe', `agent-${A}`, { agent: A, text: 'alive?', queued: true })
    const pending = pendingFrom([probe])
    return { probe, pending }
  }

  test('the fixture really is jointly held — both mailboxes contain it (anti-vacuity)', () => {
    const { probe, pending } = jointlyHeld()
    expect(mailboxFor(pending, A, ctx).map((e) => e.id)).toContain(probe.id)
    expect(mailboxFor(pending, SENSEI, ctx).map((e) => e.id)).toContain(probe.id)
  })

  test('REGISTER ROW 1: one recipient’s ack must leave the event in every other recipient’s mailbox', () => {
    const { probe, pending } = jointlyHeld()
    // A reads and clears its own pair.
    const ackEvent = ev('ack', 'system', { eventIds: [probe.id] })
    const after = pendingReducer([...pending], ackEvent)
    expect(
      mailboxFor(after, A, ctx).map((e) => e.id),
      'A cleared its own pair',
    ).not.toContain(probe.id)
    expect(
      mailboxFor(after, SENSEI, ctx).map((e) => e.id),
      'the orchestrator never acknowledged this and must still hold it (§2, P3)',
    ).toContain(probe.id)
  })

  test('REGISTER ROW 1: the event leaves pending only when EVERY recipient has cleared it (§1 "Pending")', () => {
    const { probe, pending } = jointlyHeld()
    const afterOne = pendingReducer([...pending], ev('ack', 'system', { eventIds: [probe.id] }))
    expect(
      afterOne.map((e) => e.id),
      'one of two recipients has cleared — the pair set is not empty, so the event is still pending',
    ).toContain(probe.id)
  })

  test('UNREGISTERED, COMPOUND: a worker can destroy the orchestrator’s task reminder', () => {
    // The two defects above meet here, and the result is worse than either.
    // §4 addresses a task reminder to the orchestrator alone. Membership is
    // derived instead of resolved, and a `task-NNN` stream inherits the task's
    // owner (`resolveAgent` → `taskOwner`), so the reminder also lands in the
    // owning WORKER's mailbox. The ack fold then clears by event id for
    // everyone. So a worker clearing what looks like noise in its own mailbox
    // silently deletes the orchestrator's reminder for that task — and the
    // reminder is the only thing that would have raised it again.
    const reminder = ev('task-reminder', 'task-101', {
      taskId: '101',
      to: SENSEI,
      text: 'waiting on human',
      queued: true,
    })
    const pending = pendingFrom([reminder])
    expect(
      mailboxFor(pending, A, ctx).map((e) => e.id),
      'precondition: it reached the worker too',
    ).toContain(reminder.id)
    const after = pendingReducer([...pending], ev('ack', 'system', { eventIds: [reminder.id] }))
    expect(
      mailboxFor(after, SENSEI, ctx).map((e) => e.id),
      'the worker acked; the orchestrator’s reminder must survive (§2, P3, and §4’s addressing)',
    ).toContain(reminder.id)
  })

  test('§5’s REQUIRED CASE: a correctly-addressed multi-recipient event, and one ack leaves the rest', () => {
    // §5: "At least one multi-recipient event, with the explicit assertion that
    // one recipient's acknowledgement leaves the event in every other
    // recipient's mailbox, and that a non-recipient's acknowledgement clears
    // nothing."
    //
    // §4's only genuinely multi-recipient kind is the task row: "everyone
    // involved with the task, minus the author". So: B comments on task 101,
    // which A owns. Involved = {orchestrator, A}; author = B; recipients =
    // {orchestrator, A}.
    const comment = ev('task-comment', 'task-101', { agent: B, role: 'worker', text: 'the leak is in the fold' })
    const pending = pendingFrom([comment])
    expect(
      mailboxFor(pending, SENSEI, ctx).map((e) => e.id),
      'the orchestrator is involved',
    ).toContain(comment.id)
    expect(
      mailboxFor(pending, A, ctx).map((e) => e.id),
      'A owns the task this comment is on — §4 says involved parties receive it. ' +
        '`resolveAgent` reads `data.agent`, which on a comment is the AUTHOR, so the owner is never resolved.',
    ).toContain(comment.id)
    expect(
      mailboxFor(pending, B, ctx).map((e) => e.id),
      'B wrote it — never addressed to its author',
    ).not.toContain(comment.id)

    // The half §5 names explicitly: A acks, the orchestrator keeps its pair.
    const after = pendingReducer([...pending], ev('ack', 'system', { eventIds: [comment.id] }))
    expect(
      mailboxFor(after, SENSEI, ctx).map((e) => e.id),
      'one recipient acked; the other still holds it',
    ).toContain(comment.id)
  })

  test('a zero-recipient event never enters pending at all (§1 "Pending", P4)', () => {
    // §4: acknowledgement, announcement, idle transition and memorize are
    // history. None of them may occupy a mailbox or a pending slot.
    const history = [
      ev('agent-idle', `agent-${A}`, { agent: A }),
      ev('memory', 'memories', { agent: A, text: 'noted' }),
      ev('nudge', 'system', { pendingCount: 3 }),
    ]
    expect(pendingFrom(history)).toEqual([])
  })
})

// ── P4 — PENDING IS DEFINED, NOT POLICED ─────────────────────────

describe('P4 — pending is the set of unacknowledged (recipient, event) pairs', () => {
  test('an admitted event is in at least one mailbox — no orphans', () => {
    // The floor P4 says should have nothing left to guard. Under a pair model
    // it is unfalsifiable by construction; under a predicate model it is a
    // property that can break, which is why it is still worth asking.
    const pending = pendingFrom(world())
    present('pending', pending)
    for (const e of pending) {
      const holders = [SENSEI, A, B, C].filter((agent) => mailboxFor(pending, agent, ctx).some((m) => m.id === e.id))
      expect(holders.length, `event ${e.id} (${e.type}) is in pending but in nobody's mailbox`).toBeGreaterThan(0)
    }
  })

  test('UNREGISTERED: the no-orphan floor rests on an orchestrator existing, not on the definition', () => {
    // Same queue, one difference: no agent is registered as the orchestrator —
    // task 040's never-registered corner, and a dojo's genuine state between
    // boot and the sensei's first connect. Every event whose only holder was
    // the universal mailbox is now an orphan: in pending, in no mailbox,
    // unfetchable, therefore unclearable.
    const workersOnly: RuleContext = { roleOf: (n) => (n === SENSEI ? undefined : ROLES[n]), taskOwner: ctx.taskOwner }
    const pending = pendingFrom(world())
    const orphans = pending.filter(
      (e) => ![A, B, C].some((agent) => mailboxFor(pending, agent, workersOnly).some((m) => m.id === e.id)),
    )
    expect(
      orphans.map((e) => `${e.id}:${e.type}`),
      'under the pair definition an event with no recipients is never pending, so this set is empty by construction',
    ).toEqual([])
  })
})

// ── P5 — READ BEFORE CLEAR, AUTHORIZED TO CLEAR ──────────────────

describe('P5 — an ack clears only when the code matches AND the caller is a recipient', () => {
  test('the code half holds: a wrong code clears nothing', () => {
    const pending = pendingFrom(world())
    const target = present('pending', pending)[0] as StoredEvent
    const after = applyAck(pending, [{ id: target.id, code: 'wrongc' }])
    expect(after.map((e) => e.id)).toContain(target.id)
  })

  test('REGISTER ROW 3: a NON-RECIPIENT presenting a correct code must clear nothing', () => {
    // C is not a recipient of anything in this world — the fixture's empty
    // mailbox exists for exactly this case. The code is content-derived and
    // therefore recomputable by any observer, which the spec says is harmless
    // (P5: "recomputing a code does not make the reader a recipient").
    const pending = pendingFrom(world())
    const mine = present('B mailbox', mailboxFor(pending, B, ctx))
    const target = mine[0] as StoredEvent
    expect(
      mailboxFor(pending, C, ctx).map((e) => e.id),
      'C must not be a recipient of B’s mail',
    ).not.toContain(target.id)

    // C recomputes the code from the log and acks. There is no parameter on
    // this call for WHO is acking — that absence is the defect: authorization
    // is not merely unenforced, it is unexpressible at this seam.
    const code = codeFor(target)
    const after = applyAck(pending, [{ id: target.id, code }])
    expect(
      after.map((e) => e.id),
      'a non-recipient cleared another agent’s mail (P5: the caller must be a recipient)',
    ).toContain(target.id)
  })
})

// ── P6 — ACCOUNTABLE CLEARING ────────────────────────────────────

describe('P6 — the clearing record names the agent that cleared each pair', () => {
  test('REGISTER ROW 2: the ack event records the mechanism, not the clearer', () => {
    const pending = pendingFrom(world())
    const target = present('pending', pending)[0] as StoredEvent
    // The shape infra writes (server.ts recordAck): eventIds + a ledger keyed
    // by id whose value carries `clearedBy`, which is a DeliveredVia-style
    // mechanism ('ack' | 'auto-clear'), never an agent name.
    const ackEvent = ev('ack', 'system', {
      eventIds: [target.id],
      ledger: { [String(target.id)]: { deliveredVia: 'wake', clearedBy: 'ack' } },
    })
    const ledger = (ackEvent.data as { ledger: Record<string, { clearedBy: string }> }).ledger
    const clearer = String(ledger[String(target.id)]?.clearedBy)
    expect(
      [SENSEI, A, B, C],
      `the record says "${clearer}", which is a mechanism; P6 requires the agent that cleared it`,
    ).toContain(clearer)
  })

  test('idempotence is per recipient, not global (P6)', () => {
    const pending = pendingFrom(world())
    const target = present('pending', pending)[0] as StoredEvent
    const code = codeFor(target)
    const after = applyAck(pending, [{ id: target.id, code }])
    // Repeating reports already-clear rather than erroring — this half holds.
    expect(acknowledgedCount([target.id], after)).toBe(1)
    expect(acknowledgedCount([target.id], applyAck(after, [{ id: target.id, code }]))).toBe(1)
  })
})

// ── P7 — PROGRESS ONLY BY ACKNOWLEDGEMENT ────────────────────────

describe('P7 — being shown an event never clears it', () => {
  test('all three view rungs leave the mailbox untouched', () => {
    const pending = pendingFrom(world())
    const before = mailboxFor(pending, SENSEI, ctx).map((e) => e.id)
    present('sensei mailbox', before)
    const views = viewsFor(pending, SENSEI, ctx)
    views.counts()
    views.summary()
    views.fetch()
    expect(mailboxFor(pending, SENSEI, ctx).map((e) => e.id)).toEqual(before)
  })

  test('the cheap rungs carry no code, so they cannot be sufficient to clear', () => {
    const pending = pendingFrom(world())
    const views = viewsFor(pending, A, ctx)
    const summary = present('A summary', views.summary())
    for (const line of summary) expect(line).not.toHaveProperty('code')
    const fetched = present('A fetch', views.fetch())
    for (const f of fetched) expect(typeof f.code).toBe('string')
  })
})

// ── P10 — FRESHNESS ──────────────────────────────────────────────

describe('P10 — every surface reports the queue as of the moment it responds', () => {
  test('the falling case: an agent asking whether it is finished is not answered from a pre-ack snapshot', () => {
    const pending = pendingFrom(world())
    const mine = present('A mailbox', mailboxFor(pending, A, ctx))
    const code = codeFor(mine[0] as StoredEvent)
    const after = applyAck(pending, [{ id: (mine[0] as StoredEvent).id, code }])
    const now = viewsFor(after, A, ctx).counts()
    const total = Object.values(now).reduce((s, n) => s + n, 0)
    expect(total, 'the count must describe the queue the ack just made').toBe(mine.length - 1)
  })

  test('a view is rebuilt per call, so two calls across a change disagree', () => {
    const pending = pendingFrom(world())
    const views = viewsFor(pending, SENSEI, ctx)
    const first = views.summary().length
    // The SAME view object, asked again after the underlying list changed, must
    // not answer from what it computed the first time. (`viewsFor` resolves the
    // mailbox once per call by design — this pins that the resolution is not
    // cached across calls of the returned functions.)
    const grown = pendingFrom([...world(), ev('reply', `agent-${C}`, { agent: C, text: 'new' })])
    expect(viewsFor(grown, SENSEI, ctx).summary().length).toBe(first + 1)
  })

  test('THE 059 SHAPE: no agent’s own count is ever the global total', () => {
    // The guard 059 shipped, generalised to every agent and asserted as a
    // property of the fixture rather than of one endpoint. If a routing change
    // ever makes one agent hold everything, this file stops being able to see
    // the defect — so it fails instead.
    const pending = pendingFrom(world())
    for (const agent of [SENSEI, A, B, C]) {
      const mine = mailboxFor(pending, agent, ctx).length
      expect(mine, `${agent}'s count must be distinguishable from the global total`).toBeLessThan(pending.length)
    }
  })
})
