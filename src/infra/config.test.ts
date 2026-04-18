import { describe, expect, test } from 'bun:test'
import { parseConfigValue, validateConfigKey } from './config.ts'

describe('CONFIG_SCHEMA', () => {
  test('validateConfigKey accepts known keys', () => {
    expect(validateConfigKey('port')).toBeNull()
    expect(validateConfigKey('slack.appToken')).toBeNull()
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
