#!/usr/bin/env bun

/**
 * Bump Jean's version across every surface that carries it.
 *
 * The version lives in the two package.json files. The CLI's usage banner and
 * the channel plugin's MCP server info read theirs at runtime, so these two
 * manifests are the whole surface.
 *
 * Usage:  bun run bump major|minor|patch
 *
 * It edits files only; committing and tagging stay manual.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type Part = 'major' | 'minor' | 'patch'

/** Every file that carries the version, relative to the repo root. */
export const SURFACES = ['package.json', 'src/channel/package.json']

// Anchored on the key, so it matches only the version field. The count check
// then fails loudly on a field that was moved or duplicated, instead of
// leaving a half-bumped tree.
const VERSION_FIELD = /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/g

export function nextVersion(version: string, part: Part): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) throw new Error(`not a major.minor.patch version: ${version}`)
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (part === 'major') return `${major + 1}.0.0`
  if (part === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** The one version literal in a surface's text; throws on none or several. */
export function versionIn(surface: string, text: string): string {
  const found = [...text.matchAll(VERSION_FIELD)].map((m) => m[2] ?? '')
  if (found.length !== 1) throw new Error(`${surface}: expected exactly one version literal, found ${found.length}`)
  return found[0] ?? ''
}

function readSurfaces(root: string) {
  return SURFACES.map((surface) => {
    const path = resolve(root, surface)
    const text = readFileSync(path, 'utf8')
    return { surface, path, text, version: versionIn(surface, text) }
  })
}

/** Each surface's version; throws on a surface without exactly one. */
export function readVersions(root: string): Record<string, string> {
  return Object.fromEntries(readSurfaces(root).map((s) => [s.surface, s.version]))
}

/** Writes the next version into every surface and returns it. Writes nothing
 *  unless every surface holds exactly one version and they all agree. */
export function bump(root: string, part: Part): string {
  const surfaces = readSurfaces(root)
  const distinct = [...new Set(surfaces.map((s) => s.version))]
  if (distinct.length !== 1) {
    throw new Error(`surfaces disagree: ${surfaces.map((s) => `${s.surface}=${s.version}`).join(', ')}`)
  }
  const next = nextVersion(distinct[0] ?? '', part)
  for (const s of surfaces) {
    writeFileSync(
      s.path,
      s.text.replace(VERSION_FIELD, (_, pre, _old, post) => pre + next + post),
    )
  }
  return next
}

if (import.meta.main) {
  const part = process.argv[2]
  if (part !== 'major' && part !== 'minor' && part !== 'patch') {
    console.error('usage: bun run bump major|minor|patch')
    process.exit(2)
  }
  try {
    const next = bump(resolve(import.meta.dir, '..'), part)
    console.log(`bumped to ${next}: ${SURFACES.join(', ')}`)
  } catch (err) {
    console.error(`bump: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
