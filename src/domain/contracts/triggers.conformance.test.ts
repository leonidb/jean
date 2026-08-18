/**
 * Triggers conformance — the executable form of the triggers contract.
 * RED BY ABSENCE until D5 lands `src/domain/triggers/index.ts` exporting
 * `triggers: TriggersContract`.
 */

import { describe, expect, test } from 'bun:test'
import { counted, createClock, createLog } from '../fixture/index.ts'
import type { CreateTriggerCommand, TriggersContract } from './triggers.ts'

const IMPL_PATH: string = '../triggers/index.ts'
const triggers: TriggersContract = await import(IMPL_PATH)
  .then((m) => (m as { triggers: TriggersContract }).triggers)
  .catch((err: unknown) => {
    if (String(err).includes('Cannot find module')) {
      throw new Error(
        'RED BY ABSENCE — src/domain/triggers/index.ts does not exist yet. ' +
          'Task D5 implements the TriggersContract; nothing else may (no plausible stubs — design §9).',
      )
    }
    throw err
  })

const NOW = 1_755_600_000_000
const FACTS = {
  isValidCron: (expr: string) => expr === '0 9 * * *',
  validRoles: ['worker', 'sensei', 'user', 'peer', 'librarian'] as const,
}

const base: CreateTriggerCommand = {
  id: 'tr-one',
  cron: '0 9 * * *',
  agent: 'worker-a',
  prompt: 'daily sweep',
  actor: 'orchestrator-o',
}

function stateWith(...cmds: CreateTriggerCommand[]) {
  const log = createLog(createClock())
  let state = triggers.initial()
  for (const cmd of cmds) {
    const d = triggers.decideCreate(state, cmd, FACTS)
    if (!d.ok) throw new Error(`fixture: create refused ${JSON.stringify(d.refusal)}`)
    state = triggers.fold(state, log.append('trigger-created', 'triggers', d.data))
  }
  return { state, log }
}

describe('creation — the refusal table', () => {
  test('the valid base creates; every named refusal fires on its own malformation', () => {
    const cases: Array<[Partial<CreateTriggerCommand> | CreateTriggerCommand, string]> = [
      [{ ...base, agent: '' }, 'missing-agent-or-prompt'],
      [{ ...base, prompt: '' }, 'missing-agent-or-prompt'],
      [{ ...base, cron: undefined }, 'no-schedule'],
      [{ ...base, at: new Date(NOW).toISOString() }, 'both-schedules'],
      [{ ...base, cron: 'not cron' }, 'invalid-cron'],
      [{ ...base, cron: undefined, at: 'not-a-date' }, 'invalid-at'],
      [{ ...base, kind: 'robot' as never }, 'invalid-kind'],
      [{ ...base, model: 'opus' }, 'model-on-agent-trigger'],
      [{ ...base, retries: 2 }, 'retries-on-agent-trigger'],
      // Role validates BEFORE retries (the old order, kept) — so the retries
      // cases use a VALID role, isolating the malformation (codex pass).
      [{ ...base, kind: 'headless', agent: 'librarian', retries: 99 }, 'invalid-retries'],
      [{ ...base, kind: 'headless', agent: 'librarian', retries: 1.5 }, 'invalid-retries'],
      [{ ...base, kind: 'headless', agent: 'not-a-role' }, 'invalid-role-for-headless'],
      [{ ...base, kind: 'headless', agent: 'not-a-role', retries: 99 }, 'invalid-role-for-headless'],
      // Metadata symmetry (ruled, task 103): the SAME bag-shape refusal the
      // update path makes — a trigger must not be born with metadata an
      // update would refuse. Arrays, strings and null all cross the untyped
      // boundary looking plausible.
      [{ ...base, metadata: ['a', 'b'] as never }, 'invalid-metadata'],
      [{ ...base, metadata: 'notes' as never }, 'invalid-metadata'],
      [{ ...base, metadata: null as never }, 'invalid-metadata'],
    ]
    const { state } = stateWith()
    const ok = triggers.decideCreate(state, base, FACTS)
    expect(ok.ok).toBe(true)
    let checked = 0
    for (const [cmd, refusal] of cases) {
      const d = triggers.decideCreate(state, cmd as CreateTriggerCommand, FACTS)
      expect(d.ok).toBe(false)
      if (!d.ok) expect(d.refusal.kind).toBe(refusal as never)
      checked++
    }
    counted('creation refusals', checked, cases.length)
  })

  test('a headless trigger takes a ROLE as its target, with model and retries admitted', () => {
    const { state } = stateWith()
    const d = triggers.decideCreate(
      state,
      { ...base, id: 'tr-h', kind: 'headless', agent: 'librarian', model: 'opus', retries: 2 },
      FACTS,
    )
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.data.kind).toBe('headless')
      expect(d.data.model).toBe('opus')
      expect(d.data.retries).toBe(2)
    }
  })

  test('a duplicate id refuses — ids are identities', () => {
    const { state } = stateWith(base)
    const d = triggers.decideCreate(state, { ...base }, FACTS)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.refusal).toEqual({ kind: 'duplicate-id', id: 'tr-one' })
  })
})

