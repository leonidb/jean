// The audit is the read-side half of task 011: it tells us whether a log
// written before the append fix ever suffered the damage the fix prevents.
// A detector that reports "clean" on a damaged log is worse than none, so its
// verdicts are pinned here on hand-built logs whose answers are known.
import { describe, expect, test } from 'bun:test'
import { auditHistory, formatReport } from './audit-history.ts'

const line = (id: number, type = 't') => JSON.stringify({ id, stream: 's', type, ts: '', data: {} })
const log = (...lines: string[]) => `${lines.join('\n')}\n`

describe('auditHistory', () => {
  test('an ordered log is clean and tail-safe', () => {
    const r = auditHistory(log(line(1), line(2), line(3)))
    expect(r.parsed).toBe(3)
    expect(r.inversions).toEqual([])
    expect(r.duplicates).toEqual([])
    expect(r.maxId).toBe(3)
    expect(r.tailSafe).toBe(true)
  })

  test('an inversion mid-log is reported but leaves the tail safe', () => {
    // The common production shape: concurrent writes crossed, then the log
    // carried on. Harmless — but visible, because the count tracks how often
    // the race fires on that dojo.
    const r = auditHistory(log(line(1), line(3), line(2), line(4)))
    expect(r.inversions).toEqual([{ line: 3, from: 3, to: 2 }])
    expect(r.tailSafe).toBe(true)
    expect(r.duplicates).toEqual([])
  })

  test('THE DANGEROUS SHAPE: an inversion at the tail is flagged not tail-safe', () => {
    // 1,3,2 — max 3, last line 2. On the pre-fix code the next boot reads the
    // last line and reissues id 3. This is the case the regression test in
    // src/es/store.test.ts covers from the write side.
    const r = auditHistory(log(line(1), line(3), line(2)))
    expect(r.tailSafe).toBe(false)
    expect(r.maxId).toBe(3)
    expect(r.lastLineId).toBe(2)
    expect(formatReport(r)).toContain('would have reissued 3')
  })

  test('duplicate ids are reported with every line they appear on', () => {
    const r = auditHistory(log(line(1), line(2), line(2), line(3)))
    expect(r.duplicates).toEqual([{ id: 2, lines: [2, 3] }])
    expect(formatReport(r)).toContain('DAMAGED')
  })

  test('a restart that re-entered used id space is named', () => {
    // The fingerprint of consequence 2 actually firing: a `start` event (one
    // per infra boot) carrying an id at or below the max already in the log.
    const r = auditHistory(log(line(1), line(5), line(3), line(4, 'start')))
    expect(r.restartsIntoUsedIdSpace).toEqual([{ line: 4, id: 4, maxIdBefore: 5 }])
    expect(formatReport(r)).toContain('RESTARTS THAT RE-ENTERED USED ID SPACE')
  })

  test('a healthy restart is not flagged', () => {
    const r = auditHistory(log(line(1), line(2), line(3, 'start')))
    expect(r.restartsIntoUsedIdSpace).toEqual([])
  })

  test('malformed lines are counted, not fatal — a truncated tail must stay auditable', () => {
    const r = auditHistory(`${line(1)}\n${line(2)}\n{"id":3,"stream":`)
    expect(r.parsed).toBe(2)
    expect(r.malformed).toBe(1)
    expect(r.maxId).toBe(2)
  })

  test('an empty log audits as clean rather than throwing', () => {
    const r = auditHistory('')
    expect(r.parsed).toBe(0)
    expect(r.maxId).toBe(0)
    expect(r.inversions).toEqual([])
  })
})
