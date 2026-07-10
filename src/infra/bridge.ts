/**
 * Chat bridges — connect a dojo to an external messaging surface (Telegram,
 * Slack, …) so a human can watch and lightly steer the sensei from their phone.
 *
 * A bridge is a *transport*: it turns inbound surface messages into `reply`
 * events on a user-role agent, and delivers outbound infra messages back to the
 * surface. The infra owns the event store and the agent registry; the bridge
 * owns only the wire. Keeping this seam thin is what lets any surface slot in
 * without the infra knowing which one it is — the same principle that keeps the
 * WebSocket and peer transports interchangeable in the registry.
 *
 * Telegram is the default. Each dojo runs its own bot — Telegram allows only
 * one getUpdates poller per token, so tokens can't be shared across dojos — but
 * minting a bot is a seconds-long @BotFather step with no app, scopes, install,
 * or public URL. Slack is retained for back-compat; it also needs its own app
 * per dojo (Socket Mode can't be shared) but that app is far more work to set
 * up, which is why it's no longer the recommended surface.
 */

import type { JeanConfig } from './config.ts'

/** An outbound message headed for the surface. Mirrors the infra's DeliverMsg
 *  minus the wire `type` tag the bridge doesn't care about. */
export type BridgeOutbound = { from: string; text: string }

/** The operations a bridge needs from the infra. The bridge calls these once it
 *  has resolved the surface's human-facing name (channel name / chat title) and
 *  is ready to carry traffic. Persistence stays on the infra side — the bridge
 *  owns the wire, not the dojo's filesystem. */
export type BridgeHost = {
  /** Register the surface as a user-role agent whose deliver() is `send`. */
  register: (name: string, send: (msg: BridgeOutbound) => boolean) => void
  /** Record an inbound surface message as a `reply` on `name`'s stream. */
  onInbound: (name: string, text: string) => void
  /** Persist an inbound binary attachment under the dojo; returns its absolute
   *  path so the bridge can point the sensei at a file it can open (Claude Code
   *  can Read images/PDFs/text). */
  saveAttachment: (data: Uint8Array, filename: string) => string
}

export type Bridge = {
  /** Transport label, for logs and /status. */
  kind: 'telegram' | 'slack'
  /** The surface target (telegram chat id / slack channel id), for /status. */
  target: string
  /** Connect to the surface and wire it to the host. Resolves once connected. */
  start: (host: BridgeHost) => Promise<void>
  /** Whether the transport is currently connected. */
  connected: () => boolean
}

/**
 * Pick the configured bridge, or null if none is set up. Telegram wins when
 * both are configured — it's the modern default; Slack is only there for dojos
 * that were set up before the switch.
 */
export function selectBridge(config: JeanConfig): Bridge | null {
  const tg = config.telegram
  if (tg?.botToken && tg?.chatId) return createTelegramBridge(tg.botToken, tg.chatId)

  const sl = config.slack
  if (sl?.appToken && sl?.botToken && sl?.channel) {
    return createSlackBridge(sl.appToken, sl.botToken, sl.channel)
  }
  return null
}

// ── Telegram ──────────────────────────────────────────────────────
//
// Bot API over plain fetch — no dependency, no public URL. Inbound arrives via
// long-polling (`getUpdates` held open ~50s at a time); outbound is a POST to
// `sendMessage`. Text goes straight through; photos and documents are pulled
// down (getFile + download) and handed to the sensei as a saved file path it
// can open — Claude Code can Read images, so screenshots/photos-of-text work.
// The bot never receives its own messages back through getUpdates, so there's
// no echo to filter beyond a defensive is_bot check.
//
// Setup: talk to @BotFather once (`/newbot`) for a token — seconds, no scopes,
// no app manifest, no install — then message the bot / add it to a group and
// set that chat's id as this dojo's telegram.chatId. For a private chat the
// user must /start the bot first (Telegram won't let a bot DM a stranger).
//
// One bot per dojo. Telegram permits only ONE getUpdates poller per token — a
// second concurrent poll gets 409 Conflict — so dojos can't share a token the
// way they could a webhook. That's fine: a bot is far cheaper to mint than a
// Slack app. A stray 409 (someone reused a token) surfaces in the log below.

