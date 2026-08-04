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
 *  minus the wire `type` tag the bridge doesn't care about. `attachments` are
 *  absolute local file paths a media surface uploads; text-only surfaces
 *  (Slack, for now) ignore them. */
export type BridgeOutbound = { from: string; text: string; attachments?: string[] }

/** The operations a bridge needs from the infra. The bridge calls these once it
 *  has resolved the surface's human-facing name (channel name / chat title) and
 *  is ready to carry traffic. Persistence stays on the infra side — the bridge
 *  owns the wire, not the dojo's filesystem. */
/** Provenance for an inbound message. Without this, batched messages all collapse
 *  onto the infra's record-time and their order is lost — a human writing a
 *  sequence ("I'm at Apple" / "apple" / "the store I mean") arrives as an
 *  undifferentiated pile. `sentAt` is when the *human* sent it; `sourceId` is the
 *  surface's own monotonic id, so sequence survives delivery. */
export type InboundMeta = { sentAt?: number; sourceId?: string }

export type BridgeHost = {
  /** Register the surface as a user-role agent whose deliver() is `send`. */
  register: (name: string, send: (msg: BridgeOutbound) => boolean) => void
  /** Record an inbound surface message as a `reply` on `name`'s stream. */
  onInbound: (name: string, text: string, meta?: InboundMeta) => void
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
  /** Transport health for /status — see BridgeHealth. */
  health: () => BridgeHealth
}

// ── Inbound-lag detection (task 006) ──────────────────────────────
//
// THE INCIDENT (2026-07-25, both dojos, ~08:47–08:56Z): a message sent at
// 08:46:46Z reached infra at 08:56:13Z — 9m27s — while `connected()` read true
// the whole time. Two independent pollers on different bot tokens resolved in
// the same wall-clock minute, which rules out per-infra causes. The human
// meanwhile had every reason to believe the dojo was ignoring them.
//
// TWO FAILURE CLASSES, and they need DIFFERENT signals — this is the crux:
//
//  (a) TELEGRAM HOLDS UPDATES while our polls keep completing normally. A
//      long-poll that returns zero updates is INDISTINGUISHABLE from a quiet
//      chat, so poll-liveness sees nothing wrong. The only observable is the
//      age of a message once it finally arrives: receivedAt - sentAt. That is
//      necessarily RETROSPECTIVE — no signal exists during the silence, because
//      getUpdates is our only channel and it is telling us nothing is there.
//      Detected here by `lastInboundLagMs`.
//
//  (b) THE POLLER STALLS OR ERRORS (bad token, 409 conflict, black-holed
//      connection, network blip). Here polls stop completing, which IS
//      observable live. Detected here by `lastPollAt` age.
//
// Which class the incident was is not yet settled — it turns on whether the
// window shows silent empty returns (a) or errors (b) in the infra stderr, and
// that scrollback is a pending ask. Both are cheap; both ship. Whichever it
// was, the NEXT occurrence is diagnosable from /status alone.
//
// Deliberately NOT here: retry machinery. Telegram's long-poll owns retries.
// This is observability only.

export type BridgeHealth = {
  connected: boolean
  /** Epoch ms of the last completed poll cycle, ok or not. Null before the
   *  first, and null for push transports (Slack socket mode) where "poll" has
   *  no meaning — null is "not applicable", not "unknown". */
  lastPollAt: number | null
  /** Epoch ms of the last poll that returned successfully. */
  lastPollOkAt: number | null
  /** Consecutive failed polls since the last success. */
  consecutiveFailures: number
  /** Epoch ms we received the most recent inbound message. */
  lastInboundAt: number | null
  /** receivedAt - sentAt for the most recent inbound carrying a send time.
   *  THE incident signal: ~567000 during the 08:47–08:56Z window, sub-second
   *  normally. Null when the surface gives us no send time (Slack). */
  lastInboundLagMs: number | null
  /** Largest inbound lag seen this process lifetime — survives the resolving
   *  batch, so a lag window is still visible minutes later. */
  maxInboundLagMs: number | null
}

