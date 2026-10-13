/**
 * The env `jean agent start` hands to `claude`: agent view off, so the session
 * can't be backgrounded, and no background-session markers inherited from the
 * shell that ran the command. Pinned on the pure function and, through a fake
 * `claude` on PATH, at the real spawn.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { agentLaunchEnv } from './agent-env.ts'

const AGENT = { name: 'w1', role: 'worker', dojoRoot: '/d', agentDir: '/d/w1' }
const MARKERS = {
  CLAUDE_JOB_DIR: '/tmp/cc-jobs/x',
  CLAUDE_BG_BACKEND: 'daemon',
  CLAUDE_BG_SOMETHING_NEW: '1',
  CLAUDE_CODE_SESSION_KIND: 'bg',
  CLAUDE_CODE_SESSION_ID: 'abc',
}

describe('agentLaunchEnv', () => {
  test('turns agent view off, even over an inherited value', () => {
    expect(agentLaunchEnv({ CLAUDE_CODE_DISABLE_AGENT_VIEW: '0' }, AGENT).CLAUDE_CODE_DISABLE_AGENT_VIEW).toBe('1')
  })

  test('drops inherited background-session markers and keeps everything else', () => {
    const env = agentLaunchEnv({ ...MARKERS, PATH: '/bin', CLAUDE_CODE_KEEP_ME: 'kept', CLAUDE_BGX: 'kept' }, AGENT)
    for (const key of Object.keys(MARKERS)) expect(env[key], key).toBeUndefined()
    expect(env.PATH).toBe('/bin')
    expect(env.CLAUDE_CODE_KEEP_ME).toBe('kept')
    expect(env.CLAUDE_BGX).toBe('kept')
  })

  test('sets the agent identity over inherited JEAN_*', () => {
    const env = agentLaunchEnv({ JEAN_AGENT: 'other', JEAN_DOJO: '/elsewhere' }, AGENT)
    expect(env).toMatchObject({ JEAN_AGENT: 'w1', JEAN_ROLE: 'worker', JEAN_DOJO: '/d', JEAN_AGENT_DIR: '/d/w1/.jean' })
  })
})

const CLI = resolve(import.meta.dir, 'jean.ts')
const dirs: string[] = []

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const base = mkdtempSync(resolve(tmpdir(), 'jean-agent-start-'))
  dirs.push(base)
  const home = resolve(base, 'home')
  mkdirSync(home)
  writeFileSync(resolve(home, '.claude.json'), JSON.stringify({ mcpServers: { jean: { command: 'bun' } } }))

  const dojo = resolve(base, 'dojo')
  mkdirSync(resolve(dojo, '.jean'), { recursive: true })
  writeFileSync(resolve(dojo, '.jean', 'jean.config.json'), '{}')
  writeFileSync(resolve(dojo, '.jean', 'infra.pid'), String(process.pid))
  writeFileSync(resolve(dojo, '.jean', 'infra.port'), '1')
  mkdirSync(resolve(dojo, 'w1', '.jean'), { recursive: true })
  writeFileSync(resolve(dojo, 'w1', '.jean', '.jean-agent.json'), JSON.stringify({ name: 'w1', role: 'worker' }))

  const bin = resolve(base, 'bin')
  mkdirSync(bin)
  const out = resolve(base, 'claude-env')
  writeFileSync(resolve(bin, 'claude'), `#!/bin/sh\nenv > '${out}'\nprintf '%s\\n' "$@" > '${out}.argv'\n`)
  chmodSync(resolve(bin, 'claude'), 0o755)
  return { home, dojo, bin, out }
}

test('agent view off; inherited background-session markers dropped; identity set', () => {
  const { home, dojo, bin, out } = setup()
  const r = Bun.spawnSync(['bun', 'run', CLI, 'agent', 'start', 'w1'], {
    cwd: dojo,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      CLAUDE_JOB_DIR: '/tmp/cc-jobs/x',
      CLAUDE_BG_BACKEND: 'daemon',
      CLAUDE_BG_SOMETHING_NEW: '1',
      CLAUDE_CODE_SESSION_KIND: 'bg',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_CODE_DISABLE_AGENT_VIEW: '0',
      CLAUDE_CODE_KEEP_ME: 'kept',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect(r.exitCode, r.stderr.toString()).toBe(0)

  const env = Object.fromEntries(
    readFileSync(out, 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  )
  expect(env.CLAUDE_CODE_DISABLE_AGENT_VIEW).toBe('1')
  for (const gone of [
    'CLAUDE_JOB_DIR',
    'CLAUDE_BG_BACKEND',
    'CLAUDE_BG_SOMETHING_NEW',
    'CLAUDE_CODE_SESSION_KIND',
    'CLAUDE_CODE_SESSION_ID',
  ]) {
    expect(env[gone], `${gone} reached claude`).toBeUndefined()
  }
  expect(env.CLAUDE_CODE_KEEP_ME).toBe('kept')
  expect(env.JEAN_AGENT).toBe('w1')
  expect(env.JEAN_ROLE).toBe('worker')

  const argv = readFileSync(`${out}.argv`, 'utf8').trim().split('\n')
  expect(argv.slice(-2)).toEqual(['--dangerously-load-development-channels', 'server:jean'])
})
