/**
 * The harness's own smoke suite — deterministic and green. It proves the
 * fixture's building blocks before any module leans on them; a harness
 * defect found later looks exactly like a module defect (064's own history),
 * so the harness earns its trust first, separately.
 */

import { describe, expect, test } from 'bun:test'
import type { ResolutionContract } from '../contracts/resolution.ts'
import {
  assertNonCoincident,
  counted,
  createCapture,
  createCast,
  createClock,
  createLog,
  createRng,
  replayCheck,
} from './index.ts'

describe('rng — seeded and deterministic', () => {
  test('same seed, same stream; different seeds diverge', () => {
    const a = createRng(0x5eed)
    const b = createRng(0x5eed)
    const c = createRng(0xbeef)
    const streamA = Array.from({ length: 20 }, () => a.next())
    const streamB = Array.from({ length: 20 }, () => b.next())
    const streamC = Array.from({ length: 20 }, () => c.next())
    expect(streamA).toEqual(streamB)
    expect(streamA).not.toEqual(streamC)
  })
})

describe('clock — instants are inputs', () => {
  test('advances explicitly, never backwards', () => {
    const clock = createClock(1_000)
    expect(clock.now()).toBe(1_000)
    clock.advance(500)
    expect(clock.now()).toBe(1_500)
    expect(() => clock.advance(-1)).toThrow()
  })
})

describe('log — monotonic ids, clock timestamps, real envelope', () => {
  test('append produces the StoredEvent shape real logs hold', () => {
    const clock = createClock(1_755_500_000_000)
    const log = createLog(clock)
    const first = log.append('send', 'agent-worker-a', {
      agent: 'worker-a',
      from: 'sensei',
      text: 'hello',
      queued: true,
    })
    clock.advance(1_000)
    const second = log.appendRaw('some-future-kind', 'system', { anything: true })
    expect(first.id).toBe(1)
    expect(second.id).toBe(2)
    expect(first.ts).toBe(new Date(1_755_500_000_000).toISOString())
    expect(second.ts).toBe(new Date(1_755_500_001_000).toISOString())
    expect(log.events().length).toBe(2)
  })
})

describe('cast — typed behaviours', () => {
  test('reliable acts on all, silent on none, failing at its rate', () => {
    const cast = createCast([
      { name: 'steady', role: 'worker', behaviour: { kind: 'reliable' } },
      { name: 'flaky', role: 'worker', behaviour: { kind: 'failing', rate: 0.7 } },
      { name: 'gone', role: 'worker', behaviour: { kind: 'silent' } },
    ])
    const clock = createClock()
    const log = createLog(clock)
    const offered = Array.from({ length: 200 }, (_, i) =>
      log.append('send', `agent-a${i}`, { agent: `a${i}`, from: 'sensei', text: 't', queued: true }),
    )
    const rng = createRng(0x1234)
    const [steady, flaky, gone] = cast
    expect(steady?.actsOn(offered, rng).length).toBe(200)
    expect(gone?.actsOn(offered, rng).length).toBe(0)
    const flakyActed = flaky?.actsOn(offered, rng).length ?? 0
    // ~30% of 200; generous band, deterministic under this seed.
    expect(flakyActed).toBeGreaterThan(30)
    expect(flakyActed).toBeLessThan(90)
  })

  test('duplicate names are a fixture bug, refused loudly', () => {
    expect(() =>
      createCast([
        { name: 'twin', role: 'worker', behaviour: { kind: 'reliable' } },
        { name: 'twin', role: 'worker', behaviour: { kind: 'silent' } },
      ]),
    ).toThrow('duplicate cast name')
  })
})

