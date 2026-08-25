/**
 * Resolution conformance — the executable form of spec §4's table.
 *
 * RED BY ABSENCE until D1 lands: this suite imports the implementation at
 * `src/domain/resolution/index.ts`, which does not exist yet, and no stub
 * with a plausible body may exist anywhere (that is `target/`'s failure mode,
 * refused by plan). The builder implementing D1 makes this file load and its
 * assertions pass — nothing else is allowed to.
 *
 * Written from the spec and the design only (design §8). Fixture agents use
 * distinct names throughout so no assertion can pass by coincidence (§5).
 */

import { describe, expect, test } from 'bun:test'
import { counted, createClock, createLog } from '../fixture/index.ts'
import type { ResolutionContext, ResolutionContract } from './resolution.ts'

// Dynamic import through a widened string, deliberately: a static import of a
// module that does not exist yet would turn red-by-absence into a COMPILE
// error for the whole repo (`bun run check` breaks for every other task).
// Red-by-absence is a runtime fact: this file loads, and fails loudly, until
// D1 creates the implementation. The cast keeps the suite typed against the
// contract — the implementation is still structurally checked when it lands.
const IMPL_PATH: string = '../resolution/index.ts'
const resolution: ResolutionContract = await import(IMPL_PATH)
  .then((m) => (m as { resolution: ResolutionContract }).resolution)
  .catch((err: unknown) => {
    // Only ABSENCE maps to the red-by-absence message. Once the module
    // exists, a load error inside it must surface as itself — masking it as
    // absence would misdiagnose every broken implementation (codex pass).
    if (String(err).includes('Cannot find module')) {
      throw new Error(
        'RED BY ABSENCE — src/domain/resolution/index.ts does not exist yet. ' +
          'Task D1 implements the ResolutionContract; nothing else may (no plausible stubs — design §9).',
      )
    }
    throw err
  })

/** Distinct names everywhere — §5's non-coincidence discipline. */
const ORCH = 'orchestrator-o'
const WORKER_A = 'worker-a'
const WORKER_B = 'worker-b'
const HUMAN = 'human-h'

const ctx: ResolutionContext = {
  orchestrator: ORCH,
  // The subscriber sets — "involved", defined (A-SUB). Task 101 carries the
  // automatic pair; task 202 carries a third, explicit subscriber, which is
  // the case the pre-subscriber implementation cannot answer.
  subscribersOf: (taskId) => (taskId === '101' ? [WORKER_A, ORCH] : taskId === '202' ? [WORKER_A, ORCH, WORKER_B] : []),
}

/** ctx for a dojo with no orchestrator on record — the between-boot state
 *  that must resolve EMPTY, never to a fallback (P4: no orphan mailboxes). */
const noOrchCtx: ResolutionContext = { ...ctx, orchestrator: undefined }

function build() {
  return createLog(createClock())
}

describe('spec §4 — message kinds', () => {
  test('send to a named agent → that agent, and only that agent', () => {
    const log = build()
    const e = log.append('send', `agent-${WORKER_A}`, { agent: WORKER_A, from: ORCH, text: 'dispatch', queued: true })
    expect(resolution.resolve(e, ctx)).toEqual([WORKER_A])
  })

  test('worker reply → orchestrator', () => {
    const log = build()
    const e = log.append('reply', 'task-101', { agent: WORKER_A, text: 'done' })
    expect(resolution.resolve(e, ctx)).toEqual([ORCH])
  })

  test('reply resolution is STREAM-INDEPENDENT (task 116): tagged or untagged, a reply reaches the orchestrator and nobody else', () => {
    // The 116 ruling removes the write-site's task-filing inference. This
    // pin is the VERIFIED consequence the ruling relied on: the stream a
    // reply records to changes its /history filing, never its delivery —
    // `reply` resolves by KIND, and a task-filed reply does NOT consult
    // the task's subscribers.
    const log = build()
    const onAgent = log.append('reply', `agent-${WORKER_A}`, { agent: WORKER_A, text: 'untagged' })
    const onTask = log.append('reply', 'task-202', { agent: WORKER_A, text: 'tagged' }) // task 202 has THREE subscribers
    expect(resolution.resolve(onAgent, ctx)).toEqual([ORCH])
    expect(resolution.resolve(onTask, ctx)).toEqual([ORCH]) // never the subscriber set
  })

  test('human message → orchestrator', () => {
    const log = build()
    const e = log.append('reply', 'system', { agent: HUMAN, text: 'how is it going?' })
    expect(resolution.resolve(e, ctx)).toEqual([ORCH])
  })

  test("the orchestrator's own send never lands in its own mailbox (author exclusion)", () => {
    const log = build()
    const e = log.append('send', `agent-${WORKER_B}`, { agent: WORKER_B, from: ORCH, text: 'go', queued: true })
    const recipients = resolution.resolve(e, ctx)
    expect(recipients).not.toContain(ORCH)
    expect(resolution.authorOf(e)).toBe(ORCH)
  })

  test('a send whose author IS the addressee resolves empty — exclusion must actually subtract (079 report, case 3)', () => {
    const log = build()
    const e = log.append('send', `agent-${WORKER_A}`, {
      agent: WORKER_A,
      from: WORKER_A,
      text: 'note to self',
      queued: true,
    })
    expect(resolution.resolve(e, ctx)).toEqual([])
  })
})

