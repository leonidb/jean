/**
 * Jean configuration — reads jean.config.json with schema validation.
 * Env vars override config file values.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

// ── Schema ──────────────────────────────────────────────────────

export const CONFIG_SCHEMA: Record<string, 'string' | 'number' | 'boolean'> = {
  port: 'number',
  autoNudge: 'boolean',
  'slack.appToken': 'string',
  'slack.botToken': 'string',
  'slack.channel': 'string',
}

export type JeanConfig = {
  port?: number
  /**
   * When true, the sensei receives autonomous channel deliveries:
   * - `nudgeSenseiIfIdle()` pings on pending events (worker-idle, reply, task-created, trigger-fired, …)
   * - cron/one-off triggers whose target is the sensei get delivered
   * When false (default), those pings are skipped — events still record, triggers still fire,
   * but the sensei only wakes on explicit `jean send sensei "..."` invocation. Worker-targeting
   * triggers are unaffected either way.
   */
  autoNudge?: boolean
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
  if (type === 'boolean') {
    if (raw === 'true' || raw === '1') return { value: true }
    if (raw === 'false' || raw === '0') return { value: false }
    return { error: `${key} must be true or false` }
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
  if (process.env.JEAN_AUTO_NUDGE) {
    config.autoNudge = process.env.JEAN_AUTO_NUDGE === 'true' || process.env.JEAN_AUTO_NUDGE === '1'
  }
  if (process.env.SLACK_APP_TOKEN || process.env.SLACK_BOT_TOKEN || process.env.SLACK_CHANNEL) {
    config.slack ??= {}
    if (process.env.SLACK_APP_TOKEN) config.slack.appToken = process.env.SLACK_APP_TOKEN
    if (process.env.SLACK_BOT_TOKEN) config.slack.botToken = process.env.SLACK_BOT_TOKEN
    if (process.env.SLACK_CHANNEL) config.slack.channel = process.env.SLACK_CHANNEL
  }
  return config
}
