import { render, screen } from '@testing-library/react'
import { AgentTimeline } from '../../src/renderer/src/components/session-hq/AgentTimeline'
import type { TimelineMessage } from '../../src/shared/lib/timeline-types'

vi.mock('../../src/renderer/src/components/session-hq/cards', () => ({
  BashCard: () => <div>BashCard</div>,
  FileReadCard: () => <div>FileReadCard</div>,
  FileWriteCard: () => <div>FileWriteCard</div>,
  SearchCard: () => <div>SearchCard</div>,
  ThinkingCard: ({ content }: { content: string }) => <div>{content}</div>,
  PlanCard: ({ content }: { content: string }) => <div>{content}</div>,
  AskUserCard: ({ question }: { question: string }) => <div>{question}</div>,
  SubAgentCard: () => <div>SubAgentCard</div>,
  TextCard: ({ content, isStreaming = false }: { content: string; isStreaming?: boolean }) => (
    <div data-testid={isStreaming ? 'streaming-text-card' : 'text-card'}>{content}</div>
  ),
  TodoCard: () => <div>TodoCard</div>
}))

function makeAssistantTextMessage(id: string, content: string): TimelineMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp: '2026-04-17T14:34:59.000Z'
  }
}

describe('AgentTimeline connector rendering', () => {
  it('keeps the connector for the last committed assistant text node after streaming ends', () => {
    const { container } = render(
      <AgentTimeline
        timelineMessages={[makeAssistantTextMessage('a-1', 'final assistant reply')]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
      />
    )

    expect(screen.getByTestId('text-card')).toBeInTheDocument()

    const connector = container.querySelector('.absolute.left-\\[15px\\].top-0.bottom-0.w-\\[2px\\].bg-border')
    expect(connector).not.toBeNull()
  })
})
