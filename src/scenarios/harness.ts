/**
 * Shared fixtures for the scenario suite (task 044; harness inventory =
 * task 043 part 2).
 *
 * NOT A TEST FILE — `bun test src/scenarios` ignores it. It holds the two things
 * every scenario file would otherwise re-invent: an event builder with monotonic
 * ids, and a recording executor.
 *
 * ── WHY THE RECORDER RECORDS STRINGS ──
 *
 * Every core scenario's assertion is about WHO was pushed, HOW MANY TIMES, and
 * IN WHAT ORDER. A flat `string[]` compares with `toEqual` and prints legibly
 * when it fails, which matters more here than in most suites: these tests are
 * meant to be read red, repeatedly, by someone deciding what to build next.
 *
 * Emissions are recorded but deliberately NOT type-constrained — the transition
 * has not chosen its event names, and pinning them here would make the suite
 * demand an implementation instead of a requirement. See
 * `src/infra/target/attention.ts`, "WHY `emit` IS LOOSELY TYPED".
 */

import type { StoredEvent } from '../es/index.ts'
import type { PendingEntry, TargetAttentionView, TargetExecutor } from '../infra/target/attention.ts'
import type { SupervisedAgent, SupervisedTask, TargetSupervisionView } from '../infra/target/supervision.ts'

let nextId = 0

/** Monotonic ids, because log ORDER is semantics in most of these assertions.
 *  Shared across a file's cases on purpose: ids stay globally distinct, so a
 *  case can never accidentally assert about another case's event. */
export function ev(type: string, stream: string, data: Record<string, unknown> = {}, ts?: string): StoredEvent {
  nextId += 1
  return { id: nextId, stream, type, ts: ts ?? '2026-08-05T00:00:00.000Z', data }
}

/**
 * An event with a CHOSEN id.
 *
 * The core scenarios pass both an event and a mailbox to a decision, and the
 * decision asks whether THIS event is in THAT mailbox (race guard 2, by id). So
 * the two have to agree, and an auto-assigned id would silently not — the
 * arrival dispatch would be skipped and the test would pass or fail for a reason
 * that has nothing to do with its scenario.
 */
export function eventWithId(
  id: number,
  type = 'reply',
  stream = 'agent-builder',
  data: Record<string, unknown> = { agent: 'builder' },
): StoredEvent {
  return { id, stream, type, ts: new Date(T0).toISOString(), data }
}

/** A human message on the bridge — the blocking, highest-priority shape. */
export const humanSays = (from = 'chat-human', text = 'is it done?') =>
  ev('reply', `agent-${from}`, { agent: from, text })

/** A worker's reply — machine-shaped. */
export const workerSays = (from = 'builder', text = 'progress') => ev('reply', `agent-${from}`, { agent: from, text })

/** Fold a log with a reducer, exactly as a projection does. */
export function foldWith<S>(reducer: (s: S, e: StoredEvent) => S, initial: S, log: readonly StoredEvent[]): S {
  return log.reduce(reducer, initial)
}

export type Recorder = {
  exec: TargetExecutor
  /** `deliver→<agent>` per push, in order. */
  trace: string[]
  /** Full text of each push, index-aligned with the `deliver→` entries. */
  texts: string[]
  /** `<type>` per appended event, in order. */
  emitted: { type: string; data: Record<string, unknown> }[]
  /** Flip the transport mid-sequence — a socket dying, or reconnecting. */
  setLanding: (v: boolean) => void
  /** Clear the trace and return how many entries were dropped. */
  drain: () => number
}

export function recorder(lands = true): Recorder {
  const trace: string[] = []
  const texts: string[] = []
  const emitted: { type: string; data: Record<string, unknown> }[] = []
  let landing = lands
  return {
    trace,
    texts,
    emitted,
    setLanding: (v) => {
      landing = v
    },
    drain: () => trace.splice(0).length,
    exec: {
      deliver: (to, text) => {
        trace.push(`deliver→${to}`)
        texts.push(text)
        return landing
      },
      emit: (type, data) => void emitted.push({ type, data }),
      stamp: (via) => void trace.push(`stamp:${via}`),
    },
  }
}

/** Pushes only — the count most scenarios turn on. */
export const deliveries = (r: Recorder): number => r.trace.filter((t) => t.startsWith('deliver→')).length

