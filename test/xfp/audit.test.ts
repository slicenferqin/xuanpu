import { describe, expect, it, beforeEach } from 'vitest'
import {
  __resetXfpAuditForTest,
  clearXfpAuditEvents,
  hasXfpTruncatedOutput,
  inferXfpAuditPrivacy,
  listXfpAuditEvents,
  recordXfpAuditEvent,
  recordXfpPromptObservation,
  summarizeXfpAuditOutput
} from '../../src/main/xfp/audit'

describe('XFP audit store', () => {
  beforeEach(() => {
    __resetXfpAuditForTest()
  })

  it('records recent XFP audit events newest first and filters by worktree/session', () => {
    const first = recordXfpAuditEvent({
      worktreeId: 'w-1',
      sessionId: 's-1',
      runtimeId: 'claude-code',
      kind: 'tool',
      toolName: 'xfp_get_current_focus',
      input: {},
      outputSummary: 'focus',
      outputChars: 5
    })
    const second = recordXfpAuditEvent({
      worktreeId: 'w-2',
      sessionId: 's-2',
      runtimeId: 'codex',
      kind: 'fallback',
      toolName: 'xfp_triggered_fallback',
      input: { reason: 'resume' },
      outputSummary: 'fallback',
      outputChars: 8
    })

    expect(listXfpAuditEvents().map((event) => event.id)).toEqual([second.id, first.id])
    expect(listXfpAuditEvents({ worktreeId: 'w-1' })).toEqual([first])
    expect(listXfpAuditEvents({ sessionId: 's-2' })).toEqual([second])
    expect(listXfpAuditEvents({ limit: 1 })).toEqual([second])
  })

  it('clears all or scoped audit events', () => {
    recordXfpAuditEvent({
      worktreeId: 'w-1',
      sessionId: 's-1',
      runtimeId: 'claude-code',
      kind: 'tool',
      toolName: 'xfp_get_current_focus',
      outputSummary: 'focus',
      outputChars: 5
    })
    recordXfpAuditEvent({
      worktreeId: 'w-2',
      sessionId: 's-2',
      runtimeId: 'codex',
      kind: 'fallback',
      toolName: 'xfp_triggered_fallback',
      outputSummary: 'fallback',
      outputChars: 8
    })

    expect(clearXfpAuditEvents({ worktreeId: 'w-1' })).toEqual({ deleted: 1 })
    expect(listXfpAuditEvents()).toHaveLength(1)
    expect(clearXfpAuditEvents()).toEqual({ deleted: 1 })
    expect(listXfpAuditEvents()).toEqual([])
  })

  it('summarizes output without keeping full large payloads', () => {
    const summary = summarizeXfpAuditOutput({ text: 'abcdef' }, 12)

    expect(summary.outputChars).toBeGreaterThan(12)
    expect(summary.truncated).toBe(true)
    expect(summary.outputSummary.endsWith('…')).toBe(true)
  })

  it('records prompt field-delivery observations without storing prompt content', () => {
    const event = recordXfpPromptObservation({
      worktreeId: 'w-1',
      sessionId: 's-1',
      runtimeId: 'codex',
      fieldDeliveryMode: 'xfp-fallback',
      promptChars: 1800,
      displayChars: 12,
      fallbackChars: 400,
      hasFieldContextEnvelope: false,
      hasXfpFallbackPrefix: true,
      hasFileAttachments: true,
      attachmentCount: 1,
      mcpAttached: false
    })

    expect(event).toMatchObject({
      runtimeId: 'codex',
      kind: 'prompt',
      toolName: 'field_delivery',
      input: {
        mode: 'xfp-fallback',
        promptChars: 1800,
        displayChars: 12,
        fallbackChars: 400,
        hasXfpFallbackPrefix: true,
        attachmentCount: 1
      }
    })
    expect(event.outputSummary).toContain('field delivery: xfp-fallback')
    expect(event.outputSummary).not.toContain('[Xuanpu Field Fallback]')
  })

  it('infers privacy and nested truncation from provider output', () => {
    expect(inferXfpAuditPrivacy({ disabled: true })).toBe('disabled')
    expect(inferXfpAuditPrivacy({ disabled: false })).toBe('allowed')
    expect(hasXfpTruncatedOutput({ output: { tail: '...', truncated: true } })).toBe(true)
  })
})
