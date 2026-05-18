import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { PrCommentGutter } from '@/components/diff/PrCommentGutter'
import { clampMonacoLineNumber } from '@/lib/diff-utils'
import type { PRReviewComment } from '@shared/types/git'
import type { editor } from 'monaco-editor'

const originalResizeObserver = globalThis.ResizeObserver

class MockResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}

function makeReviewComment(overrides: Partial<PRReviewComment> = {}): PRReviewComment {
  return {
    id: 1,
    body: 'This comment is anchored to an old line.',
    bodyHTML: '',
    path: 'src/App.tsx',
    line: 999,
    originalLine: 999,
    side: 'RIGHT',
    diffHunk: '',
    user: { login: 'reviewer', avatarUrl: '' },
    createdAt: '2026-05-18T00:00:00.000Z',
    updatedAt: '2026-05-18T00:00:00.000Z',
    inReplyToId: null,
    pullRequestReviewId: null,
    subjectType: 'line',
    ...overrides
  }
}

function makeEditor(lineCount: number): {
  editor: editor.IStandaloneCodeEditor
  zones: Array<{ afterLineNumber: number }>
} {
  const zones: Array<{ afterLineNumber: number }> = []
  const addZone = vi.fn((zone: { afterLineNumber: number }) => {
    if (zone.afterLineNumber < 1 || zone.afterLineNumber > lineCount) {
      throw new Error(`line ${zone.afterLineNumber} is out of range`)
    }
    zones.push(zone)
    return `zone-${zones.length}`
  })

  const editorMock = {
    getModel: vi.fn(() => ({ getLineCount: () => lineCount })),
    getScrollTop: vi.fn(() => 0),
    setScrollTop: vi.fn(),
    changeViewZones: vi.fn(
      (
        callback: (accessor: {
          addZone: typeof addZone
          removeZone: ReturnType<typeof vi.fn>
          layoutZone: ReturnType<typeof vi.fn>
        }) => void
      ) => {
        callback({
          addZone,
          removeZone: vi.fn(),
          layoutZone: vi.fn()
        })
      }
    )
  } as unknown as editor.IStandaloneCodeEditor

  return { editor: editorMock, zones }
}

describe('PR comment gutter line anchors', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: MockResizeObserver
    })
  })

  afterEach(() => {
    if (originalResizeObserver) {
      Object.defineProperty(globalThis, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: originalResizeObserver
      })
    } else {
      delete (globalThis as Partial<typeof globalThis>).ResizeObserver
    }
  })

  test('clamps stale PR review lines to the current Monaco model', async () => {
    const { editor, zones } = makeEditor(12)

    expect(clampMonacoLineNumber(999, editor)).toBe(12)
    expect(clampMonacoLineNumber(0, editor)).toBe(1)

    render(
      <PrCommentGutter
        comments={[makeReviewComment()]}
        modifiedEditor={editor}
        highlightLine={999}
      />
    )

    await waitFor(() => expect(zones).toHaveLength(1))
    expect(zones[0].afterLineNumber).toBe(12)
  })
})
