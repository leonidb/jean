/**
 * THE MULTI-AGENT CLASS — randomized scaled runs and the replay invariant checker.
 * LEVEL: core (a generated log folded through the real reducer; no sockets, no clock).
 *
 * AUTHORITY: `docs/guarantees.md` §5, last two bullets:
 *
 *   "Randomized, scaled runs. Five to ten fixture agents, randomized traffic,
 *    with the expected mailbox state tracked alongside as ground truth."
 *
 *   "A replay-based invariant checker. The full log of a randomized run is
 *    walked event by event in hindsight, applying the invariant at each point:
 *    every pair cleared only by its own recipient (P3), independently of the
 *    event's other recipients (§2), with the clearing attributed (P6)."
 *
 * ── GROUND TRUTH IS THE RESOLUTION, NOT THE SYSTEM ──
 *
 * The generator declares each event's recipients AT CREATION, from §4's table —
 * which is what §1 says a kind must do. That declaration is the ground truth
 * this file checks the system against. Nothing here reads the system's
 * membership rule to decide what the answer should be; if it did, the checker
 * could only confirm that the system agrees with itself.
 *
 * ── DETERMINISM ──
 *
 * Seeded PRNG, fixed seeds. A randomized test whose failure cannot be
 * reproduced is a rumour. The seed is printed in every failure message.
 */

import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../es/index.ts'
import { type PendingState, pendingReducer } from '../infra/reducers.ts'
import { mailboxFor, type RuleContext } from '../infra/target/mailbox-rules.ts'
import { T0 } from './harness.ts'

// ── The cast: 8 agents with typed behavioural roles (§5) ─────────

type Behaviour = 'responsive' | 'busy' | 'unresponsive' | 'failing'

const SENSEI = 'sensei'
const HUMAN = 'chat-human'

/** §5: "Fixture agents are tagged from setup — responsive, busy, unresponsive,
 *  failing-at-a-rate — with expected orchestrator-visible behaviour defined per
 *  role." The behaviour drives whether the agent ACKS what it is sent, which is
 *  the only orchestrator-visible difference that matters to these invariants. */
const CAST: { name: string; role: string; behaviour: Behaviour }[] = [
  { name: SENSEI, role: 'sensei', behaviour: 'responsive' },
  { name: HUMAN, role: 'user', behaviour: 'responsive' },
  { name: 'worker-a', role: 'worker', behaviour: 'responsive' },
  { name: 'worker-b', role: 'worker', behaviour: 'busy' },
  { name: 'worker-c', role: 'worker', behaviour: 'unresponsive' },
  { name: 'worker-d', role: 'worker', behaviour: 'failing' },
  { name: 'worker-e', role: 'worker', behaviour: 'responsive' },
  { name: 'worker-f', role: 'worker', behaviour: 'busy' },
]

const WORKERS = CAST.filter((a) => a.role === 'worker').map((a) => a.name)
const ROLES: Record<string, string> = Object.fromEntries(CAST.map((a) => [a.name, a.role]))
const BEHAVIOUR: Record<string, Behaviour> = Object.fromEntries(CAST.map((a) => [a.name, a.behaviour]))

/** Tasks, and who owns each. Task-stream events inherit this. */
const TASKS = ['301', '302', '303', '304']
const TASK_OWNER: Record<string, string> = {
  '301': 'worker-a',
  '302': 'worker-b',
  '303': 'worker-c',
  '304': 'worker-d',
}

const ctx: RuleContext = {
  roleOf: (n) => ROLES[n],
  taskOwner: (id) => (TASK_OWNER[id] ? { agent: TASK_OWNER[id], queue: TASK_OWNER[id] } : undefined),
}

// ── Deterministic randomness ─────────────────────────────────────

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    // xorshift32 — small, deterministic, adequate for choosing table rows.
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T

// ── The generator: an event plus its DECLARED recipients (§1, §4) ──

type Generated = { event: StoredEvent; recipients: string[] }

