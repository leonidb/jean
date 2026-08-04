import { describe, expect, test } from 'bun:test'
import { createBridgeHealth, selectBridge } from './bridge.ts'
import type { JeanConfig } from './config.ts'

describe('selectBridge', () => {
  test('returns null when nothing is configured', () => {
    expect(selectBridge({})).toBeNull()
  })

  test('selects telegram when botToken + chatId are set', () => {
    const bridge = selectBridge({ telegram: { botToken: 'bot:abc', chatId: '12345' } })
    expect(bridge?.kind).toBe('telegram')
    expect(bridge?.target).toBe('12345')
  })

  test('selects slack when appToken + botToken + channel are set', () => {
    const bridge = selectBridge({ slack: { appToken: 'xapp-1', botToken: 'xoxb-1', channel: 'C123' } })
    expect(bridge?.kind).toBe('slack')
    expect(bridge?.target).toBe('C123')
  })

  test('telegram wins when both are configured', () => {
    const config: JeanConfig = {
      telegram: { botToken: 'bot:abc', chatId: '12345' },
      slack: { appToken: 'xapp-1', botToken: 'xoxb-1', channel: 'C123' },
    }
    expect(selectBridge(config)?.kind).toBe('telegram')
  })

  test('ignores partial telegram config (missing chatId)', () => {
    expect(selectBridge({ telegram: { botToken: 'bot:abc' } })).toBeNull()
  })

  test('ignores partial slack config (missing channel), no telegram', () => {
    expect(selectBridge({ slack: { appToken: 'xapp-1', botToken: 'xoxb-1' } })).toBeNull()
  })

  test('falls back to slack when telegram is only partially configured', () => {
    const config: JeanConfig = {
      telegram: { botToken: 'bot:abc' }, // missing chatId — incomplete
      slack: { appToken: 'xapp-1', botToken: 'xoxb-1', channel: 'C123' },
    }
    expect(selectBridge(config)?.kind).toBe('slack')
  })
})

// ── Bridge health (task 006) ──────────────────────────────────────
//
// TESTING NOTE, worth reading before extending these: the Telegram poll loop
// itself is NOT reachable from a test. It is an infinite `for(;;)` inside a
// closure that calls global `fetch` directly, started off the un-awaited tail of
// `start()` — there is no fake-Telegram harness in this file (or anywhere in
// src/infra: nothing mocks `fetch`), so "simulate a poll gap" against the real
// loop would mean stubbing globalThis.fetch and racing an unstoppable loop.
//
// That is why the health logic is a separate, clock-injected unit. These tests
// drive it directly with the incident's real timestamps, which is both more
// precise and more durable than poking a live loop.

const T0 = Date.parse('2026-07-25T08:46:00.000Z')
const s = (n: number) => n * 1000

describe('createBridgeHealth — poll liveness', () => {
  test('first poll reports no gap (nothing to compare against)', () => {
    const h = createBridgeHealth()
    expect(h.recordPoll(true, T0)).toBeNull()
    expect(h.snapshot(true).lastPollAt).toBe(T0)
  })

  test('normal long-poll cadence (~50s) never warns', () => {
    const h = createBridgeHealth()
    let now = T0
    for (let i = 0; i < 20; i++) {
      expect(h.recordPoll(true, now)).toBeNull()
      now += s(50)
    }
  })

  test('a gap beyond the threshold warns, and names the gap', () => {
    const h = createBridgeHealth()
    h.recordPoll(true, T0)
    const warn = h.recordPoll(true, T0 + s(300))
    expect(warn).toContain('poll gap 300s')
    expect(warn).toContain('poll loop was stalled')
  })

  test('the threshold is read at CALL time, so it can be varied per test', () => {
    // Refactor stage 2: this env var used to be frozen into a module constant at
    // import, which meant it could only be varied per PROCESS — workable for the
    // spawn suite (a fresh subprocess each) and impossible in-process, where all
    // files share one module instance. Pinning the call-time read here so it
    // cannot quietly regress to an import-time constant.
    const saved = process.env.JEAN_BRIDGE_POLL_GAP_MS
    try {
      process.env.JEAN_BRIDGE_POLL_GAP_MS = String(s(10))
      const h = createBridgeHealth()
      h.recordPoll(true, T0)
      // 60s: far inside the 120s default, well beyond the 10s override. Under
      // the old import-time constant this returned null.
      const warn = h.recordPoll(true, T0 + s(60))
      expect(warn).toContain('poll gap 60s')
      expect(warn).toContain('threshold 10s')
    } finally {
      if (saved === undefined) delete process.env.JEAN_BRIDGE_POLL_GAP_MS
      else process.env.JEAN_BRIDGE_POLL_GAP_MS = saved
    }
  })

  test('failures accumulate and a success resets them; lastPollOkAt tracks only successes', () => {
    const h = createBridgeHealth()
    h.recordPoll(true, T0)
    h.recordPoll(false, T0 + s(2))
    h.recordPoll(false, T0 + s(4))
    let snap = h.snapshot(false)
    expect(snap.consecutiveFailures).toBe(2)
    expect(snap.lastPollOkAt).toBe(T0)
    expect(snap.lastPollAt).toBe(T0 + s(4))

    h.recordPoll(true, T0 + s(6))
    snap = h.snapshot(true)
    expect(snap.consecutiveFailures).toBe(0)
    expect(snap.lastPollOkAt).toBe(T0 + s(6))
  })
})

