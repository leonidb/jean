/**
 * Gmail Source connector — read-only IMAP ingestion.
 * See docs/connectors.md.
 *
 * `imapflow` fetches raw messages; `mailparser` models the MIME parts; the pure
 * `emailToItem` maps those onto an `InboundItem`. The IMAP loop needs a live
 * mailbox (the app password from env) — `emailToItem` does not, and carries the
 * logic worth testing.
 *
 * Secrets stay out of config: `settings.passwordEnv` names the env var holding
 * the Gmail app password. The connector reads `process.env[passwordEnv]`.
 */

import { ImapFlow } from 'imapflow'
import { type ParsedMail, simpleParser } from 'mailparser'
import type { Connector, ConnectorContext, InboundItem } from './types.ts'

type GmailSettings = {
  user: string
  passwordEnv: string
  host?: string
  port?: number
  poll?: string // e.g. "5m", "30s"
  /** First-run behavior: 'new' = only mail arriving after start (default, safe);
   *  'all' = the whole mailbox (goals wants this — "ingest everything"). */
  backfill?: 'new' | 'all'
}

/** Map a parsed email + its IMAP UID onto an InboundItem. Pure except for the
 *  injected `saveAttachment` — so it's fully testable with a canned raw email. */
export function emailToItem(
  parsed: ParsedMail,
  uid: number,
  saveAttachment: (data: Uint8Array, name: string) => string,
): InboundItem {
  const references = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []

  const attachments = (parsed.attachments ?? [])
    .filter((a) => a.content)
    .map((a) => {
      const name = a.filename ?? 'attachment'
      return { path: saveAttachment(new Uint8Array(a.content), name), name, mime: a.contentType }
    })

  const headers: Record<string, string> = {}
  if (parsed.to && !Array.isArray(parsed.to)) headers.to = parsed.to.text
  if (parsed.cc && !Array.isArray(parsed.cc)) headers.cc = parsed.cc.text

  return {
    // Message-ID is the stable, cross-restart identity; UID is the fallback.
    id: parsed.messageId ?? `uid-${uid}`,
    kind: 'gmail',
    at: parsed.date ? parsed.date.getTime() : 0,
    from: parsed.from?.text ?? '',
    text: parsed.text ?? '',
    // Thread anchor: what this replies to, else the root of the references chain.
    threadId: parsed.inReplyTo ?? references[0],
    subject: parsed.subject,
    ...(Object.keys(headers).length > 0 && { headers }),
    ...(attachments.length > 0 && { attachments }),
    raw: { uid },
  }
}

function parseInterval(spec: string | undefined, fallbackMs: number): number {
  if (!spec) return fallbackMs
  const m = /^(\d+)\s*(s|m|h)?$/.exec(spec.trim())
  if (!m) return fallbackMs
  const n = Number(m[1])
  const unit = m[2] ?? 'm'
  return n * (unit === 'h' ? 3_600_000 : unit === 's' ? 1000 : 60_000)
}

export function createGmailConnector(settings: GmailSettings): Connector {
  let healthy = false
  const pollMs = parseInterval(settings.poll, 300_000) // default 5m
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  return {
    kind: 'gmail',
    connected: () => healthy,
    // No send() — a read-only Source. (A bidirectional email connector would add
    // an SMTP send here; that's the "dojo that answers email" case, out of scope.)
    async start(ctx: ConnectorContext) {
      const pass = process.env[settings.passwordEnv]
      if (!pass) {
        process.stderr.write(
          `[jean] gmail(${settings.user}): no password in $${settings.passwordEnv} — connector idle\n`,
        )
        return
      }

      // Runs off the startup path (not awaited) so a bad mailbox can't hang boot.
      void (async () => {
        for (;;) {
          const client = new ImapFlow({
            host: settings.host ?? 'imap.gmail.com',
            port: settings.port ?? 993,
            secure: true,
            auth: { user: settings.user, pass },
            logger: false,
          })
          try {
            await client.connect()
            healthy = true
            process.stderr.write(`[jean] gmail connected: ${settings.user}\n`)

            for (;;) {
              await pollOnce(client, ctx, settings)
              await sleep(pollMs)
            }
          } catch (e) {
            healthy = false
            process.stderr.write(`[jean] gmail(${settings.user}) error: ${e} — reconnecting\n`)
            try {
              await client.logout()
            } catch {
              /* already down */
            }
            await sleep(Math.min(pollMs, 30_000))
          }
        }
      })()
    },
  }
}

/** One fetch pass: pull messages with UID beyond the cursor, emit each, advance. */
async function pollOnce(client: ImapFlow, ctx: ConnectorContext, settings: GmailSettings): Promise<void> {
  const lock = await client.getMailboxLock('INBOX')
  try {
    const status = client.mailbox
    const uidNext = (status && typeof status !== 'boolean' ? status.uidNext : undefined) ?? 1

    // First run establishes the starting UID: 'all' → from 1; 'new' → skip the
    // existing mailbox and take only what arrives next.
    let last = Number(ctx.cursor.get() ?? '')
    if (!Number.isFinite(last) || last <= 0) {
      last = settings.backfill === 'all' ? 0 : Math.max(0, uidNext - 1)
      ctx.cursor.set(String(last))
    }

    for await (const msg of client.fetch(`${last + 1}:*`, { uid: true, source: true }, { uid: true })) {
      if (!msg.source) continue
      const parsed = await simpleParser(msg.source)
      ctx.emit(emailToItem(parsed, msg.uid, ctx.saveAttachment))
      ctx.cursor.set(String(msg.uid))
    }
  } finally {
    lock.release()
  }
}