type TelegramMessage = {
  chat?: { id?: number | string }
  from?: { is_bot?: boolean }
  text?: string
  caption?: string
  /** Compressed photo — multiple sizes, ascending; the last is the largest. */
  photo?: Array<{ file_id: string }>
  /** File sent uncompressed (image-as-file, PDF, …). */
  document?: { file_id: string; file_name?: string }
}

function createTelegramBridge(botToken: string, chatId: string): Bridge {
  // Tracks the outcome of the most recent getUpdates so /status.bridge.connected
  // reflects reality — not a write-once "we started" flag.
  let healthy = false
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  const call = async (
    method: string,
    body: object,
    timeoutMs: number,
  ): Promise<{ ok?: boolean; result?: unknown; description?: string }> => {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // Bound the wait so a black-holed connection (laptop sleep, NAT drop)
      // can't park the poll loop far past Telegram's own 50s hold.
      signal: AbortSignal.timeout(timeoutMs),
    })
    return (await res.json()) as { ok?: boolean; result?: unknown; description?: string }
  }

  // Download a Telegram file (photo/document) by file_id: getFile resolves a
  // temporary file_path, then a plain GET fetches the bytes. Returns null if
  // either step fails. The Bot API caps downloads at 20MB (fine for snaps).
  const fetchFile = async (fileId: string): Promise<{ bytes: Uint8Array; name: string } | null> => {
    const info = await call('getFile', { file_id: fileId }, 15_000)
    const filePath = (info.result as { file_path?: string } | undefined)?.file_path
    if (!info.ok || !filePath) return null
    const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`, {
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    return { bytes: new Uint8Array(await res.arrayBuffer()), name: filePath.split('/').pop() ?? 'file' }
  }

  return {
    kind: 'telegram',
    target: chatId,
    connected: () => healthy,
    async start(host) {
      // Resolve a human-facing name: group title, else @username, else chat-<id>.
      // getChat may fail if the bot hasn't been messaged yet — harmless, the
      // poll loop establishes real connectivity regardless.
      let name = `chat-${chatId}`
      try {
        const info = await call('getChat', { chat_id: chatId }, 15_000)
        const chat = info.result as { title?: string; username?: string } | undefined
        name = chat?.title ?? (chat?.username ? `@${chat.username}` : name)
      } catch {
        /* fall back to chat-<id> */
      }

      host.register(name, (msg) => {
        // Plain text — deliberately no parse_mode. Sensei messages carry
        // arbitrary characters (code, underscores, asterisks); Markdown parsing
        // would reject unbalanced entities with a 400 and silently drop the
        // message while we still report it sent. Reliability over cosmetics.
        // Fire-and-forget (deliver() is synchronous), but a rejected POST is
        // logged rather than lost without trace.
        void call('sendMessage', { chat_id: chatId, text: `${msg.from}: ${msg.text}` }, 15_000)
          .then((r) => {
            if (!r.ok) process.stderr.write(`[jean] telegram send failed: ${r.description ?? 'unknown'}\n`)
          })
          .catch((e) => process.stderr.write(`[jean] telegram send error: ${e}\n`))
        return true
      })

      process.stderr.write(`[jean] telegram bridge started: ${name} (${chatId})\n`)

      // Turn one inbound message into a reply for the sensei. Text passes
      // straight through; a photo or document is downloaded, persisted under the
      // dojo, and forwarded as a path the sensei can open. Anything else (voice,
      // sticker, location) isn't forwarded yet — surface a caption if present so
      // it doesn't vanish without a trace.
      const deliverInbound = async (m: TelegramMessage) => {
        if (m.text) {
          host.onInbound(name, m.text)
          return
        }
        const photo = m.photo?.[m.photo.length - 1]
        const media = photo ?? m.document
        if (media) {
          const caption = m.caption ? ` — ${m.caption}` : ''
          const file = await fetchFile(media.file_id)
          if (!file) {
            host.onInbound(name, `[attachment received but could not be downloaded]${caption}`)
            return
          }
          const path = host.saveAttachment(file.bytes, m.document?.file_name ?? file.name)
          host.onInbound(name, `[${photo ? 'image' : 'file'}] ${path}${caption}`)
          return
        }
        if (m.caption) host.onInbound(name, m.caption)
        else process.stderr.write('[jean] telegram: ignored unsupported message type\n')
      }

      // Long-poll for inbound until the process exits. Runs off the startup path
      // (not awaited) so a bad token can't hang `jean infra start`.
      void (async () => {
        let offset = 0
        let primed = false // have we skipped the offline backlog yet?
        let wasHealthy: boolean | null = null
        const setHealth = (ok: boolean, why?: string) => {
          healthy = ok
          if (ok === wasHealthy) return
          wasHealthy = ok
          process.stderr.write(
            ok
              ? `[jean] telegram connected: ${name} (${chatId})\n`
              : `[jean] telegram poll error: ${why ?? 'unknown'} — retrying\n`,
          )
        }

        for (;;) {
          try {
            if (!primed) {
              // Skip whatever Telegram queued while we were offline: offset:-1
              // returns only the newest update, and we advance past it without
              // processing. An infra restart shouldn't replay stale commands at
              // the sensei (matches Slack's live-only behavior). Retried via the
              // loop — never falls through to offset 0, which would replay it all.
              const res = await call('getUpdates', { offset: -1, timeout: 0 }, 15_000)
              if (!res.ok) {
                setHealth(false, res.description)
                await sleep(2000)
                continue
              }
              const backlog = (res.result ?? []) as Array<{ update_id: number }>
              if (backlog.length > 0) offset = (backlog[backlog.length - 1]?.update_id ?? -1) + 1
              primed = true
              setHealth(true)
              continue
            }

            const res = await call('getUpdates', { offset, timeout: 50 }, 55_000)
            if (!res.ok) {
              // Bad token / 409 shared-token conflict / transient API error.
              setHealth(false, res.description)
              await sleep(2000)
              continue
            }
            setHealth(true)
            const updates = (res.result ?? []) as Array<{ update_id: number; message?: TelegramMessage }>
            for (const u of updates) {
              offset = u.update_id + 1
              const m = u.message
              if (!m || m.from?.is_bot) continue
              if (String(m.chat?.id) !== String(chatId)) continue
              await deliverInbound(m)
            }
          } catch (e) {
            // Network blip or fetch timeout — back off briefly, then keep polling.
            setHealth(false, String(e))
            await sleep(2000)
          }
        }
      })()
    },
  }
}

// ── Slack ─────────────────────────────────────────────────────────
//
// Socket Mode via @slack/bolt (lazy-imported so the dependency only loads when
// Slack is actually configured). One app per dojo: the app token can't be
// shared across infra instances the way a Telegram bot token can.

function createSlackBridge(appToken: string, botToken: string, channelId: string): Bridge {
  let connected = false

  return {
    kind: 'slack',
    target: channelId,
    connected: () => connected,
    async start(host) {
      const { App } = await import('@slack/bolt')
      const app = new App({ token: botToken, appToken, socketMode: true })

      // Derive the channel name for the agent registry.
      let name = channelId
      try {
        const info = await app.client.conversations.info({ channel: channelId })
        name = (info.channel as { name?: string })?.name ?? channelId
      } catch {
        /* fall back to channel id */
      }

      app.message(async ({ message }) => {
        const m = message as { channel?: string; text?: string; bot_id?: string; subtype?: string }
        // Ignore bot messages (our own) and non-matching channels.
        if (m.bot_id || m.subtype) return
        if (m.channel !== channelId || !m.text) return
        host.onInbound(name, m.text)
      })

      await app.start()
      connected = true
      process.stderr.write(`[jean] slack connected: #${name} (${channelId})\n`)

      host.register(name, (msg) => {
        void app.client.chat.postMessage({ channel: channelId, text: `*${msg.from}*: ${msg.text}` })
        return true
      })
    },
  }
}
