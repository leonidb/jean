/**
 * Playbooks conformance — the executable form of the playbooks contract.
 * RED BY ABSENCE until D-PB lands `src/domain/playbooks/index.ts` exporting
 * `playbooks: PlaybooksContract`.
 *
 * Aimed per the standing checklist: the indirectly-visible state here is
 * `createdAt` retention through updates and the registry's first-recorded
 * order (nothing returns them directly — they show through the views after
 * sequences); the unassumed inputs are the two tolerance rulings, malformed
 * records, and reconcile reruns; the mirror question is reconcile
 * idempotence — a quiet directory must emit ZERO events, or every watcher
 * debounce floods the log.
 */

import { describe, expect, test } from 'bun:test'
import { counted, createClock, createLog } from '../fixture/index.ts'
import type { PlaybooksContract } from './playbooks.ts'

const IMPL_PATH: string = '../playbooks/index.ts'
const playbooks: PlaybooksContract = await import(IMPL_PATH)
  .then((m) => (m as { playbooks: PlaybooksContract }).playbooks)
  .catch((err: unknown) => {
    if (String(err).includes('Cannot find module')) {
      throw new Error(
        'RED BY ABSENCE — src/domain/playbooks/index.ts does not exist yet. ' +
          'Task D-PB implements the PlaybooksContract; nothing else may (no plausible stubs — design §9).',
      )
    }
    throw err
  })

const NAMED = ['---', 'name: Deploy Checklist', 'description: how we ship', '---', '', '# Steps', 'do the steps'].join(
  '\n',
)
const NAMELESS = ['---', 'description: no name here', '---', 'body only'].join('\n')
const FOLDED = [
  '---',
  'name: folded',
  'description: >',
  '  first folded line',
  '  second folded line',
  '---',
  'body',
].join('\n')
const BARE = 'no frontmatter at all, just text'

function build() {
  return createLog(createClock())
}

describe('parsePlaybook — a pure transform; the id fallback is the fold’s, not the parser’s', () => {
  test('name and description extract; the folded `>` form joins its indented lines; absence is empty string', () => {
    expect(playbooks.parsePlaybook(NAMED)).toEqual({ name: 'Deploy Checklist', description: 'how we ship' })
    expect(playbooks.parsePlaybook(NAMELESS)).toEqual({ name: '', description: 'no name here' })
    expect(playbooks.parsePlaybook(FOLDED)).toEqual({
      name: 'folded',
      description: 'first folded line second folded line',
    })
    expect(playbooks.parsePlaybook(BARE)).toEqual({ name: '', description: '' })
  })
})

describe('the fold — CRUD over the registry, with the views agreeing', () => {
  test('created → listed and gettable, frontmatter applied, the NAMELESS one falling back to its id', () => {
    const log = build()
    let s = playbooks.initial()
    s = playbooks.fold(s, log.append('playbook-created', 'playbooks', { id: 'deploy', content: NAMED, hash: 'h1' }))
    s = playbooks.fold(s, log.append('playbook-created', 'playbooks', { id: 'notes', content: NAMELESS, hash: 'h2' }))

    expect(playbooks.all(s).map((p) => p.id)).toEqual(['deploy', 'notes'])
    expect(playbooks.all(s).map((p) => p.name)).toEqual(['Deploy Checklist', 'notes']) // the id fallback
    const deploy = playbooks.playbookOf(s, 'deploy')
    expect(deploy?.content).toBe(NAMED)
    expect(deploy?.hash).toBe('h1')
    expect(deploy?.description).toBe('how we ship')
    // The list is deliberately content-free — the cheap read stays cheap.
    for (const row of playbooks.all(s)) expect(row).not.toHaveProperty('content')
  })

  test('updated → content, hash, name and updatedAt move; createdAt and the list position do NOT (the indirect state)', () => {
    const clock = createClock()
    const log = createLog(clock)
    let s = playbooks.initial()
    const created = log.append('playbook-created', 'playbooks', { id: 'deploy', content: NAMED, hash: 'h1' })
    s = playbooks.fold(s, created)
    s = playbooks.fold(s, log.append('playbook-created', 'playbooks', { id: 'zz', content: BARE, hash: 'z1' }))
    clock.advance(60_000)
    const rewritten = ['---', 'name: Deploy v2', 'description: faster now', '---', 'new steps'].join('\n')
    s = playbooks.fold(
      s,
      log.append('playbook-updated', 'playbooks', { id: 'deploy', content: rewritten, hash: 'h2', prevHash: 'h1' }),
    )

    const deploy = playbooks.playbookOf(s, 'deploy')
    expect(deploy?.name).toBe('Deploy v2')
    expect(deploy?.content).toBe(rewritten)
    expect(deploy?.hash).toBe('h2')
    expect(deploy?.createdAt).toBe(created.ts) // retained through the update
    expect(deploy?.updatedAt).not.toBe(created.ts)
    expect(playbooks.all(s).map((p) => p.id)).toEqual(['deploy', 'zz']) // first-recorded order, stable
  })

  test('removed → gone from both views; removing the unknown is a no-op, never a crash', () => {
    const log = build()
    let s = playbooks.initial()
    s = playbooks.fold(s, log.append('playbook-created', 'playbooks', { id: 'deploy', content: NAMED, hash: 'h1' }))
    s = playbooks.fold(s, log.append('playbook-removed', 'playbooks', { id: 'deploy', lastHash: 'h1' }))
    expect(playbooks.all(s)).toEqual([])
    expect(playbooks.playbookOf(s, 'deploy')).toBeUndefined()
    s = playbooks.fold(s, log.append('playbook-removed', 'playbooks', { id: 'never-was', lastHash: 'x' }))
    expect(playbooks.all(s)).toEqual([])
  })
})

