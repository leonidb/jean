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
  // Telegram is the default chat bridge. Each dojo needs its own botToken
  // (Telegram permits one getUpdates poller per token); chatId picks the chat.
  'telegram.botToken': 'string',
  'telegram.chatId': 'string',
  // Slack (legacy) — needs its own app per dojo (Socket Mode can't be shared).
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
  /** Telegram chat bridge (default). Each dojo runs its own bot — Telegram
   *  permits one getUpdates poller per token, so tokens aren't shared. */
  telegram?: {
    botToken?: string
    chatId?: string
  }
  /** Slack chat bridge (legacy — one app per dojo). */
  slack?: {
    appToken?: string
    botToken?: string
    channel?: string
  }
  /** HISTORICAL — no reader. The per-instance connector framework (several
   *  transports per dojo, each with its own kind and product role) was removed
   *  at the teardown, with the ruling that a future mail-ingesting dojo is
   *  designed against the current adapter rather than carried. The KEY stays
   *  declared because config files are permanent and a dojo that still holds
   *  one must parse rather than choke; nothing acts on it. The flat
   *  `telegram`/`slack` keys above are the bridge, and they are live. */
  connectors?: Record<string, ConnectorEntry>
  /** Directories the sensei may write to OUTSIDE its worktree/workspace — the
   *  sensei's outbound delivery escape hatch (e.g. an iCloud drop folder).
   *  Empty by default: the sensei is fenced to its workspace, and every path
   *  here is an explicit, per-dojo widening. Each becomes an `Edit(<p>/**)` +
   *  `Write(<p>/**)` allow in the sensei's settings. Absolute paths (a leading
   *  `~/` is expanded to $HOME); relative paths resolve against the dojo root.
   *  Workers get no equivalent — they are hard-fenced to their worktree. See
   *  src/cli/permissions.ts. */
  senseiWritePaths?: string[]
}

/** A raw connector entry as it appears in jean.config.json. `kind`/`role` are
 *  loose here; `resolveConnectors` validates them against the known enums. */
/** Historical, with `connectors` above — declared so old config parses. */
export type ConnectorEntry = { kind: string; role: string; [setting: string]: unknown }

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
  if (process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_CHAT_ID) {
    config.telegram ??= {}
    if (process.env.TELEGRAM_BOT_TOKEN) config.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN
    if (process.env.TELEGRAM_CHAT_ID) config.telegram.chatId = process.env.TELEGRAM_CHAT_ID
  }
  if (process.env.SLACK_APP_TOKEN || process.env.SLACK_BOT_TOKEN || process.env.SLACK_CHANNEL) {
    config.slack ??= {}
    if (process.env.SLACK_APP_TOKEN) config.slack.appToken = process.env.SLACK_APP_TOKEN
    if (process.env.SLACK_BOT_TOKEN) config.slack.botToken = process.env.SLACK_BOT_TOKEN
    if (process.env.SLACK_CHANNEL) config.slack.channel = process.env.SLACK_CHANNEL
  }
  return config
}
