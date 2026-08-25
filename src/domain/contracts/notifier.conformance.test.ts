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
import type { AgentNotifyFacts, NotifierConfig, NotifierContract, NotifierState, RegistrationFact } from './notifier.ts'

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

describe('P8 MIRRORED (task 098) — never going LOUD: told-once blocking mail follows the ladder, not the tick grid', () => {
  test('a blocking mailbox ticked across two intervals announces once, then at the rung — never every tick', () => {
    const mail = [facts({ name: WORKER, pendingIds: [91], hasBlocking: true })]
    const first = announceAll(notifier.initial(), T0, mail)
    expect(first.effects.length).toBe(1) // the immediate interrupt (clause 1)
    // Walk the 15s grid across the whole first rung with the SAME blocking
    // mailbox. The announced-ids memory is the only thing standing between
    // one announcement and one per tick — D8 measured 8/hour correct against
    // 241 with the defect, and this suite stayed green because nothing
    // ticked a blocking mailbox twice. The four clauses guard silence; this
    // pins the mirror.
    let state = first.state
    let announcements = 0
    const rung = CONFIG.backoffMs[0] as number
    for (let t = T0 + 15_000; t < T0 + rung; t += 15_000) {
      const d = tick(state, t, mail)
      announcements += d.effects.length
      state = d.next
    }
    expect(announcements).toBe(0) // told once — not told again inside the rung
    // At the rung it repeats — quiet is not silent (clause 4 still holds)…
    expect(tick(state, T0 + rung, mail).effects.map((e) => e.to)).toEqual([WORKER])
    // …and NEW blocking mail still interrupts mid-rung: the interrupt is per
    // NEW arrival, which is exactly what the announced memory may suppress
    // and no more.
    const withNew = [facts({ name: WORKER, pendingIds: [91, 92], hasBlocking: true })]
    expect(tick(state, T0 + 30_000, withNew).effects.map((e) => e.to)).toEqual([WORKER])
  })
})

describe('RULED (task 098) — decide does not suppress on an in-flight: a lawless shell fails NOISY, never silent', () => {
  test('a second decide before the outcome emits again and re-times the in-flight; the ladder measures from the later instant', () => {
    const mail = [facts({ name: WORKER, pendingIds: [95] })]
    const d1 = tick(notifier.initial(), T0, mail)
    expect(d1.effects.length).toBe(1)
    // The shell violates executor law (a): decides again without reporting.
    // Suppression here would mean one dropped outcome silences this agent's
    // ladder forever — clause 4's exact failure — so the ruling puts the
    // uncertainty on the noisy side: double-telling, visible, recoverable.
    const d2 = tick(d1.next, T0 + 5_000, mail)
    expect(d2.effects.length).toBe(1)
    // The outcome discharges the LATER in-flight — the announcement the
    // agent may actually have heard — so the next rung measures from T0+5s.
    const s = notifier.applyOutcome(d2.next, { kind: 'announced', agent: WORKER, ids: [95], accepted: true })
    const rung = CONFIG.backoffMs[0] as number
    expect(tick(s, T0 + rung, mail).effects).toEqual([]) // measured from T0, this would fire
    expect(tick(s, T0 + 5_000 + rung, mail).effects.length).toBe(1)
  })
})

