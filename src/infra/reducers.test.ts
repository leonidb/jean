import { describe, test, expect } from 'bun:test'
import type { StoredEvent } from '../es/index.ts'
import {
  boardReducer, migrateBoard, pendingReducer, triggerReducer, toApiEvent,
  taskStream, agentStream, SYSTEM_STREAM, TRIGGERS_STREAM,
  type TaskCreatedData, type TaskStatusData, type TaskUpdatedData,
  type AckData, type AgentIdleData,
  type TriggerCreatedData, type TriggerUpdatedData, type TriggerRemovedData, type TriggerFiredData,
  type TriggerState,
} from './reducers.ts'
import type { Board } from './board.ts'

function makeEvent(id: number, type: string, stream: string, data: unknown): StoredEvent {
  return { id, type, stream, ts: `2026-01-01T00:00:0${id}Z`, data }
}

// ── Board reducer ────────────────────────────────────────────────

describe('boardReducer', () => {
  const empty: Board = { tasks: [] }

  test('task-created adds a task', () => {
    const e = makeEvent(1, 'task-created', taskStream('001'), {
      title: 'Fix bug', description: 'Details', queue: 'scratch',
    } satisfies TaskCreatedData)
    const board = boardReducer(empty, e)
    expect(board.tasks.length).toBe(1)
    expect(board.tasks[0]!.id).toBe('001')
    expect(board.tasks[0]!.title).toBe('Fix bug')
    expect(board.tasks[0]!.status).toBe('todo')
    expect(board.tasks[0]!.queue).toBe('scratch')
  })

  test('task-status updates status', () => {
    const e1 = makeEvent(1, 'task-created', taskStream('001'), {
      title: 'T', description: '', queue: 'q',
    } satisfies TaskCreatedData)
    const e2 = makeEvent(2, 'task-status', taskStream('001'), {
      from: 'todo', to: 'in-progress',
    } satisfies TaskStatusData)
    const board = boardReducer(boardReducer(empty, e1), e2)
    expect(board.tasks[0]!.status).toBe('in-progress')
  })

  test('task-updated updates fields', () => {
    const e1 = makeEvent(1, 'task-created', taskStream('001'), {
      title: 'T', description: '', queue: 'q',
    } satisfies TaskCreatedData)
    const e2 = makeEvent(2, 'task-updated', taskStream('001'), {
      agent: 'scratch', description: 'Updated desc',
    } satisfies TaskUpdatedData)
    const board = boardReducer(boardReducer(empty, e1), e2)
    expect(board.tasks[0]!.agent).toBe('scratch')
    expect(board.tasks[0]!.description).toBe('Updated desc')
  })

  test('migrates legacy status names in task-status events', () => {
    const e1 = makeEvent(1, 'task-created', taskStream('001'), {
      title: 'T', description: '', queue: 'q',
    } satisfies TaskCreatedData)
    const e2 = makeEvent(2, 'task-status', taskStream('001'), {
      from: 'inbox', to: 'active',
    } satisfies TaskStatusData)
    const board = boardReducer(boardReducer(empty, e1), e2)
    expect(board.tasks[0]!.status).toBe('in-progress')
  })

  test('ignores unrelated events', () => {
    const e = makeEvent(1, 'reply', agentStream('scratch'), { text: 'hello' })
    const board = boardReducer(empty, e)
    expect(board.tasks.length).toBe(0)
  })

  test('multiple tasks', () => {
    let board = empty
    board = boardReducer(board, makeEvent(1, 'task-created', taskStream('001'), {
      title: 'A', description: '', queue: 'q',
    } satisfies TaskCreatedData))
    board = boardReducer(board, makeEvent(2, 'task-created', taskStream('002'), {
      title: 'B', description: '', queue: 'q',
    } satisfies TaskCreatedData))
    board = boardReducer(board, makeEvent(3, 'task-status', taskStream('001'), {
      from: 'todo', to: 'in-progress',
    } satisfies TaskStatusData))
    expect(board.tasks.length).toBe(2)
    expect(board.tasks[0]!.status).toBe('in-progress')
    expect(board.tasks[1]!.status).toBe('todo')
  })
})

// ── Board migration ─────────────────────────────────────────────

