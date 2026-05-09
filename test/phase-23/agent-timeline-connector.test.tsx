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
  TodoCard: () => <div>TodoCard</div>,
  GoalStatusCard: ({ goal }: { goal: { objective: string; tokensUsed?: number; tokenBudget?: number | null } }) => (
    <div data-testid="goal-status-card">
      {goal.objective}
      {goal.tokensUsed === 1200 && goal.tokenBudget === 50000 ? '1.2K / 50K tokens' : null}
    </div>
  )
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

  it('does not render the goal card when no goal is present', () => {
    render(
      <AgentTimeline
        timelineMessages={[makeAssistantTextMessage('a-2', 'final assistant reply')]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
      />
    )

    expect(screen.queryByTestId('goal-status-card')).not.toBeInTheDocument()
  })

  it('renders a goal card above the timeline when a goal is present', () => {
    render(
      <AgentTimeline
        timelineMessages={[makeAssistantTextMessage('a-3', 'final assistant reply')]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
        sessionGoal={{
          threadId: 'thread-1',
          objective: 'Build the goal foundation',
          status: 'active',
          tokenBudget: 50000,
          tokensUsed: 1200,
          timeUsedSeconds: 90,
          createdAt: 10,
          updatedAt: 20
        }}
      />
    )

    expect(screen.getByTestId('goal-status-card')).toHaveTextContent('Build the goal foundation')
    expect(screen.getByTestId('goal-status-card')).toHaveTextContent('1.2K / 50K tokens')
  })
})
