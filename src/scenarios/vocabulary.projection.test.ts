/**
 * VOCABULARY — `message` + `details`, and the ellipsis contract.
 * LEVEL: projection (pure — text in, text out; no clock, no registry, no server).
 *
 * CANON (013 REFERENCE DESIGN, VOCABULARY block, verbatim): "An event is
 * `message` + optional `details` — details always the complete original content,
 * never a remainder. Derived messages are first line + \" …\"; the ellipsis means
 * there is more, its absence means you've seen everything but the code."
 *
 * STATUS: RED. `src/infra/target/vocabulary.ts` throws; `details` has zero
 * references on main (042 A1/A2 — an AMBIGUITY at audit time, unblocked as
 * IN SCOPE by Leonid's ruling (b), 2026-08-05).
 *
 * ── WHY A VOCABULARY GETS ITS OWN TEST FILE ──
 *
 * 042's AMBIGUITY-1 is the reason: the views were specced as consumers of a
 * shape nobody had declared, so "the ellipsis contract ships unimplemented and
 * nobody notices, because no test can exist for a vocabulary nobody declared."
 * This file is that test existing first.
 */

import { describe, expect, test } from 'bun:test'
import { derive, ELLIPSIS, messageOf } from '../infra/target/vocabulary.ts'
import { ev } from './harness.ts'

const MULTI = 'Deployment failed on prod.\nStack trace follows:\n  at boot()\n  at main()'
const SINGLE = 'Deployment failed on prod.'

describe('derive — the ellipsis contract', () => {
  test('multi-line text derives to the first line PLUS the marker', () => {
    expect(derive(MULTI)).toBe(`Deployment failed on prod.${ELLIPSIS}`)
  })

  test('single-line text derives to ITSELF, with no marker', () => {
    // THE SECOND HALF OF THE CONTRACT, and the one that is easy to lose: the
    // marker's ABSENCE is a promise too — "you've seen everything but the code."
    // An implementation that appends the marker unconditionally passes the case
    // above and breaks this one.
    expect(derive(SINGLE)).toBe(SINGLE)
    expect(derive(SINGLE)).not.toContain(ELLIPSIS.trim())
  })

  test('a LONG single line is not truncated — width is not what the marker means', () => {
    // The marker means "there is more content", not "the line was too long for
    // your terminal". Truncating by width and marking it would make an agent
    // believe a fetch would reveal something it would not.
    const long = `${'x'.repeat(400)} end`
    expect(derive(long)).toBe(long)
  })

  test('a trailing newline alone does not mean there is more', () => {
    // `'a\n'.split('\n')` yields a second, empty element. An implementation that
    // counts lines rather than content marks this as truncated and promises
    // content that does not exist.
    expect(derive(`${SINGLE}\n`)).toBe(SINGLE)
    expect(derive(`${SINGLE}\n\n  \n`)).toBe(SINGLE)
  })

  test('deriving an already-derived message is stable', () => {
    // Renderers compose. If `derive` treated its own marker as content it would
    // grow one ellipsis per pass, and the second pass would ALSO claim there is
    // more — a promise about a promise.
    const once = derive(MULTI)
    expect(derive(once)).toBe(once)
  })

  test('total — empty and whitespace-only text answer rather than throw', () => {
    expect(derive('')).toBe('')
    expect(derive('   ')).toBe('   ')
  })
})

describe('messageOf — details is the complete original, never a remainder', () => {
  test('a multi-line event carries the WHOLE original in details', () => {
    const m = messageOf(ev('reply', 'agent-chat-human', { agent: 'chat-human', text: MULTI }))
    // THE CLAUSE THE CANON RULES OUT BY NAME. The obvious implementation is
    // message = head, details = tail; an agent reading `details` would then have
    // to reassemble the original from two fields and would never know it.
    expect(m.details).toBe(MULTI)
    expect(m.details).not.toBe(MULTI.split('\n').slice(1).join('\n'))
    expect(m.message).toBe(`Deployment failed on prod.${ELLIPSIS}`)
  })

  test('details is ABSENT when the message is already the whole of it', () => {
    // Not empty-string, not a copy: absent. `details` present-but-equal would
    // make "is there more?" a string comparison at every call site instead of a
    // presence check, and the ellipsis would stop being the answer.
    const m = messageOf(ev('reply', 'agent-chat-human', { agent: 'chat-human', text: SINGLE }))
    expect(m.message).toBe(SINGLE)
    expect(m.details).toBeUndefined()
  })

  test('the two fields agree: marker present IFF details present', () => {
    // The invariant that makes the contract usable without reading both fields.
    for (const text of [MULTI, SINGLE, '', 'one\ntwo', `${SINGLE}\n`]) {
      const m = messageOf(ev('reply', 'agent-chat-human', { agent: 'chat-human', text }))
      expect(m.message.endsWith(ELLIPSIS)).toBe(m.details !== undefined)
    }
  })

  test('an event with no text still produces a message — total, never throws', () => {
    // Machine events (register, disconnect, trigger-fired) have no `text` at
    // all, and every one of them reaches a summary line. A vocabulary that only
    // works for replies is not a vocabulary.
    const m = messageOf(ev('disconnect', 'agent-builder', { agent: 'builder' }))
    expect(typeof m.message).toBe('string')
    expect(m.message.length).toBeGreaterThan(0)
  })
})