describe('migrateBoard', () => {
  test('migrates legacy statuses in snapshot', () => {
    const board: Board = {
      tasks: [
        { id: '001', title: 'A', description: '', status: 'inbox' as any, queue: 'q', createdAt: '', updatedAt: '' },
        { id: '002', title: 'B', description: '', status: 'active' as any, queue: 'q', createdAt: '', updatedAt: '' },
        { id: '003', title: 'C', description: '', status: 'done', queue: 'q', createdAt: '', updatedAt: '' },
      ],
    }
    const migrated = migrateBoard(board)
    expect(migrated.tasks[0]!.status).toBe('todo')
    expect(migrated.tasks[1]!.status).toBe('in-progress')
    expect(migrated.tasks[2]!.status).toBe('done')
  })

  test('returns same object if no migration needed', () => {
    const board: Board = {
      tasks: [
        { id: '001', title: 'A', description: '', status: 'todo', queue: 'q', createdAt: '', updatedAt: '' },
      ],
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
    expect(state[0]!.id).toBe(1)
  })

  test('task-created adds to pending', () => {
    const e = makeEvent(1, 'task-created', taskStream('001'), {
      title: 'T', description: '', queue: 'q',
    })
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
  })

  test('worker agent-idle adds to pending', () => {
    const e = makeEvent(1, 'agent-idle', agentStream('scratch'), {
      role: 'worker',
    } satisfies AgentIdleData)
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
  })

  test('sensei agent-idle does NOT add to pending', () => {
    const e = makeEvent(1, 'agent-idle', agentStream('sensei'), {
      role: 'sensei',
    } satisfies AgentIdleData)
    const state = pendingReducer([], e)
    expect(state.length).toBe(0)
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
    expect(state[0]!.id).toBe(3)
  })

  test('trigger-fired adds to pending', () => {
    const e = makeEvent(1, 'trigger-fired', TRIGGERS_STREAM, {
      triggerId: 'morning', agent: 'sensei', prompt: 'Run brief',
    } satisfies TriggerFiredData)
    const state = pendingReducer([], e)
    expect(state.length).toBe(1)
    expect(state[0]!.type).toBe('trigger-fired')
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
      id: 'morning', cron: '0 8 * * 1-5', agent: 'sensei',
      prompt: 'Run brief', createdBy: 'cli',
    } satisfies TriggerCreatedData)
    const state = triggerReducer(empty, e)
    expect(state.triggers.length).toBe(1)
    expect(state.triggers[0]!.id).toBe('morning')
    expect(state.triggers[0]!.status).toBe('active')
    expect(state.triggers[0]!.cron).toBe('0 8 * * 1-5')
    expect(state.triggers[0]!.createdAt).toBe(e.ts)
  })

  test('trigger-created with one-off at', () => {
    const e = makeEvent(1, 'trigger-created', TRIGGERS_STREAM, {
      id: 'reminder', at: '2026-04-07T10:00:00Z', agent: 'sensei',
      prompt: 'Check PR', createdBy: 'sensei',
    } satisfies TriggerCreatedData)
    const state = triggerReducer(empty, e)
    expect(state.triggers[0]!.at).toBe('2026-04-07T10:00:00Z')
    expect(state.triggers[0]!.cron).toBeUndefined()
  })

  test('trigger-updated updates fields', () => {
    const e1 = makeEvent(1, 'trigger-created', TRIGGERS_STREAM, {
      id: 'morning', cron: '0 8 * * 1-5', agent: 'sensei',
      prompt: 'Run brief', createdBy: 'cli',
    } satisfies TriggerCreatedData)
    const e2 = makeEvent(2, 'trigger-updated', TRIGGERS_STREAM, {
      id: 'morning', prompt: 'Run morning brief and post to Slack',
    } satisfies TriggerUpdatedData)
    const state = triggerReducer(triggerReducer(empty, e1), e2)
    expect(state.triggers[0]!.prompt).toBe('Run morning brief and post to Slack')
    expect(state.triggers[0]!.cron).toBe('0 8 * * 1-5') // unchanged
  })

  test('trigger-updated can disable', () => {
    const e1 = makeEvent(1, 'trigger-created', TRIGGERS_STREAM, {
      id: 'x', cron: '* * * * *', agent: 'a', prompt: 'p', createdBy: 'cli',
    } satisfies TriggerCreatedData)
    const e2 = makeEvent(2, 'trigger-updated', TRIGGERS_STREAM, {
      id: 'x', status: 'disabled',
    } satisfies TriggerUpdatedData)
    const state = triggerReducer(triggerReducer(empty, e1), e2)
    expect(state.triggers[0]!.status).toBe('disabled')
  })

  test('trigger-removed deletes trigger', () => {
    const e1 = makeEvent(1, 'trigger-created', TRIGGERS_STREAM, {
      id: 'x', cron: '* * * * *', agent: 'a', prompt: 'p', createdBy: 'cli',
    } satisfies TriggerCreatedData)
    const e2 = makeEvent(2, 'trigger-removed', TRIGGERS_STREAM, {
      id: 'x',
    } satisfies TriggerRemovedData)
    const state = triggerReducer(triggerReducer(empty, e1), e2)
    expect(state.triggers.length).toBe(0)
  })

  test('trigger-fired sets lastFiredAt on cron trigger, keeps active', () => {
    const e1 = makeEvent(1, 'trigger-created', TRIGGERS_STREAM, {
      id: 'morning', cron: '0 8 * * 1-5', agent: 'sensei',
      prompt: 'Run brief', createdBy: 'cli',
    } satisfies TriggerCreatedData)
    const e2 = makeEvent(2, 'trigger-fired', TRIGGERS_STREAM, {
      triggerId: 'morning', agent: 'sensei', prompt: 'Run brief',
    } satisfies TriggerFiredData)
    const state = triggerReducer(triggerReducer(empty, e1), e2)
    expect(state.triggers[0]!.lastFiredAt).toBe(e2.ts)
    expect(state.triggers[0]!.status).toBe('active')
  })

  test('trigger-fired sets status to fired on one-off trigger', () => {
    const e1 = makeEvent(1, 'trigger-created', TRIGGERS_STREAM, {
      id: 'reminder', at: '2026-04-07T10:00:00Z', agent: 'sensei',
      prompt: 'Check PR', createdBy: 'sensei',
    } satisfies TriggerCreatedData)
    const e2 = makeEvent(2, 'trigger-fired', TRIGGERS_STREAM, {
      triggerId: 'reminder', agent: 'sensei', prompt: 'Check PR',
    } satisfies TriggerFiredData)
    const state = triggerReducer(triggerReducer(empty, e1), e2)
    expect(state.triggers[0]!.status).toBe('fired')
    expect(state.triggers[0]!.lastFiredAt).toBe(e2.ts)
  })

  test('ignores unrelated events', () => {
    const e = makeEvent(1, 'reply', agentStream('scratch'), { text: 'hello' })
    const state = triggerReducer(empty, e)
    expect(state.triggers.length).toBe(0)
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
