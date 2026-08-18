/**
 * THE MULTI-AGENT CLASS — end to end, against the COMPOSED CORE (task 102;
 * ruled: end-to-end tests must be written against the core). No server, no
 * sockets: the dojo harness IS the shell, wiring
 * every module the way E1 wires them behind a socket, and everything the old
 * wiring suite proved behaviourally is proven here instead — response
 * shapes, headers and selector grammar are the adapter residue E1's thin
 * smoke keeps (the standing core-vs-adapter line).
 *
 * The old wiring suite's five register-row cases, carried or delegated:
 *   row 1 (a jointly-held event survives one ack)      → scenario 3, exact;
 *   row 2 (every clearing names its clearer)            → the ground-truth
 *   row 3 (a non-recipient clears nothing)                walk asserts both
 *                                                         per event, every
 *                                                         scenario;
 *   row 5 (one membership function)                     → every read here IS
 *                                                         `mailboxOf`; the
 *                                                         randomized run is
 *                                                         the divergence
 *                                                         detector (P2);
 *   response/header/selector cases                      → adapter residue,
 *                                                         E1 smoke; the old
 *                                                         file dies at H2.
 *
 * Every scenario carries the two kinds of assertion (design §7): its
 * specific outcome, and generic validity — the hindsight ground-truth walk
 * (`groundTruth`) whose independently-maintained pending must equal the
 * mailbox state the run produced.
 */

import { describe, expect, test } from 'bun:test'
import type { NotifierConfig } from '../contracts/notifier.ts'
import type { SupervisorConfig } from '../contracts/supervisor.ts'
import type { ReplyData, SendData } from '../contracts/vocabulary.ts'
import { assertNonCoincident, type CastSpec, counted, echo, type PendingPair, quiet } from '../fixture/index.ts'
import { createDojo, type Dojo } from './dojo.ts'

const T0 = 1_755_500_000_000
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

const NOTIFY: NotifierConfig = { nudgeIntervalMs: 2 * MIN, backoffMs: [2 * MIN, 5 * MIN, 10 * MIN] }
const SUPERVISE: SupervisorConfig = {
  senseiReminderMs: 10 * MIN,
  humanReminderMs: HOUR,
  dailyReminderMs: DAY,
  idlePingAfterMs: DAY,
  probeTimeoutMs: 5 * MIN,
  stuckAfterMs: 30 * MIN,
}

const SENSEI = 'sensei'

function dojoOf(specs: CastSpec[], seed = 42): Dojo {
  return createDojo(specs, { notifier: NOTIFY, supervisor: SUPERVISE, seed, startMs: T0 })
}

const pairKey = (p: PendingPair) => `${p.recipient}\u0000${p.eventId}`

/** Generic validity, asserted the same way in every scenario: the hindsight
 *  walk's independently-maintained pending equals the run's mailbox state. */
function assertGroundTruth(dojo: Dojo) {
  const truth = dojo.groundTruth()
  expect([...truth.pending].map(pairKey).sort()).toEqual([...dojo.pendingPairs()].map(pairKey).sort())
  return truth
}

describe('scenario 1 — the echo loop: one message crosses the whole system and comes back transformed', () => {
  test('send → resolution → pair → announce → wake → conduct → reply → announce → ack: conserved exactly', () => {
    const dojo = dojoOf([
      { name: SENSEI, role: 'sensei', behaviour: { kind: 'reliable' }, conduct: quiet },
      { name: 'worker-echo', role: 'worker', behaviour: { kind: 'reliable' }, conduct: echo(' — heard') },
    ])
    dojo.registerAll()
    dojo.send(SENSEI, 'worker-echo', 'ping-1')
    dojo.runFor(10 * MIN)

    // THE TRANSFORMATION ARRIVED — the loop proven end to end by content:
    // the echo conduct's deterministic addition shows up as a reply the
    // resolution addressed to the orchestrator.
    const echoed = dojo.log
      .events()
      .filter((e) => e.type === 'reply' && (e.data as ReplyData).text === 'ping-1 — heard')
    expect(echoed.length).toBe(1)

    // Conservation: exactly two pairs ever existed (the send to the worker,
    // the reply to the orchestrator) and both cleared — nothing leaked,
    // nothing was consumed by anyone else.
    const truth = assertGroundTruth(dojo)
    expect(truth.pairsCreated).toBe(2)
    expect(truth.pairsCleared).toBe(2)
    expect(dojo.pendingPairs()).toEqual([])

    // The loud direction, composed: TWO announcements moved the whole loop —
    // one wake per leg, both accepted, nothing repeated.
    expect(dojo.announcements().length).toBe(2)
    expect(dojo.announcements().every((a) => a.accepted)).toBe(true)
    expect(dojo.announcements().map((a) => a.to)).toEqual(['worker-echo', SENSEI])
  })
})

