/**
 * Board — task state persistence.
 *
 * The board is a JSON file. The orchestrator is the single writer;
 * `jean board` and infrastructure read it.
 */

// ── Types ──────────────────────────────────────────────────────────

export type TaskStatus =
  | 'inbox'
  | 'active'
  | 'blocked'
  | 'review'
  | 'done'
  | 'cancelled'

export type Task = {
  id: string
  title: string
  description: string
  status: TaskStatus
  queue: string
  playbook?: string
  agent?: string
  createdAt: string  // ISO 8601
  updatedAt: string
}

export type Board = {
  tasks: Task[]
}

// ── Valid transitions ──────────────────────────────────────────────

const transitions: Record<TaskStatus, TaskStatus[]> = {
  inbox:     ['active', 'cancelled'],
  active:    ['blocked', 'review', 'done', 'cancelled'],
  blocked:   ['active', 'cancelled'],
  review:    ['done', 'active', 'cancelled'],
  done:      [],
  cancelled: [],
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to)
}

// ── Persistence ────────────────────────────────────────────────────

const EMPTY_BOARD: Board = { tasks: [] }

export async function readBoard(path: string): Promise<Board> {
  const file = Bun.file(path)
  if (!(await file.exists())) return { ...EMPTY_BOARD, tasks: [] }
  return file.json() as Promise<Board>
}

export async function writeBoard(path: string, board: Board): Promise<void> {
  await Bun.write(path, JSON.stringify(board, null, 2) + '\n')
}

// ── Helpers ────────────────────────────────────────────────────────

let counter = 0

export function nextTaskId(): string {
  return String(++counter).padStart(3, '0')
}

export function createTask(
  fields: Pick<Task, 'title' | 'description' | 'queue'> &
    Partial<Pick<Task, 'playbook' | 'agent'>>,
): Task {
  const now = new Date().toISOString()
  return {
    id: nextTaskId(),
    status: 'inbox',
    createdAt: now,
    updatedAt: now,
    ...fields,
  }
}

export function updateTaskStatus(task: Task, status: TaskStatus): Task {
  if (!canTransition(task.status, status)) {
    throw new Error(`Invalid transition: ${task.status} → ${status}`)
  }
  return { ...task, status, updatedAt: new Date().toISOString() }
}

export function findTask(board: Board, id: string): Task | undefined {
  return board.tasks.find(t => t.id === id)
}

export function upsertTask(board: Board, task: Task): Board {
  const idx = board.tasks.findIndex(t => t.id === task.id)
  const tasks = [...board.tasks]
  if (idx >= 0) {
    tasks[idx] = task
  } else {
    tasks.push(task)
  }
  return { tasks }
}
