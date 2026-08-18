/**
 * The rename tables, as plain parse/serialize tests (task E2).
 *
 * No server, no socket, no domain state: a refusal goes in, a status and a
 * body come out. That is the whole of what this file asserts, and it is the
 * adapter's side of "a 400 is a typed refusal RENAMED, never the adapter's
 * own judgement" — WHEN each refusal is produced belongs to the module
 * conformance suites and is green there.
 *
 * ── HOW TOTALITY IS HELD ──
 *
 * The sample tables are `Record<Refusal['kind'], Refusal>`, so a refusal kind
 * added to a contract does not compile here until it has a sample — and the
 * test then walks the sample table, so every kind is exercised. A list would
 * have drifted the first time a contract grew; the type cannot.
 */

import { describe, expect, test } from 'bun:test'
import type { TriggerRefusal } from '../domain/contracts/triggers.ts'
import {
  renameCorpusRefusal,
  renameMemoryRefusal,
  renameScopeRefusal,
  renameTaskRefusal,
  renameTriggerRefusal,
  type TaskRefusal,
} from './refusals.ts'

const TASK_SAMPLES: Record<TaskRefusal['kind'], TaskRefusal> = {
  'unknown-task': { kind: 'unknown-task' },
  'illegal-transition': { kind: 'illegal-transition', from: 'done', to: 'in-progress' },
  'actor-forbidden': { kind: 'actor-forbidden', actorRole: 'worker', from: 'in-progress', to: 'done' },
  'blocker-required': { kind: 'blocker-required' },
  'unparseable-resume': { kind: 'unparseable-resume', resumeAt: 'next tuesday-ish' },
  'not-waiting': { kind: 'not-waiting', status: 'in-progress' },
  'not-a-mailbox-holder': { kind: 'not-a-mailbox-holder', name: 'someday' },
  'already-subscribed': { kind: 'already-subscribed' },
  'not-subscribed': { kind: 'not-subscribed' },
  'nothing-to-revert': { kind: 'nothing-to-revert' },
}

const TRIGGER_SAMPLES: Record<TriggerRefusal['kind'], TriggerRefusal> = {
  'missing-agent-or-prompt': { kind: 'missing-agent-or-prompt' },
  'no-schedule': { kind: 'no-schedule' },
  'both-schedules': { kind: 'both-schedules' },
  'invalid-cron': { kind: 'invalid-cron' },
  'invalid-at': { kind: 'invalid-at', at: 'soonish' },
  'invalid-kind': { kind: 'invalid-kind', got: 'sideways' },
  'model-on-agent-trigger': { kind: 'model-on-agent-trigger' },
  'retries-on-agent-trigger': { kind: 'retries-on-agent-trigger' },
  'invalid-retries': { kind: 'invalid-retries', got: 2.5 },
  'invalid-role-for-headless': { kind: 'invalid-role-for-headless', got: 'archivist', valid: ['worker', 'librarian'] },
  'duplicate-id': { kind: 'duplicate-id', id: 'nightly' },
  'unknown-trigger': { kind: 'unknown-trigger', id: 'ghost' },
  'schedule-immutable': { kind: 'schedule-immutable' },
  'unknown-fields': { kind: 'unknown-fields', fields: ['cadence', 'colour'] },
  'invalid-status': { kind: 'invalid-status', got: 'paused' },
  'invalid-metadata': { kind: 'invalid-metadata' },
}

/** Statuses a rename is allowed to reach for. A 5xx here would mean the
 *  adapter answered a caller's mistake by blaming itself. */
const CLIENT_STATUSES = new Set([400, 403, 404, 409])

