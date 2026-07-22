import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
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

  test('worker write is FENCED to its worktree (no bare Edit/Write escape)', () => {
    const wt = resolve(DOJO, 'builder')
    const { allow } = defaultPermissions('worker', DOJO, { worktree: wt })
    // Scoped to the worktree — the whole point of the fence.
    expect(allow).toContain(`Edit(${wt}/**)`)
    expect(allow).toContain(`Write(${wt}/**)`)
    // A bare grant would auto-approve writes ANYWHERE — must be absent.
    expect(allow).not.toContain('Edit')
    expect(allow).not.toContain('Write')
    expect(allow).not.toContain('Bash(curl:*)')
  })

  test('worker without a worktree falls back to bare Edit/Write (pre-fence)', () => {
    // Degenerate/test callers only — real callers always pass a worktree.
    const { allow } = defaultPermissions('worker', DOJO)
    expect(allow).toContain('Edit')
    expect(allow).toContain('Write')
  })

  test('user role mirrors worker (also fenced)', () => {
    const wt = resolve(DOJO, 'helper')
    expect(defaultPermissions('user', DOJO, { worktree: wt })).toEqual(
      defaultPermissions('worker', DOJO, { worktree: wt }),
    )
  })

  test('sensei stays workspace-only by default (no bare Edit/Write, no outbound)', () => {
    const { allow } = defaultPermissions('sensei', DOJO)
    const ws = resolve(DOJO, '.jean', 'workspace')
    expect(allow).toContain(`Edit(${ws}/**)`)
    expect(allow).not.toContain('Edit')
    expect(allow).not.toContain('Write')
    // Nothing outside the workspace is writable until a path is configured.
    expect(allow.some((r) => r.startsWith('Edit(') && !r.includes('workspace'))).toBe(false)
  })

  test('sensei outbound allowlist: senseiWritePaths widen the fence (abs + ~ + relative)', () => {
    const home = homedir()
    const { allow } = defaultPermissions('sensei', DOJO, {
      senseiWritePaths: ['/abs/drop', '~/iCloud/out', 'rel/dir'],
    })
    expect(allow).toContain('Edit(/abs/drop/**)')
    expect(allow).toContain('Write(/abs/drop/**)')
    expect(allow).toContain(`Edit(${resolve(home, 'iCloud/out')}/**)`)
    expect(allow).toContain(`Edit(${resolve(DOJO, 'rel/dir')}/**)`)
  })

  test('senseiWritePaths rejects over-broad / malformed entries', () => {
    // "" → dojo root, ".." → dojo parent — both would grant write to the whole
    // dojo (all worktrees). Must be dropped; a non-array must not throw.
    const { allow } = defaultPermissions('sensei', DOJO, {
      senseiWritePaths: ['', '  ', '..', '/legit/out'],
    })
    expect(allow).toContain('Edit(/legit/out/**)') // the good one survives
    expect(allow).not.toContain(`Edit(${DOJO}/**)`) // "" did not grant the dojo
    expect(allow).not.toContain(`Edit(${resolve(DOJO, '..')}/**)`) // ".." did not grant the parent
    // A non-array (hand-edited config) is ignored, not thrown.
    expect(() => defaultPermissions('sensei', DOJO, { senseiWritePaths: 'oops' as unknown as string[] })).not.toThrow()
  })

  test('worker CANNOT write its own authority files (no self-escalation)', () => {
    const wt = resolve(DOJO, 'builder')
    const { deny } = defaultPermissions('worker', DOJO, { worktree: wt })
    // settings.local.json (re-add bare Edit/Write), .jean-agent.json (become
    // sensei), and .mcp.json (define own server:jean) all live inside the
    // worktree — every authority surface must be denied.
    expect(deny).toContain(`Edit(${wt}/.claude/**)`)
    expect(deny).toContain(`Write(${wt}/.claude/**)`)
    expect(deny).toContain(`Edit(${wt}/.jean/**)`)
    expect(deny).toContain(`Write(${wt}/.jean/**)`)
    expect(deny).toContain(`Edit(${wt}/.mcp.json)`)
    expect(deny).toContain(`Write(${wt}/.mcp.json)`)
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

  test('workspace asymmetry: sensei gets scoped Edit/Write allow, others get deny', () => {
    const ws = resolve(DOJO, '.jean', 'workspace')

    // Sensei is the workspace's only writer — scoped allow, no deny.
    const sensei = defaultPermissions('sensei', DOJO)
    expect(sensei.allow).toContain(`Edit(${ws}/**)`)
    expect(sensei.allow).toContain(`Write(${ws}/**)`)
    for (const rule of sensei.deny) {
      expect(rule).not.toContain('workspace')
    }

    // Everyone else reads but never writes (workers, users, librarian).
    for (const role of ['worker', 'user', 'librarian'] as const) {
      const { deny } = defaultPermissions(role, DOJO)
      expect(deny).toContain(`Edit(${ws}/**)`)
      expect(deny).toContain(`Write(${ws}/**)`)
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

  test('obsoleteAllow strips a fence-defeating bare grant, keeps the scoped one', () => {
    // The migration case: an existing worker still carries bare Edit/Write;
    // sync must remove them so the new scoped fence actually bites.
    const wt = '/dojo/builder'
    const existing = {
      allow: ['mcp__jean__*', 'Read', 'Edit', 'Write', 'Bash(npm:*)'],
      deny: [],
    }
    const defaults = defaultPermissions('worker', '/dojo', { worktree: wt })
    const { merged, removedAllow } = mergePermissions(existing, defaults, { obsoleteAllow: ['Edit', 'Write'] })

    expect(removedAllow).toEqual(['Edit', 'Write'])
    expect(merged.allow).not.toContain('Edit')
    expect(merged.allow).not.toContain('Write')
    expect(merged.allow).toContain(`Edit(${wt}/**)`)
    // User customization survives the strip.
    expect(merged.allow).toContain('Bash(npm:*)')
  })

  test('obsoleteAllow never touches an already-scoped rule', () => {
    const wt = '/dojo/builder'
    const defaults = defaultPermissions('worker', '/dojo', { worktree: wt })
    // Already-fenced settings: a second sync removes nothing, adds nothing.
    const { removedAllow, addedAllow } = mergePermissions(defaults, defaults, { obsoleteAllow: ['Edit', 'Write'] })
    expect(removedAllow).toEqual([])
    expect(addedAllow).toEqual([])
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
