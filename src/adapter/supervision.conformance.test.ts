/**
 * Supervision executor conformance — the gap E1 shipped with and named as the
 * first thing to close (task E2, closing it).
 *
 * `runSupervision` had NO suite at all. It emits four event kinds, and the
 * failure mode it is exposed to is the quiet one: `emit` takes
 * `(type: string, data: unknown)`, so a misspelt kind, a missing field or a
 * renamed one type-checks perfectly, gets appended to the permanent log, and
 * is then IGNORED by the folds that were supposed to act on it. Nothing
 * throws. Nothing turns red. The agent simply never hears from supervision
 * again.
 *
 * ── WHAT IS HELD HERE, AND WHY EACH ONE ──
 *
 * 1. THE CENSUS. Every kind emitted is a `KnownKind` — checked by `satisfies`
 *    at compile time, because a kind outside the census resolves to nobody by
 *    construction (spec §4: a new kind declares its resolution before it can
 *    be emitted).
 *
 * 2. THE SHAPE, BOTH DIRECTIONS. Every required field of the vocabulary's
 *    data type is present, and NO field is present that the type does not
 *    declare. Both tables are derived from the types with mapped types, not
 *    hand-copied — a field added to `AgentDownData` fails this file's BUILD,
 *    which is the only way a pin like this stays true a year from now. The
 *    second direction is not decoration: this pass found `quietMinutes`
 *    riding on `worker-status`, which the census does not declare.
 *
 * 3. THE ADDRESS, THROUGH THE REAL RESOLVER. The events are handed to
 *    `resolution.resolve` — the same function the mailbox fold injects — and
 *    asked who they reach. This is the assertion that catches the silent
 *    class: `agent-probe` is addressed by reading `data.agent`, so spelling
 *    that field `subject` produces a probe that is written, folded, and
 *    delivered to NOBODY. Using the resolver as the oracle rather than
 *    restating its table is deliberate; if §4 ever re-addresses a kind, this
 *    file follows it instead of contradicting it.
 *
 * 4. THE PAIR-LAWS that apply. (a) effect order and (c) no interleaving, the
 *    same as the announcements runner. (b) has nothing to bind: there is no
 *    stamp, and as of E2 the executor type cannot express a delivery at all.
 *
 * ── WHAT IS NOT HELD HERE ──
 *
 * WHEN supervision decides to remind, probe or report — every clause of it —
 * belongs to `supervisor.conformance.test.ts` and is already green there.
 * This file only asks whether what the shell writes is what the rest of the
 * system can read. Adapter tests assert transport, wiring and executor laws;
 * never a domain rule.
 */

import { describe, expect, test } from 'bun:test'
import { resolve as resolvePath } from 'node:path'
import type { SupervisorEffect } from '../domain/contracts/supervisor.ts'
import type {
  AgentDownData,
  AgentProbeData,
  KnownKind,
  TaskReminderData,
  WorkerStatusData,
} from '../domain/contracts/vocabulary.ts'
import { resolution } from '../domain/resolution/index.ts'
import type { StoredEvent } from '../es/index.ts'
import { runSupervision, type SupervisionExecutor } from './executors.ts'

const EXECUTORS = resolvePath(import.meta.dir, 'executors.ts')
const SERVER = resolvePath(import.meta.dir, 'server.ts')

const ORCH = 'orchestrator-o'
const WORKER = 'worker-a'

type Emission = { type: string; data: Record<string, unknown> }

function capturing(): { exec: SupervisionExecutor; trace: Emission[] } {
  const trace: Emission[] = []
  return { trace, exec: { emit: (type, data) => trace.push({ type, data: data as Record<string, unknown> }) } }
}

const run = (effects: readonly SupervisorEffect[]): Emission[] => {
  const { exec, trace } = capturing()
  runSupervision(effects, exec)
  return trace
}

// ── 1. The census ────────────────────────────────────────────────

/** `satisfies` is the assertion: a kind outside the vocabulary's census does
 *  not compile here, and a kind outside the census has no declared resolution
 *  and therefore reaches nobody. */