describe('scenario 2 — blocking beats the quiet-clock; one announcement carries the whole mailbox', () => {
  test('a human arrival interrupts before machine mail would have been announced, and the split is visible', () => {
    const dojo = dojoOf([
      { name: SENSEI, role: 'sensei', behaviour: { kind: 'reliable' } },
      { name: 'worker-w', role: 'worker', behaviour: { kind: 'reliable' } },
      { name: 'human', role: 'user', behaviour: { kind: 'silent' } },
    ])
    dojo.registerAll()
    dojo.send(SENSEI, 'worker-w', 'status when you can') // machine — waits the quiet-clock
    dojo.clock.advance(30_000)
    dojo.send('human', 'worker-w', 'need this now') // a human is waiting

    // The blocking/queued split, from the one classification both views share.
    expect(dojo.counts('worker-w')).toEqual({ blocking: 1, queued: 1, total: 2 })

    dojo.runFor(2 * MIN)
    const first = dojo.announcements()[0]
    expect(first).toBeDefined()
    if (!first) throw new Error('unreachable')
    // Announced at the first tick after the human arrival — 90s after T0,
    // well inside the 120s quiet-clock the machine mail was waiting out.
    expect(first.at - T0).toBe(90_000)
    expect(first.hasBlocking).toBe(true)
    expect(first.pendingCount).toBe(2) // one announcement says everything waiting
    expect([...first.ids].sort()).toEqual(
      dojo.log
        .events()
        .filter((e) => e.type === 'send')
        .map((e) => e.id),
    )

    // Never loud: that one announcement moved both pairs; no second wake.
    expect(dojo.announcements().length).toBe(1)
    assertGroundTruth(dojo)
    expect(dojo.pendingPairs()).toEqual([])
  })
})

