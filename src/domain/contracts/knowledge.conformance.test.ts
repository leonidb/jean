/**
 * Knowledge conformance — the executable form of the knowledge contract.
 * RED BY ABSENCE until D7 lands `src/domain/knowledge/index.ts` exporting
 * `knowledge: KnowledgeContract`.
 */

import { describe, expect, test } from 'bun:test'
import { counted } from '../fixture/index.ts'
import type { KnowledgeContract, SearchDoc } from './knowledge.ts'

const IMPL_PATH: string = '../knowledge/index.ts'
const knowledge: KnowledgeContract = await import(IMPL_PATH)
  .then((m) => (m as { knowledge: KnowledgeContract }).knowledge)
  .catch((err: unknown) => {
    if (String(err).includes('Cannot find module')) {
      throw new Error(
        'RED BY ABSENCE — src/domain/knowledge/index.ts does not exist yet. ' +
          'Task D7 implements the KnowledgeContract; nothing else may (no plausible stubs — design §9).',
      )
    }
    throw err
  })

const DOCS: SearchDoc[] = [
  // The DENSE-BODY competitor comes FIRST in input order, deliberately
  // (codex pass): an implementation preserving input order, or ranking by
  // raw density, must fail the location-beats-density case below.
  {
    id: 'wiki-deploy',
    source: 'wiki',
    page: 'deployments',
    title: 'deployments',
    description: 'release and deployment procedures',
    headings: 'rollback checklist',
    body: 'telecom telecom telecom telecom telecom telecom telecom telecom — dense mentions, none of them the subject',
  },
  {
    id: 'wiki-telecom',
    source: 'wiki',
    page: 'telecom-research',
    title: 'telecom research',
    description: 'what we know about the telecom market',
    headings: 'pricing regulation',
    body: 'long body text about many things including deployment schedules',
  },
  {
    id: 'task-042-1',
    source: 'task',
    page: '042',
    title: 'task 042',
    description: 'the actor gate audit',
    headings: '',
    body: 'workers cannot close tasks; telecom appears here for the scope case',
  },
]

describe('memory admission', () => {
  test('agent + role + non-empty trimmed text admit; anything less refuses; scope defaults to dojo', () => {
    const good = knowledge.admitMemory({ agent: 'worker-a', role: 'worker', text: '  learned a thing  ' })
    expect(good.ok).toBe(true)
    if (good.ok) {
      expect(good.data.text).toBe('learned a thing') // trimmed
      expect(good.data.scope).toBe('dojo') // the default
    }
    const cases = [
      { role: 'worker' as const, text: 'x' }, // no agent
      { agent: 'a', text: 'x' }, // no role
      { agent: 'a', role: 'worker' as const, text: '   ' }, // blank text
    ]
    let refused = 0
    for (const c of cases) {
      const d = knowledge.admitMemory(c as never)
      expect(d.ok).toBe(false)
      refused++
    }
    counted('admission refusals', refused, 3)
    const user = knowledge.admitMemory({ agent: 'a', role: 'worker', text: 'x', scope: 'user' })
    expect(user.ok).toBe(true) // `user` is the one non-default scope — must admit
    if (user.ok) expect(user.data.scope).toBe('user')
  })
})

describe('scopes — absent widens, invalid refuses', () => {
  test('absent → all; the caller-facing scope names hold; a typo is a typed refusal, never a silent widen', () => {
    expect(knowledge.resolveScope(undefined)).toEqual({ ok: true, scope: 'all' })
    expect(knowledge.resolveScope(null)).toEqual({ ok: true, scope: 'all' })
    for (const s of ['all', 'knowledge', 'tasks', 'channel'] as const) {
      expect(knowledge.resolveScope(s)).toEqual({ ok: true, scope: s })
    }
    const bad = knowledge.resolveScope('knowlege')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.valid.length).toBeGreaterThan(0)
  })
})

describe('ranking — properties, not engine pins', () => {
  test('LOCATION BEATS DENSITY: the page ABOUT a topic outranks the page mentioning it in passing', () => {
    const index = knowledge.buildIndex(DOCS)
    const result = knowledge.search(index, 'telecom', { scope: 'all' })
    expect(result.empty).toBe(false)
    expect(result.hits.length).toBeGreaterThanOrEqual(2)
    const first = result.hits[0]
    expect(first?.page).toBe('telecom-research') // title/description hit wins
    // Every hit says where it lives and what that place is about.
    for (const h of result.hits) {
      expect(h.page.length).toBeGreaterThan(0)
      expect(typeof h.description).toBe('string')
    }
  })

  test('scope narrows exactly — non-vacuously; empty means definitively nothing for these terms', () => {
    const index = knowledge.buildIndex(DOCS)
    const taskOnly = knowledge.search(index, 'telecom', { scope: 'tasks' })
    expect(taskOnly.hits.length).toBeGreaterThan(0) // the fixture contains a task hit — [] would be vacuous
    expect(taskOnly.hits.every((h) => h.source === 'task')).toBe(true)
    const knowledgeScope = knowledge.search(index, 'telecom', { scope: 'knowledge' })
    expect(knowledgeScope.hits.length).toBeGreaterThan(0)
    expect(knowledgeScope.hits.every((h) => h.source === 'wiki' || h.source === 'memory')).toBe(true)
    const nothing = knowledge.search(index, 'zebra-xylophone', { scope: 'all' })
    expect(nothing.empty).toBe(true)
    expect(nothing.hits).toEqual([])
    expect(nothing.total).toBe(0)
  })

  test('topN clamps garbage instead of reaching slice() raw', () => {
    const index = knowledge.buildIndex(DOCS)
    let checked = 0
    for (const bad of [-3, 0, 0.5, Number.NaN]) {
      const r = knowledge.search(index, 'telecom', { scope: 'all', topN: bad })
      expect(r.returned).toBeGreaterThanOrEqual(1) // clamped into a sane bound
      checked++
    }
    counted('topN clamps', checked, 4)
  })
})

describe('document shaping — pure transforms; the fs walk stays adapter-side', () => {
  test('parsePage splits description, headings, body from raw page text', () => {
    const raw = [
      '---',
      'description: what this page is about',
      '---',
      '# Title',
      '',
      '## Section One',
      'body text here',
    ].join('\n')
    const parsed = knowledge.parsePage(raw)
    expect(parsed.description).toContain('what this page is about')
    expect(parsed.headings).toContain('Section One')
    expect(parsed.body).toContain('body text here')
  })

  test('memory, task and channel docs carry their sources and stable ids', () => {
    const mem = knowledge.memoryDocs([{ id: 7, text: 'a memory', agent: 'worker-a' }])
    expect(mem[0]?.source).toBe('memory')
    expect(mem[0]?.id).toContain('7')
    const tasks = knowledge.taskDocs([{ id: '042', title: 'audit', comments: ['finding one'] }])
    expect(tasks.every((d) => d.source === 'task')).toBe(true)
    const chan = knowledge.channelDocs([
      { who: 'human', text: 'how is it going' },
      { who: 'sensei', text: 'on track' },
    ])
    expect(chan.every((d) => d.source === 'channel')).toBe(true)
  })
})
