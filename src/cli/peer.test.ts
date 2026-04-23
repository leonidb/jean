import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const CLI = resolve(import.meta.dir, 'jean.ts')

function runJean(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['bun', 'run', CLI, ...args], {
    cwd,
    env: { ...process.env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
  if (out.exitCode !== 0 && out.stderr) console.error(`[runJean stderr]\n${out.stderr}`)
  return out
}

describe('jean peer', () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'jean-peer-test-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function initDojo(name: string, port: number): string {
    const dojo = resolve(tmp, name)
    const res = runJean(tmp, 'dojo', 'init', dojo, '--port', String(port))
    expect(res.exitCode).toBe(0)
    return dojo
  }

  test('dojo init writes identity (defaults to dojo basename)', () => {
    const dojo = initDojo('demo', 8800)
    const cfg = JSON.parse(readFileSync(resolve(dojo, '.jean', 'jean.config.json'), 'utf8'))
    expect(cfg.identity).toBe('demo')
  })

  test('peer add refuses without --origin, --description, or identity', () => {
    const dojo = initDojo('a', 8801)
    expect(runJean(dojo, 'peer', 'add').exitCode).toBe(1)
    expect(runJean(dojo, 'peer', 'add', 'x').exitCode).toBe(1)
    expect(runJean(dojo, 'peer', 'add', 'x', '--origin', '/nowhere').exitCode).toBe(1)
    expect(runJean(dojo, 'peer', 'add', 'x', '--origin', '/nowhere', '--description', '').exitCode).toBe(1)
  })

  test('peer add refuses when origin is not a Jean dojo', () => {
    const dojo = initDojo('a', 8802)
    const notDojo = resolve(tmp, 'plain')
    require('node:fs').mkdirSync(notDojo)
    const out = runJean(dojo, 'peer', 'add', 'x', '--origin', notDojo, '--description', 'something')
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('Not a Jean dojo')
  })

  test('peer add writes peers.json entry', () => {
    const a = initDojo('a', 8803)
    const b = initDojo('b', 8804)
    const out = runJean(a, 'peer', 'add', 'b-peer', '--origin', b, '--description', 'Other dojo')
    expect(out.exitCode).toBe(0)

    const peers = JSON.parse(readFileSync(resolve(a, '.jean', 'peers.json'), 'utf8'))
    expect(peers.peers['b-peer']).toBeDefined()
    expect(peers.peers['b-peer'].description).toBe('Other dojo')
    expect(peers.peers['b-peer'].origin.type).toBe('local-path')
  })

  test('peer add refuses to re-register an existing identity', () => {
    const a = initDojo('a', 8805)
    const b = initDojo('b', 8806)
    expect(runJean(a, 'peer', 'add', 'b-peer', '--origin', b, '--description', 'x').exitCode).toBe(0)
    const dup = runJean(a, 'peer', 'add', 'b-peer', '--origin', b, '--description', 'y')
    expect(dup.exitCode).toBe(1)
    expect(dup.stderr).toContain('already registered')
  })

  test('peer list shows registered peers', () => {
    const a = initDojo('a', 8807)
    const b = initDojo('b', 8808)
    runJean(a, 'peer', 'add', 'b-peer', '--origin', b, '--description', 'the B dojo')

    const out = runJean(a, 'peer', 'list')
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('b-peer')
    expect(out.stdout).toContain('the B dojo')
  })

  test('peer list on empty registry is informative', () => {
    const a = initDojo('a', 8809)
    const out = runJean(a, 'peer', 'list')
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('No peers registered')
  })

  test('peer remove removes the entry', () => {
    const a = initDojo('a', 8810)
    const b = initDojo('b', 8811)
    runJean(a, 'peer', 'add', 'b-peer', '--origin', b, '--description', 'x')

    const rm = runJean(a, 'peer', 'remove', 'b-peer')
    expect(rm.exitCode).toBe(0)

    const peers = JSON.parse(readFileSync(resolve(a, '.jean', 'peers.json'), 'utf8'))
    expect(peers.peers['b-peer']).toBeUndefined()
  })

  test('peer remove errors on unknown peer', () => {
    const a = initDojo('a', 8812)
    const out = runJean(a, 'peer', 'remove', 'missing')
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('not registered')
  })

  test('peer link establishes mutual registration', () => {
    const a = initDojo('a', 8813)
    const b = initDojo('b', 8814)

    const out = runJean(a, 'peer', 'link', b)
    expect(out.exitCode).toBe(0)

    const aPeers = JSON.parse(readFileSync(resolve(a, '.jean', 'peers.json'), 'utf8'))
    const bPeers = JSON.parse(readFileSync(resolve(b, '.jean', 'peers.json'), 'utf8'))
    expect(aPeers.peers.b).toBeDefined()
    expect(bPeers.peers.a).toBeDefined()
  })

  test('peer link refuses to link a dojo to itself', () => {
    const a = initDojo('a', 8815)
    const out = runJean(a, 'peer', 'link', a)
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('itself')
  })

  test('peer link is idempotent', () => {
    const a = initDojo('a', 8816)
    const b = initDojo('b', 8817)
    expect(runJean(a, 'peer', 'link', b).exitCode).toBe(0)
    expect(runJean(a, 'peer', 'link', b).exitCode).toBe(0) // no-op, no error

    const aPeers = JSON.parse(readFileSync(resolve(a, '.jean', 'peers.json'), 'utf8'))
    expect(Object.keys(aPeers.peers)).toEqual(['b'])
  })

  test('peer without subcommand prints usage', () => {
    const a = initDojo('a', 8818)
    const out = runJean(a, 'peer')
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('Usage: jean peer')
  })
})
