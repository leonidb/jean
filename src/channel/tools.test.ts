import { describe, expect, test } from 'bun:test'
import {
  ACK_TOOL,
  buildInfraTool,
  buildInstructions,
  buildTools,
  formatInfraResponse,
  INFRA_MAX_BODY_BYTES,
  MEMORIZE_TOOL,
  REPLY_TOOL,
  resolveReplyTaskId,
  SEND_TOOL,
} from './tools.ts'

describe('buildTools', () => {
  test('sensei gets send + comment + memorize + ack + infra (no reply)', () => {
    const names = buildTools('sensei').map((t) => t.name)
    expect(names).toEqual(['send', 'comment', 'memorize', 'ack', 'infra'])
    expect(names).not.toContain('reply')
  })

  test('worker gets reply + comment + memorize + ack + infra (no send)', () => {
    // OLD: no ack for workers. The delivery unification (ruled 2026-08-11)
    // gave every dojo agent a mailbox, and a mailbox needs its drain: a
    // worker's queued dispatches sit in no other drainable mailbox, so
    // without `ack` the nudge ladder for them never ends.
    const names = buildTools('worker').map((t) => t.name)
    expect(names).toEqual(['reply', 'comment', 'memorize', 'ack', 'infra'])
    expect(names).not.toContain('send')
  })

  test('user role matches worker (non-sensei has same toolset)', () => {
    const names = buildTools('user').map((t) => t.name)
    expect(names).toEqual(['reply', 'comment', 'memorize', 'ack', 'infra'])
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

  test('memorize requires text; scope and taskId optional', () => {
    expect(MEMORIZE_TOOL.inputSchema.required).toEqual(['text'])
    const props = propsOf(MEMORIZE_TOOL)
    expect(props.text).toBeDefined()
    expect(props.scope).toBeDefined()
    expect(props.taskId).toBeDefined()
  })

  test('memorize scope is enum dojo|user', () => {
    const scope = propsOf(MEMORIZE_TOOL).scope as { enum?: string[] }
    expect(scope.enum).toEqual(['dojo', 'user'])
  })

  test('ack takes ONE form: pairs of {id, code}', () => {
    // CASUALTY (043 part 3, executed at the transition — task 045).
    // OLD CLAIM: the schema requires NOTHING, because exactly-one-of
    // `upToId | ids` cannot be expressed in JSON Schema and `required:
    // ['upToId']` would have made the selective form schema-invalid.
    // NEW CLAIM: there is one form, so it is simply required. Scenario 5 makes
    // `{id, code}` pairs the only clearing path — an id is knowable from a
    // cheap summary line and a code is not, which is the whole of
    // read-before-ack. The awkwardness the old test documented was a symptom of
    // a two-form contract that no longer exists.
    expect(ACK_TOOL.inputSchema.required).toEqual(['pairs'])
    const props = propsOf(ACK_TOOL)
    expect((props.pairs as { type: string }).type).toBe('array')
    expect(props.upToId).toBeUndefined()
    expect(props.ids).toBeUndefined()
    // The code is per EVENT, so it lives on the item, not on the call.
    const item = (props.pairs as { items: { required: string[] } }).items
    expect(item.required.sort()).toEqual(['code', 'id'])
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

describe('formatInfraResponse', () => {
  test('2xx success returns body raw, no status prefix, not an error', () => {
    const res = formatInfraResponse(200, 'OK', '{"tasks":[]}')
    expect(res.text).toBe('{"tasks":[]}')
    expect(res.isError).toBe(false)
  })

  test('201 Created also treated as success', () => {
    const res = formatInfraResponse(201, 'Created', '{"id":"001"}')
    expect(res.text).toBe('{"id":"001"}')
    expect(res.isError).toBe(false)
  })

  test('4xx error prepends the status line and flags isError', () => {
    const res = formatInfraResponse(404, 'Not Found', '{"error":"not found"}')
    expect(res.text).toBe('404 Not Found\n{"error":"not found"}')
    expect(res.isError).toBe(true)
  })

  test('5xx error prepends status and flags isError', () => {
    const res = formatInfraResponse(500, 'Internal Server Error', '')
    expect(res.text).toBe('500 Internal Server Error\n')
    expect(res.isError).toBe(true)
  })

  test('long body is truncated with a pagination hint', () => {
    const bigBody = 'x'.repeat(INFRA_MAX_BODY_BYTES + 500)
    const res = formatInfraResponse(200, 'OK', bigBody)
    expect(res.text.length).toBeLessThan(bigBody.length)
    expect(res.text).toContain('[truncated: 500 more chars')
    expect(res.isError).toBe(false)
  })

  test('truncation applies on error too, with status prefix still present', () => {
    const bigBody = 'y'.repeat(INFRA_MAX_BODY_BYTES + 100)
    const res = formatInfraResponse(400, 'Bad Request', bigBody)
    expect(res.text.startsWith('400 Bad Request\n')).toBe(true)
    expect(res.text).toContain('[truncated: 100 more chars')
    expect(res.isError).toBe(true)
  })

  test('body at exactly the limit is NOT truncated', () => {
    const body = 'z'.repeat(INFRA_MAX_BODY_BYTES)
    const res = formatInfraResponse(200, 'OK', body)
    expect(res.text).toBe(body)
    expect(res.text).not.toContain('[truncated')
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

  test('BOTH roles are taught the pair form and the fetch that precedes it', () => {
    // CASUALTY twice over. OLD CLAIM (pre-transition): the guidance names
    // `upToId`. FIRST REWRITE: the pair form + the fetch, sensei only —
    // workers had no mailbox to drain. SECOND (delivery unification, ruled
    // 2026-08-11): workers have mailboxes and the ack tool now, so guidance
    // that stayed sensei-only would leave every worker nudged forever about a
    // queue it was never taught to clear.
    for (const role of ['sensei', 'worker'] as const) {
      const instr = buildInstructions(role, 'x')
      expect(instr).toContain('ack(')
      expect(instr).toContain('pairs')
      expect(instr).toContain('GET /events')
      expect(instr).not.toContain('upToId')
    }
  })
})
