import { describe, expect, test } from 'bun:test'
import { parseConfigValue, resolveConfig, validateConfigKey, writeConfig } from './config.ts'

describe('CONFIG_SCHEMA', () => {
  test('validateConfigKey accepts known keys', () => {
    expect(validateConfigKey('port')).toBeNull()
    expect(validateConfigKey('telegram.botToken')).toBeNull()
    expect(validateConfigKey('telegram.chatId')).toBeNull()
    expect(validateConfigKey('slack.appToken')).toBeNull()
    expect(validateConfigKey('bind')).toBeNull()
  })

  test('validateConfigKey rejects unknown keys', () => {
    expect(validateConfigKey('bogus')).toContain('Unknown')
    expect(validateConfigKey('porty')).toContain('Unknown')
  })
})

describe('parseConfigValue', () => {
  describe('number', () => {
    test('parses valid numbers', () => {
      expect(parseConfigValue('port', '8700')).toEqual({ value: 8700 })
    })

    test('rejects non-numeric strings', () => {
      const result = parseConfigValue('port', 'abc')
      expect(result).toHaveProperty('error')
    })
  })

  describe('string', () => {
    test('passes string values through', () => {
      expect(parseConfigValue('slack.channel', 'C123')).toEqual({ value: 'C123' })
    })
  })

  test('rejects unknown keys', () => {
    const result = parseConfigValue('bogus', 'anything')
    expect(result).toHaveProperty('error')
  })
})

describe('the bind address is configuration', () => {
  const withEnv = async (bind: string | undefined, body: () => void | Promise<void>) => {
    const before = process.env.JEAN_BIND
    if (bind === undefined) delete process.env.JEAN_BIND
    else process.env.JEAN_BIND = bind
    try {
      await body()
    } finally {
      if (before === undefined) delete process.env.JEAN_BIND
      else process.env.JEAN_BIND = before
    }
  }

  test('absent from an empty config — the default lives with the bind, not here', async () => {
    const dir = `/tmp/jean-bind-${Date.now()}-a`
    await Bun.write(`${dir}/.keep`, '')
    await withEnv(undefined, () => {
      expect(resolveConfig(dir).bind).toBeUndefined()
    })
  })

  test('a dojo that wrote `bind` gets it back', async () => {
    const dir = `/tmp/jean-bind-${Date.now()}-b`
    await Bun.write(`${dir}/.keep`, '')
    writeConfig(dir, { bind: '0.0.0.0' })
    await withEnv(undefined, () => {
      expect(resolveConfig(dir).bind).toBe('0.0.0.0')
    })
  })

  test('JEAN_BIND wins over the file — the same rule the port already follows', async () => {
    const dir = `/tmp/jean-bind-${Date.now()}-c`
    await Bun.write(`${dir}/.keep`, '')
    writeConfig(dir, { bind: '0.0.0.0' })
    await withEnv('192.0.2.7', () => {
      expect(resolveConfig(dir).bind).toBe('192.0.2.7')
    })
  })

  test('JEAN_BIND alone is enough — no file needed', async () => {
    const dir = `/tmp/jean-bind-${Date.now()}-d`
    await Bun.write(`${dir}/.keep`, '')
    await withEnv('0.0.0.0', () => {
      expect(resolveConfig(dir).bind).toBe('0.0.0.0')
    })
  })
})