describe('capture — effects recorded in order, refusal modelled', () => {
  test('records deliver/emit/stamp in exact order and filters', () => {
    const cap = createCapture()
    expect(cap.deliver('worker-a', 'one')).toBe(true)
    cap.emit('nudge', { pendingCount: 2 })
    cap.stamp('wake', [1, 2])
    cap.refuse('worker-b')
    expect(cap.deliver('worker-b', 'two')).toBe(false)
    expect(cap.all().map((e) => e.kind)).toEqual(['deliver', 'emit', 'stamp', 'deliver'])
    expect(cap.deliveries('worker-a').length).toBe(1)
    expect(cap.emissions('nudge').length).toBe(1)
  })
})

describe('replay checker — ground truth per pair', () => {
  /** A minimal honest resolution for exercising the checker alone: 'send'
   *  resolves to data.agent minus the author; everything else is history. */
  const toyResolution: ResolutionContract = {
    resolve: (event) => {
      if (event.type !== 'send') return []
      const d = event.data as { agent?: string; from?: string }
      if (!d.agent || d.agent === d.from) return []
      return [d.agent]
    },
    authorOf: (event) => (event.type === 'send' ? (event.data as { from?: string }).from : undefined),
  }
  const ctx = { orchestrator: 'sensei', roleOf: () => undefined, taskOwner: () => undefined }

  test('pairs accumulate per recipient and clear only their own', () => {
    const clock = createClock()
    const log = createLog(clock)
    log.append('send', 'agent-a', { agent: 'a', from: 'sensei', text: '1', queued: true })
    log.append('send', 'agent-b', { agent: 'b', from: 'sensei', text: '2', queued: true })
    const result = replayCheck(log.events(), {
      resolution: toyResolution,
      ctx,
      clearedPairsOf: () => [],
    })
    expect(result.pairsCreated).toBe(2)
    expect(result.pending.length).toBe(2)
    // Clearing a's pair leaves b's — §2 in miniature.
    const cleared = replayCheck(log.events(), {
      resolution: toyResolution,
      ctx,
      clearedPairsOf: (event) => (event.id === 2 ? [{ recipient: 'a', eventId: 1 }] : []),
    })
    expect(cleared.pending).toEqual([{ recipient: 'b', eventId: 2 }])
  })

  test('clearing a pair that does not exist is a violation, named', () => {
    const clock = createClock()
    const log = createLog(clock)
    log.append('send', 'agent-a', { agent: 'a', from: 'sensei', text: '1', queued: true })
    expect(() =>
      replayCheck(log.events(), {
        resolution: toyResolution,
        ctx,
        clearedPairsOf: () => [{ recipient: 'b', eventId: 1 }],
      }),
    ).toThrow('does not exist')
  })

  test('a resolution addressing its author is a violation, named', () => {
    const clock = createClock()
    const log = createLog(clock)
    log.append('send', 'agent-a', { agent: 'a', from: 'sensei', text: 'x', queued: true })
    const selfAddressing: ResolutionContract = {
      resolve: (event) => [(event.data as { from: string }).from],
      authorOf: (event) => (event.data as { from: string }).from,
    }
    expect(() => replayCheck(log.events(), { resolution: selfAddressing, ctx, clearedPairsOf: () => [] })).toThrow(
      'own author',
    )
  })
})

describe('§5 assertions', () => {
  test('non-coincidence catches an agent equal to the global set, and two equal agents', () => {
    const global = [1, 2, 3]
    expect(() =>
      assertNonCoincident(
        new Map([
          ['a', [1]],
          ['b', [1, 2, 3]],
        ]),
        global,
      ),
    ).toThrow('dojo-wide total')
    expect(() =>
      assertNonCoincident(
        new Map([
          ['a', [1, 2]],
          ['b', [2, 1]],
        ]),
        global,
      ),
    ).toThrow('coincide')
    // The passing shape: pairwise distinct, none global.
    assertNonCoincident(
      new Map([
        ['a', [1]],
        ['b', [2, 3]],
      ]),
      global,
    )
  })

  test('anti-vacuity fails a loop that asserted nothing', () => {
    expect(() => counted('empty loop', 0)).toThrow('anti-vacuity')
    counted('real loop', 5)
  })
})
