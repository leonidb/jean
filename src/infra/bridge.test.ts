import { describe, expect, test } from 'bun:test'
import { selectBridge } from './bridge.ts'
import type { JeanConfig } from './config.ts'

describe('selectBridge', () => {
  test('returns null when nothing is configured', () => {
    expect(selectBridge({})).toBeNull()
  })

  test('selects telegram when botToken + chatId are set', () => {
    const bridge = selectBridge({ telegram: { botToken: 'bot:abc', chatId: '12345' } })
    expect(bridge?.kind).toBe('telegram')
    expect(bridge?.target).toBe('12345')
  })

  test('selects slack when appToken + botToken + channel are set', () => {
    const bridge = selectBridge({ slack: { appToken: 'xapp-1', botToken: 'xoxb-1', channel: 'C123' } })
    expect(bridge?.kind).toBe('slack')
    expect(bridge?.target).toBe('C123')
  })

  test('telegram wins when both are configured', () => {
    const config: JeanConfig = {
      telegram: { botToken: 'bot:abc', chatId: '12345' },
      slack: { appToken: 'xapp-1', botToken: 'xoxb-1', channel: 'C123' },
    }
    expect(selectBridge(config)?.kind).toBe('telegram')
  })

  test('ignores partial telegram config (missing chatId)', () => {
    expect(selectBridge({ telegram: { botToken: 'bot:abc' } })).toBeNull()
  })

  test('ignores partial slack config (missing channel), no telegram', () => {
    expect(selectBridge({ slack: { appToken: 'xapp-1', botToken: 'xoxb-1' } })).toBeNull()
  })

  test('falls back to slack when telegram is only partially configured', () => {
    const config: JeanConfig = {
      telegram: { botToken: 'bot:abc' }, // missing chatId — incomplete
      slack: { appToken: 'xapp-1', botToken: 'xoxb-1', channel: 'C123' },
    }
    expect(selectBridge(config)?.kind).toBe('slack')
  })
})
