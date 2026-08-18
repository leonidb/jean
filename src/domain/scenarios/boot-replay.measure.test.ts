/**
 * R12 — the boot-replay cost measurement (tracker register; the
 * pre-switch question, task 102): every new-system view is a fold over the
 * whole log and boot is linear in log length, with no snapshot mechanism on
 * the new path yet. This test replays REAL dojo logs through the composed
 * folds (agents → tasks → mailbox, composition law 1) and reports the
 * number; the number — not an argument — decides whether snapshots ship
 * with E1, with G1, or later.
 *
 * Machine-bound by design: it reads logs from the local dojos and SKIPS
 * where they do not exist, so the suite stays green on any checkout while
 * producing the measurement where the dojos live. Correctness of the
 * replayed STATE is G1's shakedown question (census + history-tolerance
 * laws); cost is this one's — the assertions here are sanity floors, not
 * behaviour pins.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import type { StoredEvent } from '../contracts/vocabulary.ts'
import { replayComposed } from './dojo.ts'

const HOME = process.env.HOME ?? ''
const LOGS: readonly [string, string][] = [
  ['first', `${HOME}/dojos/first/.jean/history.jsonl`],
  ['second', `${HOME}/dojos/second/.jean/history.jsonl`],
]

describe('R12 — boot-replay cost of the composed folds over real logs', () => {
  for (const [dojo, path] of LOGS) {
    test.skipIf(!existsSync(path))(`the real ${dojo} log replays whole, and the cost is printed`, () => {
      const events: StoredEvent[] = readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as StoredEvent)
      const result = replayComposed(events)
      console.log(
        `[R12] ${dojo}: ${result.events} events replayed in ${result.durationMs.toFixed(1)}ms ` +
          `(${result.tasks} tasks, ${result.pendingPairs} pending pairs)`,
      )
      expect(result.events).toBeGreaterThan(1_000) // a real log, not a stub
      expect(result.tasks).toBeGreaterThan(0) // the folds actually folded
      expect(Number.isFinite(result.durationMs)).toBe(true)
    })
  }
})