describe('spec §4 — the task row: everyone involved, minus the author', () => {
  test('task created by the orchestrator, queued to a worker → the worker', () => {
    const log = build()
    const e = log.append('task-created', 'task-101', {
      title: 't',
      description: '',
      queue: WORKER_A,
      actor: ORCH,
    })
    expect(resolution.resolve(e, { ...ctx, subscribersOf: () => [WORKER_A, ORCH] })).toEqual([WORKER_A])
  })

  test('task created UNASSIGNED by the orchestrator → nobody; it is history (spec §4, verbatim case)', () => {
    const log = build()
    const e = log.append('task-created', 'task-999', {
      title: 'unassigned',
      description: '',
      queue: 'someday',
      actor: ORCH,
    })
    expect(resolution.resolve(e, { ...ctx, subscribersOf: () => [ORCH] })).toEqual([]) // only party = author → history
  })

  test("a worker's comment on its task → the orchestrator (the author is excluded, not the other party)", () => {
    const log = build()
    const e = log.append('task-comment', 'task-101', { agent: WORKER_A, role: 'worker', text: 'finding' })
    expect(resolution.resolve(e, ctx)).toEqual([ORCH])
  })

  test("the orchestrator's comment on a worker's task → the worker", () => {
    const log = build()
    const e = log.append('task-comment', 'task-101', { agent: ORCH, role: 'sensei', text: 'guidance' })
    expect(resolution.resolve(e, ctx)).toEqual([WORKER_A])
  })

  test('a THIRD agent commenting on the task → both involved parties (the §5 multi-recipient case)', () => {
    const log = build()
    const e = log.append('task-comment', 'task-101', { agent: WORKER_B, role: 'worker', text: 'drive-by finding' })
    const recipients = [...resolution.resolve(e, ctx)].sort()
    expect(recipients).toEqual([ORCH, WORKER_A].sort())
  })

  test('A-SUB, the discriminating case: a THIRD SUBSCRIBER (neither owner nor orchestrator) receives the task event — "involved" is the subscriber set', () => {
    // RED against the pre-subscriber implementation (which reads taskOwner);
    // the subscriber D-side turns it green by consulting subscribersOf.
    const log = build()
    const e = log.append('task-comment', 'task-202', { agent: ORCH, role: 'sensei', text: 'update for the room' })
    const recipients = [...resolution.resolve(e, ctx)].sort()
    expect(recipients).toEqual([WORKER_A, WORKER_B].sort()) // both non-author subscribers; the author excluded
  })

  test('A-SUB: the subscriber kinds are history — a subscription event is a routing-rule change, not mail', () => {
    const log = build()
    const sub = log.append('task-subscribed', 'task-101', { agent: WORKER_B, actor: WORKER_B })
    const unsub = log.append('task-unsubscribed', 'task-101', { agent: WORKER_B, actor: WORKER_B })
    expect(resolution.resolve(sub, ctx)).toEqual([])
    expect(resolution.resolve(unsub, ctx)).toEqual([])
  })

  test('the orchestrator owning the task appears ONCE — one recipient is one pair, never two (079 report, case 1)', () => {
    const log = build()
    const e = log.append('task-comment', 'task-500', { agent: WORKER_B, role: 'worker', text: 'finding' })
    const recipients = resolution.resolve(e, {
      orchestrator: ORCH,
      subscribersOf: () => [ORCH],
    })
    expect(recipients).toEqual([ORCH])
  })

  test('task status change by the worker → the orchestrator, and vice versa', () => {
    const log = build()
    const byWorker = log.append('task-status', 'task-101', { from: 'in-progress', to: 'done', actor: WORKER_A })
    const byOrch = log.append('task-status', 'task-101', { from: 'todo', to: 'assigned', actor: ORCH })
    expect(resolution.resolve(byWorker, ctx)).toEqual([ORCH])
    expect(resolution.resolve(byOrch, ctx)).toEqual([WORKER_A])
  })

  test('the whole task family resolves as the row: task-updated, task-reverted, and historical task-blocked', () => {
    const log = build()
    const updated = log.append('task-updated', 'task-101', { description: 'refined', actor: ORCH })
    const reverted = log.append('task-reverted', 'task-101', { from: 'done', to: 'in-progress', actor: WORKER_A })
    const blocked = log.append('task-blocked', 'task-101', { blockedOn: 'human', actor: WORKER_A })
    expect(resolution.resolve(updated, ctx)).toEqual([WORKER_A])
    expect(resolution.resolve(reverted, ctx)).toEqual([ORCH])
    expect(resolution.resolve(blocked, ctx)).toEqual([ORCH])
  })
})

