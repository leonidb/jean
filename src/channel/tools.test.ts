import { describe, expect, test } from 'bun:test'
import { buildInstructions, buildTools, INFRA_TOOL, REPLY_TOOL, SEND_TOOL } from './tools.ts'

/** SDK types `inputSchema.properties` as optional `Record<string, unknown>`; tests assert known shape. */
function propsOf(tool: { inputSchema: { properties?: Record<string, unknown> } }): Record<string, unknown> {
  return tool.inputSchema.properties ?? {}
}

describe('buildTools', () => {
  test('sensei gets send + infra, no reply', () => {
    const names = buildTools('sensei').map((t) => t.name)
    expect(names).toEqual(['send', 'infra'])
    expect(names).not.toContain('reply')
  })

  test('worker gets reply only', () => {
    const names = buildTools('worker').map((t) => t.name)
    expect(names).toEqual(['reply'])
  })

  test('user role matches worker (non-sensei has reply only)', () => {
    const names = buildTools('user').map((t) => t.name)
    expect(names).toEqual(['reply'])
  })
})

describe('tool shapes', () => {
  test('reply requires text only', () => {
    expect(REPLY_TOOL.inputSchema.required).toEqual(['text'])
    expect(propsOf(REPLY_TOOL).text).toBeDefined()
  })

  test('send requires to and text, taskId optional', () => {
    expect(SEND_TOOL.inputSchema.required).toEqual(['to', 'text'])
    expect(propsOf(SEND_TOOL).taskId).toBeDefined()
  })

  test('sensei infra exposes all HTTP verbs', () => {
    const method = propsOf(INFRA_TOOL).method as { enum?: string[] } | undefined
    expect(method?.enum).toEqual(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])
    expect(propsOf(INFRA_TOOL).body).toBeDefined()
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

  test('worker instructions mention reply', () => {
    const instr = buildInstructions('worker', 'scratch')
    expect(instr).toContain('scratch')
    expect(instr).toContain('`reply`')
  })
})
