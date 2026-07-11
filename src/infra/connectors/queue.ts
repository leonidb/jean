/**
 * Per-instance source store, under <dataDir>/sources/<instance>/:
 *   inbox.jsonl  — appended InboundItems (external content — deliberately NOT
 *                  the orchestration event log, and NOT pendingProjection)
 *   processed    — count of items the sensei has worked (an offset marker)
 *   cursor.json  — the connector's poll position (dedupe / no-replay)
 *
 * A plain queue, not a projection engine: the sensei reads an unworked batch,
 * triages, marks it done. Dedupe is primarily the connector's job (via cursor);
 * `InboundItem.id` is here as the key if a consumer wants a backstop.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CursorStore, InboundItem } from './types.ts'

export class SourceQueue {
  private readonly dir: string
  private readonly inboxPath: string
  private readonly processedPath: string
  private readonly cursorPath: string

  constructor(dataDir: string, instance: string) {
    this.dir = resolve(dataDir, 'sources', instance)
    this.inboxPath = resolve(this.dir, 'inbox.jsonl')
    this.processedPath = resolve(this.dir, 'processed')
    this.cursorPath = resolve(this.dir, 'cursor.json')
  }

  private ensure(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  /** Append one item. O(1) — dedupe is the connector's responsibility. */
  append(item: InboundItem): void {
    this.ensure()
    appendFileSync(this.inboxPath, `${JSON.stringify(item)}\n`)
  }

  private all(): InboundItem[] {
    if (!existsSync(this.inboxPath)) return []
    return readFileSync(this.inboxPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as InboundItem)
  }

  private processedCount(): number {
    if (!existsSync(this.processedPath)) return 0
    return Number(readFileSync(this.processedPath, 'utf8').trim()) || 0
  }

  /** Whether an id is already in the inbox (backstop dedupe for callers). */
  has(id: string): boolean {
    return this.all().some((i) => i.id === id)
  }

  /** Oldest-first items the sensei hasn't worked yet, up to `limit`. */
  unprocessed(limit = 50): InboundItem[] {
    const start = this.processedCount()
    return this.all().slice(start, start + limit)
  }

  /** Mark the next `n` items (oldest-first) as worked. */
  markProcessed(n: number): void {
    if (n <= 0) return
    this.ensure()
    writeFileSync(this.processedPath, String(this.processedCount() + n))
  }

  /** How many items are waiting for the sensei. */
  pendingCount(): number {
    return Math.max(0, this.all().length - this.processedCount())
  }

  /** The connector's persisted poll cursor for this instance. */
  cursor(): CursorStore {
    const path = this.cursorPath
    const ensure = () => this.ensure()
    return {
      get(): string | undefined {
        if (!existsSync(path)) return undefined
        try {
          return (JSON.parse(readFileSync(path, 'utf8')) as { cursor?: string }).cursor
        } catch {
          return undefined
        }
      },
      set(cursor: string): void {
        ensure()
        writeFileSync(path, JSON.stringify({ cursor }))
      },
    }
  }
}