const EMITTED_KINDS = [
  'task-reminder',
  'agent-probe',
  'agent-down',
  'worker-status',
] as const satisfies readonly KnownKind[]

// ── 2. The shape tables, derived from the vocabulary ─────────────

/** The keys a type does not allow to be absent. */
type RequiredKeys<T> = { [K in keyof T]-?: Record<string, never> extends Pick<T, K> ? never : K }[keyof T]

/** Required fields, per kind. Adding a required field to one of these
 *  vocabulary types breaks this build until the executor fills it. */
const REQUIRED: {
  'task-reminder': Record<RequiredKeys<TaskReminderData>, true>
  'agent-probe': Record<RequiredKeys<AgentProbeData>, true>
  'agent-down': Record<RequiredKeys<AgentDownData>, true>
  'worker-status': Record<RequiredKeys<WorkerStatusData>, true>
} = {
  'task-reminder': { taskId: true, to: true, text: true },
  'agent-probe': { agent: true, quietMinutes: true, text: true },
  'agent-down': { subject: true, quietMinutes: true, text: true },
  'worker-status': { agent: true, status: true, text: true },
}

/** Every field the type declares, required or optional. Anything emitted
 *  outside this set is a field the census does not know about. */
const DECLARED: {
  'task-reminder': Record<keyof TaskReminderData, true>
  'agent-probe': Record<keyof AgentProbeData, true>
  'agent-down': Record<keyof AgentDownData, true>
  'worker-status': Record<keyof WorkerStatusData, true>
} = {
  'task-reminder': { taskId: true, to: true, text: true, queued: true },
  'agent-probe': { agent: true, quietMinutes: true, text: true, queued: true },
  'agent-down': { subject: true, to: true, quietMinutes: true, text: true, queued: true },
  'worker-status': { agent: true, status: true, text: true, queued: true },
}

const REMIND: SupervisorEffect = { kind: 'remind', taskId: '042', to: ORCH, blockedOn: 'human', ageMs: 3 * 60_000 }
const PROBE: SupervisorEffect = { kind: 'probe', agent: WORKER, quietMs: 45 * 60_000 }
const DOWN: SupervisorEffect = {
  kind: 'report',
  to: ORCH,
  subject: WORKER,
  status: 'down',
  quietMs: 90 * 60_000,
}
const STUCK: SupervisorEffect = { ...DOWN, status: 'up-but-stuck' } as SupervisorEffect
const RECOVERED: SupervisorEffect = { ...DOWN, status: 'recovered' } as SupervisorEffect

const ALL = [REMIND, PROBE, DOWN, STUCK, RECOVERED]

describe('the shape of what supervision writes', () => {
  test('every emitted kind is in the census — nothing is invented at the emit site', () => {
    const kinds = run(ALL).map((e) => e.type)
    expect(kinds.length).toBe(5)
    for (const kind of kinds) expect(EMITTED_KINDS as readonly string[]).toContain(kind)
  })

  test('every REQUIRED field of the vocabulary’s data type is present and defined', () => {
    let checked = 0
    for (const emission of run(ALL)) {
      const required = REQUIRED[emission.type as keyof typeof REQUIRED]
      expect(required).toBeDefined()
      for (const field of Object.keys(required)) {
        expect(emission.data[field], `${emission.type}.${field}`).toBeDefined()
        checked++
      }
    }
    expect(checked).toBe(15) // anti-vacuity: three required fields on each of five emissions
  })

  test('NO field is emitted that the census does not declare', () => {
    for (const emission of run(ALL)) {
      const declared = DECLARED[emission.type as keyof typeof DECLARED]
      for (const field of Object.keys(emission.data)) {
        // A field outside the declared shape is not harmless: it reads as
        // meaningful to a human scanning the log and means nothing to any
        // fold. `worker-status` carried a `quietMinutes` this way until E2.
        expect(Object.hasOwn(declared, field), `${emission.type} emitted undeclared field "${field}"`).toBe(true)
      }
    }
  })

  test('the three report statuses map onto the TWO kinds the vocabulary has for them', () => {
    expect(run([DOWN])[0]?.type).toBe('agent-down')
    expect(run([STUCK])[0]?.type).toBe('worker-status')
    expect(run([RECOVERED])[0]?.type).toBe('worker-status')
    // And each fills ITS OWN shape — the two are not interchangeable.
    expect(run([DOWN])[0]?.data.subject).toBe(WORKER)
    expect(run([STUCK])[0]?.data.agent).toBe(WORKER)
    expect(run([STUCK])[0]?.data.status).toBe('up-but-stuck')
  })

  test('R13: an unmeasurable silence never becomes NaN in a fact', () => {
    // NaN reads LOUD downstream — it fails every comparison, so a consumer
    // finds no bound satisfied and acts on every tick.
    const emitted = run([{ kind: 'probe', agent: WORKER, quietMs: Number.NaN }])
    expect(Number.isNaN(emitted[0]?.data.quietMinutes)).toBe(false)
    expect(typeof emitted[0]?.data.quietMinutes).toBe('number')
  })
})

