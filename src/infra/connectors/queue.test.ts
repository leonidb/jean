import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceQueue } from './queue.ts'
import type { InboundItem } from './types.ts'

const item = (id: string): InboundItem => ({ id, kind: 'gmail', at: 1, from: 'a@b.c', text: `msg ${id}` })

describe('SourceQueue', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jean-queue-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('append + unprocessed + markProcessed advances the offset', () => {
    const q = new SourceQueue(dir, 'mail')
    q.append(item('1'))
    q.append(item('2'))
    q.append(item('3'))
    expect(q.pendingCount()).toBe(3)
    expect(q.unprocessed().map((i) => i.id)).toEqual(['1', '2', '3'])
    q.markProcessed(2)
    expect(q.pendingCount()).toBe(1)
    expect(q.unprocessed().map((i) => i.id)).toEqual(['3'])
  })

  test('unprocessed respects the limit', () => {
    const q = new SourceQueue(dir, 'mail')
    for (let i = 0; i < 5; i++) q.append(item(String(i)))
    expect(q.unprocessed(2).map((i) => i.id)).toEqual(['0', '1'])
  })

  test('has finds appended ids', () => {
    const q = new SourceQueue(dir, 'mail')
    q.append(item('x'))
    expect(q.has('x')).toBe(true)
    expect(q.has('y')).toBe(false)
  })

  test('empty queue is safe', () => {
    const q = new SourceQueue(dir, 'mail')
    expect(q.pendingCount()).toBe(0)
    expect(q.unprocessed()).toEqual([])
    q.markProcessed(0) // no-op, no throw
    expect(q.pendingCount()).toBe(0)
  })

  test('cursor persists (survives a fresh handle on the same dir)', () => {
    const q1 = new SourceQueue(dir, 'mail')
    expect(q1.cursor().get()).toBeUndefined()
    q1.cursor().set('UID-42')
    const q2 = new SourceQueue(dir, 'mail')
    expect(q2.cursor().get()).toBe('UID-42')
  })

  test('separate instances are isolated', () => {
    const a = new SourceQueue(dir, 'personal')
    const b = new SourceQueue(dir, 'work')
    a.append(item('1'))
    expect(a.pendingCount()).toBe(1)
    expect(b.pendingCount()).toBe(0)
  })
})
