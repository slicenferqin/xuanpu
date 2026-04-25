import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  feedTerminalInput,
  clearTerminalBuffer,
  __resetAllBuffersForTest,
  __TUNABLES_FOR_TEST
} from '../../../src/main/field/terminal-line-buffer'

beforeEach(() => {
  __resetAllBuffersForTest()
})

describe('terminal-line-buffer — Phase 21 M7', () => {
  it('returns no lines for chunks without \\r', () => {
    expect(feedTerminalInput('w-1', 'ls -la')).toEqual([])
  })

  it('emits a single line on \\r', () => {
    expect(feedTerminalInput('w-1', 'ls -la\r')).toEqual(['ls -la'])
  })

  it('handles multiple commands in one chunk', () => {
    expect(feedTerminalInput('w-1', 'ls\rpwd\r')).toEqual(['ls', 'pwd'])
  })

  it('accumulates across multiple chunks before \\r', () => {
    feedTerminalInput('w-1', 'pn')
    feedTerminalInput('w-1', 'pm ')
    expect(feedTerminalInput('w-1', 'test\r')).toEqual(['pnpm test'])
  })

  it('skips empty lines (\\r only)', () => {
    expect(feedTerminalInput('w-1', '\r')).toEqual([])
    expect(feedTerminalInput('w-1', '   \r')).toEqual([])
  })

  it('isolates buffers per worktree', () => {
    feedTerminalInput('w-1', 'foo')
    feedTerminalInput('w-2', 'bar')
    expect(feedTerminalInput('w-1', '\r')).toEqual(['foo'])
    expect(feedTerminalInput('w-2', '\r')).toEqual(['bar'])
  })

  it('clearTerminalBuffer resets state', () => {
    feedTerminalInput('w-1', 'incomplete')
    clearTerminalBuffer('w-1')
    expect(feedTerminalInput('w-1', 'fresh\r')).toEqual(['fresh'])
  })

  it('strips ESC + CSI sequences (e.g. arrow keys)', () => {
    // ESC [ A is up arrow; should not pollute the buffer
    expect(feedTerminalInput('w-1', 'ls\x1b[A\r')).toEqual(['ls'])
    // ESC [ 2 ; 5 H is a cursor positioning sequence
    expect(feedTerminalInput('w-1', 'ls\x1b[2;5H -la\r')).toEqual(['ls -la'])
  })

  it('strips OSC sequences (terminated by BEL)', () => {
    // OSC 0 ; title BEL
    expect(feedTerminalInput('w-1', 'echo hi\x1b]0;title\x07\r')).toEqual(['echo hi'])
  })

  it('strips OSC sequences (terminated by ESC \\)', () => {
    expect(feedTerminalInput('w-1', 'echo hi\x1b]0;title\x1b\\\r')).toEqual(['echo hi'])
  })

  it('drops control bytes below 0x20 (except \\t \\n \\r)', () => {
    // \x03 is Ctrl+C; should be filtered out
    expect(feedTerminalInput('w-1', 'ls\x03\r')).toEqual(['ls'])
  })

  it('preserves tab characters', () => {
    expect(feedTerminalInput('w-1', 'echo\thi\r')).toEqual(['echo\thi'])
  })

  it('drops DEL (0x7f, backspace) without trying to interpret it', () => {
    // We do NOT attempt to apply backspace semantics; we just don't include it.
    // Result is the raw character stream minus backspaces.
    expect(feedTerminalInput('w-1', 'lz\x7fs\r')).toEqual(['lzs'])
  })

  it('handles overflow: discards buffer until next \\r and notifies callback', () => {
    const cap = __TUNABLES_FOR_TEST.MAX_BUFFER_BYTES
    const onOverflow = vi.fn()
    feedTerminalInput('w-1', 'a'.repeat(cap + 10), onOverflow)
    expect(onOverflow).toHaveBeenCalledOnce()
    // After overflow, buffer is in "discard mode" until \r
    expect(feedTerminalInput('w-1', 'more', onOverflow)).toEqual([])
    expect(onOverflow).toHaveBeenCalledOnce() // still 1 — only fires once per overflow window
    // \r resets overflow state and yields nothing for the discarded line
    expect(feedTerminalInput('w-1', '\r')).toEqual([])
    // Next command works normally
    expect(feedTerminalInput('w-1', 'ls\r')).toEqual(['ls'])
  })
})
