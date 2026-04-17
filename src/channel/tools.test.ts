import { describe, expect, test } from 'bun:test'
import { buildInfraTool, buildInstructions, buildTools, REPLY_TOOL, resolveReplyTaskId, SEND_TOOL } from './tools.ts'

describe('buildTools', () => {
  test('sensei gets send + comment + infra (no reply — sensei messages have explicit recipients)', () => {
    const names = buildTools('sensei').map((t) => t.name)
    expect(names).toEqual(['send', 'comment', 'infra'])
    expect(names).not.toContain('reply')
  })

  test('worker gets reply + comment + infra (no send — only sensei routes messages)', () => {
    const names = buildTools('worker').map((t) => t.name)
    expect(names).toEqual(['reply', 'comment', 'infra'])
    expect(names).not.toContain('send')
  })

  test('user role matches worker (non-sensei has same toolset)', () => {
    const names = buildTools('user').map((t) => t.name)
    expect(names).toEqual(['reply', 'comment', 'infra'])
  })
})

/** SDK types `inputSchema.properties` as optional `Record<string, unknown>`; tests assert known shape. */
function methodEnumOf(tool: { inputSchema: { properties?: Record<string, unknown> } }): string[] {
  const method = tool.inputSchema.properties?.method as { enum?: string[] } | undefined
  return method?.enum ?? []
}

function propsOf(tool: { inputSchema: { properties?: Record<string, unknown> } }): Record<string, unknown> {
  return tool.inputSchema.properties ?? {}
}

describe('buildInfraTool', () => {
  test('sensei infra exposes all HTTP verbs', () => {
    const tool = buildInfraTool('sensei')
    expect(methodEnumOf(tool)).toEqual(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])
    expect(propsOf(tool).body).toBeDefined()
  })

  test('worker infra is GET-only', () => {
    const tool = buildInfraTool('worker')
    expect(methodEnumOf(tool)).toEqual(['GET'])
    expect(propsOf(tool).body).toBeUndefined()
  })

  test('user infra is GET-only (same as worker)', () => {
    expect(methodEnumOf(buildInfraTool('user'))).toEqual(['GET'])
  })
})

describe('tool shapes', () => {
  test('reply requires text only; taskId is optional', () => {
    expect(REPLY_TOOL.inputSchema.required).toEqual(['text'])
    expect(propsOf(REPLY_TOOL).text).toBeDefined()
    expect(propsOf(REPLY_TOOL).taskId).toBeDefined()
  })

  test('send requires to and text, taskId optional', () => {
    expect(SEND_TOOL.inputSchema.required).toEqual(['to', 'text'])
    expect(propsOf(SEND_TOOL).taskId).toBeDefined()
  })
})

describe('resolveReplyTaskId', () => {
  test('explicit arg wins over the last-deliver fallback', () => {
    expect(resolveReplyTaskId({ taskId: '020' }, '018')).toBe('020')
  })

  test('falls back to last-deliver when no explicit arg', () => {
    expect(resolveReplyTaskId({}, '018')).toBe('018')
  })

  test('trims whitespace around explicit arg', () => {
    expect(resolveReplyTaskId({ taskId: '  020  ' }, '018')).toBe('020')
  })

  test('empty-string explicit is ignored (falls back)', () => {
    expect(resolveReplyTaskId({ taskId: '' }, '018')).toBe('018')
    expect(resolveReplyTaskId({ taskId: '   ' }, '018')).toBe('018')
  })

  test('non-string explicit is ignored', () => {
    expect(resolveReplyTaskId({ taskId: 42 }, '018')).toBe('018')
    expect(resolveReplyTaskId({ taskId: null }, '018')).toBe('018')
  })

  test('returns undefined when neither source has a value', () => {
    expect(resolveReplyTaskId({}, undefined)).toBeUndefined()
    expect(resolveReplyTaskId({ taskId: '' }, undefined)).toBeUndefined()
  })
})

describe('buildInstructions', () => {
  test('sensei instructions mention send and infra but not reply', () => {
    const instr = buildInstructions('sensei', 'my-sensei')
    expect(instr).toContain('my-sensei')
    expect(instr).toContain('`send`')
    expect(instr).toContain('`infra`')
    expect(instr).not.toContain('`reply`')
  })

  test('worker instructions mention reply and infra with read-only note', () => {
    const instr = buildInstructions('worker', 'scratch')
    expect(instr).toContain('scratch')
    expect(instr).toContain('`reply`')
    expect(instr).toContain('`infra`')
    expect(instr).toContain('read-only')
  })

  test('worker instructions steer state changes back to sensei', () => {
    const instr = buildInstructions('worker', 'x')
    expect(instr).toContain("sensei's job")
  })
})