describe('outcome-to-in-flight matching (codex, task 098) — a discharge requires the in-flight it reports on', () => {
  test('a DUPLICATED accepted outcome advances nothing: the repeat comes at the first rung, not the second', () => {
    const mail = [facts({ name: WORKER, pendingIds: [61] })]
    const once = announceAll(notifier.initial(), T0, mail)
    expect(once.effects.length).toBe(1)
    // The shell reports the same outcome twice. The defect codex caught
    // advanced the ladder on both: the agent waited 300s where the rung said
    // 120s — silence in exactly the increment P8 forbids.
    const dup = notifier.applyOutcome(once.state, { kind: 'announced', agent: WORKER, ids: [61], accepted: true })
    const rung = CONFIG.backoffMs[0] as number
    expect(tick(dup, T0 + rung, mail).effects.map((e) => e.to)).toEqual([WORKER])
  })

  test('a STRAY carriage (no in-flight) records its ids — no blocking re-fire — but moves neither clock nor rung', () => {
    const mail = (ids: number[]) => [facts({ name: WORKER, pendingIds: ids, hasBlocking: true })]
    const first = announceAll(notifier.initial(), T0, mail([71]))
    expect(first.effects.length).toBe(1)
    // Mid-rung, id 72 arrives and the agent fetches it ITSELF — carriage
    // with nothing in flight. The agent did see the mail…
    const s = notifier.applyOutcome(first.state, { kind: 'carried', agent: WORKER, ids: [72], via: 'fetch' })
    // …so the priority interrupt must not re-fire for it…
    expect(tick(s, T0 + 30_000, mail([71, 72])).effects).toEqual([])
    // …and nothing advanced: the repeat still comes at the first rung
    // measured from the T0 discharge — not a rung later, not never.
    const rung = CONFIG.backoffMs[0] as number
    expect(tick(s, T0 + rung, mail([71, 72])).effects.map((e) => e.to)).toEqual([WORKER])
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

// ── THE GREET: THE ZERO CASE OF THE ANNOUNCEMENT (task 133) ──────
//
// The mechanism is the empty-mailbox test itself, not a guard on it — so
// these walks flip exactly that and nothing else. A positive control runs
// beside them, because "no greet" is also what a mechanism that stopped
// running altogether prints: this ticket's own history has three walks
// that asserted no-greet through a door that never minted, and stayed
// green at 13 passing with the table flipped.

const SENSEI = 'sensei'

function reg(over: Partial<RegistrationFact> & { name: string }): RegistrationFact {
  return { role: 'sensei', pendingIds: [], ...over } as RegistrationFact
}

describe('the greet — minted only for a self-directed seat with an empty mailbox', () => {
  test('POSITIVE CONTROL: a sensei registering with an empty mailbox IS greeted', () => {
    // Without this, every assertion below passes for a mechanism that does
    // nothing at all.
    expect(notifier.greetOnRegistration(reg({ name: SENSEI }))).toEqual({ kind: 'greet', to: SENSEI })
  })

  test('mail waiting means NO greet — one evaluation, one outcome, never both', () => {
    // The whole shape: the greet cannot race the mail because it is only
    // minted in the mail's absence.
    expect(notifier.greetOnRegistration(reg({ name: SENSEI, pendingIds: [7] }))).toBeUndefined()
  })

  test("a worker is never greeted, empty mailbox or not — that is the sensei's job, not infra's", () => {
    // A DECISION, not a derivation (ruled 2026-08-25: a judgement call —
    // greeting workers was a live option). Greeting
    // workers is coherent; we chose against it because a worker with
    // nothing waiting is SUPPOSED to sit idle, and telling it otherwise is
    // the orchestrator's job, not infra's. Change the decision and this
    // walk changes with it — it pins the choice, not a necessity.
    expect(notifier.greetOnRegistration(reg({ name: WORKER, role: 'worker' }))).toBeUndefined()
    expect(notifier.greetOnRegistration(reg({ name: WORKER, role: 'worker', pendingIds: [7] }))).toBeUndefined()
  })

  test('SELF-LIMITING: an unacked greet is mail, so a reconnect mints nothing', () => {
    // greet -> disconnect without acking -> reconnect. The first greet is
    // still pending, so the mailbox is not empty, so nothing is minted and
    // the agent is told about the greet it already had. No agent can ever
    // hold two. Stated because the single-greet-across-many-reconnects
    // behaviour reads like a bug otherwise.
    const first = notifier.greetOnRegistration(reg({ name: SENSEI }))
    expect(first).toEqual({ kind: 'greet', to: SENSEI })
    const greetId = 42
    expect(notifier.greetOnRegistration(reg({ name: SENSEI, pendingIds: [greetId] }))).toBeUndefined()
  })

  test('the effect names its recipient and carries no prose — the adapter renders', () => {
    const effect = notifier.greetOnRegistration(reg({ name: SENSEI }))
    expect(effect).toEqual({ kind: 'greet', to: SENSEI })
    expect(Object.keys(effect ?? {}).sort()).toEqual(['kind', 'to'])
  })
})
