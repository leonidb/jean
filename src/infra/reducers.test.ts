import { describe, expect, test } from 'bun:test'
import type { StoredEvent } from '../es/index.ts'
import type { Board, TaskStatus } from './board.ts'
import {
  type AckData,
  type AgentIdleData,
  agentStream,
  boardReducer,
  migrateBoard,
  PLAYBOOKS_STREAM,
  type PlaybookCreatedData,
  type PlaybookRemovedData,
  type PlaybookState,
  type PlaybookUpdatedData,
  pendingReducer,
  playbookReducer,
  SYSTEM_STREAM,
  type TaskCreatedData,
  type TaskRevertedData,
  type TaskStatusData,
  type TaskUpdatedData,
  TRIGGERS_STREAM,
  type TriggerCreatedData,
  type TriggerFiredData,
  type TriggerRemovedData,
  type TriggerState,
  type TriggerUpdatedData,
  taskStream,
  toApiEvent,
  triggerReducer,
  type WikiConsolidatedData,
} from './reducers.ts'

function makeEvent(id: number, type: string, stream: string, data: unknown): StoredEvent {
  return { id, type, stream, ts: `2026-01-01T00:00:0${id}Z`, data }
}

// ── Board reducer ────────────────────────────────────────────────

describe('boardReducer', () => {
  const empty: Board = { tasks: [] }

  test('task-created adds a task', () => {
    const e = makeEvent(1, 'task-created', taskStream('001'), {
      title: 'Fix bug',
      description: 'Details',
      queue: 'scratch',
    } satisfies TaskCreatedData)
    const board = boardReducer(empty, e)
    expect(board.tasks.length).toBe(1)
    expect(board.tasks[0]?.id).toBe('001')
    expect(board.tasks[0]?.title).toBe('Fix bug')
    expect(board.tasks[0]?.status).toBe('todo')
    expect(board.tasks[0]?.queue).toBe('scratch')
  })

  test('task-status updates status', () => {
    const e1 = makeEvent(1, 'task-created', taskStream('001'), {
      title: 'T',
      description: '',
      queue: 'q',
    } satisfies TaskCreatedData)
    const e2 = makeEvent(2, 'task-status', taskStream('001'), {
      from: 'todo',
      to: 'in-progress',
    } satisfies TaskStatusData)
    const board = boardReducer(boardReducer(empty, e1), e2)
    expect(board.tasks[0]?.status).toBe('in-progress')
  })

  test('task-reverted sets status to `to`, bypassing the DAG', () => {
    const e1 = makeEvent(1, 'task-created', taskStream('001'), {
      title: 'T',
      description: '',
      queue: 'q',
    } satisfies TaskCreatedData)
    const e2 = makeEvent(2, 'task-status', taskStream('001'), {
      from: 'todo',
      to: 'in-progress',
    } satisfies TaskStatusData)
    const e3 = makeEvent(3, 'task-status', taskStream('001'), {
      from: 'in-progress',
      to: 'done',
    } satisfies TaskStatusData)
    // `done → in-progress` is forbidden by canTransition, but task-reverted bypasses that.
    const e4 = makeEvent(4, 'task-reverted', taskStream('001'), {
      from: 'done',
      to: 'in-progress',
      actor: 'cli',
    } satisfies TaskRevertedData)
    const board = [e1, e2, e3, e4].reduce(boardReducer, empty)
    expect(board.tasks[0]?.status).toBe('in-progress')
    expect(board.tasks[0]?.updatedAt).toBe(e4.ts)
  })

  test('task-updated updates fields', () => {
    const e1 = makeEvent(1, 'task-created', taskStream('001'), {
      title: 'T',
      description: '',
      queue: 'q',
    } satisfies TaskCreatedData)
    const e2 = makeEvent(2, 'task-updated', taskStream('001'), {
      agent: 'scratch',
      description: 'Updated desc',
    } satisfies TaskUpdatedData)
    const board = boardReducer(boardReducer(empty, e1), e2)
    expect(board.tasks[0]?.agent).toBe('scratch')
    expect(board.tasks[0]?.description).toBe('Updated desc')
  })

  test('migrates legacy status names in task-status events', () => {
    const e1 = makeEvent(1, 'task-created', taskStream('001'), {
      title: 'T',
      description: '',
      queue: 'q',
    } satisfies TaskCreatedData)
    const e2 = makeEvent(2, 'task-status', taskStream('001'), {
      from: 'inbox' as TaskStatus,
      to: 'active' as TaskStatus,
    } satisfies TaskStatusData)
    const board = boardReducer(boardReducer(empty, e1), e2)
    expect(board.tasks[0]?.status).toBe('in-progress')
  })

  test('ignores unrelated events', () => {
    const e = makeEvent(1, 'reply', agentStream('scratch'), { text: 'hello' })
    const board = boardReducer(empty, e)
    expect(board.tasks.length).toBe(0)
  })

  test('multiple tasks', () => {
    let board = empty
    board = boardReducer(
      board,
      makeEvent(1, 'task-created', taskStream('001'), {
        title: 'A',
        description: '',
        queue: 'q',
      } satisfies TaskCreatedData),
    )
    board = boardReducer(
      board,
      makeEvent(2, 'task-created', taskStream('002'), {
        title: 'B',
        description: '',
        queue: 'q',
      } satisfies TaskCreatedData),
    )
    board = boardReducer(
      board,
      makeEvent(3, 'task-status', taskStream('001'), {
        from: 'todo',
        to: 'in-progress',
      } satisfies TaskStatusData),
    )
    expect(board.tasks.length).toBe(2)
    expect(board.tasks[0]?.status).toBe('in-progress')
    expect(board.tasks[1]?.status).toBe('todo')
  })
})

