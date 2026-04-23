/**
 * Jean configuration — reads jean.config.json with schema validation.
 * Env vars override config file values.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── Schema ──────────────────────────────────────────────────────

export const CONFIG_SCHEMA: Record<string, 'string' | 'number'> = {
  port: 'number',
  identity: 'string',
  'slack.appToken': 'string',
  'slack.botToken': 'string',
  'slack.channel': 'string',
}

export type JeanConfig = {
  port?: number
  /** Stable short name for this dojo. Appears as the `from` field on outbound
   *  peer messages and as the key under which other dojos register us. Set at
   *  `jean dojo init` (defaults to basename of dojo root) and rarely changed. */
  identity?: string
  slack?: {
    appToken?: string
    botToken?: string
    channel?: string
  }
}

// ── Read/Write ──────────────────────────────────────────────────

const CONFIG_FILENAME = 'jean.config.json'

export function configPath(dataDir: string): string {
  return resolve(dataDir, CONFIG_FILENAME)
}

export function readConfig(dataDir: string): JeanConfig {
  const path = configPath(dataDir)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

export function writeConfig(dataDir: string, config: JeanConfig): void {
  writeFileSync(configPath(dataDir), `${JSON.stringify(config, null, 2)}\n`)
}

// ── Dot-path helpers ────────────────────────────────────────────

export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  const last = parts.pop()
  if (last === undefined) return
  let current = obj
  for (const part of parts) {
    if (current[part] == null || typeof current[part] !== 'object') {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  current[last] = value
}

// ── Validation ──────────────────────────────────────────────────

export function validateConfigKey(key: string): string | null {
  if (!(key in CONFIG_SCHEMA)) return `Unknown config key: ${key}`
  return null
}

export function parseConfigValue(key: string, raw: string): { value: unknown } | { error: string } {
  const type = CONFIG_SCHEMA[key]
  if (!type) return { error: `Unknown config key: ${key}` }
  if (type === 'number') {
    const n = Number(raw)
    if (Number.isNaN(n)) return { error: `${key} must be a number` }
    return { value: n }
  }
  return { value: raw }
}

// ── Resolve config with env var overrides ───────────────────────

export function resolveConfig(dataDir: string): JeanConfig {
  const config = readConfig(dataDir)
  // Env vars override config file
  if (process.env.JEAN_PORT) {
    const p = Number(process.env.JEAN_PORT)
    if (!Number.isNaN(p)) config.port = p
  }
  if (process.env.SLACK_APP_TOKEN || process.env.SLACK_BOT_TOKEN || process.env.SLACK_CHANNEL) {
    config.slack ??= {}
    if (process.env.SLACK_APP_TOKEN) config.slack.appToken = process.env.SLACK_APP_TOKEN
    if (process.env.SLACK_BOT_TOKEN) config.slack.botToken = process.env.SLACK_BOT_TOKEN
    if (process.env.SLACK_CHANNEL) config.slack.channel = process.env.SLACK_CHANNEL
  }
  return config
}
