import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { defaultPermissions } from './permissions.ts'

const DOJO = '/tmp/test-dojo'

describe('defaultPermissions', () => {
  test('sensei gets send + read-only infra, no reply, no curl', () => {
    const { allow } = defaultPermissions('sensei', DOJO)
    expect(allow).toContain('mcp__jean__send')
    expect(allow).toContain('mcp__jean__infra')
    expect(allow).not.toContain('mcp__jean__reply')
    expect(allow).not.toContain('Bash(curl:*)')
  })

  test('worker gets reply + infra + edit/write, no send', () => {
    const { allow } = defaultPermissions('worker', DOJO)
    expect(allow).toContain('mcp__jean__reply')
    expect(allow).toContain('mcp__jean__infra')
    expect(allow).toContain('Edit')
    expect(allow).toContain('Write')
    expect(allow).not.toContain('mcp__jean__send')
    expect(allow).not.toContain('Bash(curl:*)')
  })

  test('user role mirrors worker', () => {
    expect(defaultPermissions('user', DOJO)).toEqual(defaultPermissions('worker', DOJO))
  })

  test('every role includes safe read + git', () => {
    for (const role of ['sensei', 'worker', 'user'] as const) {
      const { allow } = defaultPermissions(role, DOJO)
      expect(allow).toContain('Read')
      expect(allow).toContain('Glob')
      expect(allow).toContain('Grep')
      expect(allow).toContain('Bash(git:*)')
    }
  })

  test('with dojoRoot: every role denies Edit/Write on .jean/context/**', () => {
    const ctx = resolve(DOJO, '.jean', 'context')
    for (const role of ['sensei', 'worker', 'user'] as const) {
      const { deny } = defaultPermissions(role, DOJO)
      expect(deny).toContain(`Edit(${ctx}/**)`)
      expect(deny).toContain(`Write(${ctx}/**)`)
    }
  })

  test('librarian: gets Edit/Write allow, no deny on context (it IS the writer)', () => {
    const { allow, deny } = defaultPermissions('librarian', DOJO)

    // The librarian is the only role that may write the wiki, so its allow
    // includes Edit + Write and its deny does NOT block .jean/context/**.
    expect(allow).toContain('Edit')
    expect(allow).toContain('Write')
    expect(allow).toContain('Read')

    // No deny on .jean/context — the very thing this role exists to do.
    for (const rule of deny) {
      expect(rule).not.toContain('.jean/context')
      expect(rule).not.toContain('.jean/.consolidator')
    }
  })

  test('librarian: deny Edit/Write on .jean/raw_context/** (immutable sources)', () => {
    const { deny } = defaultPermissions('librarian', DOJO)
    const rawCtx = resolve(DOJO, '.jean', 'raw_context')
    expect(deny).toContain(`Edit(${rawCtx}/**)`)
    expect(deny).toContain(`Write(${rawCtx}/**)`)
  })

  test('librarian: no MCP tools at all (runs without channel plugin)', () => {
    const { allow } = defaultPermissions('librarian', DOJO)
    for (const rule of allow) {
      expect(rule.startsWith('mcp__')).toBe(false)
    }
  })

  test('librarian: includes Bash(curl) for infra HTTP calls', () => {
    const { allow } = defaultPermissions('librarian', DOJO)
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
