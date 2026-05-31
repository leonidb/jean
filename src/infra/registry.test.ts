import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { allocatePort, readRegistry, registryPath, removeDojo, upsertDojo } from './registry.ts'

describe('dojo registry', () => {
  let tmp: string
  let prev: string | undefined

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-registry-test-'))
    prev = process.env.JEAN_REGISTRY_PATH
    process.env.JEAN_REGISTRY_PATH = resolve(tmp, 'dojos.json')
  })

  afterEach(() => {
    if (prev === undefined) delete process.env.JEAN_REGISTRY_PATH
    else process.env.JEAN_REGISTRY_PATH = prev
    rmSync(tmp, { recursive: true, force: true })
  })

  test('empty registry allocates the first port', () => {
    expect(allocatePort(undefined, resolve(tmp, 'a'))).toEqual({ port: 8700 })
  })

  test('auto-allocate skips ports held by other dojos', () => {
    const a = resolve(tmp, 'a')
    const b = resolve(tmp, 'b')
    mkdirSync(a)
    mkdirSync(b)
    upsertDojo({ path: a, port: 8700, identity: 'a' })
    expect(allocatePort(undefined, b)).toEqual({ port: 8701 })
  })

  test('preferred port held by a live dojo is rejected', () => {
    const a = resolve(tmp, 'a')
    const b = resolve(tmp, 'b')
    mkdirSync(a)
    mkdirSync(b)
    upsertDojo({ path: a, port: 8700, identity: 'a' })
    const r = allocatePort(8700, b)
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('already registered')
  })

  test('a dojo can keep its own port (own entry ignored)', () => {
    const a = resolve(tmp, 'a')
    mkdirSync(a)
    upsertDojo({ path: a, port: 8700, identity: 'a' })
    expect(allocatePort(8700, a)).toEqual({ port: 8700 })
  })

  test('stale entries (missing path) are pruned and their port reclaimed', () => {
    const gone = resolve(tmp, 'gone') // never created on disk
    upsertDojo({ path: gone, port: 8700, identity: 'gone' })
    expect(allocatePort(8700, resolve(tmp, 'b'))).toEqual({ port: 8700 })
  })

  test('upsert updates an existing dojo in place (matched by path)', () => {
    const a = resolve(tmp, 'a')
    mkdirSync(a)
    upsertDojo({ path: a, port: 8700, identity: 'a' })
    upsertDojo({ path: a, port: 8701, identity: 'a2' })
    const live = readRegistry().filter((e) => existsSync(e.path))
    expect(live.length).toBe(1)
    expect(live[0]?.port).toBe(8701)
    expect(live[0]?.identity).toBe('a2')
  })

  test('removeDojo drops the entry', () => {
    const a = resolve(tmp, 'a')
    mkdirSync(a)
    upsertDojo({ path: a, port: 8700 })
    removeDojo(a)
    expect(readRegistry().length).toBe(0)
  })

  test('rejects an out-of-range or non-integer preferred port', () => {
    const a = resolve(tmp, 'a')
    expect('error' in allocatePort(0, a)).toBe(true)
    expect('error' in allocatePort(70000, a)).toBe(true)
    expect('error' in allocatePort(8700.5, a)).toBe(true)
  })

  test('upsert does not drop a stale neighbor entry (non-destructive write)', () => {
    const live = resolve(tmp, 'live')
    const gone = resolve(tmp, 'gone') // never created on disk
    mkdirSync(live)
    upsertDojo({ path: gone, port: 8700, identity: 'gone' }) // stale entry
    upsertDojo({ path: live, port: 8701, identity: 'live' }) // an unrelated write
    // The stale entry survives the neighbor write (not silently GC'd)...
    expect(readRegistry().some((e) => e.identity === 'gone')).toBe(true)
    // ...but allocation still reclaims its port in-memory.
    expect(allocatePort(8700, resolve(tmp, 'b'))).toEqual({ port: 8700 })
  })

  test('atomic write leaves no .tmp file behind', () => {
    const a = resolve(tmp, 'a')
    mkdirSync(a)
    upsertDojo({ path: a, port: 8700 })
    expect(readdirSync(tmp).filter((f) => f.includes('.tmp'))).toEqual([])
    expect(existsSync(registryPath())).toBe(true)
  })
})
