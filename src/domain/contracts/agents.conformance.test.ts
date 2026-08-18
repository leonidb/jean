/**
 * Agents conformance — the executable form of the agents contract.
 * RED BY ABSENCE until D4 lands `src/domain/agents/index.ts` exporting
 * `agents: AgentsContract`. No plausible stubs anywhere (design §9).
 */

import { describe, expect, test } from 'bun:test'
import { counted, createClock, createLog } from '../fixture/index.ts'
import type { AgentsContract } from './agents.ts'

const IMPL_PATH: string = '../agents/index.ts'
const agents: AgentsContract = await import(IMPL_PATH)
  .then((m) => (m as { agents: AgentsContract }).agents)
  .catch((err: unknown) => {
    if (String(err).includes('Cannot find module')) {
      throw new Error(
        'RED BY ABSENCE — src/domain/agents/index.ts does not exist yet. ' +
          'Task D4 implements the AgentsContract; nothing else may (no plausible stubs — design §9).',
      )
    }
    throw err
  })

const NOW = 1_755_600_000_000

function foldLog(build: (log: ReturnType<typeof createLog>) => void) {
  const log = createLog(createClock())
  build(log)
  let state = agents.initial()
  for (const e of log.events()) state = agents.fold(state, e)
  return state
}

describe('reserved names (R6)', () => {
  test('infra and api are reserved; registration refuses them for EVERY role', () => {
    let refused = 0
    for (const name of ['infra', 'api']) {
      expect(agents.isReservedName(name)).toBe(true)
      for (const role of ['worker', 'sensei', 'user', 'peer', 'librarian'] as const) {
        const verdict = agents.decideRegistration(agents.initial(), {
          name,
          role,
          orchestratorConnected: false,
        })
        expect(verdict).toEqual({ kind: 'refuse-reserved' })
        refused++
      }
    }
    counted('reserved refusals', refused, 10)
    expect(agents.isReservedName('worker-a')).toBe(false)
  })
})

describe('membership — durable from the log', () => {
  test('a name joins on first register and stays a dojo agent across a disconnect (the mailbox holds; being away costs nothing)', () => {
    const state = foldLog((log) => {
      log.append('register', 'agent-worker-a', { agent: 'worker-a', role: 'worker', idle: true })
      log.append('disconnect', 'agent-worker-a', { agent: 'worker-a' })
    })
    expect(agents.isDojoAgent(state, 'worker-a')).toBe(true)
  })

  test('an unknown name is NOT a dojo agent — the queue-vs-warn line', () => {
    const state = foldLog((log) => {
      log.append('register', 'agent-worker-a', { agent: 'worker-a', role: 'worker', idle: true })
    })
    expect(agents.isDojoAgent(state, 'nobody-ever')).toBe(false)
  })

  test('user and peer registrations do not make dojo agents (their mail routes by role, not by queue)', () => {
    const state = foldLog((log) => {
      log.append('register', 'agent-human-h', { agent: 'human-h', role: 'user', idle: true })
      log.append('register', 'agent-peer-p', { agent: 'peer-p', role: 'peer', idle: true })
    })
    expect(agents.isDojoAgent(state, 'human-h')).toBe(false)
    expect(agents.isDojoAgent(state, 'peer-p')).toBe(false)
  })
})

describe('the orchestrator seat', () => {
  test('the most recent sensei register holds the seat — and holds it while disconnected (the seat outlives the session)', () => {
    const state = foldLog((log) => {
      log.append('register', 'agent-sensei-one', { agent: 'sensei-one', role: 'sensei', idle: true })
      log.append('register', 'agent-sensei-two', { agent: 'sensei-two', role: 'sensei', idle: true })
      log.append('disconnect', 'agent-sensei-two', { agent: 'sensei-two' })
    })
    expect(agents.orchestratorOf(state)).toBe('sensei-two')
  })

  test('no sensei ever registered → no seat (empty, never a fallback)', () => {
    const state = foldLog((log) => {
      log.append('register', 'agent-worker-a', { agent: 'worker-a', role: 'worker', idle: true })
    })
    expect(agents.orchestratorOf(state)).toBeUndefined()
  })

  test('a second orchestrator session is refused while one is connected', () => {
    const state = foldLog((log) => {
      log.append('register', 'agent-sensei-one', { agent: 'sensei-one', role: 'sensei', idle: true })
    })
    const verdict = agents.decideRegistration(state, {
      name: 'sensei-two',
      role: 'sensei',
      sessionId: 's2',
      orchestratorConnected: true,
    })
    expect(verdict).toEqual({ kind: 'refuse-second-orchestrator' })
  })

  test('PRECEDENCE: the orchestrator reconnecting on its own session replaces — its own liveness must not lock the seat', () => {
    const state = foldLog((log) => {
      log.append('register', 'agent-sensei-one', { agent: 'sensei-one', role: 'sensei', idle: true, sessionId: 's1' })
    })
    const verdict = agents.decideRegistration(state, {
      name: 'sensei-one',
      role: 'sensei',
      sessionId: 's1',
      incumbent: { sessionId: 's1', live: true },
      orchestratorConnected: true,
    })
    expect(verdict).toEqual({ kind: 'replace' })
  })
})

