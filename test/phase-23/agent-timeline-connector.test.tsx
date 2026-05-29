import { render, screen } from '@testing-library/react'
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
  it('uses the real timeline scroller for containment and short-content alignment', () => {
    render(
      <AgentTimeline
        timelineMessages={[makeAssistantTextMessage('a-scroll', 'final assistant reply')]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
      />
    )

    expect(screen.getByTestId('hq-agent-timeline-scroll')).toHaveClass('overscroll-contain')
  })

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

  it('renders queued optimistic user messages with their attachments', () => {
    render(
      <AgentTimeline
        timelineMessages={[
          {
            id: 'queued-1',
            role: 'user',
            content: 'Review this screenshot next',
            timestamp: '2026-04-17T14:34:59.000Z',
            deliveryStatus: 'queued',
            attachments: [
              {
                type: 'file',
                mime: 'image/png',
                url: 'data:image/png;base64,queued-image',
                filename: 'queued.png'
              }
            ]
          }
        ]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="busy"
      />
    )

    expect(screen.getByText('QUEUED')).toBeInTheDocument()
    expect(screen.getByText('Review this screenshot next')).toBeInTheDocument()
    expect(screen.getByAltText('queued.png')).toHaveAttribute(
      'src',
      'data:image/png;base64,queued-image'
    )
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

  it('uses the agent running row instead of the empty thinking pulse', () => {
    render(
      <AgentTimeline
        timelineMessages={[]}
        streamingContent=""
        streamingParts={[]}
        isStreaming
        lifecycle="busy"
        ephemeralStatusRows={[
          {
            id: 'running-session',
            kind: 'running',
            timestamp: Date.now(),
            startedAt: Date.now(),
            ephemeral: true
          }
        ]}
      />
    )

    expect(screen.getByTestId('thread-status-running')).toBeInTheDocument()
    expect(screen.queryByText(/Thinking|思考中/)).not.toBeInTheDocument()
  })
})