// ── 3. The address, through the real resolver ────────────────────

/** The emission as it would sit in the log, so the real resolver can read it.
 *  `stream` is the one the shell would use; none of these kinds resolve by
 *  stream, which is itself worth having written down. */
const asEvent = (emission: Emission, stream: string): StoredEvent => ({
  id: 1,
  ts: new Date(0).toISOString(),
  stream,
  type: emission.type,
  data: emission.data,
})

const recipientsOf = (emission: Emission, stream = 'system') =>
  resolution.resolve(asEvent(emission, stream), { orchestrator: ORCH, subscribersOf: () => [] })

describe('who these events actually reach — the resolver as the oracle', () => {
  test('THE PROBE REACHES ITS SUBJECT — the one field name that can fail in silence', () => {
    const emission = run([PROBE])[0]
    if (emission === undefined) throw new Error('unreachable')
    // §4 addresses a probe by reading `data.agent`. Spelling it `subject`
    // here would produce an event that is written, folded and delivered to
    // nobody, with nothing failing anywhere — which is why this assertion
    // goes through `resolve` rather than reading the field back.
    expect(recipientsOf(emission, `agent-${WORKER}`)).toEqual([WORKER])
  })

  test('reminders and reports reach the orchestrator', () => {
    expect(recipientsOf(run([REMIND])[0] as Emission, 'task-042')).toEqual([ORCH])
    expect(recipientsOf(run([DOWN])[0] as Emission)).toEqual([ORCH])
    expect(recipientsOf(run([STUCK])[0] as Emission)).toEqual([ORCH])
    expect(recipientsOf(run([RECOVERED])[0] as Emission)).toEqual([ORCH])
  })

  test('every emission reaches SOMEBODY — no supervision event is written into the void', () => {
    // The generic version of the two tests above, and the one that would
    // catch a fifth effect kind added without its addressing thought through.
    const streams = ['task-042', `agent-${WORKER}`, 'system', 'system', 'system']
    run(ALL).forEach((emission, i) => {
      expect(recipientsOf(emission, streams[i] as string).length, `${emission.type} reached nobody`).toBeGreaterThan(0)
    })
  })
})

// ── 4. The pair-laws that apply ──────────────────────────────────

