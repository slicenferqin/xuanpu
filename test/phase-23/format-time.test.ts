import { describe, expect, it } from 'vitest'
import { formatMessageTime } from '../../src/renderer/src/lib/format-time'

describe('formatMessageTime', () => {
  const now = new Date(2026, 4, 25, 11, 54)

  it('uses 24-hour time for messages from today', () => {
    expect(formatMessageTime(new Date(2026, 4, 25, 9, 5).toISOString(), now)).toBe('09:05')
    expect(formatMessageTime(new Date(2026, 4, 25, 23, 54).toISOString(), now)).toBe('23:54')
  })

  it('adds day, month-day, or year-month-day for older messages', () => {
    expect(formatMessageTime(new Date(2026, 4, 24, 11, 54).toISOString(), now)).toBe('24 11:54')
    expect(formatMessageTime(new Date(2026, 3, 24, 11, 54).toISOString(), now)).toBe(
      '04-24 11:54'
    )
    expect(formatMessageTime(new Date(2025, 3, 24, 11, 54).toISOString(), now)).toBe(
      '2025-04-24 11:54'
    )
  })

  it('returns an empty label for invalid timestamps', () => {
    expect(formatMessageTime('not-a-date', now)).toBe('')
  })
})
