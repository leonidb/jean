/**
 * Source adapter — composes a connector into the read-only "Source" role by
 * routing its inbound items into the per-instance queue. (The Bridge adapter,
 * added in the step-3 refactor, routes inbound to the live conversation and
 * wires the connector's outbound instead.)
 *
 * This is where `role` lives — the connector itself stays role-agnostic.
 */

import { createGmailConnector } from './gmail.ts'
import type { SourceQueue } from './queue.ts'
import type { Connector, ConnectorConfig, ConnectorContext } from './types.ts'

/** Build the role-neutral context a source connector runs against: inbound →
 *  queue, attachments persisted via the supplied writer, cursor from the queue. */
export function sourceContext(
  queue: SourceQueue,
  saveAttachment: (data: Uint8Array, name: string) => string,
): ConnectorContext {
  return {
    emit: (item) => queue.append(item),
    saveAttachment,
    cursor: queue.cursor(),
  }
}

/** Instantiate the connector for a config entry, or null if its kind has no
 *  Source implementation yet (slack/whatsapp land later; telegram is a bridge). */
export function createSourceConnector(config: ConnectorConfig): Connector | null {
  switch (config.kind) {
    case 'gmail':
      return createGmailConnector(config.settings as Parameters<typeof createGmailConnector>[0])
    default:
      return null
  }
}
