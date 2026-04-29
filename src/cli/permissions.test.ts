import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { defaultPermissions } from './permissions.ts'

describe('defaultPermissions', () => {
  test('sensei gets send + read-only infra, no reply, no curl', () => {
    const { allow } = defaultPermissions('sensei')
    expect(allow).toContain('mcp__jean__send')
    expect(allow).toContain('mcp__jean__infra')
    expect(allow).not.toContain('mcp__jean__reply')
    expect(allow).not.toContain('Bash(curl:*)')
  })

  test('worker gets reply + infra + edit/write, no send', () => {
    const { allow } = defaultPermissions('worker')
    expect(allow).toContain('mcp__jean__reply')
    expect(allow).toContain('mcp__jean__infra')
    expect(allow).toContain('Edit')
    expect(allow).toContain('Write')
    expect(allow).not.toContain('mcp__jean__send')
    expect(allow).not.toContain('Bash(curl:*)')
  })

  test('user role mirrors worker', () => {
    expect(defaultPermissions('user')).toEqual(defaultPermissions('worker'))
  })

  test('every role includes safe read + git', () => {
    for (const role of ['sensei', 'worker', 'user'] as const) {
      const { allow } = defaultPermissions(role)
      expect(allow).toContain('Read')
      expect(allow).toContain('Glob')
      expect(allow).toContain('Grep')
      expect(allow).toContain('Bash(git:*)')
    }
  })

  test('without dojoRoot: deny is empty (backwards-compatible)', () => {
    expect(defaultPermissions('sensei').deny).toEqual([])
    expect(defaultPermissions('worker').deny).toEqual([])
    expect(defaultPermissions('user').deny).toEqual([])
  })

  test('with dojoRoot: every role denies Edit/Write on .jean/context/**', () => {
    const dojoRoot = '/tmp/test-dojo'
    const ctx = resolve(dojoRoot, '.jean', 'context')
    for (const role of ['sensei', 'worker', 'user'] as const) {
      const { deny } = defaultPermissions(role, dojoRoot)
      expect(deny).toContain(`Edit(${ctx}/**)`)
      expect(deny).toContain(`Write(${ctx}/**)`)
    }
  })

  test('librarian: gets Edit/Write allow, no deny on context (it IS the writer)', () => {
    const dojoRoot = '/tmp/test-dojo'
    const { allow, deny } = defaultPermissions('librarian', dojoRoot)

    // The librarian is the only role that may write the wiki, so its allow
    // includes Edit + Write and its deny does NOT block .jean/context/**.
    expect(allow).toContain('Edit')
    expect(allow).toContain('Write')
    expect(allow).toContain('Read')

    // No deny anywhere on .jean/context — the very thing this role exists to do.
    for (const rule of deny) {
      expect(rule).not.toContain('.jean/context')
      expect(rule).not.toContain('.jean/.consolidator')
    }
  })

  test('librarian: no MCP tools at all (runs without channel plugin)', () => {
    const { allow } = defaultPermissions('librarian', '/tmp/test-dojo')
    for (const rule of allow) {
      expect(rule.startsWith('mcp__')).toBe(false)
    }
  })

  test('librarian: includes Bash(curl) for infra HTTP calls', () => {
    const { allow } = defaultPermissions('librarian', '/tmp/test-dojo')
    expect(allow).toContain('Bash(curl:*)')
  })

  test('with dojoRoot: deny paths are absolute (not relative)', () => {
    // Relative paths in deny rules would resolve against the agent's
    // working directory, not the dojo root — making the deny brittle if
    // the agent runs from a worktree subdir. Always use absolute.
    const { deny } = defaultPermissions('worker', '/some/where/dojo')
    for (const rule of deny) {
      expect(rule).toMatch(/^(Edit|Write)\(\//)
    }
  })
})
