import { describe, expect, test } from 'bun:test'
import { CONFIG_SCHEMA, parseConfigValue, validateConfigKey } from './config.ts'

describe('CONFIG_SCHEMA', () => {
  test('includes autoNudge as boolean', () => {
    expect(CONFIG_SCHEMA.autoNudge).toBe('boolean')
  })

  test('validateConfigKey accepts known keys', () => {
    expect(validateConfigKey('autoNudge')).toBeNull()
    expect(validateConfigKey('port')).toBeNull()
    expect(validateConfigKey('slack.appToken')).toBeNull()
  })

  test('validateConfigKey rejects unknown keys', () => {
    expect(validateConfigKey('bogus')).toContain('Unknown')
    expect(validateConfigKey('autoNudg')).toContain('Unknown')
  })
})

describe('parseConfigValue', () => {
  describe('boolean', () => {
    test('accepts "true" and "1" as true', () => {
      expect(parseConfigValue('autoNudge', 'true')).toEqual({ value: true })
      expect(parseConfigValue('autoNudge', '1')).toEqual({ value: true })
    })

    test('accepts "false" and "0" as false', () => {
      expect(parseConfigValue('autoNudge', 'false')).toEqual({ value: false })
      expect(parseConfigValue('autoNudge', '0')).toEqual({ value: false })
    })

    test('rejects other strings with a clear error', () => {
      const result = parseConfigValue('autoNudge', 'yes')
      expect(result).toHaveProperty('error')
      expect((result as { error: string }).error).toContain('autoNudge')
    })
  })

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
