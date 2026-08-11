import { describe, expect, test } from 'bun:test'
import {
  ACK_TOOL,
  buildInfraTool,
  buildInstructions,
  buildTools,
  formatInfraResponse,
  INBOX_TOOL,
  INFRA_MAX_BODY_BYTES,
  MEMORIZE_TOOL,
  REPLY_TOOL,
  resolveInboxCall,
  resolveReplyTaskId,
  SEND_TOOL,
  sendOutcome,
} from './tools.ts'

describe('buildTools', () => {
  test('sensei gets send + comment + memorize + inbox + ack + infra (no reply)', () => {
    const names = buildTools('sensei').map((t) => t.name)
    expect(names).toEqual(['send', 'comment', 'memorize', 'inbox', 'ack', 'infra'])
    expect(names).not.toContain('reply')
  })

  test('worker gets reply + comment + memorize + ack + infra (no send)', () => {
    // OLD: no ack for workers. The delivery unification (ruled 2026-08-11)
    // gave every dojo agent a mailbox, and a mailbox needs its drain: a
    // worker's queued dispatches sit in no other drainable mailbox, so
    // without `ack` the nudge ladder for them never ends.
    const names = buildTools('worker').map((t) => t.name)
    expect(names).toEqual(['reply', 'comment', 'memorize', 'inbox', 'ack', 'infra'])
    expect(names).not.toContain('send')
  })

  test('user role matches worker (non-sensei has same toolset)', () => {
    const names = buildTools('user').map((t) => t.name)
    expect(names).toEqual(['reply', 'comment', 'memorize', 'inbox', 'ack', 'infra'])
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

  test('BOTH roles are taught where codes come from and that ack clears', () => {
    // CASUALTY three times over. OLD CLAIM (pre-transition): the guidance
    // names `upToId`. FIRST REWRITE: the pair form + the fetch, sensei only —
    // workers had no mailbox to clear. SECOND (delivery unification, ruled
    // 2026-08-11): both roles taught the hand-built `GET /events` fetch.
    // THIRD (task 057): the mechanics live in the tool definitions — the
    // pair form's canonical home is ACK_TOOL's own description, and the
    // instruction text points at `inbox({view: 'fetch'})` as the code
    // source rather than a hand-built URL.
    for (const role of ['sensei', 'worker'] as const) {
      const instr = buildInstructions(role, 'x')
      expect(instr).toContain('ack')
      expect(instr).toContain('inbox')
      expect(instr).not.toContain('GET /events')
      expect(instr).not.toContain('upToId')
    }
  })
})

// ── The `inbox` tool (task 057) — the read ladder as one operation ──
//
// STATUS AT WRITING: RED — INBOX_TOOL and resolveInboxCall do not exist yet.
// The spec is task 056's three design comments; the two properties that are
// the point: (1) the ZERO-ARGUMENT call lands on the summary — 052's
// canonical opening move as the path of least resistance; (2) `fetch` is the
// only view issuing ack codes, and the 051 selectors ride it verbatim.

describe('INBOX_TOOL — one read tool, contracts only', () => {
  test('the view parameter covers the ladder, and nothing is required', () => {
    const view = (INBOX_TOOL.inputSchema.properties as Record<string, { enum?: string[] }>).view
    expect(view?.enum).toEqual(['counts', 'summary', 'grouped', 'fetch'])
    expect(INBOX_TOOL.inputSchema.required ?? []).toEqual([])
  })

  test('the description carries the load-bearing contracts', () => {
    // Contracts, not judgment: default view, codes-only-on-fetch, one
    // selector, the `missing` semantics, fetching-is-not-acking. The
    // when/why sentences live in the skills — asserting their ABSENCE by
    // keyword would be brittle, so only the contract presence is pinned.
    const d = INBOX_TOOL.description ?? ''
    expect(d).toContain("'summary' (default)")
    expect(d).toContain('ack code')
    expect(d).toContain('ONE selector')
    expect(d).toContain('missing')
    expect(d).toContain('Fetching is not acking')
  })

  test('both roles carry inbox — the mailbox is role-uniform', () => {
    for (const role of ['sensei', 'worker', 'user'] as const) {
      expect(buildTools(role).map((t) => t.name)).toContain('inbox')
    }
  })
})

describe('resolveInboxCall — the view → endpoint mapping, pure', () => {
  test('THE ZERO-ARGUMENT CALL is the summary — the canonical opening move needs no memory', () => {
    expect(resolveInboxCall({})).toEqual({ path: '/events/summary' })
  })

  test('each view maps to its endpoint', () => {
    expect(resolveInboxCall({ view: 'counts' })).toEqual({ path: '/events/counts' })
    expect(resolveInboxCall({ view: 'summary' })).toEqual({ path: '/events/summary' })
    expect(resolveInboxCall({ view: 'grouped' })).toEqual({ path: '/inbox' })
    expect(resolveInboxCall({ view: 'fetch' })).toEqual({ path: '/events' })
  })

  test('the 051 selectors ride view:fetch verbatim', () => {
    expect(resolveInboxCall({ view: 'fetch', ids: [41, 42] })).toEqual({ path: '/events?ids=41,42' })
    expect(resolveInboxCall({ view: 'fetch', from: 'chat-human' })).toEqual({ path: '/events?from=chat-human' })
    expect(resolveInboxCall({ view: 'fetch', type: 'worker:reply' })).toEqual({
      path: '/events?type=worker%3Areply',
    })
  })

  test('selector values are URL-encoded — a key is data, not path syntax', () => {
    expect(resolveInboxCall({ view: 'fetch', from: 'chat 42&x=y' })).toEqual({
      path: '/events?from=chat%2042%26x%3Dy',
    })
  })

  test('a selector without view:fetch is refused with the remedy named', () => {
    const r = resolveInboxCall({ from: 'chat-human' })
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain("view:'fetch'")
  })

  test('two selectors have no defined precedence — refused', () => {
    const r = resolveInboxCall({ view: 'fetch', ids: [1], from: 'x' })
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('one selector')
  })

  test('malformed ids are refused, not repaired — empty list, non-integers, junk', () => {
    for (const ids of [[], [1.5], ['41'], [0], [-3]]) {
      const r = resolveInboxCall({ view: 'fetch', ids })
      expect('error' in r).toBe(true)
    }
  })

  test('an empty selector string is refused', () => {
    expect('error' in resolveInboxCall({ view: 'fetch', from: '  ' })).toBe(true)
    expect('error' in resolveInboxCall({ view: 'fetch', type: '' })).toBe(true)
  })

  test('an unknown view is refused with the valid views named', () => {
    const r = resolveInboxCall({ view: 'all' })
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('counts')
  })
})

describe('buildInstructions — mechanics live in tool definitions now', () => {
  test('both roles point at the inbox tool, not at hand-built event paths', () => {
    for (const role of ['sensei', 'worker'] as const) {
      const text = buildInstructions(role, 'x')
      expect(text).toContain('`inbox`')
      // The retirement that makes the swap a compaction rather than an
      // addition: the instruction text no longer hand-builds event URLs.
      expect(text).not.toContain('GET /events')
    }
  })
})

describe('sendOutcome — queued IS a success (the unification made two success shapes)', () => {
  test('adapter-delivered and mailbox-queued both read as ok', () => {
    expect(sendOutcome({ delivered: true })).toEqual({ ok: true, queued: false })
    expect(sendOutcome({ queued: true })).toEqual({ ok: true, queued: true })
  })

  test('neither flag means the send truly failed — unknown name, offline peer', () => {
    expect(sendOutcome({})).toEqual({ ok: false, queued: false })
    expect(sendOutcome({ delivered: false })).toEqual({ ok: false, queued: false })
  })
})