// ── Board migration ─────────────────────────────────────────────

describe('migrateBoard', () => {
  test('migrates legacy statuses in snapshot', () => {
    const board: Board = {
      tasks: [
        // biome-ignore lint/suspicious/noExplicitAny: legacy value for migration test
        { id: '001', title: 'A', description: '', status: 'inbox' as any, queue: 'q', createdAt: '', updatedAt: '' },
        // biome-ignore lint/suspicious/noExplicitAny: legacy value for migration test
        { id: '002', title: 'B', description: '', status: 'active' as any, queue: 'q', createdAt: '', updatedAt: '' },
        { id: '003', title: 'C', description: '', status: 'done', queue: 'q', createdAt: '', updatedAt: '' },
      ],
    }
    const migrated = migrateBoard(board)
    expect(migrated.tasks[0]?.status).toBe('todo')
    expect(migrated.tasks[1]?.status).toBe('in-progress')
    expect(migrated.tasks[2]?.status).toBe('done')
  })

  test('returns same object if no migration needed', () => {
    const board: Board = {
      tasks: [{ id: '001', title: 'A', description: '', status: 'todo', queue: 'q', createdAt: '', updatedAt: '' }],
    }
    const migrated = migrateBoard(board)
    expect(migrated).toBe(board)
  })
})

// ── Pending reducer ──────────────────────────────────────────────