describe('spec §4 — supervision and liveness kinds', () => {
  test('task-reminder → orchestrator', () => {
    const log = build()
    const e = log.append('task-reminder', 'system', { taskId: '101', to: ORCH, text: 'still parked', queued: true })
    expect(resolution.resolve(e, ctx)).toEqual([ORCH])
  })

  test('idle-liveness ping (agent-probe) → the pinged worker', () => {
    const log = build()
    const e = log.append('agent-probe', `agent-${WORKER_B}`, {
      agent: WORKER_B,
      quietMinutes: 1440,
      text: 'alive?',
      queued: true,
    })
    expect(resolution.resolve(e, ctx)).toEqual([WORKER_B])
  })

  test('greet → the named recipient — the greet is ORDINARY MAIL, not a second push path (task 133)', () => {
    // If this resolves to nobody, the greet is a direct push with no
    // mailbox entry: exactly the defect shape task 053 exists to catch,
    // and exactly what the OLD implementation did (a raw `ports.deliver`).
    // Resolving here is what makes P7/P8 carry it unchanged.
    const log = build()
    const e = log.append('greet', `agent-${ORCH}`, { agent: ORCH, queued: true })
    expect(resolution.resolve(e, ctx)).toEqual([ORCH])
  })

  test('agent-down / worker-status / disconnect → orchestrator', () => {
    const log = build()
    const down = log.append('agent-down', 'system', {
      subject: WORKER_A,
      to: ORCH,
      quietMinutes: 90,
      text: 'down',
      queued: true,
    })
    const status = log.append('worker-status', 'system', {
      agent: WORKER_A,
      status: 'recovered',
      text: 'back',
      queued: true,
    })
    const gone = log.append('disconnect', `agent-${WORKER_A}`, { agent: WORKER_A })
    expect(resolution.resolve(down, ctx)).toEqual([ORCH])
    expect(resolution.resolve(status, ctx)).toEqual([ORCH])
    expect(resolution.resolve(gone, ctx)).toEqual([ORCH])
  })

  test('trigger-fired targeting an agent → that agent', () => {
    const log = build()
    const e = log.append('trigger-fired', 'triggers', { triggerId: 'tr1', agent: WORKER_B, prompt: 'daily sweep' })
    expect(resolution.resolve(e, ctx)).toEqual([WORKER_B])
  })

  test('trigger-fired kind:headless resolves empty — the run spawns; there is no session to mail (079 report, case 2)', () => {
    const log = build()
    const e = log.append('trigger-fired', 'triggers', {
      triggerId: 'tr2',
      agent: 'librarian',
      prompt: 'consolidate',
      kind: 'headless',
    })
    expect(resolution.resolve(e, ctx)).toEqual([])
  })
})

describe('spec §4 — history: the empty case of the one rule', () => {
  test('ack, nudge, agent-idle, memory, register, start, permission-request, wiki-consolidated, trigger CRUD, playbook CRUD, headless-completed → nobody', () => {
    const log = build()
    const events = [
      log.append('ack', 'system', { eventIds: [1] }),
      log.append('nudge', `agent-${WORKER_A}`, { pendingCount: 3 }),
      log.append('agent-idle', `agent-${WORKER_A}`, { agent: WORKER_A, role: 'worker' }),
      log.append('memory', 'memory', { agent: WORKER_A, role: 'worker', text: 'learned', scope: 'dojo' }),
      log.append('register', `agent-${WORKER_A}`, { agent: WORKER_A, role: 'worker', idle: true }),
      log.append('start', 'system', { port: 4100 }),
      log.append('permission-request', `agent-${WORKER_A}`, { agent: WORKER_A, tool: 'Bash', input: {} }),
      log.append('wiki-consolidated', 'system', { pagesCreated: 1 }),
      log.append('trigger-created', 'triggers', {
        id: 'tr1',
        cron: '0 9 * * *',
        agent: WORKER_A,
        prompt: 'p',
        actor: ORCH,
      }),
      log.append('trigger-updated', 'triggers', { id: 'tr1', status: 'disabled' }),
      log.append('trigger-removed', 'triggers', { id: 'tr1' }),
      log.append('playbook-created', 'playbooks', { id: 'pb', content: 'c', hash: 'h' }),
      log.append('playbook-updated', 'playbooks', { id: 'pb', content: 'c2', hash: 'h2', prevHash: 'h' }),
      log.append('playbook-removed', 'playbooks', { id: 'pb', lastHash: 'h2' }),
      log.append('headless-completed', 'triggers', {
        triggerId: 'tr1',
        role: 'librarian',
        exitCode: 0,
        durationMs: 5,
        timedOut: false,
      }),
    ]
    let asserted = 0
    for (const e of events) {
      expect(resolution.resolve(e, ctx)).toEqual([])
      asserted++
    }
    expect(asserted).toBe(events.length) // anti-vacuity
  })
})

