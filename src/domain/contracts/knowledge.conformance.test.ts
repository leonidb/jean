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

/** Build and unwrap — the fixture's docs are duplicate-free by construction. */
function index(docs: SearchDoc[]) {
  const built = knowledge.buildIndex(docs)
  if (!built.ok) throw new Error(`fixture: duplicate id ${built.refusal.id}`)
  return built.index
}

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
    const idx = index(DOCS)
    const result = knowledge.search(idx, 'telecom', { scope: 'all' })
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
    const idx = index(DOCS)
    const taskOnly = knowledge.search(idx, 'telecom', { scope: 'tasks' })
    expect(taskOnly.hits.length).toBeGreaterThan(0) // the fixture contains a task hit — [] would be vacuous
    expect(taskOnly.hits.every((h) => h.source === 'task')).toBe(true)
    const knowledgeScope = knowledge.search(idx, 'telecom', { scope: 'knowledge' })
    expect(knowledgeScope.hits.length).toBeGreaterThan(0)
    expect(knowledgeScope.hits.every((h) => h.source === 'wiki' || h.source === 'memory')).toBe(true)
    const nothing = knowledge.search(idx, 'zebra-xylophone', { scope: 'all' })
    expect(nothing.empty).toBe(true)
    expect(nothing.hits).toEqual([])
    expect(nothing.total).toBe(0)
  })

  test('topN clamps garbage instead of reaching slice() raw', () => {
    const idx = index(DOCS)
    let checked = 0
    for (const bad of [-3, 0, 0.5, Number.NaN]) {
      const r = knowledge.search(idx, 'telecom', { scope: 'all', topN: bad })
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

describe('the 096 batch — five pins and the three rulings', () => {
  test('PIN 1 (the serious one): a stopwords-only query is EMPTY — never "everything matched"', () => {
    const idx = index(DOCS)
    const r = knowledge.search(idx, 'the and of a', { scope: 'all' })
    expect(r.empty).toBe(true)
    expect(r.hits).toEqual([])
  })

  test('PIN 2: channelDocs with zero and negative windows terminates and still yields docs', () => {
    const messages = [
      { who: 'human', text: 'one' },
      { who: 'sensei', text: 'two' },
      { who: 'worker', text: 'three' },
    ]
    let checked = 0
    for (const win of [0, -4]) {
      const docs = knowledge.channelDocs(messages, win)
      expect(Array.isArray(docs)).toBe(true)
      expect(docs.length).toBeGreaterThan(0)
      checked++
    }
    counted('window clamps', checked, 2)
  })

  test('PIN 3: an unrecognised scope reaching search matches NOTHING — visible failure, never a silent widen', () => {
    const idx = index(DOCS)
    const r = knowledge.search(idx, 'telecom', { scope: 'knowlege' as never })
    expect(r.hits).toEqual([])
    expect(r.empty).toBe(true)
  })

  test('RULED: resolveScope("") REFUSES — an empty string is a sent value, not absence (per-field polarity)', () => {
    const d = knowledge.resolveScope('')
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.valid.length).toBeGreaterThan(0)
  })

  test('PIN 5 + coverage-as-ordering: repeated query terms change nothing, and same-tier coverage outranks density', () => {
    const idx = index(DOCS)
    const once = knowledge.search(idx, 'telecom', { scope: 'all' })
    const thrice = knowledge.search(idx, 'telecom telecom telecom', { scope: 'all' })
    expect(thrice.hits.map((h) => h.id)).toEqual(once.hits.map((h) => h.id))
    // Same field tier (body-only): two distinct terms beat one term repeated.
    const tier: SearchDoc[] = [
      {
        id: 'a-dense-one-term', // sorts FIRST: a tie-break win by id would pick this, so covers-both winning proves SCORE (codex pass)
        source: 'wiki',
        page: 'dense',
        title: 'unrelated words here',
        description: 'unrelated description',
        headings: '',
        body: 'harbour harbour harbour harbour harbour harbour harbour harbour',
      },
      {
        id: 'z-covers-both',
        source: 'wiki',
        page: 'covers',
        title: 'different unrelated words',
        description: 'another unrelated description',
        headings: '',
        body: 'harbour lighthouse mentioned together exactly once',
      },
    ]
    const r = knowledge.search(index(tier), 'harbour lighthouse', { scope: 'all' })
    expect(r.hits[0]?.id).toBe('z-covers-both')
    // And the dense doc is PRESENT — a coverage FLOOR dropping it would be
    // the invented policy the ruling declines (codex pass: pins causality).
    expect(r.hits.map((h) => h.id)).toContain('a-dense-one-term')
  })

  test('RULED: duplicate document ids REFUSE loudly, naming the first duplicate — silent keeping is silent repair', () => {
    const dup = knowledge.buildIndex([
      ...DOCS,
      { id: 'wiki-deploy', source: 'wiki', page: 'x', title: 'x', description: '', headings: '', body: '' },
    ])
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.refusal).toEqual({ kind: 'duplicate-doc-id', id: 'wiki-deploy' })
  })
})
