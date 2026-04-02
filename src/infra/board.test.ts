import { describe, test, expect } from 'bun:test'
import { canTransition } from './board.ts'

describe('canTransition', () => {
  test('inbox → active', () => {
    expect(canTransition('inbox', 'active')).toBe(true)
  })

  test('inbox → cancelled', () => {
    expect(canTransition('inbox', 'cancelled')).toBe(true)
  })

  test('inbox → done is invalid', () => {
    expect(canTransition('inbox', 'done')).toBe(false)
  })

  test('active → blocked', () => {
    expect(canTransition('active', 'blocked')).toBe(true)
  })

  test('active → review', () => {
    expect(canTransition('active', 'review')).toBe(true)
  })

  test('active → done', () => {
    expect(canTransition('active', 'done')).toBe(true)
  })

  test('done is terminal', () => {
    expect(canTransition('done', 'active')).toBe(false)
    expect(canTransition('done', 'inbox')).toBe(false)
  })

  test('cancelled is terminal', () => {
    expect(canTransition('cancelled', 'active')).toBe(false)
  })

  test('review → done', () => {
    expect(canTransition('review', 'done')).toBe(true)
  })

  test('review → active (send back)', () => {
    expect(canTransition('review', 'active')).toBe(true)
  })

  test('blocked → active', () => {
    expect(canTransition('blocked', 'active')).toBe(true)
  })
})
