/**
 * Notifier conformance — P8's four clauses, the refused-wake and carriage
 * rules, per-agent independence. RED BY ABSENCE until D8 lands
 * `src/domain/notifier/index.ts` exporting `notifier: NotifierContract`.
 *
 * Episode state is indirectly visible — nothing returns it; it shows only
 * in WHEN announcements fire — so every law here is driven through
 * behaviour sequences over a deterministic clock (the first survivor
 * cluster, aimed at directly).
 */

import { describe, expect, test } from 'bun:test'
import { counted } from '../fixture/index.ts'
import type { AgentNotifyFacts, NotifierConfig, NotifierContract, NotifierState } from './notifier.ts'

const IMPL_PATH: string = '../notifier/index.ts'
const notifier: NotifierContract = await import(IMPL_PATH)
  .then((m) => (m as { notifier: NotifierContract }).notifier)
  .catch((err: unknown) => {
    if (String(err).includes('Cannot find module')) {
      throw new Error(
        'RED BY ABSENCE — src/domain/notifier/index.ts does not exist yet. ' +
          'Task D8 implements the NotifierContract; nothing else may (no plausible stubs — design §9).',
      )
    }
    throw err
  })

const T0 = 1_755_600_000_000
const CONFIG: NotifierConfig = { nudgeIntervalMs: 120_000, backoffMs: [120_000, 300_000, 600_000] }

const WORKER = 'worker-a'
const OTHER = 'worker-b'

function facts(over: Partial<AgentNotifyFacts> & { name: string }): AgentNotifyFacts {
  return { pendingIds: [], hasBlocking: false, ...over }
}

/** Run decide at `now` for one agent's facts; return the effects and next. */
function tick(state: NotifierState, now: number, agents: AgentNotifyFacts[]) {
  return notifier.decide(state, { now, agents }, CONFIG)
}

/** Drive: announce whatever decide asked, report accepted, return state. */
function announceAll(state: NotifierState, now: number, agents: AgentNotifyFacts[]) {
  const d = tick(state, now, agents)
  let s = d.next
  for (const e of d.effects) {
    s = notifier.applyOutcome(s, { kind: 'announced', agent: e.to, ids: e.ids, accepted: true })
  }
  return { state: s, effects: d.effects }
}

describe('configuration — a shrinking ladder is refused, not silently violated', () => {
  test('valid config passes; empty, shrinking, and non-positive refuse typed', () => {
    expect(notifier.validateConfig(CONFIG)).toEqual({ ok: true })
    expect(notifier.validateConfig({ nudgeIntervalMs: 1, backoffMs: [] })).toEqual({
      ok: false,
      refusal: { kind: 'empty-ladder' },
    })
    const shrink = notifier.validateConfig({ nudgeIntervalMs: 1, backoffMs: [300_000, 120_000] })
    expect(shrink.ok).toBe(false)
    if (!shrink.ok) expect(shrink.refusal.kind).toBe('shrinking-ladder')
    expect(notifier.validateConfig({ nudgeIntervalMs: 0, backoffMs: [1] }).ok).toBe(false)
    expect(notifier.validateConfig({ nudgeIntervalMs: 1, backoffMs: [0, 60_000] }).ok).toBe(false)
  })
})

describe('P8 clause 1 — the first announcement follows the mail within the bounded interval', () => {
  test('machine mail: a quiet agent is told once the quiet-clock passes, and not before', () => {
    const s = notifier.initial()
    const quietSince = T0 - 60_000 // active a minute ago; interval is 2 min
    const withMail = [facts({ name: WORKER, pendingIds: [11], lastActivityAt: quietSince })]
    expect(tick(s, T0, withMail).effects).toEqual([]) // inside the quiet window — not yet
    const later = quietSince + CONFIG.nudgeIntervalMs
    const due = tick(s, later, withMail)
    expect(due.effects.map((e) => e.to)).toEqual([WORKER])
    expect(due.effects[0]?.ids).toEqual([11])
  })

  test('blocking (human) mail announces IMMEDIATELY — priority decides interrupt, nothing asks if the agent is busy', () => {
    const s = notifier.initial()
    const justActive = [facts({ name: WORKER, pendingIds: [21], hasBlocking: true, lastActivityAt: T0 - 1 })]
    const d = tick(s, T0, justActive)
    expect(d.effects.map((e) => e.to)).toEqual([WORKER])
    expect(d.effects[0]?.hasBlocking).toBe(true)
  })

  test('no activity EVER reads maximally quiet: a fresh session with waiting mail is announced at once', () => {
    const s = notifier.initial()
    const fresh = [facts({ name: WORKER, pendingIds: [31] })] // lastActivityAt absent
    expect(tick(s, T0, fresh).effects.map((e) => e.to)).toEqual([WORKER])
  })

  test('an empty mailbox announces nothing — ever', () => {
    const s = notifier.initial()
    expect(tick(s, T0, [facts({ name: WORKER })]).effects).toEqual([])
  })
})

