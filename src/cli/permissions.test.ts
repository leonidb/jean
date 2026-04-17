import { describe, expect, test } from 'bun:test'
import { defaultPermissions } from './permissions.ts'

describe('defaultPermissions', () => {
  test('sensei gets send + read-only infra, no reply, no curl', () => {
    const perms = defaultPermissions('sensei')
    expect(perms).toContain('mcp__jean__send')
    expect(perms).toContain('mcp__jean__infra')
    expect(perms).not.toContain('mcp__jean__reply')
    expect(perms).not.toContain('Bash(curl:*)')
  })

  test('worker gets reply + infra + edit/write, no send', () => {
    const perms = defaultPermissions('worker')
    expect(perms).toContain('mcp__jean__reply')
    expect(perms).toContain('mcp__jean__infra')
    expect(perms).toContain('Edit')
    expect(perms).toContain('Write')
    expect(perms).not.toContain('mcp__jean__send')
    expect(perms).not.toContain('Bash(curl:*)')
  })

  test('user role mirrors worker', () => {
    expect(defaultPermissions('user')).toEqual(defaultPermissions('worker'))
  })

  test('every role includes safe read + git', () => {
    for (const role of ['sensei', 'worker', 'user'] as const) {
      const perms = defaultPermissions(role)
      expect(perms).toContain('Read')
      expect(perms).toContain('Glob')
      expect(perms).toContain('Grep')
      expect(perms).toContain('Bash(git:*)')
    }
  })
})