describe('role precedence — one identity, ordered sources of fact', () => {
  test('a name in both persisted sets resolves user while disconnected — a missed human outranks a shrunken mailbox', () => {
    const state = foldLog((log) => {
      log.append('register', 'agent-human', { agent: 'human', role: 'user', idle: true })
      log.append('register', 'agent-human', { agent: 'human', role: 'sensei', idle: true })
    })
    expect(agents.roleOf(state, 'human')).toBe('user')
  })

  test('the live session’s role wins over every persisted record', () => {
    const state = foldLog((log) => {
      log.append('register', 'agent-human', { agent: 'human', role: 'user', idle: true })
    })
    expect(agents.roleOf(state, 'human', 'sensei')).toBe('sensei')
  })

  test('a plain worker resolves from its record; an unknown name resolves nothing', () => {
    const state = foldLog((log) => {
      log.append('register', 'agent-worker-a', { agent: 'worker-a', role: 'worker', idle: true })
    })
    expect(agents.roleOf(state, 'worker-a')).toBe('worker')
    expect(agents.roleOf(state, 'stranger')).toBeUndefined()
  })
})

describe('session classification — a hint, honestly derived', () => {
  const thresholds = (role: string) => (role === 'sensei' ? 600_000 : 2_700_000)

  test('a dead transport is offline whatever it said a second ago', () => {
    expect(
      agents.classifySession({ role: 'worker', lastActivityAt: NOW - 1, transportLive: false }, NOW, thresholds),
    ).toBe('offline')
  })

  test('no observed traffic reads quiet, never active — absence of evidence is not evidence of presence', () => {
    expect(agents.classifySession({ role: 'worker', transportLive: true }, NOW, thresholds)).toBe('quiet')
  })

  test('the injected per-role threshold decides active vs quiet — role asymmetry preserved, boundary inclusive', () => {
    const tenMinAgo = NOW - 600_000
    expect(
      agents.classifySession({ role: 'worker', lastActivityAt: tenMinAgo, transportLive: true }, NOW, thresholds),
    ).toBe(
      'active', // inside the worker bound
    )
    // EXACTLY at the threshold is still active (the extracted <= boundary)…
    expect(
      agents.classifySession({ role: 'sensei', lastActivityAt: tenMinAgo, transportLive: true }, NOW, thresholds),
    ).toBe('active')
    // …one ms past it is quiet.
    expect(
      agents.classifySession({ role: 'sensei', lastActivityAt: tenMinAgo - 1, transportLive: true }, NOW, thresholds),
    ).toBe('quiet')
  })
})

describe('duplicate sessions — keep the incumbent, expressed over plain values', () => {
  const base = { name: 'worker-a', role: 'worker' as const, orchestratorConnected: false }
  const registered = foldLog((log) => {
    log.append('register', 'agent-worker-a', { agent: 'worker-a', role: 'worker', idle: true, sessionId: 's1' })
  })

  test('live incumbent + different session → refuse the newcomer and notify the orchestrator once', () => {
    const verdict = agents.decideRegistration(registered, {
      ...base,
      sessionId: 's2',
      incumbent: { sessionId: 's1', live: true },
    })
    expect(verdict).toEqual({ kind: 'refuse-duplicate', notifyOrchestrator: true })
  })

  test('same session reconnecting → replace cleanly', () => {
    const verdict = agents.decideRegistration(registered, {
      ...base,
      sessionId: 's1',
      incumbent: { sessionId: 's1', live: true },
    })
    expect(verdict).toEqual({ kind: 'replace' })
  })

  test('dead incumbent → replace cleanly, whatever the session ids', () => {
    const verdict = agents.decideRegistration(registered, {
      ...base,
      sessionId: 's2',
      incumbent: { sessionId: 's1', live: false },
    })
    expect(verdict).toEqual({ kind: 'replace' })
  })

  test('no incumbent → admit', () => {
    const verdict = agents.decideRegistration(registered, { ...base, sessionId: 's3' })
    expect(verdict).toEqual({ kind: 'admit' })
  })
})

describe('the idle report — a diagnostic classification, never activity', () => {
  test('current session ok; stale session named; disconnected named', () => {
    expect(agents.idleReport({ connected: true, currentSessionId: 's1' }, 's1')).toEqual({ kind: 'ok' })
    expect(agents.idleReport({ connected: true, currentSessionId: 's1' }, 's9')).toEqual({
      kind: 'stale-session',
      current: 's1',
    })
    expect(agents.idleReport({ connected: false }, 's1')).toEqual({ kind: 'not-connected' })
    // A report with no session id from a connected agent is the current one's.
    expect(agents.idleReport({ connected: true, currentSessionId: 's1' }, undefined)).toEqual({ kind: 'ok' })
  })
})