describe('scenario 3 — subscription churn and reassignment mid-conversation route exactly', () => {
  test('the subscriber set is "everyone involved" at every step; independent acknowledgement holds end to end', () => {
    const dojo = dojoOf([
      { name: SENSEI, role: 'sensei', behaviour: { kind: 'reliable' } },
      { name: 'worker-a', role: 'worker', behaviour: { kind: 'reliable' } },
      { name: 'worker-b', role: 'worker', behaviour: { kind: 'reliable' } },
      { name: 'worker-c', role: 'worker', behaviour: { kind: 'reliable' } },
    ])
    dojo.registerAll()

    // Creation: the automatic surface — roster owner + the seat; the author
    // (the orchestrator) is excluded from its own event's mail.
    const created = dojo.createTask('001', 'routing', 'worker-a', SENSEI)
    expect([...dojo.subscribersOf('001')].sort()).toEqual([SENSEI, 'worker-a'])
    expect(dojo.mailboxIds('worker-a')).toContain(created.id)
    expect(dojo.mailboxIds(SENSEI)).not.toContain(created.id)

    // An explicit third subscriber — the case the pre-subscriber row could
    // never answer. The subscription event itself is history: no new pairs.
    const pairsBefore = dojo.pendingPairs().length
    expect(dojo.subscribe('001', 'worker-c', 'worker-c').ok).toBe(true)
    expect(dojo.pendingPairs().length).toBe(pairsBefore)

    // A comment routes to everyone involved minus its author.
    const comment1 = dojo.comment('001', 'worker-a', 'worker', 'progress')
    expect(dojo.mailboxIds(SENSEI)).toContain(comment1.id)
    expect(dojo.mailboxIds('worker-c')).toContain(comment1.id)
    expect(dojo.mailboxIds('worker-a')).not.toContain(comment1.id)
    expect(dojo.mailboxIds('worker-b')).not.toContain(comment1.id)

    // REGISTER ROW 1, end to end: worker-c clears ITS pair; the
    // orchestrator — never having acknowledged — still holds the event.
    dojo.act('worker-c')
    expect(dojo.mailboxIds('worker-c')).not.toContain(comment1.id)
    expect(dojo.mailboxIds(SENSEI)).toContain(comment1.id)

    // Reassignment mid-conversation: the new owner subscribes automatically
    // AND hears the reassignment itself (fold-before-resolve — composition
    // law 1: the event addresses the parties it creates).
    const reassigned = dojo.reassign('001', 'worker-b', SENSEI)
    expect([...dojo.subscribersOf('001')].sort()).toEqual([SENSEI, 'worker-a', 'worker-b', 'worker-c'])
    expect(dojo.mailboxIds('worker-b')).toContain(reassigned.id)
    expect(dojo.mailboxIds('worker-a')).toContain(reassigned.id) // still involved

    // Rule 4 — no automatic unsubscription: the PREVIOUS owner keeps
    // hearing about its old task (deliberate over-delivery).
    const comment2 = dojo.comment('001', 'worker-b', 'worker', 'taking over')
    expect(dojo.mailboxIds('worker-a')).toContain(comment2.id)
    expect(dojo.mailboxIds('worker-c')).toContain(comment2.id)
    expect(dojo.mailboxIds('worker-b')).not.toContain(comment2.id)

    // The explicit exit exists, and after it the routing narrows exactly.
    expect(dojo.unsubscribe('001', 'worker-a', 'worker-a').ok).toBe(true)
    const comment3 = dojo.comment('001', SENSEI, 'sensei', 'wrapping up')
    expect(dojo.mailboxIds('worker-a')).not.toContain(comment3.id)
    expect(dojo.mailboxIds('worker-b')).toContain(comment3.id)
    expect(dojo.mailboxIds('worker-c')).toContain(comment3.id)

    // §5 non-coincidence over the four mailboxes and the dojo-wide total —
    // asserted, not trusted.
    const perAgent = new Map(
      [SENSEI, 'worker-a', 'worker-b', 'worker-c'].map((n) => [n, dojo.mailboxIds(n) as readonly unknown[]]),
    )
    const globalIds = [...new Set(dojo.pendingPairs().map((p) => p.eventId))]
    assertNonCoincident(perAgent, globalIds)

    const truth = assertGroundTruth(dojo)
    expect(truth.observedJointHolds).toBeGreaterThanOrEqual(1)
  })
})

describe('scenario 4 — absence and return: being away costs a report, never a dispatch', () => {
  test('down exactly once (mail pending or not), recovery exactly once, and the queued dispatch lands on return', () => {
    const dojo = dojoOf([
      { name: SENSEI, role: 'sensei', behaviour: { kind: 'reliable' } },
      { name: 'worker-x', role: 'worker', behaviour: { kind: 'reliable' } },
    ])
    dojo.registerAll()
    dojo.createTask('002', 'field work', 'worker-x', SENSEI)
    dojo.taskStatus('002', { from: 'assigned', to: 'in-progress', actor: 'worker-x' })
    dojo.act('worker-x') // reads its assignment; the activity clock is now real
    dojo.act(SENSEI)

    // The worker vanishes; a dispatch arrives while it is away.
    dojo.disconnect('worker-x')
    const away = dojo.send(SENSEI, 'worker-x', 'update when you can')

    dojo.runFor(35 * MIN)
    // DOWN reported exactly once — despite the pending dispatch (row 8
    // scoped to probes, task 102): silence is the verdict for a dead
    // session, and mail does not shield it.
    expect(dojo.reports().filter((r) => r.effect.kind === 'report' && r.effect.status === 'down').length).toBe(1)

    // The worker returns.
    dojo.register('worker-x', 'worker')
    dojo.runFor(10 * MIN)
    expect(dojo.reports().filter((r) => r.effect.kind === 'report' && r.effect.status === 'recovered').length).toBe(1)

    // Being away never cost the dispatch: it was announced after the return
    // and acknowledged — the mailbox held it the whole time.
    const wokeWith = dojo.announcements().filter((a) => a.to === 'worker-x' && a.accepted && a.ids.includes(away.id))
    expect(wokeWith.length).toBeGreaterThanOrEqual(1)
    expect(dojo.mailboxIds('worker-x')).toEqual([])

    assertGroundTruth(dojo)
  })
})