describe('tolerance rulings — the content-preserving direction (extraction decisions, task 105)', () => {
  test('RULED: created for a KNOWN id REPLACES — one entry, the latest content; two entries sharing an id is an impossible registry', () => {
    const log = build()
    let s = playbooks.initial()
    s = playbooks.fold(s, log.append('playbook-created', 'playbooks', { id: 'deploy', content: NAMED, hash: 'h1' }))
    s = playbooks.fold(s, log.append('playbook-created', 'playbooks', { id: 'deploy', content: BARE, hash: 'h9' }))
    expect(playbooks.all(s).length).toBe(1) // the old fold showed two
    expect(playbooks.playbookOf(s, 'deploy')?.content).toBe(BARE)
    expect(playbooks.playbookOf(s, 'deploy')?.hash).toBe('h9')
  })

  test('RULED: updated for an UNKNOWN id CREATES (upsert) — the old fold dropped the content forever', () => {
    const log = build()
    let s = playbooks.initial()
    const e = log.append('playbook-updated', 'playbooks', {
      id: 'orphan',
      content: NAMED,
      hash: 'h5',
      prevHash: 'gone',
    })
    s = playbooks.fold(s, e)
    const orphan = playbooks.playbookOf(s, 'orphan')
    expect(orphan?.content).toBe(NAMED)
    expect(orphan?.createdAt).toBe(e.ts) // honestly the upsert's instant
  })

  test('malformed records fold to NOTHING — no id, or a non-string body, cannot act (per-field polarity)', () => {
    const log = build()
    let s = playbooks.initial()
    const malformed = [
      log.appendRaw('playbook-created', 'playbooks', { content: NAMED, hash: 'h' }), // no id
      log.appendRaw('playbook-created', 'playbooks', { id: 'x', hash: 'h' }), // no content
      log.appendRaw('playbook-created', 'playbooks', { id: 'y', content: 42, hash: 'h' }), // body not text
      log.appendRaw('playbook-created', 'playbooks', null), // no data at all
    ]
    let checked = 0
    for (const e of malformed) {
      s = playbooks.fold(s, e)
      checked++
    }
    expect(playbooks.all(s)).toEqual([])
    counted('malformed records tolerated', checked, 4)
    // …and an unrelated kind on the same stream is simply not this module’s.
    s = playbooks.fold(s, log.appendRaw('kind-from-the-future', 'playbooks', { id: 'z', content: 'x', hash: 'h' }))
    expect(playbooks.all(s)).toEqual([])
  })

  test('malformed UPDATED and REMOVED records also fold to nothing — and never clobber the entry they name (codex pass)', () => {
    const log = build()
    let s = playbooks.initial()
    s = playbooks.fold(s, log.append('playbook-created', 'playbooks', { id: 'deploy', content: NAMED, hash: 'h1' }))
    const before = playbooks.playbookOf(s, 'deploy')
    const malformed = [
      log.appendRaw('playbook-updated', 'playbooks', { id: 'deploy', hash: 'h9' }), // no content — must not clobber
      log.appendRaw('playbook-updated', 'playbooks', { content: BARE, hash: 'h9' }), // no id — nothing to act on
      log.appendRaw('playbook-removed', 'playbooks', {}), // no id — must not remove anything
      log.appendRaw('playbook-removed', 'playbooks', null),
    ]
    let checked = 0
    for (const e of malformed) {
      s = playbooks.fold(s, e)
      checked++
    }
    counted('malformed update/remove records tolerated', checked, 4)
    expect(playbooks.all(s).length).toBe(1)
    expect(playbooks.playbookOf(s, 'deploy')).toEqual(before) // untouched, byte for byte
  })
})