describe('update — immutable schedule, refused unknowns, typed fields', () => {
  test('schedule fields refuse; unknown fields refuse BY NAME; valid fields decide', () => {
    const { state } = stateWith(base)
    const sched = triggers.decideUpdate(state, { id: 'tr-one', fields: { cron: '1 1 * * *' } })
    expect(sched.ok).toBe(false)
    if (!sched.ok) expect(sched.refusal).toEqual({ kind: 'schedule-immutable' })
    const unknown = triggers.decideUpdate(state, { id: 'tr-one', fields: { prompt: 'p2', frobnicate: true } })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.refusal).toEqual({ kind: 'unknown-fields', fields: ['frobnicate'] })
    const good = triggers.decideUpdate(state, { id: 'tr-one', fields: { prompt: 'p2', status: 'disabled' } })
    expect(good.ok).toBe(true)
    if (good.ok) expect(good.data).toEqual({ id: 'tr-one', prompt: 'p2', status: 'disabled' })
  })

  test('status accepts active|disabled only — `fired` is terminal, not settable; malformed metadata refuses', () => {
    const { state } = stateWith(base)
    const bad = triggers.decideUpdate(state, { id: 'tr-one', fields: { status: 'fired' } })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.refusal.kind).toBe('invalid-status')
    const badMeta = triggers.decideUpdate(state, { id: 'tr-one', fields: { metadata: ['not', 'an', 'object'] } })
    expect(badMeta.ok).toBe(false)
    if (!badMeta.ok) expect(badMeta.refusal.kind).toBe('invalid-metadata')
    const missing = triggers.decideUpdate(state, { id: 'tr-404', fields: { prompt: 'x' } })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.refusal).toEqual({ kind: 'unknown-trigger', id: 'tr-404' })
  })
})

describe('the fold — firing, one-shot terminality, history tolerance', () => {
  test('a fired one-shot becomes status `fired` and leaves the due plan; a cron trigger stays active', () => {
    const at = new Date(NOW - 1_000).toISOString()
    const { state, log } = stateWith(base, { id: 'tr-shot', at, agent: 'worker-a', prompt: 'once', actor: 'o' })
    const due = triggers.dueOneShots(state, NOW)
    expect(due.map((t) => t.id)).toEqual(['tr-shot'])
    const shot = triggers.triggerOf(state, 'tr-shot')
    if (!shot) throw new Error('fixture: missing trigger')
    const fired = triggers.fold(state, log.append('trigger-fired', 'triggers', triggers.fireData(shot)))
    expect(triggers.triggerOf(fired, 'tr-shot')?.status).toBe('fired')
    expect(triggers.triggerOf(fired, 'tr-shot')?.lastFiredAt).toBeDefined()
    expect(triggers.dueOneShots(fired, NOW)).toEqual([]) // fired leaves the plan
    expect(triggers.triggerOf(fired, 'tr-one')?.status).toBe('active')
  })

  test('an at in the future is not due; a removed trigger leaves the state', () => {
    const at = new Date(NOW + 60_000).toISOString()
    const { state, log } = stateWith({ id: 'tr-later', at, agent: 'worker-a', prompt: 'later', actor: 'o' })
    expect(triggers.dueOneShots(state, NOW)).toEqual([])
    const removed = triggers.decideRemove(state, 'tr-later')
    expect(removed.ok).toBe(true)
    if (removed.ok) {
      const s = triggers.fold(state, log.append('trigger-removed', 'triggers', removed.data))
      expect(triggers.triggerOf(s, 'tr-later')).toBeUndefined()
    }
  })

  test('history tolerance: a created event with no schedule is dropped; a missing kind defaults to agent', () => {
    const log = createLog(createClock())
    let state = triggers.initial()
    state = triggers.fold(
      state,
      log.appendRaw('trigger-created', 'triggers', { id: 'tr-bad', agent: 'a', prompt: 'p', actor: 'o' }),
    )
    expect(triggers.triggerOf(state, 'tr-bad')).toBeUndefined()
    state = triggers.fold(
      state,
      log.appendRaw('trigger-created', 'triggers', {
        id: 'tr-old',
        cron: '0 9 * * *',
        agent: 'a',
        prompt: 'p',
        actor: 'o',
      }),
    )
    expect(triggers.triggerOf(state, 'tr-old')?.kind).toBe('agent')
  })
})

