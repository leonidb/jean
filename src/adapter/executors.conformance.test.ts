/**
 * Executor conformance — pair-laws (b) and (c), against the REAL executors
 * (A5 stated them; R11 deferred them to the E-side; task E1 closes it).
 *
 * Law (a) — effect order — is demonstrated in A5's own fixture suite against a
 * capturing executor. (b) and (c) are properties of the SHELL's sequencing and
 * could not be held there, which is why they waited for this file.
 *
 * ── WHY (c) IS HELD TWICE — AND WHAT THE MEASUREMENT ACTUALLY SHOWED ──
 *
 * "No interleaving" is a claim about the absence of a yield, and task 074
 * measured a case where only a source read could catch one: a microtask-sized
 * break preserved ordering under bun's scheduler, shipping green while failing
 * in production under load. That is why the structural half was written.
 *
 * It did NOT reproduce here, and the honest record matters more than the
 * tidy story. Deferring the stamp with `queueMicrotask` reddens BOTH halves —
 * because this runner's every effect is an observable call, so a deferred one
 * is simply missing from the trace at the instant the reader looks. 074's
 * behavioural test observed a final outcome instead, which the microtask
 * resolved before.
 *
 * The structural half is kept for what it states rather than for what it
 * uniquely caught: the law is "no yield", and a test that asserts the absence
 * of a yield says so directly, where a call-count test happens to imply it for
 * this particular runner shape. A future runner that batched or returned a
 * promise would break that coincidence.
 */

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { AnnounceEffect, NotifierExecutor } from '../domain/contracts/notifier.ts'
import { runAnnouncements } from './executors.ts'

const EXECUTORS = resolve(import.meta.dir, 'executors.ts')

type Call = { op: 'deliver' | 'stamp' | 'emit'; to?: string; ids?: readonly number[] }

/** A capturing executor: every call, in order, with the arguments that matter
 *  to the laws. */
function capturing(accept: (to: string) => boolean = () => true): { exec: NotifierExecutor; trace: Call[] } {
  const trace: Call[] = []
  return {
    trace,
    exec: {
      deliver: (to) => {
        trace.push({ op: 'deliver', to })
        return accept(to)
      },
      stamp: (_via, ids) => trace.push({ op: 'stamp', ids: [...ids] }),
      emit: () => trace.push({ op: 'emit' }),
    },
  }
}

const announce = (to: string, ids: number[]): AnnounceEffect => ({
  kind: 'announce',
  to,
  ids,
  pendingCount: ids.length,
  hasBlocking: false,
})

describe('law (b) — the stamp rides its own deliver', () => {
  test('each stamp immediately follows the deliver it is evidence of, carrying THAT deliver’s ids', () => {
    const { exec, trace } = capturing()
    const effects = [announce('worker-a', [1, 2]), announce('worker-b', [3])]
    runAnnouncements(effects, exec)

    // Every stamp's predecessor is a deliver, and the ids belong to the
    // announcement that deliver carried — never a batch assembled afterwards.
    let checked = 0
    for (let i = 0; i < trace.length; i++) {
      const call = trace[i]
      if (call?.op !== 'stamp') continue
      const before = trace[i - 1]
      expect(before?.op).toBe('deliver')
      const owner = effects.find((e) => e.to === before?.to)
      expect(call.ids).toEqual(owner?.ids as number[])
      checked++
    }
    expect(checked).toBe(2) // anti-vacuity: both announcements stamped
  })

  test('a REFUSED deliver stamps nothing — there is no delivery to be evidence of', () => {
    const { exec, trace } = capturing((to) => to !== 'worker-b')
    runAnnouncements([announce('worker-a', [1]), announce('worker-b', [2])], exec)
    const stamped = trace.filter((c) => c.op === 'stamp')
    expect(stamped.length).toBe(1)
    expect(stamped[0]?.ids).toEqual([1]) // worker-a's, and only worker-a's
  })
})

describe('law (c) — one decision’s effects never interleave with another’s reads', () => {
  test('behaviourally: a reader running between decisions sees whole decisions, never a partial one', () => {
    const seen: string[] = []
    const { exec, trace } = capturing()
    const read = () => seen.push(trace.map((c) => c.op).join(','))

    runAnnouncements([announce('worker-a', [1]), announce('worker-b', [2])], exec)
    read()
    runAnnouncements([announce('worker-c', [3])], exec)
    read()

    // Six calls after the first decision (deliver+stamp+emit, twice), nine
    // after the second. A reader never observes four, five, seven or eight —
    // the counts a partially-performed decision would show.
    expect(seen[0]?.split(',').length).toBe(6)
    expect(seen[1]?.split(',').length).toBe(9)
  })

  test('STRUCTURALLY: the runner contains no yield — the half a behavioural test cannot see', async () => {
    const source = await Bun.file(EXECUTORS).text()
    // Comments stripped first: this file's own prose discusses `await` and
    // promises at length, and a guard that trips on its documentation gets
    // loosened until it guards nothing (the lesson from core/boundary.test.ts).
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const body = code.slice(code.indexOf('export function runAnnouncements'))
    const runner = body.slice(0, body.indexOf('\n}\n') + 2)

    expect(runner).toContain('exec.deliver(')
    // Any of these between two effects would let another decision's read land
    // mid-run. The behavioural test above cannot distinguish that from correct
    // ordering, because a microtask resolves before the next test statement.
    expect(runner).not.toMatch(/\bawait\b|\basync\b|queueMicrotask|setTimeout|setImmediate|\.then\(/)
  })
})
