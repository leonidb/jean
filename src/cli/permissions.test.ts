import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { defaultPermissions, mergePermissions } from './permissions.ts'

const DOJO = '/tmp/test-dojo'

describe('defaultPermissions', () => {
  test('every channel-loading role allows all Jean MCP tools via wildcard', () => {
    for (const role of ['sensei', 'worker', 'user'] as const) {
      const { allow } = defaultPermissions(role, DOJO)
      expect(allow).toContain('mcp__jean__*')
    }
  })

  test('sensei has no curl', () => {
    const { allow } = defaultPermissions('sensei', DOJO)
    expect(allow).not.toContain('Bash(curl:*)')
  })

  test('worker has edit/write + no curl (per-role distinctions are filesystem, not MCP)', () => {
    const { allow } = defaultPermissions('worker', DOJO)
    expect(allow).toContain('Edit')
    expect(allow).toContain('Write')
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

describe('mergePermissions', () => {
  test('adds missing framework rules without removing user-added entries', () => {
    const existing = {
      allow: ['Read', 'Glob', 'Grep', 'Bash(npm:*)'], // user-added Bash(npm:*)
      deny: [], // pre-wiki-deny era
    }
    const defaults = defaultPermissions('sensei', '/dojo')

    const { merged, addedAllow, addedDeny } = mergePermissions(existing, defaults)

    // Preserves user customization
    expect(merged.allow).toContain('Bash(npm:*)')
    // Adds framework defaults that were missing
    expect(merged.allow).toContain('mcp__jean__*')
    // Adds the wiki deny rules
    expect(merged.deny).toContain('Edit(/dojo/.jean/context/**)')
    expect(merged.deny).toContain('Write(/dojo/.jean/context/**)')

    expect(addedAllow).toContain('mcp__jean__*')
    expect(addedDeny).toContain('Edit(/dojo/.jean/context/**)')
  })

  test('idempotent — second merge is a no-op', () => {
    const defaults = defaultPermissions('worker', '/dojo')
    const first = mergePermissions(undefined, defaults)
    const second = mergePermissions(first.merged, defaults)

    expect(second.addedAllow).toEqual([])
    expect(second.addedDeny).toEqual([])
    expect(second.merged).toEqual(first.merged)
  })

  test('handles missing existing.permissions gracefully', () => {
    const defaults = defaultPermissions('sensei', '/dojo')
    const { merged, addedAllow, addedDeny } = mergePermissions(undefined, defaults)

    expect(merged.allow).toEqual(defaults.allow)
    expect(merged.deny).toEqual(defaults.deny)
    expect(addedAllow).toEqual(defaults.allow)
    expect(addedDeny).toEqual(defaults.deny)
  })

  test('does NOT remove user-added deny rules absent from defaults', () => {
    // A user might add their own deny rules — e.g. denying a specific
    // file. Sync should leave those alone.
    const existing = {
      allow: defaultPermissions('worker', '/dojo').allow,
      deny: ['Edit(/dojo/secrets.json)'], // user-added, not in defaults
    }
    const defaults = defaultPermissions('worker', '/dojo')
    const { merged } = mergePermissions(existing, defaults)

    expect(merged.deny).toContain('Edit(/dojo/secrets.json)')
    // And framework rules still present
    expect(merged.deny).toContain('Edit(/dojo/.jean/context/**)')
  })

  test('preserves order: existing entries first, additions appended', () => {
    const existing = {
      allow: ['Bash(custom:*)', 'Read'],
      deny: [],
    }
    const defaults = defaultPermissions('sensei', '/dojo')
    const { merged } = mergePermissions(existing, defaults)

    // User's Bash(custom:*) stays at index 0 — readers can tell what's
    // user-added by reading top-down.
    expect(merged.allow[0]).toBe('Bash(custom:*)')
    expect(merged.allow[1]).toBe('Read')
  })
})