describe('P8 clause 2 — repeat gaps follow the ladder: never shrinking, bounded above', () => {
  test('the gaps between repeats are exactly non-shrinking and cap at the last rung, which repeats forever', () => {
    const mail = (last?: number) => [facts({ name: WORKER, pendingIds: [41], lastActivityAt: last ?? T0 - 600_000 })]
    let { state } = announceAll(notifier.initial(), T0, mail())
    let announcedAt = T0
    const gaps: number[] = []
    let probeCount = 0
    // Walk forward until each next announcement fires; record the gaps.
    for (let rung = 0; rung < 5; rung++) {
      let t = announcedAt
      for (;;) {
        t += 15_000 // the tick grid
        const d = tick(state, t, mail())
        if (d.effects.length > 0) {
          gaps.push(t - announcedAt)
          const done = announceAll(state, t, mail())
          state = done.state
          announcedAt = t
          probeCount++
          break
        }
        state = d.next
        if (t - announcedAt > 1_200_000) throw new Error('ladder went silent — P8 clause 4 violated')
      }
    }
    counted('ladder repeats observed', probeCount, 5)
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1] as number) // never shrinks
    }
    // FOLLOWS THE LADDER, not merely bounded (codex pass, 095): each gap
    // matches its configured rung within grid slack, the last rung repeating.
    for (let i = 0; i < gaps.length; i++) {
      const rung = CONFIG.backoffMs[Math.min(i, CONFIG.backoffMs.length - 1)] as number
      expect(gaps[i]).toBeGreaterThanOrEqual(rung)
      expect(gaps[i]).toBeLessThanOrEqual(rung + 15_000)
    }
    const cap = CONFIG.backoffMs[CONFIG.backoffMs.length - 1] as number
    for (const g of gaps) expect(g).toBeLessThanOrEqual(cap + 15_000) // bounded above (grid slack)
    // The last two gaps sit at the cap — the final rung repeats forever.
    expect(gaps[gaps.length - 1]).toBeGreaterThanOrEqual(cap)
  })
})

describe('P8 clause 3 — any activity resets the ladder', () => {
  test('an agent act between repeats restarts the quiet-clock instead of the next rung firing', () => {
    const mail = (last: number) => [facts({ name: WORKER, pendingIds: [51], lastActivityAt: last })]
    const first = announceAll(notifier.initial(), T0, mail(T0 - 600_000))
    expect(first.effects.length).toBe(1)
    // The agent acts (a fetch, a reply — any own act) shortly after.
    const actedAt = T0 + 30_000
    const s = notifier.observeEvent(
      first.state,
      {
        id: 999,
        ts: new Date(actedAt).toISOString(),
        type: 'reply',
        stream: 'task-1',
        data: { agent: WORKER, text: 'here' },
      },
      WORKER,
    )
    // At what would have been the first backoff rung, nothing fires — the
    // clock now measures from the agent's act.
    const wouldBeRung = T0 + (CONFIG.backoffMs[0] as number)
    expect(tick(s, wouldBeRung, mail(actedAt)).effects).toEqual([])
    // …and once the full quiet interval passes from the act, it fires again.
    const due = actedAt + CONFIG.nudgeIntervalMs + 15_000
    expect(tick(s, due, mail(actedAt)).effects.length).toBe(1)
  })
})

describe('the refused wake and carriage — outcomes are data, and they matter', () => {
  test('a REFUSED delivery does not advance the episode: the agent is told again at the next eligible tick', () => {
    const mail = [facts({ name: WORKER, pendingIds: [61] })]
    const d = tick(notifier.initial(), T0, mail)
    expect(d.effects.length).toBe(1)
    const refused = notifier.applyOutcome(d.next, { kind: 'announced', agent: WORKER, ids: [61], accepted: false })
    // Soon after — well inside any backoff rung — the announcement repeats:
    // the agent was never told, so nothing was discharged.
    const retry = tick(refused, T0 + 30_000, mail)
    expect(retry.effects.map((e) => e.to)).toEqual([WORKER])
  })

  test('CARRIAGE discharges the current announcement without terminating the ladder (told ≠ done)', () => {
    const mail = [facts({ name: WORKER, pendingIds: [71] })]
    const d = tick(notifier.initial(), T0, mail)
    let s = d.next
    // The agent fetched its inbox itself before the push landed.
    s = notifier.applyOutcome(s, { kind: 'carried', agent: WORKER, ids: [71], via: 'fetch' })
    // No re-announcement right away — it has been told (S1: no double-telling)…
    expect(tick(s, T0 + 30_000, mail).effects).toEqual([])
    // …but the mail stays unhandled, and the ladder resumes on the backoff
    // schedule (P8 clause 4: never terminates while unhandled).
    let announced = false
    let t = T0
    let state = s
    while (t < T0 + 1_800_000) {
      t += 15_000
      const again = tick(state, t, mail)
      if (again.effects.length > 0) {
        announced = true
        break
      }
      state = again.next
    }
    expect(announced).toBe(true)
  })
})

describe('per-agent independence — one ladder never advances another (§5 non-coincidence in time)', () => {
  test('two agents with different mail and clocks announce independently; an outcome for one never touches the other', () => {
    const both = [
      facts({ name: WORKER, pendingIds: [81] }), // never active — due at once
      facts({ name: OTHER, pendingIds: [82], lastActivityAt: T0 - 1_000 }), // fresh — waits
    ]
    const d = tick(notifier.initial(), T0, both)
    expect(d.effects.map((e) => e.to)).toEqual([WORKER])
    const s = notifier.applyOutcome(d.next, { kind: 'announced', agent: WORKER, ids: [81], accepted: true })
    // OTHER's quiet-clock still runs its own course.
    const otherDue = T0 - 1_000 + CONFIG.nudgeIntervalMs
    const d2 = tick(s, otherDue, both)
    expect(d2.effects.map((e) => e.to)).toEqual([OTHER])
    // A carriage outcome for an agent not in view (unassumed input) is a
    // structural no-op — never a crash, never cross-agent discharge.
    const stray = notifier.applyOutcome(s, { kind: 'carried', agent: 'never-seen', ids: [999], via: 'fetch' })
    expect(tick(stray, otherDue, both).effects.map((e) => e.to)).toEqual([OTHER])
  })
})