describe('createBridgeHealth — inbound lag', () => {
  test('a promptly-delivered message does not warn', () => {
    const h = createBridgeHealth()
    expect(h.recordInbound(T0, T0 + 400)).toBeNull()
    expect(h.snapshot(true).lastInboundLagMs).toBe(400)
  })

  test('the 2026-07-25 incident lag warns and is recorded', () => {
    const h = createBridgeHealth()
    // The message: sentAt 08:46:46Z, reached infra 08:56:13Z.
    const sentAt = Date.parse('2026-07-25T08:46:46.000Z')
    const receivedAt = Date.parse('2026-07-25T08:56:13.000Z')
    const warn = h.recordInbound(sentAt, receivedAt)
    expect(warn).toContain('inbound lagged 567s')
    expect(warn).toContain('our poll loop was healthy')
    expect(h.snapshot(true).lastInboundLagMs).toBe(s(567))
  })

  test('maxInboundLagMs survives the resolving batch — the evidence outlives the window', () => {
    const h = createBridgeHealth()
    h.recordInbound(T0, T0 + s(567)) // the lagging message
    // 09:00:23Z arrived sub-second once the window closed; without a max, the
    // only trace of a 9-minute stall would vanish on the very next message.
    h.recordInbound(T0 + s(900), T0 + s(900) + 200)
    const snap = h.snapshot(true)
    expect(snap.lastInboundLagMs).toBe(200)
    expect(snap.maxInboundLagMs).toBe(s(567))
  })

  test('a surface with no send time reports null lag, not a fabricated zero', () => {
    const h = createBridgeHealth()
    expect(h.recordInbound(undefined, T0)).toBeNull()
    const snap = h.snapshot(true)
    expect(snap.lastInboundAt).toBe(T0)
    expect(snap.lastInboundLagMs).toBeNull()
  })

  test('clock skew clamps to zero rather than reporting a negative lag', () => {
    const h = createBridgeHealth()
    // Telegram `date` has 1s resolution, so a just-sent message can look future-dated.
    expect(h.recordInbound(T0 + 800, T0)).toBeNull()
    expect(h.snapshot(true).lastInboundLagMs).toBe(0)
  })
})

describe('createBridgeHealth — the incident, replayed', () => {
  // THE POINT OF THIS TEST: it pins the finding that motivated the design —
  // poll-liveness alone would NOT have detected the 08:47–08:56Z incident,
  // because the poll loop was completing normally the whole time. If someone
  // later "simplifies" by dropping the inbound-lag signal and keeping only the
  // poll gap, this fails.
  test('polls stay healthy across the stall; only the inbound lag reveals it', () => {
    const h = createBridgeHealth()
    let now = T0
    let pollWarnings = 0
    // ~10 minutes of long-polls returning empty — indistinguishable from a
    // quiet chat, which is exactly why this class needs its own signal.
    for (let i = 0; i < 12; i++) {
      if (h.recordPoll(true, now)) pollWarnings++
      now += s(50)
    }
    expect(pollWarnings).toBe(0)
    expect(h.snapshot(true).consecutiveFailures).toBe(0)

    // Then the held batch lands, carrying its true age.
    const lagWarn = h.recordInbound(T0, now)
    expect(lagWarn).not.toBeNull()
    expect(h.snapshot(true).maxInboundLagMs).toBeGreaterThan(s(560))
  })
})

describe('bridge health surface', () => {
  test('a telegram bridge exposes health before any poll has run', () => {
    const bridge = selectBridge({ telegram: { botToken: 'bot:abc', chatId: '12345' } })
    const h = bridge?.health()
    expect(h?.connected).toBe(false)
    expect(h?.lastPollAt).toBeNull()
    expect(h?.lastInboundLagMs).toBeNull()
    expect(h?.consecutiveFailures).toBe(0)
  })

  test('slack reports null poll fields — push transport, not polling', () => {
    const bridge = selectBridge({ slack: { appToken: 'xapp-1', botToken: 'xoxb-1', channel: 'C123' } })
    const h = bridge?.health()
    expect(h?.lastPollAt).toBeNull()
    expect(h?.lastPollOkAt).toBeNull()
    expect(h?.lastInboundLagMs).toBeNull()
  })
})
