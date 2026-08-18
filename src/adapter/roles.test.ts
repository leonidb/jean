/**
 * The ROLES pin — E1's second named gap, closed (task E2).
 *
 * The register frame's role is validated against a list the adapter keeps by
 * hand, and the list must stay in step with the vocabulary's `AgentRole`. A
 * role added to the vocabulary and not here is REFUSED at the socket with
 * `invalid-role`: the dojo grows a role, an agent tries to register under it,
 * and the answer is a closed connection with no clue in it.
 *
 * ── THE PIN IS THE TYPE; THIS FILE COVERS THE HOLE THE TYPE LEAVES ──
 *
 * `ROLES` is now built from `Record<AgentRole, true>`, so a missing key and
 * an extra key are both compile errors — the drift cannot be committed. That
 * is a better guard than any test, and it is why the list is a table rather
 * than a `new Set([...])`.
 *
 * What a `Record<AgentRole, true>` cannot see is `AgentRole` being WIDENED —
 * to `string`, or to include a template type — at which point the table
 * accepts anything and stops constraining. So this file reads the union out
 * of the vocabulary's own source and compares. It is a narrow test with a
 * narrow purpose, and it says so rather than claiming to be the pin.
 */

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ROLES } from './server.ts'

const VOCABULARY = resolve(import.meta.dir, '../domain/contracts/vocabulary.ts')

describe('the adapter’s role list against the vocabulary’s', () => {
  test('every role the vocabulary declares is a role the socket will admit', async () => {
    const source = await Bun.file(VOCABULARY).text()
    const declaration = source.match(/export type AgentRole =([^\n]*(?:\n\s*\|[^\n]*)*)/)?.[1]
    expect(declaration, 'AgentRole is no longer a plain union — the ROLES table has stopped constraining').toBeDefined()

    const declared = [...(declaration ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string)
    expect(declared.length).toBeGreaterThan(0) // anti-vacuity: the regex found a union, not an empty match
    expect([...ROLES].sort()).toEqual(declared.sort())
  })
})