/** A poll gap beyond this is reported. Telegram holds getUpdates ~50s and the
 *  fetch aborts at 55s, so a healthy loop always cycles inside ~55s; 2 minutes
 *  is clear of that without being slack.
 *
 *  READ AT CALL TIME, not at import (refactor stage 2). Frozen at import, these
 *  two could only be varied per-PROCESS — fine for the spawn suite, which sets
 *  `JEAN_*` per subprocess, but unusable from an in-process test, where every
 *  file shares one process and one module instance. */
const pollGapWarnMs = () => Number(process.env.JEAN_BRIDGE_POLL_GAP_MS ?? 120_000)
/** An inbound arriving older than this is reported. Normal is sub-second; the
 *  incident was 9m27s. PROVISIONAL — pending the stderr scrollback for the
 *  08:47–08:56Z window, which is what would tell us the real jitter floor.
 *  Read at call time, same reason as above. */
const inboundLagWarnMs = () => Number(process.env.JEAN_BRIDGE_LAG_MS ?? 60_000)

/**
 * Health tracker for a polling bridge. Clock is always injected so the whole
 * thing is unit-testable without waiting on wall time or stubbing global fetch
 * (the poll loop itself is unreachable from a test — it runs forever inside a
 * closure over `fetch`; see the note in bridge.test.ts).
 *
 * `recordPoll` / `recordInbound` return a warning string when a threshold is
 * crossed, rather than writing it. Keeping I/O at the call site is what makes
 * the decision testable.
 */
