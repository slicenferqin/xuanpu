import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

const writeTextMock = vi.fn().mockResolvedValue(undefined)
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: writeTextMock },
  writable: true
})

function makeUserMessage(id: string, content: string): TimelineMessage {
  return {
    id,
    role: 'user',
    content,
    timestamp: '2026-04-18T11:06:43.000Z'
  }
}

describe('AgentTimeline user message actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders timestamp and hover action row for user messages', () => {
    render(
      <AgentTimeline
        timelineMessages={[makeUserMessage('u-1', 'Need help fixing this')]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
        onForkUserMessage={vi.fn()}
      />
    )

    expect(screen.getByTestId('timeline-user-actions-u-1')).toBeInTheDocument()
    expect(screen.getByTestId('timeline-user-actions-u-1').className).toContain('absolute')
    expect(screen.getByTestId('timeline-user-timestamp-u-1')).toBeInTheDocument()
    expect(screen.getByTestId('copy-message-button')).toBeInTheDocument()
    expect(screen.getByTestId('fork-message-button')).toBeInTheDocument()
  })

  it('uses the distinct user bubble tint instead of the neutral tool-card style', () => {
    render(
      <AgentTimeline
        timelineMessages={[makeUserMessage('u-style', 'Keep this as a user bubble')]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
      />
    )

    const bubble = screen.getByTestId('timeline-user-bubble-u-style')
    expect(bubble.className).toContain('bg-primary/10')
    expect(bubble.className).toContain('w-fit')
    expect(bubble.className).not.toContain('bg-agent-card')
  })

  it('applies a physical spacer to fill the viewport in a bootstrap round', () => {
    // useTimelineScrollController owns the geometry calculation; AgentTimeline
    // only renders the provided physical spacer.

    render(
      <AgentTimeline
        timelineMessages={[makeUserMessage('u-spacer', 'Start a fresh turn')]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
        clearScreenSpacerHeight={304}
      />
    )

    const sections = document.querySelectorAll('[data-round-id]')
    const lastSection = sections[sections.length - 1] as HTMLElement
    expect(lastSection.className).not.toContain('flex-1')
    expect(screen.getByTestId('timeline-clear-screen-spacer')).toHaveStyle({ height: '304px' })
  })

  it('keeps the prompt anchor rail vertically centered', () => {
    render(
      <AgentTimeline
        timelineMessages={[
          makeUserMessage('u-anchor-1', 'First prompt'),
          makeUserMessage('u-anchor-2', 'Second prompt')
        ]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
      />
    )

    const rail = screen.getByTestId('timeline-round-anchor-rail')
    expect(rail.className).toContain('top-0')
    expect(rail.className).toContain('-mt-6')
    expect(rail.className).not.toContain('-translate-y-1/2')

    const railItems = screen.getByTestId('timeline-round-anchor-rail-items')
    expect(railItems.className).toContain('overflow-visible')
    expect(railItems.className).not.toContain('overflow-y-auto')
    expect(railItems).toHaveStyle({ height: '336px' })
  })

  it('keeps every prompt anchor in the fixed fisheye rail for long sessions', () => {
    render(
      <AgentTimeline
        timelineMessages={Array.from({ length: 18 }, (_, index) =>
          makeUserMessage(`u-anchor-many-${index + 1}`, `Prompt ${index + 1}`)
        )}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
      />
    )

    const railButtons = screen.getAllByTestId('timeline-round-anchor-button')
    expect(railButtons).toHaveLength(18)
    expect(railButtons[0]).toHaveStyle({ top: '0%' })
    expect(railButtons[railButtons.length - 1]).toHaveStyle({ top: '100%' })
    expect(railButtons[0].getAttribute('aria-label')).toContain('第 1 轮')
    expect(railButtons[railButtons.length - 1].getAttribute('aria-label')).toContain('第 18 轮')
  })

  it('magnifies anchors near the pointer without using a rail scrollbar', () => {
    render(
      <AgentTimeline
        timelineMessages={Array.from({ length: 50 }, (_, index) =>
          makeUserMessage(`u-fisheye-${index + 1}`, `Prompt ${index + 1}`)
        )}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
      />
    )

    const railItems = screen.getByTestId('timeline-round-anchor-rail-items')
    Object.defineProperty(railItems, 'getBoundingClientRect', {
      value: () => ({ top: 0, left: 0, width: 32, height: 420, right: 32, bottom: 420 }),
      configurable: true
    })

    fireEvent.mouseMove(railItems, { clientY: 210 })

    const railButtons = screen.getAllByTestId('timeline-round-anchor-button')
    expect(railButtons).toHaveLength(50)
    expect(railItems.className).not.toContain('overflow-y-auto')
    expect(Number.parseFloat(railButtons[25].style.height)).toBeGreaterThan(
      Number.parseFloat(railButtons[0].style.height)
    )
  })

  it('shows edit button only when the message is editable', () => {
    render(
      <AgentTimeline
        timelineMessages={[makeUserMessage('u-2', 'Editable message')]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
        canEditUserMessage={() => true}
        onEditUserMessage={vi.fn()}
      />
    )

    expect(screen.getByTestId('edit-message-button')).toBeInTheDocument()
  })

  it('switches into inline edit mode when the user message is being edited', () => {
    render(
      <AgentTimeline
        timelineMessages={[makeUserMessage('u-3', 'Edit me')]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
        editingMessageId="u-3"
        editingContent="Edited draft"
      />
    )

    expect(screen.getByTestId('timeline-user-edit-textarea')).toHaveValue('Edited draft')
    expect(screen.queryByTestId('fork-message-button')).not.toBeInTheDocument()
  })

  it('calls copy through the shared button logic', async () => {
    render(
      <AgentTimeline
        timelineMessages={[makeUserMessage('u-4', 'Copy this line')]}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
      />
    )

    await act(async () => {
      fireEvent.click(screen.getByTestId('copy-message-button'))
    })
    expect(writeTextMock).toHaveBeenCalledWith('Copy this line')
  })
})