function generate(seed: number, count: number): Generated[] {
  const rand = rng(seed)
  let id = 0
  const out: Generated[] = []
  const make = (type: string, stream: string, data: Record<string, unknown>): StoredEvent => {
    id += 1
    return { id, stream, type, ts: new Date(T0 + id * 1000).toISOString(), data }
  }

  while (out.length < count) {
    const kind = Math.floor(rand() * 6)
    if (kind === 0) {
      // Dispatch to a named worker → that worker.
      const to = pick(rand, WORKERS)
      out.push({
        event: make('send', `agent-${to}`, { agent: to, from: SENSEI, text: 'do the thing', queued: true }),
        recipients: [to],
      })
    } else if (kind === 1) {
      // Worker reply → orchestrator.
      const from = pick(rand, WORKERS)
      out.push({ event: make('reply', `agent-${from}`, { agent: from, text: 'progress' }), recipients: [SENSEI] })
    } else if (kind === 2) {
      // Human message, unaddressed → orchestrator.
      out.push({ event: make('reply', `agent-${HUMAN}`, { agent: HUMAN, text: 'status?' }), recipients: [SENSEI] })
    } else if (kind === 3) {
      // Worker comment on a task → everyone involved minus the author.
      const task = pick(rand, TASKS)
      const author = pick(rand, WORKERS)
      const owner = TASK_OWNER[task] as string
      const involved = new Set([SENSEI, owner])
      involved.delete(author)
      out.push({
        event: make('task-comment', `task-${task}`, { agent: author, role: 'worker', text: 'note' }),
        recipients: [...involved],
      })
    } else if (kind === 4) {
      // Liveness ping → the pinged worker, and nobody else (§4).
      const to = pick(rand, WORKERS)
      out.push({
        event: make('agent-probe', `agent-${to}`, { agent: to, text: 'alive?', queued: true }),
        recipients: [to],
      })
    } else {
      // Task reminder → orchestrator (§4), whatever task it concerns.
      const task = pick(rand, TASKS)
      out.push({
        event: make('task-reminder', `task-${task}`, { taskId: task, to: SENSEI, text: 'waiting', queued: true }),
        recipients: [SENSEI],
      })
    }
  }
  return out
}

/** Does this behaviour ack what it receives? §5's roles, as the only
 *  orchestrator-visible difference these invariants can see. */
function acksIt(agent: string, rand: () => number): boolean {
  switch (BEHAVIOUR[agent]) {
    case 'responsive':
      return true
    case 'busy':
      return rand() < 0.5
    case 'failing':
      return rand() < 0.2
    default:
      return false
  }
}

function fold(log: readonly StoredEvent[]): PendingState {
  let state: PendingState = []
  for (const e of log) state = pendingReducer(state, e)
  return state
}

const SEEDS = [0x5eed, 0xbeef, 0x1234, 0xfeed]

// ── §5 — RANDOMIZED SCALED RUNS ──────────────────────────────────

describe('§5 — randomized scaled runs, ground truth tracked alongside', () => {
  for (const seed of SEEDS) {
    test(`P1 holds for every event in a 120-event run (seed 0x${seed.toString(16)})`, () => {
      const generated = generate(seed, 120)
      const pending = fold(generated.map((g) => g.event))
      expect(pending.length, 'the run must actually have produced mail').toBeGreaterThan(0)

      // For each event still pending, the set of agents holding it must equal
      // the set the generator declared at creation.
      const holders = (eventId: number) =>
        CAST.map((a) => a.name).filter((agent) => mailboxFor(pending, agent, ctx).some((e) => e.id === eventId))

      const divergences: string[] = []
      for (const { event, recipients } of generated) {
        if (!pending.some((e) => e.id === event.id)) continue
        const actual = holders(event.id).sort()
        const expected = [...recipients].sort()
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          divergences.push(`#${event.id} ${event.type}: declared [${expected}] → held by [${actual}]`)
        }
      }
      expect(
        divergences.slice(0, 6),
        `P1: delivery must match the declared resolution (seed 0x${seed.toString(16)}, ${divergences.length} diverged)`,
      ).toEqual([])
    })
  }

  test('the fixture stays a discriminator at scale: no two mailboxes coincide, none is the total', () => {
    const generated = generate(0x5eed, 120)
    const pending = fold(generated.map((g) => g.event))
    const sizes = CAST.map((a) => ({ agent: a.name, n: mailboxFor(pending, a.name, ctx).length }))
    for (const { agent, n } of sizes) {
      expect(n, `${agent} must not hold the entire queue`).toBeLessThan(pending.length)
    }
    // The workers' answers must not all be the same number either — that is the
    // collapse 059 hid behind, arriving at scale.
    const workerSizes = new Set(sizes.filter((s) => WORKERS.includes(s.agent)).map((s) => s.n))
    expect(workerSizes.size, 'the workers must not all hold identically many events').toBeGreaterThan(1)
  })
})

// ── §5 — THE REPLAY INVARIANT CHECKER ────────────────────────────

