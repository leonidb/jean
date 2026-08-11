/**
 * SCENARIO 9 — PARKED WORK STAYS VISIBLE (the CONTENT half).
 * LEVEL: projection (board state + a clock in → lines out; pure).
 *
 * CANON (S9, verbatim): "Parked work stays visible. Externally-blocked tasks
 * appear as a daily one-line list with per-item age. They never interrupt and
 * never silently vanish."
 *
 * The DELIVERY half — that it arrives on a schedule and never interrupts — is
 * `s09-digest.wiring.test.ts`.
 *
 * STATUS: RED — `buildDigest` and `isParked` throw.
 *
 * ── 042's DEVIATION-5: THIS SCENARIO HAD NO OWNING COMMIT AT ALL ──
 *
 * The mechanism was settled (O1: calendar-like schedules ride the regular
 * trigger scheduler) and then the six-commit order simply contained no entry for
 * it — "neither a reminder ladder nor a view: it is a scheduled digest. A
 * settled mechanism with no owner is exactly how a scenario silently doesn't get
 * built."
 *
 * ── ONE INTERPRETATION, RAISED RATHER THAN TAKEN SILENTLY ──
 *
 * "Externally-blocked" is not defined against S7's four `blockedOn` values. The
 * reading encoded in `isParked` is the three the dojo cannot act on itself
 * (`human`, `external`, `time`), excluding `sensei` because the S7/S8 nag ladder
 * already covers those and a task would otherwise be both nagged daily and
 * digested daily. It is behind one predicate so a different ruling moves one
 * case. **Flagged on task 044's board comment.**
 */

import { describe, expect, test } from 'bun:test'
import type { TargetBoard, TargetTask } from '../infra/target/blocked.ts'
import { buildDigest, isParked } from '../infra/target/digest.ts'
import { DAY, HOUR, T0 } from './harness.ts'

function task(id: string, over: Partial<TargetTask> = {}): TargetTask {
  return {
    id,
    title: `task ${id}`,
    description: '',
    status: 'waiting',
    queue: 'builder',
    createdAt: new Date(T0 - 30 * DAY).toISOString(),
    updatedAt: new Date(T0).toISOString(),
    ...over,
  }
}

const parked = (id: string, blockedOn: TargetTask['blockedOn'], sinceMs: number) =>
  task(id, { blockedOn, blockedSince: new Date(T0 - sinceMs).toISOString() })

const boardOf = (...tasks: TargetTask[]): TargetBoard => ({ tasks })

describe('S9 — one line per parked task, each carrying its age', () => {
  test('every parked task gets exactly one line', () => {
    const b = boardOf(parked('001', 'human', 2 * DAY), parked('002', 'external', 3 * HOUR), parked('003', 'time', DAY))
    const lines = buildDigest(b, T0)
    expect(lines).toHaveLength(3)
    for (const id of ['001', '002', '003']) {
      expect(lines.filter((l) => l.includes(id))).toHaveLength(1)
    }
  })

  test('each line carries an age', () => {
    // The format is a dial; the PRESENCE of an age is the requirement. A list
    // without ages reads identically on day 1 and day 30, which is the state
    // S9 exists to make visible.
    const lines = buildDigest(boardOf(parked('001', 'human', 5 * DAY)), T0)
    expect(lines[0]).toMatch(/\d/)
    expect(lines[0]).toMatch(/\d+\s*(s|m|h|d|sec|min|hour|day)/i)
  })

  test('the age GROWS — the same task reads differently a month later', () => {
    // The assertion that a hard-coded or creation-time age fails.
    const b = boardOf(parked('001', 'human', HOUR))
    expect(buildDigest(b, T0)[0]).not.toBe(buildDigest(b, T0 + 30 * DAY)[0])
  })

  test('a line names the task well enough to act on it', () => {
    const lines = buildDigest(boardOf(parked('001', 'human', DAY)), T0)
    expect(lines[0]).toContain('001')
    expect(lines[0]).toContain('task 001')
  })
})