describe('scenario 5 — the snooze cycle: demoted, never silenced, resumed automatically', () => {
  test('no reminder while the snooze lives (inside a day); the blocker cadence resumes the instant it passes; the reminder is real mail', () => {
    const dojo = dojoOf([
      { name: SENSEI, role: 'sensei', behaviour: { kind: 'reliable' } },
      { name: 'worker-p', role: 'worker', behaviour: { kind: 'reliable' } },
    ])
    dojo.registerAll()
    dojo.createTask('003', 'parked work', 'worker-p', SENSEI)
    dojo.taskStatus('003', { from: 'assigned', to: 'in-progress', actor: 'worker-p' })
    const resumeAt = T0 + 2 * HOUR
    dojo.taskStatus('003', {
      from: 'in-progress',
      to: 'waiting',
      actor: 'worker-p',
      blockedOn: 'human',
      resumeAt: new Date(resumeAt).toISOString(),
    })

    dojo.runFor(2 * HOUR)
    const early = dojo.reminders().filter((r) => r.at < resumeAt)
    expect(early).toEqual([]) // demoted to the daily floor — quiet this early

    dojo.runFor(20 * MIN)
    const reminders = dojo.reminders()
    expect(reminders.length).toBeGreaterThanOrEqual(1)
    const firstAt = reminders[0]?.at ?? 0
    // …and the instant it passes, the human cadence is back — the first
    // reminder lands within one grid step of expiry, no restart needed.
    expect(firstAt).toBeGreaterThanOrEqual(resumeAt)
    expect(firstAt - resumeAt).toBeLessThanOrEqual(2 * MIN)

    // The reminder IS the wake: a real task-reminder event, a real pair in
    // the orchestrator's mailbox, announced and acknowledged like any mail.
    const reminderEvents = dojo.log.events().filter((e) => e.type === 'task-reminder')
    expect(reminderEvents.length).toBe(reminders.length)
    const truth = assertGroundTruth(dojo)
    expect(truth.pairsCreated).toBeGreaterThan(2) // creation mail + the reminders — the loop stayed live

    // The hourly cadence after resumption: a second reminder, an hour later.
    dojo.runFor(HOUR + 2 * MIN)
    const later = dojo.reminders()
    expect(later.length).toBeGreaterThanOrEqual(2)
    const gap = (later[1]?.at ?? 0) - firstAt
    expect(gap).toBeGreaterThanOrEqual(HOUR)
    expect(gap).toBeLessThanOrEqual(HOUR + 2 * MIN)
    assertGroundTruth(dojo) // the FINAL state — the second cycle included (codex pass)
  })
})

