import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../es/index.ts'
import { buildInbox, type Inbox, inboxGroupOf, renderInboxLine, renderInboxWake } from './inbox.ts'

const NOW = Date.parse('2026-07-24T12:00:00.000Z')

function ev(id: number, type: string, data: Record<string, unknown>, agoMs = 60_000): StoredEvent {
  return { id, stream: 's', type, ts: new Date(NOW - agoMs).toISOString(), data }
}

/** Registry stub: chat-* → user, researcher → worker, peers unknown. */
const roleOf = (name: string) => {
  if (name.startsWith('chat-')) return 'user'
  if (name === 'researcher' || name === 'builder') return 'worker'
  return undefined
}

describe('buildInbox', () => {
  test('empty input → null (the empty case must cost zero)', () => {
    expect(buildInbox([], { now: NOW, roleOf })).toBeNull()
  })

  test('user reply → blocking; worker reply → queued worker:reply', () => {
    const inbox = buildInbox(
      [
        ev(1, 'reply', { agent: 'chat-1000000001', text: "what does this one cost?" }, 41_000),
        ev(2, 'reply', { agent: 'researcher', text: 'analysis done' }, 120_000),
      ],
      { now: NOW, roleOf },
    ) as Inbox
    expect(inbox.blocking).toHaveLength(1)
    expect(inbox.blocking[0]?.from).toBe('chat-1000000001')
    expect(inbox.blocking[0]?.preview).toBe("what does this one cost?")
    expect(inbox.blocking[0]?.waitedMs).toBe(41_000)
    expect(inbox.queued.count).toBe(1)
    expect(inbox.queued.byType['worker:reply']).toBe(1)
  })

  test('unknown sender with chat- prefix classifies as user (registry fallback)', () => {
    const inbox = buildInbox([ev(1, 'reply', { agent: 'chat-999', text: 'hi' })], {
      now: NOW,
      roleOf: () => undefined,
    }) as Inbox
    expect(inbox.blocking).toHaveLength(1)
  })

  test('coalescing: one entry per sender — count, LATEST preview, OLDEST age', () => {
    const inbox = buildInbox(
      [
        ev(1, 'reply', { agent: 'chat-1', text: 'first question' }, 480_000), // 8m ago
        ev(2, 'reply', { agent: 'chat-1', text: '[image] /path/shelf.jpg' }, 200_000),
        ev(3, 'reply', { agent: 'chat-1', text: 'and the second one?' }, 30_000),
      ],
      { now: NOW, roleOf },
    ) as Inbox
    expect(inbox.blocking).toHaveLength(1)
    const b = inbox.blocking[0]
    expect(b?.count).toBe(3)
    expect(b?.ids).toEqual([1, 2, 3])
    expect(b?.preview).toBe('and the second one?') // latest
    expect(b?.waitedMs).toBe(480_000) // oldest — a burst must not look fresh
    expect(b?.kinds).toEqual({ text: 2, photo: 1 })
  })

  test('sentAt (human send-time) wins over record-time for age', () => {
    const e = ev(1, 'reply', { agent: 'chat-1', text: 'q', sentAt: NOW - 300_000 }, 10_000)
    const inbox = buildInbox([e], { now: NOW, roleOf }) as Inbox
    expect(inbox.blocking[0]?.waitedMs).toBe(300_000)
  })

  test('longest-waiting human sorts first', () => {
    const inbox = buildInbox(
      [
        ev(1, 'reply', { agent: 'chat-fresh', text: 'a' }, 10_000),
        ev(2, 'reply', { agent: 'chat-waiting', text: 'b' }, 900_000),
      ],
      { now: NOW, roleOf },
    ) as Inbox
    expect(inbox.blocking[0]?.from).toBe('chat-waiting')
  })

  test('byType granularity: trigger id, comment role, playbook collapse, oldestMs', () => {
    const inbox = buildInbox(
      [
        ev(1, 'trigger-fired', { triggerId: 'daily-audio-briefing', agent: 'sensei' }, 120_000),
        ev(2, 'task-comment', { agent: 'builder', role: 'worker', text: 'done' }, 300_000),
        ev(3, 'playbook-updated', { id: 'x' }, 30_000),
        ev(4, 'task-created', { title: 't' }, 60_000),
      ],
      { now: NOW, roleOf },
    ) as Inbox
    expect(inbox.blocking).toHaveLength(0)
    expect(inbox.queued.count).toBe(4)
    expect(inbox.queued.byType).toEqual({
      'trigger:daily-audio-briefing': 1,
      'worker:comment': 1,
      playbook: 1,
      'task-created': 1,
    })
    expect(inbox.queued.oldestMs).toBe(300_000)
  })

  test('long preview truncates', () => {
    const long = 'x'.repeat(200)
    const inbox = buildInbox([ev(1, 'reply', { agent: 'chat-1', text: long })], { now: NOW, roleOf }) as Inbox
    expect((inbox.blocking[0]?.preview ?? '').length).toBeLessThanOrEqual(91)
  })

  test('peer reply → queued peer:reply, never blocking', () => {
    const inbox = buildInbox([ev(1, 'reply', { agent: 'work-dojo', text: 'peer ping' })], {
      now: NOW,
      roleOf: (n) => (n === 'work-dojo' ? 'peer' : undefined),
    }) as Inbox
    expect(inbox.blocking).toHaveLength(0)
    expect(inbox.queued.byType['peer:reply']).toBe(1)
  })

  test('reply with missing agent → machine bucket, no crash', () => {
    const inbox = buildInbox([ev(1, 'reply', { text: 'orphan' })], { now: NOW, roleOf }) as Inbox
    expect(inbox.blocking).toHaveLength(0)
    expect(inbox.queued.count).toBe(1)
  })

  test('future sentAt clamps to zero age', () => {
    const e = ev(1, 'reply', { agent: 'chat-1', text: 'q', sentAt: NOW + 120_000 })
    const inbox = buildInbox([e], { now: NOW, roleOf }) as Inbox
    expect(inbox.blocking[0]?.waitedMs).toBe(0)
  })
})

