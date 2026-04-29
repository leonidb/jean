import { describe, expect, test } from 'bun:test'
import type { Trigger } from './reducers.ts'
import { shouldCatchUp } from './trigger-catchup.ts'

const baseTrigger: Trigger = {
  id: 'consolidate-wiki',
  cron: '0 3 * * *', // nightly at 3am
  agent: 'librarian',
  prompt: 'consolidate the wiki',
  kind: 'headless',
  status: 'active',
  actor: 'cli',
  createdAt: '2026-04-01T00:00:00Z',
}

describe('shouldCatchUp', () => {
  test('"at" (one-off) trigger never catches up', () => {
    const t: Trigger = {
      ...baseTrigger,
      cron: undefined,
      at: '2026-04-29T03:00:00Z',
      lastFiredAt: '2026-04-01T00:00:00Z',
    }
    expect(shouldCatchUp(t, new Date('2026-04-29T10:00:00Z'))).toBe(false)
  })

  test('never-fired trigger does NOT catch up (brand-new)', () => {
    const t = { ...baseTrigger, lastFiredAt: undefined }
    // Fire at 10am — last 3am fire was 7h ago — but trigger never fired before.
    expect(shouldCatchUp(t, new Date('2026-04-29T10:00:00Z'))).toBe(false)
  })

  test('lastFiredAt before previous expected fire → catch up', () => {
    // Last fired April 27 4am. Now is April 29 10am.
    // Previous expected fire per cron (0 3 * * *): April 29 3am.
    // 27 4am < 29 3am → catch up.
    const t = { ...baseTrigger, lastFiredAt: '2026-04-27T04:00:00Z' }
    expect(shouldCatchUp(t, new Date('2026-04-29T10:00:00Z'))).toBe(true)
  })

  test('lastFiredAt after previous expected fire → no catch up', () => {
    // Last fired April 29 3:01am. Previous expected fire: April 29 3am.
    // Already fired. Don't fire again.
    const t = { ...baseTrigger, lastFiredAt: '2026-04-29T03:01:00Z' }
    expect(shouldCatchUp(t, new Date('2026-04-29T10:00:00Z'))).toBe(false)
  })

  test('lastFiredAt exactly at previous expected fire → no catch up', () => {
    const t = { ...baseTrigger, lastFiredAt: '2026-04-29T03:00:00Z' }
    expect(shouldCatchUp(t, new Date('2026-04-29T10:00:00Z'))).toBe(false)
  })

  test('metadata.skipCatchup overrides — never catches up', () => {
    const t = {
      ...baseTrigger,
      lastFiredAt: '2026-04-01T00:00:00Z',
      metadata: { skipCatchup: true },
    }
    // Way overdue, but skipCatchup is set → false.
    expect(shouldCatchUp(t, new Date('2026-04-29T10:00:00Z'))).toBe(false)
  })

  test('hourly schedule with last fire 5h ago → catch up', () => {
    const t: Trigger = {
      ...baseTrigger,
      cron: '0 * * * *', // every hour at :00
      lastFiredAt: '2026-04-29T05:00:00Z',
    }
    // Now 10:30am. Most recent fire: 10:00am. Last fired 5:00am < 10:00 → catch up.
    expect(shouldCatchUp(t, new Date('2026-04-29T10:30:00Z'))).toBe(true)
  })

  test('hourly schedule, fired 30 min ago, current minute is :30 → no catch up', () => {
    // Fired at 10:00. Now 10:30. Previous expected fire: 10:00. lastFired === previousRun → no.
    const t: Trigger = {
      ...baseTrigger,
      cron: '0 * * * *',
      lastFiredAt: '2026-04-29T10:00:00Z',
    }
    expect(shouldCatchUp(t, new Date('2026-04-29T10:30:00Z'))).toBe(false)
  })
})