describe('the malformed-input cluster (090 pins, from D5’s report — severity order)', () => {
  test('#1 THE CATCH-UP BOUNDARY: fired exactly AT the last scheduled instant → no catch-up (a <= here double-fires every close restart)', () => {
    const { state } = stateWith(base)
    const t = triggers.triggerOf(state, 'tr-one')
    if (!t) throw new Error('fixture')
    const scheduledInstant = NOW - 3_600_000
    const prevRun = (_c: string, _n: number) => scheduledInstant
    const firedExactlyThen = { ...t, lastFiredAt: new Date(scheduledInstant).toISOString() }
    expect(triggers.shouldCatchUp(firedExactlyThen, NOW, prevRun)).toBe(false)
    const firedJustBefore = { ...t, lastFiredAt: new Date(scheduledInstant - 1).toISOString() }
    expect(triggers.shouldCatchUp(firedJustBefore, NOW, prevRun)).toBe(true)
  })

  test('#2 update field TYPES refuse — a non-string prompt/agent must never reach the log, and the type check precedes status/metadata', () => {
    const { state } = stateWith(base)
    const badPrompt = triggers.decideUpdate(state, { id: 'tr-one', fields: { prompt: { note: 'object' } } })
    expect(badPrompt.ok).toBe(false)
    const badAgent = triggers.decideUpdate(state, { id: 'tr-one', fields: { agent: 42 } })
    expect(badAgent.ok).toBe(false)
    // Order: with a bad prompt AND a bad status, the field-type refusal wins.
    const both = triggers.decideUpdate(state, { id: 'tr-one', fields: { prompt: 42, status: 'fired' } })
    expect(both.ok).toBe(false)
    if (!both.ok) expect(both.refusal.kind).not.toBe('invalid-status')
  })

  test('#3 RULED: a legacy created event carrying BOTH schedules keeps cron — a repeating job must not become one silent fire', () => {
    const log = createLog(createClock())
    let state = triggers.initial()
    state = triggers.fold(
      state,
      log.appendRaw('trigger-created', 'triggers', {
        id: 'tr-legacy',
        cron: '0 9 * * *',
        at: new Date(NOW - 1_000).toISOString(),
        agent: 'worker-a',
        prompt: 'p',
        actor: 'o',
      }),
    )
    const t = triggers.triggerOf(state, 'tr-legacy')
    expect(t?.cron).toBe('0 9 * * *')
    expect(t?.at).toBeUndefined()
    // …and after a fire it stays active (the at-wins defect is one silent fire).
    state = triggers.fold(
      state,
      log.appendRaw('trigger-fired', 'triggers', { triggerId: 'tr-legacy', agent: 'worker-a', prompt: 'p' }),
    )
    expect(triggers.triggerOf(state, 'tr-legacy')?.status).toBe('active')
  })

  test('#4 empty-string schedule fields are ABSENT, normalized once: cron:"" with a valid at creates an at-trigger', () => {
    const { state } = stateWith()
    const d = triggers.decideCreate(
      state,
      {
        id: 'tr-empty',
        cron: '',
        at: new Date(NOW + 60_000).toISOString(),
        agent: 'worker-a',
        prompt: 'p',
        actor: 'o',
      },
      FACTS,
    )
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.data.at).toBeDefined()
      expect(d.data.cron || undefined).toBeUndefined()
    }
  })

  test('#5 RULED: a duplicate created event for an existing id — FIRST WINS, same law as tasks (086)', () => {
    const { state, log } = stateWith(base)
    const s = triggers.fold(
      state,
      log.appendRaw('trigger-created', 'triggers', {
        id: 'tr-one',
        cron: '0 9 * * *',
        agent: 'impostor',
        prompt: 'replaced?',
        actor: 'x',
      }),
    )
    const t = triggers.triggerOf(s, 'tr-one')
    expect(t?.prompt).toBe('daily sweep') // the original, untouched
    expect(t?.agent).toBe('worker-a')
  })

  test('#6 deep immutability: mutating a returned trigger (nested metadata included) never reaches the registry', () => {
    const { state } = stateWith({ ...base, id: 'tr-meta', metadata: { note: 'original' } })
    const t = triggers.triggerOf(state, 'tr-meta')
    if (!t) throw new Error('fixture')
    // Frozen (throws) or copied (write lands on a copy) are both compliant;
    // what may never happen is the registry changing.
    try {
      ;(t.metadata as Record<string, unknown>).note = 'mutated'
    } catch {
      // frozen — fine
    }
    expect((triggers.triggerOf(state, 'tr-meta')?.metadata as Record<string, unknown>)?.note).toBe('original')
  })
})