describe('renderInboxLine', () => {
  test('blocking + queued, ASCII only', () => {
    const inbox = buildInbox(
      [
        ev(1, 'reply', { agent: 'chat-1000000001', text: 'q1' }, 180_000),
        ev(2, 'reply', { agent: 'chat-1000000001', text: 'q2' }, 60_000),
        ev(3, 'reply', { agent: 'researcher', text: 'done' }, 720_000),
      ],
      { now: NOW, roleOf },
    ) as Inbox
    const line = renderInboxLine(inbox)
    expect(line).toBe('1 blocking (chat-10000.. x2, 3m) | 1 queued (oldest 12m)')
    // Header transport: must be pure ASCII.
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true)
  })

  test('queued only', () => {
    const inbox = buildInbox([ev(1, 'task-created', { title: 't' }, 120_000)], { now: NOW, roleOf }) as Inbox
    expect(renderInboxLine(inbox)).toBe('1 queued (oldest 2m)')
  })

  test('sub-minute and hour ages format as s / h', () => {
    const a = buildInbox([ev(1, 'reply', { agent: 'chat-1', text: 'q' }, 20_000)], { now: NOW, roleOf }) as Inbox
    expect(renderInboxLine(a)).toContain('20s')
    const b = buildInbox([ev(1, 'reply', { agent: 'chat-1', text: 'q' }, 5_400_000)], { now: NOW, roleOf }) as Inbox
    expect(renderInboxLine(b)).toContain('1.5h')
  })

  test('blocking only (no queued) renders without the queued segment', () => {
    const inbox = buildInbox([ev(1, 'reply', { agent: 'chat-1', text: 'q' }, 60_000)], { now: NOW, roleOf }) as Inbox
    expect(renderInboxLine(inbox)).toBe('1 blocking (chat-1, 1m)')
  })

  test('non-ASCII sender name is sanitized — the line stays pure ASCII (header transport invariant)', () => {
    const inbox = buildInbox([ev(1, 'reply', { agent: 'chat-café🥋', text: 'q' }, 60_000)], {
      now: NOW,
      roleOf: () => 'user',
    }) as Inbox
    const line = renderInboxLine(inbox)
    expect(/^[\x20-\x7e]*$/.test(line)).toBe(true)
    expect(line).toContain('blocking')
  })
})