/** Who each push went to, in order. */
export const recipients = (r: Recorder): string[] =>
  r.trace.filter((t) => t.startsWith('deliver→')).map((t) => t.slice('deliver→'.length))

// ── Clock helpers ────────────────────────────────────────────────
//
// `now` is data everywhere in this suite, so a wait is arithmetic rather than
// wall time. Named so the assertions read as the scenarios do.

export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** T0 for every scenario. A fixed instant, never `Date.now()` — these tests must
 *  give the same answer in a year. */
export const T0 = Date.parse('2026-08-05T00:00:00.000Z')

// ── The delivery dials ───────────────────────────────────────────
//
// Named, not indexed. Several assertions turn on WHICH rung applies, and the
// live suite already learned that the hard way: "the second nudge waits the
// second rung, not the first — a mistake this test caught in its own first
// draft" (core/attention.test.ts).

/** S2's interval: how long an agent may stay uninformed of a new event,
 *  measured from its LAST ACTIVITY. */
export const INTERVAL = 5 * MINUTE
/** Repeats for a queue that stays unhandled (ruling (a): the ladder survives). */
export const RUNG_1 = 2 * MINUTE
export const RUNG_2 = 10 * MINUTE
export const RUNG_3 = 30 * MINUTE
export const LADDER = [RUNG_1, RUNG_2, RUNG_3]
/** The surviving watchdog-shaped backstop for a very long wait. */
export const LONG_WAIT = 2 * HOUR

/** The slice of the world a target view is built from. The adapter reads this
 *  off the registry and the pending list; here it is just data. */
export type World = {
  now: number
  agent: string | null
  /** Defaults to "there is an owner". */
  deliverable?: boolean
  /** S2's clock. Canon E5: messaging-system events only. */
  lastActivityAt: number
  /** S3's dial. Defaults to 1 — everything gets pushed unless a case says
   *  otherwise. */
  threshold?: number
  /** Mailbox as (id, priority) pairs, or full entries when `from` matters. */
  pending: ([id: number, priority: number] | PendingEntry)[]
}

// ── The supervision dials (S7, S8, S10, S11) ─────────────────────

/** How long a silent worker has before a reminder (S10). */
export const REMINDER_AFTER = 30 * MINUTE
/** "Within bounded time" (S11) — the bound. */
export const BROKEN_AFTER = 4 * HOUR

export const SENSEI = 'sensei'
export const BRIDGE = 'chat-human'

export type SupervisionWorld = {
  now: number
  /** Defaults to `SENSEI`. Null models a dojo where none has registered. */
  sensei?: string | null
  /** Defaults to `BRIDGE`. NULL is the case O3 rules on. */
  bridge?: string | null
  /** Defaults to "everyone named is reachable". */
  deliverable?: string[]
  tasks?: SupervisedTask[]
  agents?: SupervisedAgent[]
  reminderAfterMs?: number
  brokenAfterMs?: number
}

export function supervisionView(w: SupervisionWorld): TargetSupervisionView {
  const sensei = w.sensei === undefined ? SENSEI : w.sensei
  const bridge = w.bridge === undefined ? BRIDGE : w.bridge
  const tasks = w.tasks ?? []
  const agents = w.agents ?? []
  const everyone = [
    sensei,
    bridge,
    ...tasks.map((t) => t.holder),
    ...tasks.map((t) => t.agent),
    ...agents.map((a) => a.name),
  ]
  return {
    now: w.now,
    sensei,
    bridge,
    deliverable: w.deliverable ?? [...new Set(everyone.filter((n): n is string => typeof n === 'string'))],
    tasks,
    agents,
    reminderAfterMs: w.reminderAfterMs ?? REMINDER_AFTER,
    brokenAfterMs: w.brokenAfterMs ?? BROKEN_AFTER,
  }
}

export function targetView(w: World): TargetAttentionView {
  return {
    now: w.now,
    agent: w.agent,
    deliverable: w.deliverable ?? w.agent !== null,
    lastActivityAt: w.lastActivityAt,
    threshold: w.threshold ?? 1,
    pending: w.pending.map((p) => (Array.isArray(p) ? { id: p[0], priority: p[1], from: 'someone' } : p)),
    nudgeIntervalMs: INTERVAL,
    nudgeBackoffMs: LADDER,
    longWaitMs: LONG_WAIT,
  }
}