describe('the task rename table', () => {
  test('every refusal kind renames to a client status and carries its own kind back', () => {
    const kinds = Object.keys(TASK_SAMPLES) as TaskRefusal['kind'][]
    expect(kinds.length).toBe(10) // anti-vacuity: the table is walked, not skipped
    for (const kind of kinds) {
      const renamed = renameTaskRefusal(TASK_SAMPLES[kind])
      expect(CLIENT_STATUSES.has(renamed.status), `${kind} → ${renamed.status}`).toBe(true)
      // The `kind` travels so a caller can branch without regexing prose.
      expect(renamed.body.refusal).toBe(kind)
      expect(renamed.body.error.length).toBeGreaterThan(0)
    }
  })

  test('the three status meanings are kept apart', () => {
    // 404 = the thing named does not exist. 403 = it exists and you may not.
    // 409 = it exists, you may, and its current state says no — the only one
    // of the three a caller is right to retry after something changes.
    expect(renameTaskRefusal({ kind: 'unknown-task' }).status).toBe(404)
    expect(renameTaskRefusal(TASK_SAMPLES['actor-forbidden']).status).toBe(403)
    expect(renameTaskRefusal(TASK_SAMPLES['not-waiting']).status).toBe(409)
    expect(renameTaskRefusal(TASK_SAMPLES['illegal-transition']).status).toBe(400)
  })

  test('the payload reaches the message — a refusal that names a value says which', () => {
    // The failure this catches is a message that describes the CLASS of
    // problem and drops the instance ("invalid transition"), which sends the
    // reader back to the logs to find out which one.
    expect(renameTaskRefusal(TASK_SAMPLES['illegal-transition']).body.error).toContain('done')
    expect(renameTaskRefusal(TASK_SAMPLES['illegal-transition']).body.error).toContain('in-progress')
    expect(renameTaskRefusal(TASK_SAMPLES['actor-forbidden']).body.error).toContain('worker')
    expect(renameTaskRefusal(TASK_SAMPLES['unparseable-resume']).body.error).toContain('next tuesday-ish')
    expect(renameTaskRefusal(TASK_SAMPLES['not-a-mailbox-holder']).body.error).toContain('someday')
  })
})

describe('the trigger rename table', () => {
  test('every refusal kind renames to a client status and carries its own kind back', () => {
    const kinds = Object.keys(TRIGGER_SAMPLES) as TriggerRefusal['kind'][]
    expect(kinds.length).toBe(16)
    for (const kind of kinds) {
      const renamed = renameTriggerRefusal(TRIGGER_SAMPLES[kind])
      expect(CLIENT_STATUSES.has(renamed.status), `${kind} → ${renamed.status}`).toBe(true)
      expect(renamed.body.refusal).toBe(kind)
      expect(renamed.body.error.length).toBeGreaterThan(0)
    }
  })

  test('a taken id is a CONFLICT and a missing one is NOT FOUND — the pair that must not collapse', () => {
    expect(renameTriggerRefusal(TRIGGER_SAMPLES['duplicate-id']).status).toBe(409)
    expect(renameTriggerRefusal(TRIGGER_SAMPLES['unknown-trigger']).status).toBe(404)
  })

  test('the payload reaches the message', () => {
    expect(renameTriggerRefusal(TRIGGER_SAMPLES['unknown-fields']).body.error).toContain('cadence')
    expect(renameTriggerRefusal(TRIGGER_SAMPLES['invalid-role-for-headless']).body.error).toContain('archivist')
    expect(renameTriggerRefusal(TRIGGER_SAMPLES['invalid-role-for-headless']).body.error).toContain('librarian')
    expect(renameTriggerRefusal(TRIGGER_SAMPLES['duplicate-id']).body.error).toContain('nightly')
  })
})

describe('the knowledge renames', () => {
  test('a malformed memory is the caller’s 400', () => {
    const renamed = renameMemoryRefusal({ kind: 'missing-fields' })
    expect(renamed.status).toBe(400)
    expect(renamed.body.refusal).toBe('missing-fields')
  })

  test('an invalid scope hands back what WOULD have been valid, never a silent widen', () => {
    const renamed = renameScopeRefusal(['all', 'knowledge', 'tasks', 'channel'], 'knowlege')
    expect(renamed.status).toBe(400)
    expect(renamed.body.error).toContain('knowlege') // the typo, quoted back
    expect(renamed.validScopes).toEqual(['all', 'knowledge', 'tasks', 'channel'])
  })

  test('a duplicate document id is the ADAPTER’s fault and says so with a 5xx', () => {
    // The corpus is the adapter's to build, so a collision in it is not the
    // caller's mistake — answering 400 would send them looking at their query.
    const renamed = renameCorpusRefusal({ kind: 'duplicate-doc-id', id: 'wiki-task-001' })
    expect(renamed.status).toBe(500)
    expect(renamed.body.error).toContain('wiki-task-001')
  })
})
