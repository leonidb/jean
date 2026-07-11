import { describe, expect, test } from 'bun:test'
import type { JeanConfig } from '../config.ts'
import { resolveConnectors } from './config.ts'

describe('resolveConnectors', () => {
  test('empty config → no connectors', () => {
    expect(resolveConnectors({})).toEqual([])
  })

  test('parses a connectors map, splitting kind/role from settings', () => {
    const config: JeanConfig = {
      connectors: {
        'personal-mail': { kind: 'gmail', role: 'source', imap: { user: 'me@gmail.com' }, poll: '5m' },
      },
    }
    expect(resolveConnectors(config)).toEqual([
      {
        instance: 'personal-mail',
        kind: 'gmail',
        role: 'source',
        settings: { imap: { user: 'me@gmail.com' }, poll: '5m' },
      },
    ])
  })

  test('back-compat: flat telegram becomes a bridge connector', () => {
    const config: JeanConfig = { telegram: { botToken: 'x', chatId: '123' } }
    expect(resolveConnectors(config)).toEqual([
      { instance: 'telegram', kind: 'telegram', role: 'bridge', settings: { botToken: 'x', chatId: '123' } },
    ])
  })

  test('back-compat: flat slack becomes a bridge connector', () => {
    const config: JeanConfig = { slack: { appToken: 'a', botToken: 'b', channel: 'C1' } }
    const [c] = resolveConnectors(config)
    expect(c?.kind).toBe('slack')
    expect(c?.role).toBe('bridge')
  })

  test('an explicit connectors entry overrides the legacy flat key of the same name', () => {
    const config: JeanConfig = {
      telegram: { botToken: 'legacy', chatId: 'old' },
      connectors: { telegram: { kind: 'telegram', role: 'bridge', botToken: 'new', chatId: 'new' } },
    }
    const telegrams = resolveConnectors(config).filter((c) => c.instance === 'telegram')
    expect(telegrams).toHaveLength(1)
    expect(telegrams[0]?.settings.botToken).toBe('new')
  })

  test('skips entries with unknown kind or role, keeps the good ones', () => {
    const config: JeanConfig = {
      connectors: {
        bad1: { kind: 'carrierpigeon', role: 'source' },
        bad2: { kind: 'gmail', role: 'sideways' },
        good: { kind: 'gmail', role: 'source' },
      },
    }
    expect(resolveConnectors(config).map((c) => c.instance)).toEqual(['good'])
  })
})