describe('renderInboxWake', () => {
  test('carries the full JSON object and the ack instruction', () => {
    const inbox = buildInbox([ev(1, 'reply', { agent: 'chat-1', text: 'hello' }, 60_000)], {
      now: NOW,
      roleOf,
    }) as Inbox
    const wake = renderInboxWake(inbox)
    expect(wake).toContain('"blocking"')
    expect(wake).toContain('hello')
    // CASUALTY (043 part 3, executed at the transition — task 045 change M).
    // OLD CLAIM: the wake instructs `ack({upToId`. NEW CLAIM: it instructs the
    // `{id, code}` pair form. Scenario 5 makes pairs the ONLY clearing path and
    // deletes `upToId`, so the old assertion pinned an instruction that would
    // now 400 for every agent that followed it. The claim itself — that the
    // wake TELLS the agent how to ack — is unchanged and is what this line
    // still checks.
    expect(wake).toContain('ack({pairs:')
    expect(wake).not.toContain('upToId')
    // Parseable payload between header and footer lines.
    const jsonPart = wake.split('\n').slice(1, -1).join('\n')
    expect(() => JSON.parse(jsonPart)).not.toThrow()
  })
})

describe('inboxGroupOf — ONE classification for the summary and the fetch selectors (task 051)', () => {
  // The contract this pins: the key a summary surface SHOWS is the key a
  // selector ACCEPTS, because both come from this one function. A drift here
  // is the translation gap the 051 ruling exists to prevent — most visibly
  // `playbook`, where the summary's key covers three raw event types and a
  // raw-type match would fetch nothing.
  test('a user reply groups as blocking, keyed by its sender', () => {
    expect(inboxGroupOf(ev(1, 'reply', { agent: 'chat-1000000001', text: 'hi' }), roleOf)).toEqual({
      kind: 'blocking',
      from: 'chat-1000000001',
    })
  })

  test('a worker reply groups as queued worker:reply — the sender is not a blocking key', () => {
    expect(inboxGroupOf(ev(2, 'reply', { agent: 'researcher', text: 'done' }), roleOf)).toEqual({
      kind: 'queued',
      type: 'worker:reply',
    })
  })

  test('the summary keys that differ from raw event types are the selector keys too', () => {
    expect(inboxGroupOf(ev(3, 'playbook-updated', { id: 'deploy' }), roleOf)).toEqual({
      kind: 'queued',
      type: 'playbook',
    })
    expect(inboxGroupOf(ev(4, 'trigger-fired', { triggerId: 'daily-digest', agent: 'sensei' }), roleOf)).toEqual({
      kind: 'queued',
      type: 'trigger:daily-digest',
    })
    expect(inboxGroupOf(ev(5, 'task-comment', { agent: 'researcher', role: 'worker', text: 'x' }), roleOf)).toEqual({
      kind: 'queued',
      type: 'worker:comment',
    })
  })

  test('an unlisted machine type keys as itself', () => {
    expect(inboxGroupOf(ev(6, 'task-created', { title: 't' }), roleOf)).toEqual({
      kind: 'queued',
      type: 'task-created',
    })
  })

  test('PARTITION: buildInbox files every event exactly where inboxGroupOf says', () => {
    // Structural agreement, asserted over a mixed list: blocking entries carry
    // exactly the ids the classifier calls blocking, and the byType counts
    // match a fold of the classifier's queued keys. If buildInbox ever grows a
    // second opinion, this is the case that names it.
    const events = [
      ev(1, 'reply', { agent: 'chat-1', text: 'q1' }),
      ev(2, 'reply', { agent: 'researcher', text: 'r1' }),
      ev(3, 'playbook-created', { id: 'p' }),
      ev(4, 'playbook-removed', { id: 'p' }),
      ev(5, 'task-created', { title: 't' }),
      ev(6, 'reply', { agent: 'chat-1', text: 'q2' }),
    ]
    const inbox = buildInbox(events, { now: NOW, roleOf }) as Inbox
    const blockingIds = new Set(inbox.blocking.flatMap((b) => b.ids))
    const expectQueued: Record<string, number> = {}
    for (const e of events) {
      const g = inboxGroupOf(e, roleOf)
      if (g.kind === 'blocking') expect(blockingIds.has(e.id)).toBe(true)
      else expectQueued[g.type] = (expectQueued[g.type] ?? 0) + 1
    }
    expect(inbox.queued.byType).toEqual(expectQueued)
    expect(inbox.queued.count).toBe(events.length - blockingIds.size)
  })
})