describe('§5 — replay: every pair cleared only by its own recipient, independently, attributed', () => {
  /**
   * Walk the log in hindsight, maintaining the ground-truth pair set, and check
   * the system's pending list against it after every event.
   *
   * GROUND TRUTH: `pairs` maps event id → the recipients who have not yet
   * cleared it. An ack by agent X removes (X, id) and nothing else. An event is
   * pending iff its recipient set is non-empty.
   */
  function replay(seed: number) {
    const generated = generate(seed, 80)
    const rand = rng(seed ^ 0xa5a5)
    const pairs = new Map<number, Set<string>>()
    const log: StoredEvent[] = []
    const violations: string[] = []
    let ackId = 100_000
    let attributions = 0
    let acksIssued = 0
    /** Occasions on which the P3 question could actually be ASKED: an event
     *  with two or more declared recipients that the system had in fact
     *  delivered to two or more mailboxes. Counted because a checker that
     *  never encounters one reports "no violations" while having tested
     *  nothing (§5's anti-vacuity rule). */
    let observableJointHolds = 0

    for (const { event, recipients } of generated) {
      log.push(event)
      if (recipients.length > 0) pairs.set(event.id, new Set(recipients))

      // Each recipient decides, per its behavioural role, whether to ack now.
      for (const who of recipients) {
        if (!acksIt(who, rand)) continue
        // WHO ACTUALLY HELD WHAT, in the system, immediately before this ack.
        // The P3 claim is checked only against agents the system itself had
        // delivered to: an agent that never received an event cannot be said to
        // have LOST it, and conflating the two would let a delivery defect
        // (P1) masquerade as a clearing defect. Under-delivery is the P1 test's
        // business, above.
        const heldBefore = new Map<number, string[]>()
        {
          const pendingBefore = fold(log)
          for (const [id] of pairs) {
            heldBefore.set(
              id,
              CAST.map((a) => a.name).filter((agent) => mailboxFor(pendingBefore, agent, ctx).some((e) => e.id === id)),
            )
          }
        }
        // THE OVERLAP, not the two sizes. An earlier draft counted "declared to
        // ≥2 AND delivered to ≥2", which a defect injection promptly showed to
        // be vacuous: dropping author-exclusion from the membership rule made
        // both sets large while their INTERSECTION stayed at one, so the
        // counter rose and the check underneath it still asked nothing. The
        // condition under which P3 can actually be exercised is two agents who
        // are both declared recipients AND actually hold it.
        const declared = pairs.get(event.id) ?? new Set<string>()
        const overlap = (heldBefore.get(event.id) ?? []).filter((a) => declared.has(a))
        if (overlap.length >= 2) observableJointHolds += 1
        ackId += 1
        acksIssued += 1
        // The ack event as infra writes it (server.ts recordAck): ids and a
        // ledger keyed by id. P6 requires the CLEARER to be named; if some
        // field in here carries an agent name, count it.
        const ackEvent: StoredEvent = {
          id: ackId,
          stream: 'system',
          type: 'ack',
          ts: new Date(T0 + ackId).toISOString(),
          data: { eventIds: [event.id], ledger: { [String(event.id)]: { clearedBy: 'ack' } } },
        }
        log.push(ackEvent)
        const named = JSON.stringify(ackEvent.data)
        if (CAST.some((a) => named.includes(`"${a.name}"`))) attributions += 1

        // Ground truth: only this agent's pair goes.
        pairs.get(event.id)?.delete(who)
        if (pairs.get(event.id)?.size === 0) pairs.delete(event.id)

        // The system, folded over the same log.
        const pending = fold(log)
        for (const [id, remaining] of pairs) {
          if (pending.some((e) => e.id === id)) continue
          // Only agents the system HAD delivered to can have lost anything.
          const lost = [...remaining].filter((agent) => (heldBefore.get(id) ?? []).includes(agent))
          if (lost.length > 0) {
            violations.push(
              `#${id}: ${lost.join(', ')} held it and never acked it, ` +
                `but ${who}'s ack on #${event.id} took it out of every mailbox`,
            )
          }
        }
        if (violations.length >= 4) return { violations, attributions, acksIssued, observableJointHolds }
      }
    }
    return { violations, attributions, acksIssued, observableJointHolds }
  }

  for (const seed of SEEDS) {
    test(`P3/§2: an ack clears one pair, never the event (seed 0x${seed.toString(16)})`, () => {
      const { violations, acksIssued, observableJointHolds } = replay(seed)
      expect(acksIssued, 'the run must actually have acked things').toBeGreaterThan(0)
      // ANTI-VACUITY, AND IT IS THE INTERESTING ASSERTION HERE (§5).
      //
      // A pure P3 violation needs an event that BOTH the spec declares to
      // several recipients AND the system delivered to several mailboxes. If no
      // such event occurs in a randomized 80-event run, "no violations" is a
      // statement about the generator, not about the system — so the checker
      // must say so rather than report a clean bill.
      //
      // Under §4 the only genuinely multi-recipient kind is the task row
      // (orchestrator + the involved worker, minus the author), and the system
      // under-delivers exactly those: a `task-comment` resolves to its AUTHOR,
      // who is then excluded, so the task's owner never receives it. The joint
      // holds the system does create — a probe held by both subject and
      // orchestrator — are ones §4 declares single-recipient. The two sets do
      // not overlap, which is why this count is zero.
      expect(
        observableJointHolds,
        'no correctly-addressed multi-recipient event ever reached two mailboxes, ' +
          'so P3 cannot be exercised through §4’s resolutions — see the core file for the defect itself',
      ).toBeGreaterThan(0)
      expect(violations.slice(0, 4), `seed 0x${seed.toString(16)}`).toEqual([])
    })
  }

  test('P6: every clearing in the run names the agent that cleared it', () => {
    const { attributions, acksIssued } = replay(0x5eed)
    expect(acksIssued, 'anti-vacuity: there were acks to attribute').toBeGreaterThan(0)
    expect(attributions, `${acksIssued} acks were written, none naming a clearer`).toBe(acksIssued)
  })
})
