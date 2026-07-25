// Attention phase 4 §3 — the session-classification rules, unit level. These
// are role-asymmetric and easy to get subtly wrong, and two of them encode
// review findings, so they're pinned here rather than only through a server.
import { afterEach, describe, expect, test } from 'bun:test'
import { classifySession, QUIET_THRESHOLD_DEFAULTS, quietThresholdMs } from './liveness.ts'

const NOW = 1_800_000_000_000 // fixed clock — these functions take `now`, they don't read one
const ENV_KEYS = ['JEAN_QUIET_THRESHOLD_MS', 'JEAN_QUIET_THRESHOLD_WORKER_MS', 'JEAN_QUIET_THRESHOLD_SENSEI_MS']

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('quiet thresholds', () => {
  test('role defaults encode the measured asymmetry: a sensei is stale far sooner than a worker', () => {
    expect(quietThresholdMs('sensei')).toBe(10 * 60_000)
    expect(quietThresholdMs('worker')).toBe(45 * 60_000)
    expect(quietThresholdMs('sensei')).toBeLessThan(quietThresholdMs('worker'))
    // Every role has one — no undefined threshold can slip through.
    for (const ms of Object.values(QUIET_THRESHOLD_DEFAULTS)) expect(ms).toBeGreaterThan(0)
  })

  test('per-role env override beats the global one, which beats the default', () => {
    process.env.JEAN_QUIET_THRESHOLD_MS = '5000'
    expect(quietThresholdMs('worker')).toBe(5000) // global applies
    process.env.JEAN_QUIET_THRESHOLD_WORKER_MS = '1000'
    expect(quietThresholdMs('worker')).toBe(1000) // per-role wins
    expect(quietThresholdMs('sensei')).toBe(5000) // …only for its own role
  })

  test('garbage env values fall through to the default instead of producing an instant-quiet threshold', () => {
    for (const bad of ['', 'soon', '0', '-1', 'NaN']) {
      process.env.JEAN_QUIET_THRESHOLD_WORKER_MS = bad
      expect(quietThresholdMs('worker')).toBe(45 * 60_000)
    }
  })
})

describe('classifySession', () => {
  test('recent traffic is active; traffic older than the role threshold is quiet', () => {
    expect(classifySession({ role: 'worker', lastActivityAt: NOW - 60_000 }, NOW)).toBe('active')
    expect(classifySession({ role: 'worker', lastActivityAt: NOW - 44 * 60_000 }, NOW)).toBe('active')
    expect(classifySession({ role: 'worker', lastActivityAt: NOW - 46 * 60_000 }, NOW)).toBe('quiet')
    // Same silence, different verdict per role — that's the whole point.
    expect(classifySession({ role: 'sensei', lastActivityAt: NOW - 20 * 60_000 }, NOW)).toBe('quiet')
    expect(classifySession({ role: 'worker', lastActivityAt: NOW - 20 * 60_000 }, NOW)).toBe('active')
  })

  test('exactly at the threshold still reads active (the boundary is inclusive, not a flicker)', () => {
    expect(classifySession({ role: 'sensei', lastActivityAt: NOW - 10 * 60_000 }, NOW)).toBe('active')
  })

  test('NO OBSERVED TRAFFIC READS QUIET, NEVER ACTIVE — the bridge-registration case', () => {
    // Review finding [C]: infra registering a chat surface at boot is INFRA's
    // act, not the human's. An entry created that way carries no
    // lastActivityAt, and must not read active — otherwise a months-silent
    // bridge human looks freshly present for 45 minutes after every restart.
    expect(classifySession({ role: 'user' }, NOW)).toBe('quiet')
    expect(classifySession({ role: 'user', transportLive: true }, NOW)).toBe('quiet')
    expect(classifySession({ role: 'sensei' }, NOW)).toBe('quiet')
  })

  test('a dead transport is offline whatever it said a moment ago', () => {
    expect(classifySession({ role: 'sensei', lastActivityAt: NOW, transportLive: false }, NOW)).toBe('offline')
    expect(classifySession({ role: 'worker', transportLive: false }, NOW)).toBe('offline')
    // A transport with no liveness check (undefined) is not treated as dead.
    expect(classifySession({ role: 'worker', lastActivityAt: NOW }, NOW)).toBe('active')
  })
})
