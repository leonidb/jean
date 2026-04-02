import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { unlinkSync } from 'fs'
import {
  readBoard,
  writeBoard,
  createTask,
  findTask,
  upsertTask,
  updateTaskStatus,
  canTransition,
  type Board,
  type TaskStatus,
} from './board.ts'

// ── canTransition ──────────────────────────────────────────────────

describe('canTransition', () => {
  test('allows valid transitions from inbox', () => {
    expect(canTransition('inbox', 'active')).toBe(true)
    expect(canTransition('inbox', 'cancelled')).toBe(true)
  })

  test('rejects invalid transitions from inbox', () => {
    expect(canTransition('inbox', 'done')).toBe(false)
    expect(canTransition('inbox', 'review')).toBe(false)
    expect(canTransition('inbox', 'blocked')).toBe(false)
  })

  test('allows valid transitions from active', () => {
    expect(canTransition('active', 'blocked')).toBe(true)
    expect(canTransition('active', 'review')).toBe(true)
    expect(canTransition('active', 'done')).toBe(true)
    expect(canTransition('active', 'cancelled')).toBe(true)
  })

  test('terminal states have no transitions', () => {
    expect(canTransition('done', 'active')).toBe(false)
    expect(canTransition('cancelled', 'inbox')).toBe(false)
  })

  test('blocked can return to active', () => {
    expect(canTransition('blocked', 'active')).toBe(true)
  })

  test('review can go back to active or forward to done', () => {
    expect(canTransition('review', 'active')).toBe(true)
    expect(canTransition('review', 'done')).toBe(true)
  })
})

// ── createTask ─────────────────────────────────────────────────────

describe('createTask', () => {
  test('creates a task with inbox status', () => {
    const task = createTask({
      title: 'Repro Validator crash',
      description: 'Reproduce the crash with None in categories',
      queue: 'scratch',
    })

    expect(task.title).toBe('Repro Validator crash')
    expect(task.status).toBe('inbox')
    expect(task.queue).toBe('scratch')
    expect(task.id).toMatch(/^\d{3}$/)
    expect(task.createdAt).toBeTruthy()
    expect(task.updatedAt).toBe(task.createdAt)
  })

  test('accepts optional playbook and agent', () => {
    const task = createTask({
      title: 'Test',
      description: 'Desc',
      queue: 'review',
      playbook: 'code-review',
      agent: 'review-agent',
    })
    expect(task.playbook).toBe('code-review')
    expect(task.agent).toBe('review-agent')
  })
})

// ── updateTaskStatus ───────────────────────────────────────────────

describe('updateTaskStatus', () => {
  test('transitions inbox → active', async () => {
    const task = createTask({ title: 'T', description: 'D', queue: 'q' })
    await Bun.sleep(1) // ensure updatedAt differs
    const updated = updateTaskStatus(task, 'active')
    expect(updated.status).toBe('active')
    expect(updated.updatedAt).not.toBe(task.updatedAt)
  })

  test('throws on invalid transition', () => {
    const task = createTask({ title: 'T', description: 'D', queue: 'q' })
    expect(() => updateTaskStatus(task, 'done')).toThrow('Invalid transition')
  })
})

// ── Board persistence ──────────────────────────────────────────────

describe('board persistence', () => {
  let boardPath: string

  beforeEach(() => {
    boardPath = join(tmpdir(), `jean-test-${Date.now()}.json`)
  })

  afterEach(() => {
    try { unlinkSync(boardPath) } catch {}
  })

  test('readBoard returns empty board for missing file', async () => {
    const board = await readBoard(boardPath)
    expect(board.tasks).toEqual([])
  })

  test('writeBoard + readBoard round-trips', async () => {
    const task = createTask({ title: 'Test task', description: 'Desc', queue: 'scratch' })
    const board: Board = { tasks: [task] }

    await writeBoard(boardPath, board)
    const loaded = await readBoard(boardPath)

    expect(loaded.tasks).toHaveLength(1)
    expect(loaded.tasks[0]!.title).toBe('Test task')
    expect(loaded.tasks[0]!.status).toBe('inbox')
  })
})

// ── findTask / upsertTask ──────────────────────────────────────────

describe('findTask', () => {
  test('finds a task by id', () => {
    const task = createTask({ title: 'T', description: 'D', queue: 'q' })
    const board: Board = { tasks: [task] }
    expect(findTask(board, task.id)).toBe(task)
  })

  test('returns undefined for missing id', () => {
    const board: Board = { tasks: [] }
    expect(findTask(board, '999')).toBeUndefined()
  })
})

describe('upsertTask', () => {
  test('inserts new task', () => {
    const board: Board = { tasks: [] }
    const task = createTask({ title: 'T', description: 'D', queue: 'q' })
    const updated = upsertTask(board, task)
    expect(updated.tasks).toHaveLength(1)
  })

  test('updates existing task', () => {
    const task = createTask({ title: 'T', description: 'D', queue: 'q' })
    const board: Board = { tasks: [task] }
    const modified = { ...task, title: 'Updated' }
    const updated = upsertTask(board, modified)
    expect(updated.tasks).toHaveLength(1)
    expect(updated.tasks[0]!.title).toBe('Updated')
  })
})
