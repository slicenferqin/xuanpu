import { describe, it, expect } from 'vitest'
import {
  isPlaceholderSessionTitle,
  extractTitleSourceText
} from '../../src/main/services/opencode-session-title'

describe('isPlaceholderSessionTitle', () => {
  it('treats null/undefined/empty as placeholder', () => {
    expect(isPlaceholderSessionTitle(null)).toBe(true)
    expect(isPlaceholderSessionTitle(undefined)).toBe(true)
    expect(isPlaceholderSessionTitle('')).toBe(true)
    expect(isPlaceholderSessionTitle('   ')).toBe(true)
  })

  it('matches Hive default "Session N"', () => {
    expect(isPlaceholderSessionTitle('Session 1')).toBe(true)
    expect(isPlaceholderSessionTitle('Session 42')).toBe(true)
    expect(isPlaceholderSessionTitle('session 7')).toBe(true) // case-insensitive
  })

  it('matches OpenCode "New Session YYYY-MM-DD..." default', () => {
    expect(isPlaceholderSessionTitle('New Session 2026-04-29T11:00:00.000Z')).toBe(true)
    expect(isPlaceholderSessionTitle('new session 2025-12-01T00:00:00Z')).toBe(true)
    expect(isPlaceholderSessionTitle('New Session-2026-04-29')).toBe(true)
  })

  it('does NOT match meaningful titles', () => {
    expect(isPlaceholderSessionTitle('Debugging production 500 errors')).toBe(false)
    expect(isPlaceholderSessionTitle('Refactoring user service')).toBe(false)
    expect(isPlaceholderSessionTitle('Session about debugging')).toBe(false) // not "Session N"
    expect(isPlaceholderSessionTitle('My Session')).toBe(false)
  })
})

describe('extractTitleSourceText', () => {
  it('returns the trimmed string when given a string', () => {
    expect(extractTitleSourceText('  hello world  ')).toBe('hello world')
  })

  it('joins text parts with spaces and skips file parts', () => {
    expect(
      extractTitleSourceText([
        { type: 'text', text: 'first' },
        { type: 'file', mime: 'image/png', url: 'data:...' },
        { type: 'text', text: 'second' }
      ])
    ).toBe('first second')
  })

  it('returns empty string when only files are passed', () => {
    expect(
      extractTitleSourceText([
        { type: 'file', mime: 'image/png', url: 'a' },
        { type: 'file', mime: 'image/png', url: 'b' }
      ])
    ).toBe('')
  })

  it('handles empty arrays and empty strings', () => {
    expect(extractTitleSourceText('')).toBe('')
    expect(extractTitleSourceText([])).toBe('')
  })

  it('preserves single text content', () => {
    expect(
      extractTitleSourceText([{ type: 'text', text: 'Add dark mode toggle' }])
    ).toBe('Add dark mode toggle')
  })
})