describe('S9 — never silently vanishes', () => {
  test('a task parked for three months is still on the list', () => {
    // The failure mode this forbids is the quiet one: an "old enough to hide"
    // rule would make exactly the most-forgotten work the least visible.
    const lines = buildDigest(boardOf(parked('001', 'external', 90 * DAY)), T0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('001')
  })

  test('a long list is not truncated — forty parked tasks produce forty lines', () => {
    // "One line each" plus a "… and 23 more" tail would satisfy the letter of
    // the requirement and violate its point.
    const many = Array.from({ length: 40 }, (_, i) => parked(String(i).padStart(3, '0'), 'external', (i + 1) * HOUR))
    const lines = buildDigest(boardOf(...many), T0)
    expect(lines).toHaveLength(40)
    expect(lines.join('\n')).not.toMatch(/\d+ more|truncat|…$/m)
  })

  test('the list is stable day over day — same parked set, same lines modulo age', () => {
    // A digest whose membership churns is one nobody can scan. Only the ages
    // move.
    const b = boardOf(parked('001', 'human', DAY), parked('002', 'external', 2 * DAY))
    const today = buildDigest(b, T0)
    const tomorrow = buildDigest(b, T0 + DAY)
    expect(tomorrow).toHaveLength(today.length)
    expect(tomorrow.map((l) => l.match(/\d{3}/)?.[0])).toEqual(today.map((l) => l.match(/\d{3}/)?.[0]))
  })

  test('an empty board produces an empty list, not a placeholder', () => {
    // Nothing parked is not news. A "nothing to report" line arriving daily is
    // an interruption with a friendly face.
    expect(buildDigest(boardOf(), T0)).toEqual([])
    expect(buildDigest(boardOf(task('001', { status: 'in-progress' })), T0)).toEqual([])
  })
})

describe('S9 — membership', () => {
  test('active and finished tasks are not on the list', () => {
    const b = boardOf(
      task('001', { status: 'in-progress' }),
      task('002', { status: 'done' }),
      task('003', { status: 'todo' }),
      parked('004', 'human', DAY),
    )
    const lines = buildDigest(b, T0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('004')
  })

  test('RULED (H3, 2026-08-11) — membership: human and external always; sensei-held never', () => {
    // Was "INTERPRETATION (flagged, not canon)". The flag did its job: H3's
    // ruling confirmed the sensei exclusion (C5) and settled the rest —
    // "Parked = any task whose blockedOn is human or external", with `time`
    // governed by its resume date (the describe block below).
    expect(isParked(parked('001', 'human', DAY), T0)).toBe(true)
    expect(isParked(parked('002', 'external', DAY), T0)).toBe(true)
    expect(isParked(parked('004', 'sensei', DAY), T0)).toBe(false)
    expect(isParked(task('005', { status: 'in-progress' }), T0)).toBe(false)
  })

  test('the digest is exactly the tasks isParked admits — no second rule', () => {
    // Same shape as the mailbox contract: one predicate, and the renderer does
    // not get its own opinion on membership.
    const all = [
      parked('001', 'human', DAY),
      parked('002', 'sensei', DAY),
      parked('003', 'external', DAY),
      task('004', { status: 'done' }),
    ]
    const lines = buildDigest(boardOf(...all), T0)
    expect(lines).toHaveLength(all.filter((t) => isParked(t, T0)).length)
    for (const t of all.filter((t) => isParked(t, T0))) expect(lines.some((l) => l.includes(t.id))).toBe(true)
  })
})

describe('S9 — H3 (ruled 2026-08-11): the resume date is the wake', () => {
  // CANON, the amended sentence verbatim: "A time-parked task carries its
  // resume date; it stays out of the digest until that date and surfaces in it
  // from then on — the date is the wake, a trigger is optional precision."
  //
  // How the ruling got here matters for reading these cases: (1) Leonid cut
  // `time` from unconditional membership — a daily line about a September task
  // until September is spam, scheduled work is decided once; (2) the overdue
  // valve required recording the resume date on the task; (3) WITH the date,
  // the required trigger dissolved — the digest cycle itself is the wake, at
  // daily granularity. Exact day-boundary granularity is deliberately the
  // implementation's ("up to the digest") — these cases test comfortably
  // either side of the date, never the boundary minute.
  const timePark = (id: string, resumeAt?: string) =>
    task(id, {
      blockedOn: 'time',
      blockedSince: new Date(T0 - DAY).toISOString(),
      ...(resumeAt !== undefined && { resumeAt }),
    })

  test('a time-parked task with a FUTURE resume date stays out of the digest', () => {
    const september = timePark('001', new Date(T0 + 30 * DAY).toISOString())
    expect(isParked(september, T0)).toBe(false)
    expect(buildDigest(boardOf(september), T0)).toEqual([])
  })

  test('from its resume date onward it surfaces — and never drops off again', () => {
    // "Surfaces in it from then on": the date is a wake, not a one-shot ping.
    // A task that appeared on resume day and vanished on day two would be the
    // silent-vanish S9 exists to forbid, arriving through the new field.
    const due = timePark('001', new Date(T0 + 2 * DAY).toISOString())
    expect(buildDigest(boardOf(due), T0 + 2 * DAY + HOUR).some((l) => l.includes('001'))).toBe(true)
    expect(buildDigest(boardOf(due), T0 + 40 * DAY).some((l) => l.includes('001'))).toBe(true)
  })

  test('a time-park with NO resume date is visible immediately — never-silently-vanishes wins', () => {
    // The date is what earns the silence. A time-park that recorded no wake
    // has no discovery-by-consequence path, so hiding it would be exactly the
    // vanish the scenario forbids; showing it daily is the safe direction.
    const undated = timePark('001')
    expect(isParked(undated, T0)).toBe(true)
    expect(buildDigest(boardOf(undated), T0).some((l) => l.includes('001'))).toBe(true)
  })
})
