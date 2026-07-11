/**
 * Resolve a dojo's configured connectors into a validated list.
 * See docs/connectors.md.
 */

import type { JeanConfig } from '../config.ts'
import {
  CONNECTOR_KINDS,
  CONNECTOR_ROLES,
  type ConnectorConfig,
  type ConnectorKind,
  type ConnectorRole,
} from './types.ts'

const isKind = (v: unknown): v is ConnectorKind => (CONNECTOR_KINDS as readonly string[]).includes(v as string)
const isRole = (v: unknown): v is ConnectorRole => (CONNECTOR_ROLES as readonly string[]).includes(v as string)

/**
 * Read the `connectors` map (instance → { kind, role, ...settings }) and — for
 * back-compat — synthesize bridge connectors from the legacy flat `telegram` /
 * `slack` keys when an explicit entry hasn't already claimed that instance name.
 *
 * Invalid entries (unknown kind/role) are skipped with a warning rather than
 * throwing, so one bad connector doesn't stop the infra from starting.
 */
export function resolveConnectors(config: JeanConfig): ConnectorConfig[] {
  const out: ConnectorConfig[] = []
  const seen = new Set<string>()

  for (const [instance, entry] of Object.entries(config.connectors ?? {})) {
    const parsed = parseEntry(instance, entry)
    if (parsed) {
      out.push(parsed)
      seen.add(instance)
    }
  }

  // Legacy flat keys → bidirectional bridge connectors, unless an explicit
  // `connectors` entry of the same instance name already exists.
  for (const kind of ['telegram', 'slack'] as const) {
    const legacy = config[kind]
    if (legacy && !seen.has(kind)) {
      out.push({ instance: kind, kind, role: 'bridge', settings: { ...legacy } })
    }
  }

  return out
}

function parseEntry(instance: string, entry: unknown): ConnectorConfig | null {
  if (!entry || typeof entry !== 'object') {
    process.stderr.write(`[jean] connector "${instance}": not an object — skipped\n`)
    return null
  }
  const { kind, role, ...settings } = entry as Record<string, unknown>
  if (!isKind(kind)) {
    process.stderr.write(`[jean] connector "${instance}": unknown kind ${JSON.stringify(kind)} — skipped\n`)
    return null
  }
  if (!isRole(role)) {
    process.stderr.write(`[jean] connector "${instance}": unknown role ${JSON.stringify(role)} — skipped\n`)
    return null
  }
  return { instance, kind, role, settings }
}
