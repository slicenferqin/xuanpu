import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AgentTimeline } from '../../src/renderer/src/components/session-hq/AgentTimeline'
import type { TimelineMessage } from '../../src/shared/lib/timeline-types'

vi.mock('../../src/renderer/src/components/session-hq/cards', () => ({
  BashCard: ({ toolUse }: { toolUse: { name: string; input?: Record<string, unknown> } }) => (
    <div data-testid="bash-card">
      {toolUse.name}:{String(toolUse.input?.command ?? '')}
    </div>
  ),
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
  GoalStatusCard: ({
    goal,
    onDismiss
  }: {
    goal: {
      objective: string
      successCriteria?: string
      tokensUsed?: number
      tokenBudget?: number | null
    }
    onDismiss?: () => void
  }) => (
    <div data-testid="goal-status-card">
      {goal.objective}
      {goal.successCriteria}
      {goal.tokensUsed === 1200 && goal.tokenBudget === 50000 ? '1.2K / 50K tokens' : null}
      {onDismiss ? (
        <button type="button" data-testid="goal-status-dismiss" onClick={onDismiss}>
          dismiss
        </button>
      ) : null}
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

    const connector = container.querySelector(
      '.absolute.left-\\[15px\\].top-0.bottom-0.w-\\[2px\\].bg-border'
    )
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
          successCriteria: 'Focused tests pass',
          status: 'active',
          tokenBudget: 50000,
          tokensUsed: 1200,
          timeUsedSeconds: 90,
          createdAt: 10,
          updatedAt: 20
        }}
      />
    )

    expect(screen.getByTestId('goal-status-sticky')).toContainElement(
      screen.getByTestId('goal-status-card')
    )
    expect(screen.getByTestId('goal-status-card')).toHaveTextContent('Build the goal foundation')
    expect(screen.getByTestId('goal-status-card')).toHaveTextContent('Focused tests pass')
    expect(screen.getByTestId('goal-status-card')).toHaveTextContent('1.2K / 50K tokens')
  })

  it('passes the goal dismiss callback through to the sticky goal card', async () => {
    const user = userEvent.setup()
    const onDismissSessionGoal = vi.fn()

    render(
      <AgentTimeline
        timelineMessages={[makeAssistantTextMessage('a-3b', 'final assistant reply')]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
        sessionGoal={{
          threadId: 'thread-1',
          objective: 'Build the goal foundation',
          successCriteria: 'Focused tests pass',
          status: 'completed'
        }}
        onDismissSessionGoal={onDismissSessionGoal}
      />
    )

    await user.click(screen.getByTestId('goal-status-dismiss'))
    expect(onDismissSessionGoal).toHaveBeenCalledTimes(1)
  })

  it('routes token-saver MCP bash tools to the Bash card in committed messages', () => {
    render(
      <AgentTimeline
        timelineMessages={[
          {
            id: 'a-4',
            role: 'assistant',
            content: '',
            timestamp: '2026-04-17T14:34:59.000Z',
            parts: [
              {
                type: 'tool_use',
                toolUse: {
                  id: 'tool-1',
                  name: 'mcp__xuanpu__bash',
                  input: { command: 'pnpm test' },
                  status: 'success',
                  startTime: 1,
                  output: 'ok'
                }
              }
            ]
          }
        ]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
      />
    )

    expect(screen.getByTestId('bash-card')).toHaveTextContent('mcp__xuanpu__bash:pnpm test')
  })

  it('routes token-saver MCP bash tools to the Bash card while streaming', () => {
    render(
      <AgentTimeline
        timelineMessages={[]}
        streamingContent=""
        streamingParts={[
          {
            type: 'tool_use',
            toolUse: {
              id: 'tool-stream-1',
              name: 'mcp__xuanpu__bash',
              input: { command: 'git status --short' },
              status: 'running',
              startTime: 1
            }
          }
        ]}
        isStreaming
        lifecycle="busy"
      />
    )

    expect(screen.getByTestId('bash-card')).toHaveTextContent(
      'mcp__xuanpu__bash:git status --short'
    )
  })
})