describe('pair-laws over supervision', () => {
  test('law (a): one decision’s effects are emitted in the order listed, one event each', () => {
    const trace = run(ALL)
    // ONE EVENT, NOT A PAIR — the liveness block's clause, held at the write
    // site: a general record plus a follow-up would reintroduce the
    // forgot-to-route hazard one level up.
    expect(trace.length).toBe(ALL.length)
    expect(trace.map((e) => e.type)).toEqual([
      'task-reminder',
      'agent-probe',
      'agent-down',
      'worker-status',
      'worker-status',
    ])
  })

  test('law (c): the runner contains no yield, so no reader lands mid-decision', async () => {
    const source = await Bun.file(EXECUTORS).text()
    // Comments stripped first — this file's and that file's prose both
    // discuss `await` at length, and a guard that trips on its own
    // documentation gets loosened until it guards nothing.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const body = code.slice(code.indexOf('export function runSupervision'))
    const runner = body.slice(0, body.indexOf('\n}\n') + 2)

    expect(runner).toContain('exec.emit(')
    expect(runner).not.toMatch(/\bawait\b|\basync\b|queueMicrotask|setTimeout|setImmediate|\.then\(/)
  })

  test('law (b) has nothing to bind: the executor cannot deliver, structurally', async () => {
    // Not a stylistic note. These events are ADDRESSED MAIL and reach their
    // subjects through the ordinary resolution path; a shell that also handed
    // them to a transport here would deliver each of them twice. E1's type
    // carried a `deliver` that nothing called — a weld waiting to be made —
    // and E2 removed it, so the double delivery is now unsayable rather than
    // merely unwritten.
    const source = await Bun.file(EXECUTORS).text()
    const decl = source.slice(source.indexOf('export type SupervisionExecutor'))
    const shape = decl.slice(0, decl.indexOf('}') + 1)
    expect(shape).toContain('emit')
    expect(shape).not.toContain('deliver')
  })
})

/**
 * The supervisor's view is COMPOSED, never re-derived (task 115).
 *
 * This is the seam the probe loop actually shipped from. `supervisionView`
 * held its own status filter, inherited from a query written for a different
 * consumer, and every parked task's holder rode the stuck clock for it. The
 * domain now states the predicate once and the composer reads it — but a
 * composer that reads the WRONG field, or quietly grows its own filter back,
 * is invisible to every behavioural test in this suite: measured during the
 * fix round, rewiring `engaged` to `holdsUndone` right here left the adapter
 * suite at 141 pass / 0 fail.
 *
 * So the pin is structural, for the same reason task 074's welds are: the
 * break that matters does not change what any reachable adapter test
 * observes. It asserts WIRING — that these facts arrive from the domain's
 * named predicate — and never what the predicate should answer, which is the
 * domain's own conformance and is pinned there.
 */
describe('the supervisor view composes its held-work facts', () => {
  const bodyOf = async () => {
    const source = await Bun.file(SERVER).text()
    const start = source.indexOf('function supervisionView(')
    expect(start, 'anchor lost: supervisionView is no longer a function declaration in server.ts').toBeGreaterThan(-1)
    // COMMENTS STRIPPED FIRST. The prose here explains the defect and names
    // the statuses to do it, so a guard reading the raw text fails on its own
    // documentation — measured, on the first form of this test. What is being
    // asserted is what the composer DOES.
    const body = source
      .slice(start, source.indexOf('\n  }\n', start))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
    // THE ANCHOR PROVES ITSELF. A slice that silently caught the wrong span
    // would make every assertion below vacuous — the failure mode this
    // dojo has recorded twice — so the landmarks of both arms are checked
    // before anything is concluded from the text.
    expect(body, 'the extracted span is not the two-armed view').toContain('connected: true')
    expect(body).toContain('connected: false')
    return body
  }

  test('both arms read the facts from the domain predicate, by name', async () => {
    const body = await bodyOf()
    // COUNTED, NOT MERELY PRESENT — one per arm. `toContain` was the first
    // form here and it was vacuous: the disconnected arm's correct line
    // satisfied it while the live arm was rewired to the wrong field, which
    // is the very break this guard exists for. Measured, not reasoned about.
    expect(body.match(/tasks\.supervisionLoadOf\(/g)?.length).toBe(2)
    expect(body.match(/engaged: load\.engaged/g)?.length).toBe(2)
    expect(body.match(/holdsUndone: load\.holdsUndone/g)?.length).toBe(2)
  })

  test('the composer names no task status at all — there is nothing here to re-derive', async () => {
    const body = await bodyOf()
    // Deliberately every status, not just `waiting`: the defect was not one
    // wrong member, it was a second copy of the rule living at the seam.
    // Every quoting form, because the single-quoted one is only the shape
    // the formatter happens to produce today.
    expect(body).not.toMatch(/['"`](todo|assigned|in-progress|waiting|done|cancelled)['"`]/)
    // WHAT THIS CANNOT CATCH, stated rather than implied: a filter built
    // from an imported constant or a locally named set mentions no status
    // and passes here. It is caught one test up instead — a re-derivation
    // has to stop reading `load`, and those reads are counted per arm.
  })
})
