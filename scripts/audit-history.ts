#!/usr/bin/env bun

/**
 * Integrity audit for a Jean event log (`.jean/history.jsonl`).
 *
 * WHY THIS EXISTS (task 011, 2026-07-25): `createStore.append()` reserved event
 * ids and then wrote them without serializing the writes. O_APPEND makes each
 * line atomic but guarantees nothing about ORDER between concurrent writers, so
 * a higher id could land ahead of a lower one. That was cosmetic in `/history`
 * — and dangerous at startup, because `lastId()` read the file's LAST LINE: a
 * log whose tail was not its max id made the next restart under-read and
 * REISSUE a live id into the one file this system never rewrites.
 *
 * Both halves are fixed in src/es/store.ts (writes serialized; `lastId` takes
 * the max by value). This script is the read-side check for logs written
 * BEFORE that fix, and the regression watch afterwards. It reports:
 *
 *   - INVERSIONS: adjacent lines whose ids go backwards. Harmless where they
 *     sit mid-log; the danger is one at the TAIL.
 *   - DUPLICATE IDS: the same id on more than one line. This is the damage
 *     consequence-2 would do — evidence it actually fired in production.
 *   - TAIL SAFETY: whether the last line holds the max id. If it does not, an
 *     infra START on the OLD code would reissue ids; the fixed code recovers,
 *     so this is now a "how close did we come" signal rather than a live alarm.
 *   - RESTART-STRADDLING INVERSIONS: whether any `start` event (one per infra
 *     boot) was ever preceded by a log whose max id exceeded the id it was
 *     handed — i.e. whether a restart ever actually re-entered used id space.
 *
 * Read-only. It never writes to, moves, or rewrites the log.
 *
 * Usage:  bun run scripts/audit-history.ts <path-to-history.jsonl> [...more]
 *         bun run scripts/audit-history.ts ~/dojo/.jean/history.jsonl
 */

import { readFileSync } from 'node:fs'

export type AuditReport = {
  path: string
  lines: number
  parsed: number
  malformed: number
  maxId: number
  lastLineId: number | null
  inversions: Array<{ line: number; from: number; to: number }>
  duplicates: Array<{ id: number; lines: number[] }>
  /** `start` events (infra boots) whose id is below the max id already present
   *  earlier in the log — the fingerprint of a restart that reissued ids. */
  restartsIntoUsedIdSpace: Array<{ line: number; id: number; maxIdBefore: number }>
  tailSafe: boolean
}

/** Audit the raw text of a history.jsonl. Pure — no I/O, so it is testable. */
export function auditHistory(text: string, path = '<stdin>'): AuditReport {
  const rawLines = text.split('\n').filter((l) => l.trim().length > 0)
  const ids: number[] = []
  const lineOfId = new Map<number, number[]>()
  const inversions: AuditReport['inversions'] = []
  const restartsIntoUsedIdSpace: AuditReport['restartsIntoUsedIdSpace'] = []
  let malformed = 0
  let maxId = 0
  let previous: number | null = null
  let lastLineId: number | null = null

  rawLines.forEach((line, i) => {
    let event: { id?: unknown; type?: unknown }
    try {
      event = JSON.parse(line) as { id?: unknown; type?: unknown }
    } catch {
      malformed++
      return
    }
    const id = event.id
    if (typeof id !== 'number') {
      malformed++
      return
    }
    // A `start` event is an infra boot. If the log already contains a HIGHER id
    // than the one this boot was handed, that boot re-entered used id space.
    if (event.type === 'start' && id <= maxId) {
      restartsIntoUsedIdSpace.push({ line: i + 1, id, maxIdBefore: maxId })
    }
    if (previous !== null && id < previous) inversions.push({ line: i + 1, from: previous, to: id })
    ids.push(id)
    lineOfId.set(id, [...(lineOfId.get(id) ?? []), i + 1])
    if (id > maxId) maxId = id
    previous = id
    lastLineId = id
  })

  const duplicates = [...lineOfId.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([id, lines]) => ({ id, lines }))

  return {
    path,
    lines: rawLines.length,
    parsed: ids.length,
    malformed,
    maxId,
    lastLineId,
    inversions,
    duplicates,
    restartsIntoUsedIdSpace,
    tailSafe: lastLineId === maxId,
  }
}

/** One-line-per-log summary plus detail for anything that needs attention. */
export function formatReport(r: AuditReport): string {
  const out: string[] = []
  const verdict = r.duplicates.length > 0 ? 'DAMAGED' : r.inversions.length > 0 ? 'disordered' : 'clean'
  out.push(
    `${r.path}\n  ${r.parsed} events (max id ${r.maxId})  inversions=${r.inversions.length}  duplicates=${r.duplicates.length}  malformed=${r.malformed}  →  ${verdict}`,
  )
  out.push(
    r.tailSafe
      ? `  tail: last line holds the max id — a restart on the pre-fix code would have been safe`
      : `  tail: last line is id ${r.lastLineId} but max is ${r.maxId} — a restart on the PRE-FIX code would have reissued ${r.maxId}`,
  )
  if (r.duplicates.length > 0) {
    out.push(`  DUPLICATE IDS (consequence 2 fired here):`)
    for (const d of r.duplicates.slice(0, 20)) out.push(`    id ${d.id} on lines ${d.lines.join(', ')}`)
    if (r.duplicates.length > 20) out.push(`    …and ${r.duplicates.length - 20} more`)
  }
  if (r.restartsIntoUsedIdSpace.length > 0) {
    out.push(`  RESTARTS THAT RE-ENTERED USED ID SPACE:`)
    for (const s of r.restartsIntoUsedIdSpace) out.push(`    line ${s.line}: start got id ${s.id}, max was ${s.maxIdBefore}`)
  }
  if (r.inversions.length > 0) {
    const sample = r.inversions.slice(0, 5).map((i) => `line ${i.line} (${i.from}→${i.to})`)
    out.push(`  inversions (harmless mid-log, sample): ${sample.join(', ')}${r.inversions.length > 5 ? ' …' : ''}`)
  }
  return out.join('\n')
}

if (import.meta.main) {
  const paths = process.argv.slice(2)
  if (paths.length === 0) {
    process.stderr.write('usage: bun run scripts/audit-history.ts <path-to-history.jsonl> [...]\n')
    process.exit(2)
  }
  let worst = 0 // 0 clean, 1 disordered, 2 damaged
  for (const path of paths) {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (err) {
      process.stderr.write(`${path}\n  could not be read: ${err instanceof Error ? err.message : String(err)}\n`)
      worst = Math.max(worst, 1)
      continue
    }
    const report = auditHistory(text, path)
    process.stdout.write(`${formatReport(report)}\n`)
    worst = Math.max(worst, report.duplicates.length > 0 ? 2 : report.inversions.length > 0 ? 1 : 0)
  }
  // Exit code carries the verdict so this can gate a check: 0 clean,
  // 1 disordered (pre-fix writes, recoverable), 2 duplicate ids (real damage).
  process.exit(worst)
}