export function createBridgeHealth() {
  let lastPollAt: number | null = null
  let lastPollOkAt: number | null = null
  let consecutiveFailures = 0
  let lastInboundAt: number | null = null
  let lastInboundLagMs: number | null = null
  let maxInboundLagMs: number | null = null

  return {
    /** Record a completed poll cycle. Returns a warning when the gap since the
     *  previous cycle exceeded the threshold — i.e. the loop was stalled and has
     *  just recovered. NOTE this is inherently after-the-fact: a loop that never
     *  returns emits nothing, which is why /status also exposes lastPollAt for a
     *  reader to age live. */
    recordPoll(ok: boolean, now: number): string | null {
      const gap = lastPollAt === null ? null : now - lastPollAt
      lastPollAt = now
      if (ok) {
        lastPollOkAt = now
        consecutiveFailures = 0
      } else {
        consecutiveFailures++
      }
      const threshold = pollGapWarnMs()
      if (gap !== null && gap > threshold) {
        return `poll gap ${Math.round(gap / 1000)}s (threshold ${Math.round(threshold / 1000)}s) — the poll loop was stalled, not the chat`
      }
      return null
    },

    /** Record an inbound message AT ARRIVAL — before any attachment download,
     *  so our own fetch time never inflates the transport lag we are measuring.
     *  `sentAt` is the surface's send time (Telegram `date`, 1s resolution);
     *  pass undefined when the surface gives none. */
    recordInbound(sentAt: number | undefined, now: number): string | null {
      lastInboundAt = now
      if (sentAt === undefined) {
        lastInboundLagMs = null
        return null
      }
      // Clamp: Telegram's `date` has 1s resolution and clocks skew, so a
      // just-sent message can compute a small negative age.
      const lag = Math.max(0, now - sentAt)
      lastInboundLagMs = lag
      if (maxInboundLagMs === null || lag > maxInboundLagMs) maxInboundLagMs = lag
      const threshold = inboundLagWarnMs()
      if (lag > threshold) {
        return `inbound lagged ${Math.round(lag / 1000)}s from send to receipt (threshold ${Math.round(threshold / 1000)}s) — the surface held it, our poll loop was healthy`
      }
      return null
    },

    snapshot(connected: boolean): BridgeHealth {
      return {
        connected,
        lastPollAt,
        lastPollOkAt,
        consecutiveFailures,
        lastInboundAt,
        lastInboundLagMs,
        maxInboundLagMs,
      }
    },
  }
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
  /** Telegram's own monotonic per-chat id — preserves order across a batch. */
  message_id?: number
  /** When the HUMAN sent it (epoch seconds), not when we recorded it. */
  date?: number
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
  // Ages and lags behind that boolean (task 006) — `connected: true` was the
  // whole of what we knew during a 9-minute inbound stall.
  const pollHealth = createBridgeHealth()
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

  // Pick the Telegram upload method + form field by extension. Only route to a
  // specialized endpoint for formats Telegram actually accepts there — sendAudio
  // wants MP3/M4A, sendVideo wants MP4, sendPhoto wants JPEG/PNG, GIFs go through
  // sendAnimation. Everything else (wav, flac, mov, webm, pdf, …) falls to
  // sendDocument, which accepts any file: it renders as a downloadable file
  // rather than being bounced for a format mismatch. Guaranteed delivery beats
  // inline rendering.
  const uploadMethod = (path: string): { method: string; field: string } => {
    const ext = (path.split('.').pop() ?? '').toLowerCase()
    if (['jpg', 'jpeg', 'png'].includes(ext)) return { method: 'sendPhoto', field: 'photo' }
    if (ext === 'gif') return { method: 'sendAnimation', field: 'animation' }
    if (['mp3', 'm4a'].includes(ext)) return { method: 'sendAudio', field: 'audio' }
    if (ext === 'mp4') return { method: 'sendVideo', field: 'video' }
    return { method: 'sendDocument', field: 'document' }
  }

  // Upload one local file as multipart/form-data. Bun.file() streams the bytes
  // without slurping the whole thing into memory. Returns Telegram's ack shape.
  //
  // SECURITY: `path` is whatever the sender named — there's no allowlist, so any
  // caller that can reach the send path (a dojo agent, or a local process via the
  // unauthenticated loopback POST /send) can upload any file the infra can read.
  // That's acceptable ONLY because the destination is the owner's own private
  // chat: it's not a new exfil primitive (a local caller already has the owner's
  // file access). If this bridge is ever pointed at a SHARED/GROUP chat, this
  // becomes a real local-file → third-party channel and needs a path allowlist.
  const sendFile = async (path: string): Promise<{ ok?: boolean; description?: string }> => {
    const file = Bun.file(path)
    if (!(await file.exists())) return { ok: false, description: `file not found: ${path}` }
    const { method, field } = uploadMethod(path)
    const form = new FormData()
    form.append('chat_id', chatId)
    form.append(field, file, path.split('/').pop() ?? 'file')
    const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    return (await res.json()) as { ok?: boolean; description?: string }
  }

  return {
    kind: 'telegram',
    target: chatId,
    connected: () => healthy,
    health: () => pollHealth.snapshot(healthy),
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
        // deliver() is synchronous, so the actual sends are fire-and-forget —
        // but sequenced in an async IIFE so text lands before its attachments
        // (the sensei composes "here's X" then the file). Failures are surfaced
        // to the chat AND logged, never dropped silently.
        void (async () => {
          if (msg.text) {
            // Plain text — deliberately no parse_mode. Sensei messages carry
            // arbitrary characters (code, underscores, asterisks); Markdown
            // parsing would 400 on unbalanced entities and silently drop it.
            const r = await call('sendMessage', { chat_id: chatId, text: `${msg.from}: ${msg.text}` }, 15_000)
            if (!r.ok) process.stderr.write(`[jean] telegram send failed: ${r.description ?? 'unknown'}\n`)
          }
          for (const path of msg.attachments ?? []) {
            const r = await sendFile(path)
            if (!r.ok) {
              const base = path.split('/').pop() ?? path
              process.stderr.write(`[jean] telegram upload failed (${path}): ${r.description ?? 'unknown'}\n`)
              // Tell the human something went wrong rather than a file just not
              // appearing — the same don't-lie-about-delivery principle.
              void call(
                'sendMessage',
                { chat_id: chatId, text: `[couldn't send ${base}: ${r.description ?? 'error'}]` },
                15_000,
              )
            }
          }
        })().catch((e) => process.stderr.write(`[jean] telegram outbound error: ${e}\n`))
        return true
      })

      process.stderr.write(`[jean] telegram bridge started: ${name} (${chatId})\n`)

      // Resolve a message to the text the sensei will see — performing any (slow)
      // attachment download. Deliberately does NOT emit: the caller decides when,
      // so downloads can run in parallel while emission stays in arrival order.
      // Text passes straight through; a photo/document is downloaded, persisted,
      // and forwarded as a path the sensei can open. Anything else (voice,
      // sticker, location) isn't forwarded yet — surface a caption if present so
      // it doesn't vanish without a trace.
      const prepareInbound = async (m: TelegramMessage): Promise<string | null> => {
        if (m.text) return m.text
        const photo = m.photo?.[m.photo.length - 1]
        const media = photo ?? m.document
        if (media) {
          const caption = m.caption ? ` — ${m.caption}` : ''
          const file = await fetchFile(media.file_id)
          if (!file) return `[attachment received but could not be downloaded]${caption}`
          const path = host.saveAttachment(file.bytes, m.document?.file_name ?? file.name)
          return `[${photo ? 'image' : 'file'}] ${path}${caption}`
        }
        if (m.caption) return m.caption
        process.stderr.write('[jean] telegram: ignored unsupported message type\n')
        return null
      }

      // Long-poll for inbound until the process exits. Runs off the startup path
      // (not awaited) so a bad token can't hang `jean infra start`.
      void (async () => {
        let offset = 0
        let primed = false // have we skipped the offline backlog yet?
        let wasHealthy: boolean | null = null
        // Emission chain. Attachment downloads are started as each update arrives
        // (so they run in PARALLEL and never stall the poll loop — a slow image
        // used to block every message queued behind it), but items are emitted
        // strictly in ARRIVAL ORDER, so a text can't overtake an image sent
        // before it. Order must survive delivery; latency must not serialize.
        let emit: Promise<void> = Promise.resolve()
        const setHealth = (ok: boolean, why?: string) => {
          healthy = ok
          // Every poll outcome is recorded, including unchanged ones — the gap
          // between cycles is the signal, so this must run BEFORE the
          // transition-only early return below.
          const warn = pollHealth.recordPoll(ok, Date.now())
          if (warn) process.stderr.write(`[jean] telegram ${warn}\n`)
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

              // Start the (possibly slow) attachment fetch NOW — it runs while we
              // keep polling. Failures resolve to null rather than rejecting, so a
              // bad download can't poison the chain.
              const prepared = prepareInbound(m).catch((e) => {
                process.stderr.write(`[jean] telegram inbound prepare failed: ${e}\n`)
                return null
              })
              // Provenance: the human's real send time + Telegram's monotonic id,
              // so a burst of messages keeps its sequence instead of collapsing
              // onto one record-time.
              const meta = {
                ...(typeof m.date === 'number' && { sentAt: m.date * 1000 }),
                ...(m.message_id != null && { sourceId: String(m.message_id) }),
              }
              // Lag is measured HERE, at arrival off getUpdates — not after the
              // emit chain — so a slow attachment download can't be mistaken for
              // transport lag. This is the signal that would have named the
              // 08:47–08:56Z incident while it was resolving (task 006).
              const lagWarn = pollHealth.recordInbound(meta.sentAt, Date.now())
              if (lagWarn) process.stderr.write(`[jean] telegram ${lagWarn}\n`)
              // Emit in arrival order, but don't block the poll loop on it.
              emit = emit.then(async () => {
                const text = await prepared
                if (text !== null) host.onInbound(name, text, meta)
              })
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
  let lastInboundAt: number | null = null

  return {
    kind: 'slack',
    target: channelId,
    connected: () => connected,
    // Socket Mode is PUSH, not polling — the poll fields are structurally
    // inapplicable and report null rather than a fabricated value. Slack's
    // message payload isn't parsed for a send time either (see the onInbound
    // call below, which passes no meta), so inbound lag is genuinely unknown
    // here; reporting null is the honest answer, not an omission to fix later
    // by guessing.
    health: () => ({
      connected,
      lastPollAt: null,
      lastPollOkAt: null,
      consecutiveFailures: 0,
      lastInboundAt,
      lastInboundLagMs: null,
      maxInboundLagMs: null,
    }),
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
        lastInboundAt = Date.now()
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
