import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TimelineNodeRenderer } from '../../src/renderer/src/components/session-hq/timeline/TimelineNodeRenderer'
import { useQuestionStore } from '../../src/renderer/src/stores/useQuestionStore'
import type { TimelineNode } from '../../src/renderer/src/lib/session-timeline/view-model'

vi.mock('@/components/session-hq/cards', () => ({
  BashCard: () => <div>BashCard</div>,
  FileReadCard: () => <div>FileReadCard</div>,
  FileWriteCard: () => <div>FileWriteCard</div>,
  SearchCard: () => <div>SearchCard</div>,
  ThinkingCard: ({ content }: { content: string }) => <div>{content}</div>,
  PlanCard: ({ content }: { content: string }) => <div>{content}</div>,
  AskUserCard: ({ question, isPending }: { question: string; isPending: boolean }) => (
    <div data-testid="ask-user-card">
      {question}:{isPending ? 'pending' : 'done'}
    </div>
  ),
  SubAgentCard: () => <div>SubAgentCard</div>,
  TextCard: ({ content }: { content: string }) => <div>{content}</div>,
  TodoCard: () => <div>TodoCard</div>
}))

function makeNode(overrides: Partial<TimelineNode>): TimelineNode {
  return {
    key: 'node-1',
    cardType: 'text',
    message: {
      id: 'message-1',
      role: 'assistant',
      content: '',
      timestamp: '2026-05-26T00:00:00.000Z'
    },
    ...overrides
  }
}

describe('TimelineNodeRenderer', () => {
  beforeEach(() => {
    useQuestionStore.setState({ pendingBySession: new Map() })
  })

  it('keeps ask-user cards pending when the runtime question store still has the tool call', () => {
    useQuestionStore.getState().addQuestion('session-1', {
      id: 'question-1',
      sessionID: 'session-1',
      questions: [],
      tool: { messageID: 'message-1', callID: 'ask-1' }
    })

    render(
      <TimelineNodeRenderer
        sessionId="session-1"
        node={makeNode({
          cardType: 'ask-user',
          toolUse: {
            id: 'ask-1',
            name: 'ask_user',
            input: { question: 'Pick a target' },
            status: 'success',
            startTime: 1
          }
        })}
      />
    )

    expect(screen.getByTestId('ask-user-card')).toHaveTextContent('Pick a target:pending')
  })

  it('keeps the generic XFP tool fallback label after renderer extraction', () => {
    render(
      <TimelineNodeRenderer
        node={makeNode({
          cardType: 'tool-call',
          toolUse: {
            id: 'xfp-1',
            name: 'mcp__xuanpu-field__get_context',
            input: {},
            status: 'running',
            startTime: 1
          }
        })}
      />
    )

    expect(screen.getByText('XFP · get context')).toBeInTheDocument()
  })
})