describe('pendingReducer', () => {
  test('reply adds to pending', () => {
    const e = makeEvent(1, 'reply', agentStream('scratch'), { text: 'done' })
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
    expect(state[0]?.id).toBe(1)
  })

  test('task-created adds to pending', () => {
    const e = makeEvent(1, 'task-created', taskStream('001'), {
      title: 'T',
      description: '',
      queue: 'q',
    })
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
  })

  test('worker agent-idle does NOT add to pending (idle is diagnostic-only)', () => {
    const e = makeEvent(1, 'agent-idle', agentStream('scratch'), {
      agent: 'scratch',
      role: 'worker',
    } satisfies AgentIdleData)
    const state = pendingReducer([], e)
    expect(state.length).toBe(0)
  })

  test('sensei agent-idle does NOT add to pending', () => {
    const e = makeEvent(1, 'agent-idle', agentStream('sensei'), {
      agent: 'sensei',
      role: 'sensei',
    } satisfies AgentIdleData)
    const state = pendingReducer([], e)
    expect(state.length).toBe(0)
  })

  test('worker register adds to pending (sensei should see new agents)', () => {
    const e = makeEvent(1, 'register', agentStream('scratch'), {
      agent: 'scratch',
      role: 'worker',
      idle: true,
    })
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
  })

  test('sensei register does NOT add to pending (no self-nudge)', () => {
    const e = makeEvent(1, 'register', agentStream('sensei'), {
      agent: 'sensei',
      role: 'sensei',
      idle: true,
    })
    const state = pendingReducer([], e)
    expect(state.length).toBe(0)
  })

  test('disconnect adds to pending (sensei should see agents leaving)', () => {
    const e = makeEvent(1, 'disconnect', agentStream('scratch'), { agent: 'scratch' })
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
  })

  test('worker task-comment adds to pending (curated, replaces idle as the wake signal)', () => {
    const e = makeEvent(1, 'task-comment', taskStream('001'), {
      agent: 'scratch',
      role: 'worker',
      text: 'finding: X',
    })
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
  })

  test('ack removes events by ID', () => {
    const e1 = makeEvent(1, 'reply', agentStream('a'), { text: 'x' })
    const e2 = makeEvent(2, 'reply', agentStream('a'), { text: 'y' })
    const e3 = makeEvent(3, 'reply', agentStream('a'), { text: 'z' })
    let state = [e1, e2, e3]
    const ack = makeEvent(4, 'ack', SYSTEM_STREAM, {
      eventIds: [1, 2],
    } satisfies AckData)
    state = pendingReducer(state, ack)
    expect(state.length).toBe(1)
    expect(state[0]?.id).toBe(3)
  })

  test('trigger-fired adds to pending', () => {
    const e = makeEvent(1, 'trigger-fired', TRIGGERS_STREAM, {
      triggerId: 'morning',
      agent: 'sensei',
      prompt: 'Run brief',
    } satisfies TriggerFiredData)
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
    expect(state[0]?.type).toBe('trigger-fired')
  })

  test('headless trigger-fired does NOT add to pending (librarian runs are not sensei-actionable)', () => {
    const e = makeEvent(1, 'trigger-fired', TRIGGERS_STREAM, {
      triggerId: 'consolidate-wiki',
      agent: 'librarian',
      prompt: 'consolidate',
      kind: 'headless',
    } satisfies TriggerFiredData)
    const state = pendingReducer([], e)
    expect(state.length).toBe(0)
  })

  test('wiki-consolidated with real work adds to pending (sensei should know it happened)', () => {
    const e = makeEvent(1, 'wiki-consolidated', SYSTEM_STREAM, {
      pagesUpdated: 2,
      eventsProcessed: 5,
    } satisfies WikiConsolidatedData)
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
    expect(state[0]?.type).toBe('wiki-consolidated')
  })

  test('wiki-consolidated with anomalies adds to pending', () => {
    const e = makeEvent(1, 'wiki-consolidated', SYSTEM_STREAM, {
      anomalies: ['stale reference on team-style.md'],
    } satisfies WikiConsolidatedData)
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
  })

  test('no-op wiki-consolidated does NOT add to pending (nothing changed, stay silent)', () => {
    const e = makeEvent(1, 'wiki-consolidated', SYSTEM_STREAM, {
      eventsProcessed: 3,
      pagesCreated: 0,
      pagesUpdated: 0,
    } satisfies WikiConsolidatedData)
    const state = pendingReducer([], e)
    expect(state.length).toBe(0)
  })

  test('ignores unrelated events', () => {
    const e = makeEvent(1, 'nudge', SYSTEM_STREAM, { pendingCount: 1 })
    const state = pendingReducer([], e)
    expect(state.length).toBe(0)
  })
})

// ── Trigger reducer ──────────────────────────────────────────────

