// The bump script, and the guard that keeps every version surface on one
// number. A bump run on a scratch copy of the surfaces, never on this repo.
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { bump, nextVersion, readVersions, SURFACES } from './bump.ts'

const REPO = resolve(import.meta.dir, '..')
const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const manifest = (version: string) => `{\n  "name": "x",\n  "version": "${version}",\n  "private": true\n}\n`

/** A root holding every surface at the given versions, plus a copy of the script. */
function scratch(...versions: string[]) {
  const root = mkdtempSync(resolve(tmpdir(), 'jean-bump-'))
  dirs.push(root)
  SURFACES.forEach((surface, i) => {
    mkdirSync(resolve(root, surface, '..'), { recursive: true })
    writeFileSync(resolve(root, surface), manifest(versions[i] ?? versions[0] ?? ''))
  })
  mkdirSync(resolve(root, 'scripts'))
  cpSync(resolve(import.meta.dir, 'bump.ts'), resolve(root, 'scripts', 'bump.ts'))
  return root
}

const read = (root: string) => SURFACES.map((surface) => readFileSync(resolve(root, surface), 'utf8'))

describe('nextVersion', () => {
  test('each part resets the parts below it', () => {
    expect(nextVersion('1.4.7', 'major')).toBe('2.0.0')
    expect(nextVersion('1.4.7', 'minor')).toBe('1.5.0')
    expect(nextVersion('1.4.7', 'patch')).toBe('1.4.8')
    expect(nextVersion('0.9.9', 'minor')).toBe('0.10.0')
  })

  test('refuses anything but major.minor.patch', () => {
    for (const bad of ['1.4', '1.4.7-rc.1', 'v1.4.7', '']) expect(() => nextVersion(bad, 'patch')).toThrow()
  })
})

describe('bump', () => {
  test('writes the next version into every surface and changes nothing else', () => {
    const root = scratch('0.1.0')
    expect(bump(root, 'minor')).toBe('0.2.0')
    expect(read(root)).toEqual(SURFACES.map(() => manifest('0.2.0')))
  })

  test('a surface without exactly one version field fails before anything is written', () => {
    for (const broken of ['{ "name": "x" }\n', `${manifest('0.1.0')}{ "version": "0.1.0" }\n`]) {
      const root = scratch('0.1.0')
      writeFileSync(resolve(root, SURFACES.at(-1) ?? ''), broken)
      const before = read(root)
      expect(() => bump(root, 'patch')).toThrow(/expected exactly one version literal/)
      expect(read(root)).toEqual(before)
    }
  })

  test('surfaces that disagree fail before anything is written', () => {
    const root = scratch('0.1.0', '0.1.1')
    const before = read(root)
    expect(() => bump(root, 'patch')).toThrow(/surfaces disagree/)
    expect(read(root)).toEqual(before)
  })

  test('run as a script, it bumps the tree it sits in and prints the new version', () => {
    const root = scratch('1.2.3')
    const r = Bun.spawnSync(['bun', resolve(root, 'scripts', 'bump.ts'), 'major'], { stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode, r.stderr.toString()).toBe(0)
    expect(r.stdout.toString()).toContain('bumped to 2.0.0')
    expect(read(root)).toEqual(SURFACES.map(() => manifest('2.0.0')))
  })

  test('run as a script without a part, it prints usage and writes nothing', () => {
    const root = scratch('1.2.3')
    const r = Bun.spawnSync(['bun', resolve(root, 'scripts', 'bump.ts'), 'beta'], { stdout: 'pipe', stderr: 'pipe' })
    expect(r.exitCode).toBe(2)
    expect(r.stderr.toString()).toContain('usage: bun run bump major|minor|patch')
    expect(read(root)).toEqual(SURFACES.map(() => manifest('1.2.3')))
  })
})

describe('the version guard', () => {
  const versions = readVersions(REPO)
  const version = versions['package.json'] ?? ''

  test('every surface holds the same version', () => {
    expect(new Set(Object.values(versions)), JSON.stringify(versions)).toEqual(new Set([version]))
  })

  test('every tracked package.json with a version is a surface', () => {
    const tracked = Bun.spawnSync(['git', 'ls-files', '*package.json'], { cwd: REPO, stdout: 'pipe' })
      .stdout.toString()
      .split('\n')
      .filter((path) => path && /"version"\s*:/.test(readFileSync(resolve(REPO, path), 'utf8')))
    expect(tracked.sort()).toEqual([...SURFACES].sort())
  })

  test('the CLI banner shows it', () => {
    const r = Bun.spawnSync(['bun', resolve(REPO, 'src', 'cli', 'jean.ts')], { stdout: 'pipe', stderr: 'pipe' })
    expect(r.stdout.toString()).toContain(`(v${version})`)
  })

  test('no source file spells it out: code reads it from its package.json', () => {
    const literal = new RegExp(`(?<![\\d.])v?${version.replaceAll('.', '\\.')}(?![\\d.])`)
    const sources = Bun.spawnSync(['git', 'ls-files', 'src/*.ts'], { cwd: REPO, stdout: 'pipe' })
      .stdout.toString()
      .split('\n')
      .filter((path) => path && !path.endsWith('.test.ts'))
    expect(sources.length).toBeGreaterThan(0)
    expect(sources.filter((path) => literal.test(readFileSync(resolve(REPO, path), 'utf8')))).toEqual([])
  })
})
