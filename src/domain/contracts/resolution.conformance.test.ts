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
import { createClock, createLog } from '../fixture/index.ts'
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
  roleOf: (name) =>
    name === ORCH ? 'sensei' : name === HUMAN ? 'user' : name === WORKER_A || name === WORKER_B ? 'worker' : undefined,
  taskOwner: (taskId) => (taskId === '101' ? WORKER_A : undefined),
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
    expect(resolution.resolve(e, { ...ctx, taskOwner: () => WORKER_A })).toEqual([WORKER_A])
  })

  test('task created UNASSIGNED by the orchestrator → nobody; it is history (spec §4, verbatim case)', () => {
    const log = build()
    const e = log.append('task-created', 'task-999', {
      title: 'unassigned',
      description: '',
      queue: 'someday',
      actor: ORCH,
    })
    expect(resolution.resolve(e, { ...ctx, taskOwner: () => undefined })).toEqual([])
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