describe('catch-up — the startup policy, cron arithmetic injected', () => {
  const prevRun = (_cron: string, now: number) => now - 3_600_000 // an hour ago

  test('a cron trigger that missed its most recent scheduled fire catches up', () => {
    const { state, log } = stateWith(base)
    const t = triggers.triggerOf(state, 'tr-one')
    if (!t) throw new Error('fixture')
    // Fired two hours ago; the schedule says one hour ago — missed.
    const firedLongAgo = triggers.fold(
      state,
      log.appendRaw('trigger-fired', 'triggers', { triggerId: 'tr-one', agent: 'worker-a', prompt: 'daily sweep' }),
    )
    const withOldFire = triggers.triggerOf(firedLongAgo, 'tr-one')
    if (!withOldFire) throw new Error('fixture')
    const twoHoursAgo = { ...withOldFire, lastFiredAt: new Date(NOW - 7_200_000).toISOString() }
    expect(triggers.shouldCatchUp(twoHoursAgo, NOW, prevRun)).toBe(true)
    // Fired half an hour ago — after the last scheduled run: no catch-up.
    const fresh = { ...withOldFire, lastFiredAt: new Date(NOW - 1_800_000).toISOString() }
    expect(triggers.shouldCatchUp(fresh, NOW, prevRun)).toBe(false)
  })

  test('never-fired triggers, one-shots, and skipCatchup opt-outs never catch up', () => {
    const { state } = stateWith(base, {
      id: 'tr-shot',
      at: new Date(NOW - 1_000).toISOString(),
      agent: 'worker-a',
      prompt: 'once',
      actor: 'o',
    })
    const brandNew = triggers.triggerOf(state, 'tr-one')
    const oneShot = triggers.triggerOf(state, 'tr-shot')
    if (!brandNew || !oneShot) throw new Error('fixture')
    expect(triggers.shouldCatchUp(brandNew, NOW, prevRun)).toBe(false) // the user just created it
    expect(triggers.shouldCatchUp(oneShot, NOW, prevRun)).toBe(false) // one-shots are the due plan's
    const optedOut = {
      ...brandNew,
      lastFiredAt: new Date(NOW - 7_200_000).toISOString(),
      metadata: { skipCatchup: true },
    }
    expect(triggers.shouldCatchUp(optedOut, NOW, prevRun)).toBe(false)
  })
})