describe('triggerReducer', () => {
  const empty: TriggerState = { triggers: [] }

  test('trigger-created adds a trigger', () => {
    const e = makeEvent(1, 'trigger-created', TRIGGERS_STREAM, {
      id: 'morning',
      cron: '0 8 * * 1-5',
      agent: 'sensei',
      prompt: 'Run brief',
      actor: 'cli',
    } satisfies TriggerCreatedData)
    const state = triggerReducer(empty, e)
    expect(state.triggers.length).toBe(1)
    expect(state.triggers[0]?.id).toBe('morning')
    expect(state.triggers[0]?.status).toBe('active')
    expect(state.triggers[0]?.cron).toBe('0 8 * * 1-5')
    expect(state.triggers[0]?.createdAt).toBe(e.ts)
  })

  test('trigger-created with one-off at', () => {
    const e = makeEvent(1, 'trigger-created', TRIGGERS_STREAM, {
      id: 'reminder',
      at: '2026-04-07T10:00:00Z',
      agent: 'sensei',
      prompt: 'Check PR',
      actor: 'sensei',
    } satisfies TriggerCreatedData)
    const state = triggerReducer(empty, e)
    expect(state.triggers[0]?.at).toBe('2026-04-07T10:00:00Z')
    expect(state.triggers[0]?.cron).toBeUndefined()
  })

  test('trigger-updated updates fields', () => {
    const e1 = makeEvent(1, 'trigger-created', TRIGGERS_STREAM, {
      id: 'morning',
      cron: '0 8 * * 1-5',
      agent: 'sensei',
      prompt: 'Run brief',
      actor: 'cli',
    } satisfies TriggerCreatedData)
    const e2 = makeEvent(2, 'trigger-updated', TRIGGERS_STREAM, {
      id: 'morning',
      prompt: 'Run morning brief and post to Slack',
    } satisfies TriggerUpdatedData)
    const state = triggerReducer(triggerReducer(empty, e1), e2)
    expect(state.triggers[0]?.prompt).toBe('Run morning brief and post to Slack')
    expect(state.triggers[0]?.cron).toBe('0 8 * * 1-5') // unchanged
  })

  test('trigger-updated can disable', () => {
    const e1 = makeEvent(1, 'trigger-created', TRIGGERS_STREAM, {
      id: 'x',
      cron: '* * * * *',
      agent: 'a',
      prompt: 'p',
      actor: 'cli',
    } satisfies TriggerCreatedData)
    const e2 = makeEvent(2, 'trigger-updated', TRIGGERS_STREAM, {
      id: 'x',
      status: 'disabled',
    } satisfies TriggerUpdatedData)
    const state = triggerReducer(triggerReducer(empty, e1), e2)
    expect(state.triggers[0]?.status).toBe('disabled')
  })

  test('trigger-removed deletes trigger', () => {
    const e1 = makeEvent(1, 'trigger-created', TRIGGERS_STREAM, {
      id: 'x',
      cron: '* * * * *',
      agent: 'a',
      prompt: 'p',
      actor: 'cli',
    } satisfies TriggerCreatedData)
    const e2 = makeEvent(2, 'trigger-removed', TRIGGERS_STREAM, {
      id: 'x',
    } satisfies TriggerRemovedData)
    const state = triggerReducer(triggerReducer(empty, e1), e2)
    expect(state.triggers.length).toBe(0)
  })

  test('trigger-fired sets lastFiredAt on cron trigger, keeps active', () => {
    const e1 = makeEvent(1, 'trigger-created', TRIGGERS_STREAM, {
      id: 'morning',
      cron: '0 8 * * 1-5',
      agent: 'sensei',
      prompt: 'Run brief',
      actor: 'cli',
    } satisfies TriggerCreatedData)
    const e2 = makeEvent(2, 'trigger-fired', TRIGGERS_STREAM, {
      triggerId: 'morning',
      agent: 'sensei',
      prompt: 'Run brief',
    } satisfies TriggerFiredData)
    const state = triggerReducer(triggerReducer(empty, e1), e2)
    expect(state.triggers[0]?.lastFiredAt).toBe(e2.ts)
    expect(state.triggers[0]?.status).toBe('active')
  })

  test('trigger-fired sets status to fired on one-off trigger', () => {
    const e1 = makeEvent(1, 'trigger-created', TRIGGERS_STREAM, {
      id: 'reminder',
      at: '2026-04-07T10:00:00Z',
      agent: 'sensei',
      prompt: 'Check PR',
      actor: 'sensei',
    } satisfies TriggerCreatedData)
    const e2 = makeEvent(2, 'trigger-fired', TRIGGERS_STREAM, {
      triggerId: 'reminder',
      agent: 'sensei',
      prompt: 'Check PR',
    } satisfies TriggerFiredData)
    const state = triggerReducer(triggerReducer(empty, e1), e2)
    expect(state.triggers[0]?.status).toBe('fired')
    expect(state.triggers[0]?.lastFiredAt).toBe(e2.ts)
  })

  test('ignores unrelated events', () => {
    const e = makeEvent(1, 'reply', agentStream('scratch'), { text: 'hello' })
    const state = triggerReducer(empty, e)
    expect(state.triggers.length).toBe(0)
  })
})

// ── Playbook reducer ────────────────────────────────────────────