describe('the task-include seam — composed by the shell from the two owning modules', () => {
  test('a known ID yields {id, name, content}; unknown and EMPTY references yield undefined (empty Task.playbook = absent)', () => {
    const log = build()
    let s = playbooks.initial()
    s = playbooks.fold(s, log.append('playbook-created', 'playbooks', { id: 'deploy', content: NAMED, hash: 'h1' }))
    expect(playbooks.includeFor(s, 'deploy')).toEqual({ id: 'deploy', name: 'Deploy Checklist', content: NAMED })
    // Matched by ID, never by the frontmatter name — Task.playbook carries
    // the filename-derived identity (the old adapter's find-by-id).
    expect(playbooks.includeFor(s, 'Deploy Checklist')).toBeUndefined()
    expect(playbooks.includeFor(s, 'no-such')).toBeUndefined()
    expect(playbooks.includeFor(s, '')).toBeUndefined()
    expect(playbooks.includeFor(s, undefined)).toBeUndefined()
  })
})

describe('decideReconcile — the watcher’s pure half; idempotent by construction', () => {
  test('new files create, changed hashes update (carrying prevHash), vanished entries remove (carrying lastHash)', () => {
    const log = build()
    let s = playbooks.initial()
    s = playbooks.fold(s, log.append('playbook-created', 'playbooks', { id: 'keep', content: NAMED, hash: 'k1' }))
    s = playbooks.fold(s, log.append('playbook-created', 'playbooks', { id: 'stale', content: BARE, hash: 's1' }))
    s = playbooks.fold(s, log.append('playbook-created', 'playbooks', { id: 'gone', content: BARE, hash: 'g1' }))

    const decided = playbooks.decideReconcile(s, [
      { id: 'keep', content: NAMED, hash: 'k1' }, // unchanged — must emit nothing
      { id: 'stale', content: NAMELESS, hash: 's2' }, // hash moved — update
      { id: 'fresh', content: FOLDED, hash: 'f1' }, // unknown — create
      // 'gone' has no file — remove
    ])
    // EXACT order, not membership: creations and updates in FILE order,
    // then removals (the old watcher's order, stated by the contract —
    // codex pass: a sorted comparison let removals lead).
    expect(decided.map((e) => e.type)).toEqual(['playbook-updated', 'playbook-created', 'playbook-removed'])
    const update = decided.find((e) => e.type === 'playbook-updated')
    expect(update?.data).toEqual({ id: 'stale', content: NAMELESS, hash: 's2', prevHash: 's1' })
    const create = decided.find((e) => e.type === 'playbook-created')
    expect(create?.data).toEqual({ id: 'fresh', content: FOLDED, hash: 'f1' })
    const remove = decided.find((e) => e.type === 'playbook-removed')
    expect(remove?.data).toEqual({ id: 'gone', lastHash: 'g1' })
  })

  test('THE HASH IS THE FACT (codex pass): the diff compares hashes, never bodies — both directions pinned', () => {
    const log = build()
    let s = playbooks.initial()
    s = playbooks.fold(s, log.append('playbook-created', 'playbooks', { id: 'deploy', content: NAMED, hash: 'h1' }))
    // Same body, NEW hash → an update (a body-comparing reconciler skips it).
    const rehashed = playbooks.decideReconcile(s, [{ id: 'deploy', content: NAMED, hash: 'h2' }])
    expect(rehashed.map((e) => e.type)).toEqual(['playbook-updated'])
    // Different body, SAME hash → nothing (the domain never hashes and never
    // second-guesses the write site's fact — R10).
    const sameHash = playbooks.decideReconcile(s, [{ id: 'deploy', content: BARE, hash: 'h1' }])
    expect(sameHash).toEqual([])
  })

  test('THE MIRROR: a quiet directory emits ZERO events — and folding a reconcile’s output makes the next reconcile quiet', () => {
    const log = build()
    let s = playbooks.initial()
    const files = [
      { id: 'a', content: NAMED, hash: 'a1' },
      { id: 'b', content: FOLDED, hash: 'b1' },
    ]
    // First pass over an empty registry: everything creates.
    const first = playbooks.decideReconcile(s, files)
    expect(first.length).toBe(2)
    for (const e of first) s = playbooks.fold(s, log.appendRaw(e.type, 'playbooks', e.data))
    // Second pass over the SAME files: nothing — a watcher debounce rerun
    // appends zero events, or every quiet tick floods the log.
    expect(playbooks.decideReconcile(s, files)).toEqual([])
    // Empty everywhere is quiet too, not an error.
    expect(playbooks.decideReconcile(playbooks.initial(), [])).toEqual([])
  })
})
