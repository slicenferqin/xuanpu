import { describe, expect, it } from 'vitest'
import {
  stripFieldContextEnvelope,
  stripFieldContextEnvelopeFromMessage
} from '../../src/shared/lib/field-context-envelope'

describe('stripFieldContextEnvelope', () => {
  it('extracts the real user message from a Field Context envelope', () => {
    const input = `[Field Context - as of 10:41:56]
## Worktree
xuanpu--akita

[User Message]
实现 XFP helper`

    expect(stripFieldContextEnvelope(input)).toBe('实现 XFP helper')
  })

  it('supports the existing unicode dash Field Context header format', () => {
    const input = `[Field Context — as of 10:41:56]
Observed context

[User Message]
继续`

    expect(stripFieldContextEnvelope(input)).toBe('继续')
  })

  it('extracts the real user message from an XFP fallback envelope', () => {
    const input = `[Xuanpu Field Fallback]
## Current Focus
- File: src/main.ts

[User Message]
这里为什么挂？`

    expect(stripFieldContextEnvelope(input)).toBe('这里为什么挂？')
  })

  it('extracts the real user message from a Xuanpu plan mode envelope', () => {
    const input = `[Xuanpu Plan Mode]
For this turn, work in planning mode.

[User Message]
Plan the migration`

    expect(stripFieldContextEnvelope(input)).toBe('Plan the migration')
  })

  it('returns non-envelope input unchanged', () => {
    const input = '普通消息\n[User Message]\n也只是用户自己输入的文本'

    expect(stripFieldContextEnvelope(input)).toBe(input)
  })

  it('tolerates leading wrapper whitespace and preserves user message whitespace', () => {
    const input = '  \n\t[Field Context]\ncontext\n\n  [User Message]  \n  hello  \n'

    expect(stripFieldContextEnvelope(input)).toBe('  hello  \n')
  })

  it('supports CRLF envelopes', () => {
    const input = '[Field Context - as of 10:41:56]\r\ncontext\r\n\r\n[User Message]\r\n真实消息'

    expect(stripFieldContextEnvelope(input)).toBe('真实消息')
  })

  it('safely returns the original envelope when the User Message marker is missing', () => {
    const input = `[Field Context - as of 10:41:56]
context only`

    expect(stripFieldContextEnvelope(input)).toBe(input)
  })

  it('strips only text parts in structured messages and keeps attachments', () => {
    const input = [
      {
        type: 'file',
        mime: 'image/png',
        url: 'file:///tmp/screenshot.png',
        filename: 'screenshot.png'
      },
      {
        type: 'text',
        text: `[Field Context - as of 10:41:56]
context

[User Message]
看下这张图`
      }
    ]

    expect(stripFieldContextEnvelopeFromMessage(input)).toEqual([
      {
        type: 'file',
        mime: 'image/png',
        url: 'file:///tmp/screenshot.png',
        filename: 'screenshot.png'
      },
      { type: 'text', text: '看下这张图' }
    ])
  })
})
