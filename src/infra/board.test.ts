import { describe, test, expect } from 'bun:test'
import { canTransition, migrateStatus } from './board.ts'

describe('canTransition', () => {
  test('todo → assigned', () => {
    expect(canTransition('todo', 'assigned')).toBe(true)
  })

  test('todo → cancelled', () => {
    expect(canTransition('todo', 'cancelled')).toBe(true)
  })

  test('todo → in-progress (shortcut, skip assigned)', () => {
    expect(canTransition('todo', 'in-progress')).toBe(true)
  })

  test('todo → done is invalid', () => {
    expect(canTransition('todo', 'done')).toBe(false)
  })

  test('assigned → in-progress', () => {
    expect(canTransition('assigned', 'in-progress')).toBe(true)
  })

  test('assigned → cancelled', () => {
    expect(canTransition('assigned', 'cancelled')).toBe(true)
  })

  test('assigned → done is invalid', () => {
    expect(canTransition('assigned', 'done')).toBe(false)
  })

  test('in-progress → waiting', () => {
    expect(canTransition('in-progress', 'waiting')).toBe(true)
  })

  test('in-progress → done', () => {
    expect(canTransition('in-progress', 'done')).toBe(true)
  })

  test('in-progress → cancelled', () => {
    expect(canTransition('in-progress', 'cancelled')).toBe(true)
  })

  test('waiting → in-progress', () => {
    expect(canTransition('waiting', 'in-progress')).toBe(true)
  })

  test('waiting → done', () => {
    expect(canTransition('waiting', 'done')).toBe(true)
  })

  test('waiting → cancelled', () => {
    expect(canTransition('waiting', 'cancelled')).toBe(true)
  })

  test('done is terminal', () => {
    expect(canTransition('done', 'in-progress')).toBe(false)
    expect(canTransition('done', 'todo')).toBe(false)
  })

  test('cancelled is terminal', () => {
    expect(canTransition('cancelled', 'in-progress')).toBe(false)
  })
})

describe('migrateStatus', () => {
  test('maps inbox → todo', () => {
    expect(migrateStatus('inbox')).toBe('todo')
  })

  test('maps active → in-progress', () => {
    expect(migrateStatus('active')).toBe('in-progress')
  })

  test('maps blocked → waiting', () => {
    expect(migrateStatus('blocked')).toBe('waiting')
  })

  test('maps review → waiting', () => {
    expect(migrateStatus('review')).toBe('waiting')
  })

  test('passes through current states', () => {
    expect(migrateStatus('todo')).toBe('todo')
    expect(migrateStatus('in-progress')).toBe('in-progress')
    expect(migrateStatus('waiting')).toBe('waiting')
    expect(migrateStatus('done')).toBe('done')
  })
})
