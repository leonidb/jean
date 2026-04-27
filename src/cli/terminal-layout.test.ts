import { describe, expect, test } from 'bun:test'
import { buildITermLayoutScript, type LayoutSpec } from './terminal-layout.ts'

function spec(opts: Partial<LayoutSpec> = {}): LayoutSpec {
  return {
    dojoRoot: '/path/to/dojo',
    infra: { command: 'jean infra start' },
    sensei: { name: 'sensei', command: 'jean agent start sensei' },
    workers: [
      { name: 'builder', command: 'jean agent start builder' },
      { name: 'product', command: 'jean agent start product' },
    ],
    ...opts,
  }
}

describe('buildITermLayoutScript', () => {
  test('targets the current session of the current tab (does not open a new window)', () => {
    const out = buildITermLayoutScript(spec())
    expect(out).toContain('current session of current tab of current window')
    expect(out).not.toContain('create window')
  })

  test('infra is always first and lives in the original session', () => {
    const out = buildITermLayoutScript(spec())
    const lines = out.split('\n')
    const infraLine = lines.findIndex((l) => l.includes('jean infra start'))
    const senseiLine = lines.findIndex((l) => l.includes('jean agent start sensei'))
    expect(infraLine).toBeGreaterThanOrEqual(0)
    expect(senseiLine).toBeGreaterThan(infraLine)
    expect(lines[infraLine]).toContain('s_infra')
  })

  test('three columns when sensei + workers both present', () => {
    const out = buildITermLayoutScript(spec())
    // Two vertical splits: infra → sensei, sensei → first worker.
    const verticalSplits = out.split('split vertically').length - 1
    expect(verticalSplits).toBe(2)
  })

  test('workers stack via horizontal splits, one per additional worker', () => {
    const out = buildITermLayoutScript(
      spec({
        workers: [
          { name: 'a', command: 'jean agent start a' },
          { name: 'b', command: 'jean agent start b' },
          { name: 'c', command: 'jean agent start c' },
        ],
      }),
    )
    // 3 workers → 2 horizontal splits (first worker takes the column, the
    // other two split off it).
    const horizontalSplits = out.split('split horizontally').length - 1
    expect(horizontalSplits).toBe(2)
  })

  test('skips middle column when no sensei (only workers)', () => {
    const out = buildITermLayoutScript(
      spec({
        sensei: undefined,
        workers: [{ name: 'solo', command: 'jean agent start solo' }],
      }),
    )
    expect(out).not.toContain('s_sensei')
    // Only one vertical split needed: infra → solo worker.
    const verticalSplits = out.split('split vertically').length - 1
    expect(verticalSplits).toBe(1)
  })

  test('cd-prefixes every command with the dojo root', () => {
    const out = buildITermLayoutScript(spec({ dojoRoot: '/Users/me/projects/demo' }))
    // Every command line should `cd` first.
    const writeLines = out.split('\n').filter((l) => l.includes('write text'))
    expect(writeLines.length).toBeGreaterThan(0)
    for (const line of writeLines) {
      expect(line).toContain("cd '/Users/me/projects/demo'")
    }
  })

  test('escapes embedded double-quotes in commands', () => {
    const out = buildITermLayoutScript(
      spec({
        sensei: undefined,
        workers: [{ name: 'q', command: `echo "hello"` }],
      }),
    )
    expect(out).toContain('\\"hello\\"')
  })

  test('infra-only spec (no sensei, no workers) generates valid minimal script', () => {
    const out = buildITermLayoutScript(spec({ sensei: undefined, workers: [] }))
    expect(out).toContain('jean infra start')
    expect(out).not.toContain('split vertically')
    expect(out).not.toContain('split horizontally')
  })
})