describe('scenario 6 — the randomized horizon: two simulated days, five agents, ground truth alongside', () => {
  test('repetition recovers the failing agent, the ladder bounds the unresponsive one, and every message is conserved', () => {
    const dojo = dojoOf(
      [
        { name: SENSEI, role: 'sensei', behaviour: { kind: 'reliable' } },
        { name: 'worker-a', role: 'worker', behaviour: { kind: 'reliable' }, conduct: echo(' ✓') },
        { name: 'worker-b', role: 'worker', behaviour: { kind: 'failing', rate: 0.35 }, conduct: echo(' ~b') },
        { name: 'worker-c', role: 'worker', behaviour: { kind: 'unresponsive' } },
        { name: 'human', role: 'user', behaviour: { kind: 'silent' } },
      ],
      1755,
    )
    dojo.registerAll()

    // One machine dispatch to the unresponsive worker up front: its ladder
    // runs the whole horizon and the loud bound below measures it.
    const toC = dojo.send(SENSEI, 'worker-c', 'you will ignore this')

    // 36 hours of seeded traffic: machine dispatches, occasional human
    // (blocking) mail, occasional task work — then a 6-hour drain window of
    // pure ticks, so "repetition recovers" has room to finish.
    const workers = ['worker-a', 'worker-b'] as const
    let taskSeq = 100
    for (let halfHour = 0; halfHour < 72; halfHour++) {
      const target = dojo.rng.pick(workers)
      dojo.send(SENSEI, target, `dispatch ${halfHour}`)
      if (dojo.rng.chance(0.25)) dojo.send('human', dojo.rng.pick(workers), `question ${halfHour}`)
      if (dojo.rng.chance(0.15)) {
        const id = String(taskSeq++)
        const owner = dojo.rng.pick(workers)
        const bystander = owner === 'worker-a' ? 'worker-b' : 'worker-a'
        dojo.createTask(id, `job ${id}`, owner, SENSEI)
        // Subscription churn at scale — and the orchestrator's comment now
        // resolves to TWO parties (owner + bystander), the §5
        // multi-recipient observability the ground truth counts.
        dojo.subscribe(id, bystander, SENSEI)
        dojo.comment(id, SENSEI, 'sensei', 'context attached')
      }
      dojo.runFor(30 * MIN)
    }
    dojo.runFor(6 * HOUR)

    // GENERIC VALIDITY over the whole horizon: the independently-replayed
    // pending equals the run's mailbox state, and the walk itself asserted
    // §1/§2/P4/P6 at every one of the thousands of events (rows 2 and 3,
    // carried).
    const truth = assertGroundTruth(dojo)
    counted('pairs created across the horizon', truth.pairsCreated, 80)
    counted('joint holds observed', truth.observedJointHolds, 5)

    // CONSERVATION, per echo agent: every dispatch eventually produced
    // exactly one transformed reply — the failing worker dropped wakes and
    // mishandled events all horizon, and repetition recovered every single
    // one (P8's promise, measured rather than narrated).
    const sends = dojo.log.events().filter((e) => e.type === 'send')
    const replies = dojo.log.events().filter((e) => e.type === 'reply')
    for (const [worker, mark] of [
      ['worker-a', ' ✓'],
      ['worker-b', ' ~b'],
    ] as const) {
      const dispatched = sends.filter((e) => (e.data as SendData).agent === worker).length
      const answered = replies.filter(
        (e) => (e.data as ReplyData).agent === worker && (e.data as ReplyData).text.endsWith(mark),
      ).length
      expect(answered, `${worker}: every dispatch answered exactly once`).toBe(dispatched)
    }
    expect(dojo.mailboxIds('worker-a')).toEqual([])
    expect(dojo.mailboxIds('worker-b')).toEqual([]) // drained despite 35% dropped wakes

    // THE LOUD DIRECTION, composed: worker-c heard every announcement and
    // ignored every one. Discharged announcements must follow the ladder —
    // independently computed ceiling, never one per tick.
    const horizonEnd = dojo.clock.now()
    let expected = 0
    // First due: c's register was its activity; the quiet-clock ran from T0.
    let at = T0 + NOTIFY.nudgeIntervalMs
    let rung = 0
    while (at <= horizonEnd) {
      expected++
      at += NOTIFY.backoffMs[Math.min(rung, NOTIFY.backoffMs.length - 1)] as number
      rung++
    }
    const toWorkerC = dojo.announcements().filter((a) => a.to === 'worker-c')
    expect(toWorkerC.every((a) => a.accepted)).toBe(true) // heard, not refused
    counted('announcements to the unresponsive worker', toWorkerC.length, NOTIFY.backoffMs.length + 1)
    expect(toWorkerC.length).toBeLessThanOrEqual(expected) // the ladder, never the tick grid
    // …and the ladder ran the WHOLE horizon (clause 4 — the ceiling alone
    // would forgive a notifier that fell silent after a few rungs; codex
    // pass): the final rung repeats forever, so the last announcement sits
    // within one cap-plus-grid window of the horizon's end.
    const lastToC = toWorkerC[toWorkerC.length - 1]?.at ?? 0
    const cap = NOTIFY.backoffMs[NOTIFY.backoffMs.length - 1] as number
    expect(horizonEnd - lastToC).toBeLessThanOrEqual(cap + 2 * MIN)
    expect(dojo.mailboxIds('worker-c')).toContain(toC.id) // never acted, never lost
  })
})