describe('playbookReducer', () => {
  const empty: PlaybookState = { playbooks: [] }

  const sampleContent = `---
name: review
description: >
  PR code review lifecycle.
---

# Review

One task per PR.`

  test('playbook-created adds a playbook', () => {
    const e = makeEvent(1, 'playbook-created', PLAYBOOKS_STREAM, {
      id: 'review',
      content: sampleContent,
      hash: 'abc123',
    } satisfies PlaybookCreatedData)
    const state = playbookReducer(empty, e)
    expect(state.playbooks.length).toBe(1)
    expect(state.playbooks[0]?.id).toBe('review')
    expect(state.playbooks[0]?.name).toBe('review')
    expect(state.playbooks[0]?.description).toBe('PR code review lifecycle.')
    expect(state.playbooks[0]?.hash).toBe('abc123')
    expect(state.playbooks[0]?.content).toBe(sampleContent)
  })

  test('playbook-created with no frontmatter uses id as name', () => {
    const e = makeEvent(1, 'playbook-created', PLAYBOOKS_STREAM, {
      id: 'dev',
      content: '# Dev\n\nJust markdown.',
      hash: 'def456',
    } satisfies PlaybookCreatedData)
    const state = playbookReducer(empty, e)
    expect(state.playbooks[0]?.name).toBe('dev')
    expect(state.playbooks[0]?.description).toBe('')
  })

  test('playbook-updated updates content and metadata', () => {
    const e1 = makeEvent(1, 'playbook-created', PLAYBOOKS_STREAM, {
      id: 'review',
      content: sampleContent,
      hash: 'abc123',
    } satisfies PlaybookCreatedData)
    const newContent = sampleContent.replace('One task per PR.', 'One task per PR. Updated.')
    const e2 = makeEvent(2, 'playbook-updated', PLAYBOOKS_STREAM, {
      id: 'review',
      content: newContent,
      hash: 'def789',
      prevHash: 'abc123',
    } satisfies PlaybookUpdatedData)
    const state = playbookReducer(playbookReducer(empty, e1), e2)
    expect(state.playbooks[0]?.hash).toBe('def789')
    expect(state.playbooks[0]?.content).toContain('Updated.')
  })

  test('playbook-removed deletes playbook', () => {
    const e1 = makeEvent(1, 'playbook-created', PLAYBOOKS_STREAM, {
      id: 'review',
      content: sampleContent,
      hash: 'abc123',
    } satisfies PlaybookCreatedData)
    const e2 = makeEvent(2, 'playbook-removed', PLAYBOOKS_STREAM, {
      id: 'review',
      lastHash: 'abc123',
    } satisfies PlaybookRemovedData)
    const state = playbookReducer(playbookReducer(empty, e1), e2)
    expect(state.playbooks.length).toBe(0)
  })

  test('ignores unrelated events', () => {
    const e = makeEvent(1, 'reply', agentStream('scratch'), { text: 'hello' })
    const state = playbookReducer(empty, e)
    expect(state.playbooks.length).toBe(0)
  })
})

describe('pendingReducer — playbook events', () => {
  test('playbook-created adds to pending', () => {
    const e = makeEvent(1, 'playbook-created', PLAYBOOKS_STREAM, {
      id: 'review',
      content: '# Review',
      hash: 'abc',
    })
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
  })

  test('playbook-updated adds to pending', () => {
    const e = makeEvent(1, 'playbook-updated', PLAYBOOKS_STREAM, {
      id: 'review',
      content: '# Review v2',
      hash: 'def',
      prevHash: 'abc',
    })
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
  })

  test('playbook-removed adds to pending', () => {
    const e = makeEvent(1, 'playbook-removed', PLAYBOOKS_STREAM, {
      id: 'review',
      lastHash: 'abc',
    })
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
  })
})

// ── API event format ─────────────────────────────────────────────

describe('toApiEvent', () => {
  test('extracts taskId from stream', () => {
    const e = makeEvent(1, 'task-created', taskStream('001'), { title: 'T' })
    const api = toApiEvent(e)
    expect(api.taskId).toBe('001')
    expect(api.type).toBe('task-created')
  })

  test('extracts agent from stream', () => {
    const e = makeEvent(1, 'reply', agentStream('scratch'), { text: 'hi' })
    const api = toApiEvent(e)
    expect(api.agent).toBe('scratch')
  })

  test('extracts agent from data when stream is not agent-prefixed', () => {
    const e = makeEvent(1, 'send', taskStream('001'), { agent: 'scratch', text: 'go', from: 'sensei', delivered: true })
    const api = toApiEvent(e)
    expect(api.taskId).toBe('001')
    expect(api.agent).toBe('scratch')
  })

  test('includes data as-is', () => {
    const e = makeEvent(1, 'task-status', taskStream('001'), { from: 'inbox', to: 'active' })
    const api = toApiEvent(e)
    expect(api.data).toEqual({ from: 'inbox', to: 'active' })
  })
})