describe('degenerate contexts — empty, never a fallback', () => {
  test('no orchestrator on record: orchestrator-addressed kinds resolve empty, not to anyone else', () => {
    const log = build()
    const reply = log.append('reply', 'task-101', { agent: WORKER_A, text: 'done' })
    const down = log.append('agent-down', 'system', { subject: WORKER_A, quietMinutes: 9, text: 'down', queued: true })
    expect(resolution.resolve(reply, noOrchCtx)).toEqual([])
    expect(resolution.resolve(down, noOrchCtx)).toEqual([])
  })

  test('an unknown kind resolves empty — logs are permanent and folds must survive shapes newer than any census', () => {
    const log = build()
    const e = log.appendRaw('kind-from-the-future', 'system', { whatever: true })
    expect(resolution.resolve(e, ctx)).toEqual([])
  })
})

describe('the admission flag — the kinds that became mail mid-history (five at task 102; six with task 119)', () => {
  test('without `queued: true` the flagged kinds resolve to NOBODY; the same shapes with it resolve as declared', () => {
    // Every real log holds these WITHOUT the flag: bookkeeping-era records
    // and synchronous `delivered` handovers. Resolving them would resurrect
    // months of handled mail as pending on the first composed replay — the
    // gap every fixture above hid by always setting the flag.
    const log = build()
    const unflagged = [
      log.append('send', `agent-${WORKER_A}`, {
        agent: WORKER_A,
        from: ORCH,
        text: 'handed over live',
        delivered: true,
      }),
      log.append('task-reminder', 'system', { taskId: '101', to: ORCH, text: 'bookkeeping era' }),
      log.append('agent-probe', `agent-${WORKER_B}`, { agent: WORKER_B, quietMinutes: 1440, text: 'alive?' }),
      log.append('agent-down', 'system', { subject: WORKER_A, quietMinutes: 90, text: 'down' }),
      log.append('worker-status', 'system', { agent: WORKER_A, status: 'recovered', text: 'back' }),
    ]
    let checked = 0
    for (const e of unflagged) {
      expect(resolution.resolve(e, ctx), `${e.type} without the flag must be history`).toEqual([])
      checked++
    }
    counted('unflagged records resolving empty', checked, 5)
    // The mirror direction (checklist #3): the gate must ADMIT, not just
    // refuse — the same shape with the flag is mail, per the table above.
    const flagged = log.append('send', `agent-${WORKER_A}`, { agent: WORKER_A, from: ORCH, text: 'go', queued: true })
    expect(resolution.resolve(flagged, ctx)).toEqual([WORKER_A])
  })

  test('wiki-consolidated is the SIXTH gated kind (task 119): flagged → the orchestrator; historical records stay history', () => {
    // The first scheduled headless night delivered three anomalies to no
    // mailbox — the operating contract (the orchestrator's skill surfaces
    // `data.anomalies` to the human) contradicted the census inference
    // that lumped this kind with bookkeeping. Routed as mail, admission-
    // gated: old logs hold many consolidation records that must not
    // resurrect as pending on replay.
    const log = build()
    const flagged = log.append('wiki-consolidated', 'system', {
      pagesUpdated: 3,
      anomalies: ['stale reference in ops.md'],
      queued: true,
    })
    expect(resolution.resolve(flagged, ctx)).toEqual([ORCH])
    // Anomaly-free runs mail too — routine-vs-surface is the reader's
    // judgement, not a routing split.
    const routine = log.append('wiki-consolidated', 'system', { pagesUpdated: 1, queued: true })
    expect(resolution.resolve(routine, ctx)).toEqual([ORCH])
    // Every historical record (no flag) resolves empty — replay protection.
    const historical = log.append('wiki-consolidated', 'system', { pagesUpdated: 7, anomalies: ['old'] })
    expect(resolution.resolve(historical, ctx)).toEqual([])
    // And with no orchestrator on record: empty, never a fallback (P4).
    expect(resolution.resolve(flagged, noOrchCtx)).toEqual([])
  })
})
