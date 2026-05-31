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
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 768
    })
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

  it('renders round navigator as a sticky overlay layer outside the timeline layout', () => {
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

    expect(screen.getByTestId('round-navigator-layer').className).toContain('sticky')
    const nav = screen.getByTestId('round-navigator')
    expect(nav.className).toContain('absolute')
    expect(nav.className).toContain('pointer-events-none')
  })

  it('keeps the collapsed navigator visible as low-impact round ticks', () => {
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

    const nav = screen.getByTestId('round-navigator')
    const markers = screen.getAllByTestId('round-navigator-marker')
    expect(markers).toHaveLength(18)
    expect(screen.getAllByTestId('round-navigator-marker-line')).toHaveLength(18)
    expect(screen.getByTestId('round-navigator-layer').className).not.toContain('hidden')
    expect(nav.getAttribute('data-state')).toBe('closed')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('does not open from the invisible rail hit area outside visible ticks', () => {
    render(
      <AgentTimeline
        timelineMessages={Array.from({ length: 18 }, (_, index) =>
          makeUserMessage(`u-hit-area-${index + 1}`, `Prompt ${index + 1}`)
        )}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
      />
    )

    const nav = screen.getByTestId('round-navigator')

    fireEvent.mouseEnter(nav)

    expect(nav.getAttribute('data-state')).toBe('closed')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('expands the right rail into a preview list on hover', () => {
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

    const nav = screen.getByTestId('round-navigator')
    expect(nav.className).toContain('absolute')

    fireEvent.mouseEnter(screen.getAllByTestId('round-navigator-marker')[0])

    const wheel = screen.getByRole('listbox')
    const track = screen.getByTestId('round-navigator-track')
    expect(nav.getAttribute('data-state')).toBe('open')
    expect(nav.style.width).toBe('348px')
    expect(nav.style.transform).toBe('translateX(-310px)')
    expect(track.style.height).toBe('452px')
    expect(Number.parseInt(nav.style.height, 10)).toBeGreaterThan(
      Number.parseInt(track.style.height, 10)
    )
    expect(screen.queryByTestId('round-navigator-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('round-navigator-wheel')).not.toBeInTheDocument()
    expect(wheel).toBe(track)
    expect(wheel.parentElement).toBe(nav)
    expect(screen.getAllByTestId('round-navigator-marker')).toHaveLength(11)
    expect(screen.getAllByRole('option')).toHaveLength(11)
    expect(screen.getAllByTestId('round-navigator-option-label')).toHaveLength(11)
    expect(screen.getAllByTestId('round-navigator-option-line')).toHaveLength(11)
  })

  it('shows every round in the expanded rail when the viewport can fit readable rows', () => {
    render(
      <AgentTimeline
        timelineMessages={Array.from({ length: 32 }, (_, index) =>
          makeUserMessage(`u-dense-${index + 1}`, `Prompt ${index + 1}`)
        )}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
      />
    )

    fireEvent.mouseEnter(screen.getAllByTestId('round-navigator-marker')[0])

    expect(screen.getAllByRole('option')).toHaveLength(32)
    expect(screen.getAllByTestId('round-navigator-option-label')).toHaveLength(32)
    expect(screen.getAllByTestId('round-navigator-option-line')).toHaveLength(32)
  })

  it('keeps medium-length full previews readable instead of over-compressing rows', () => {
    render(
      <AgentTimeline
        timelineMessages={Array.from({ length: 22 }, (_, index) =>
          makeUserMessage(`u-medium-${index + 1}`, `Prompt ${index + 1}`)
        )}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
      />
    )

    const firstCollapsedMarker = screen.getAllByTestId('round-navigator-marker')[0]
    const collapsedTop = firstCollapsedMarker.style.top
    const collapsedHeight = firstCollapsedMarker.style.height

    fireEvent.mouseEnter(firstCollapsedMarker)

    expect(screen.getAllByRole('option')).toHaveLength(22)
    expect(screen.getAllByRole('option')[0]).toHaveStyle({
      top: collapsedTop,
      height: collapsedHeight
    })
    expect(screen.getAllByRole('option')[0]).toHaveStyle({ height: '25px' })
    expect(screen.getByTestId('round-navigator-track').style.height).toBe('562px')
  })

  it('raises the full-preview capacity on taller viewports', () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      writable: true,
      value: 1200
    })

    render(
      <AgentTimeline
        timelineMessages={Array.from({ length: 48 }, (_, index) =>
          makeUserMessage(`u-tall-${index + 1}`, `Prompt ${index + 1}`)
        )}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
      />
    )

    fireEvent.mouseEnter(screen.getAllByTestId('round-navigator-marker')[0])

    expect(screen.getAllByRole('option')).toHaveLength(48)
    expect(screen.getAllByTestId('round-navigator-option-label')).toHaveLength(48)
    expect(screen.getByTestId('round-navigator-track').style.height).toBe('972px')
  })

  it('keeps wheel scrolling isolated from the timeline scroll controller', () => {
    const onWheel = vi.fn()

    render(
      <AgentTimeline
        timelineMessages={Array.from({ length: 18 }, (_, index) =>
          makeUserMessage(`u-wheel-${index + 1}`, `Prompt ${index + 1}`)
        )}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
        onWheel={onWheel}
      />
    )

    fireEvent.mouseEnter(screen.getAllByTestId('round-navigator-marker')[0])
    fireEvent.wheel(screen.getByRole('listbox'), { deltaY: 100 })

    expect(onWheel).not.toHaveBeenCalled()
  })

  it('closes when the pointer leaves the expanded visible track', () => {
    vi.useFakeTimers()

    try {
      render(
        <AgentTimeline
          timelineMessages={Array.from({ length: 18 }, (_, index) =>
            makeUserMessage(`u-close-track-${index + 1}`, `Prompt ${index + 1}`)
          )}
          streamingContent=""
          streamingParts={[]}
          isStreaming={false}
          lifecycle="idle"
        />
      )

      const nav = screen.getByTestId('round-navigator')
      fireEvent.mouseEnter(screen.getAllByTestId('round-navigator-marker')[0])
      expect(nav.getAttribute('data-state')).toBe('open')

      fireEvent.mouseLeave(screen.getByTestId('round-navigator-track'))
      act(() => {
        vi.advanceTimersByTime(150)
      })

      expect(nav.getAttribute('data-state')).toBe('closed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('supports keyboard focus navigation and activation in the round preview', () => {
    const onRoundAnchorNavigate = vi.fn()

    render(
      <AgentTimeline
        timelineMessages={Array.from({ length: 4 }, (_, index) =>
          makeUserMessage(`u-key-${index + 1}`, `Prompt ${index + 1}`)
        )}
        streamingContent=""
        streamingParts={[]}
        isStreaming={false}
        lifecycle="idle"
        onRoundAnchorNavigate={onRoundAnchorNavigate}
      />
    )

    const nav = screen.getByTestId('round-navigator')

    fireEvent.focus(nav)
    expect(nav.getAttribute('data-state')).toBe('open')

    fireEvent.keyDown(nav, { key: 'ArrowUp' })
    fireEvent.keyDown(nav, { key: 'Enter' })

    expect(onRoundAnchorNavigate).toHaveBeenCalledWith('u-key-3')

    fireEvent.keyDown(nav, { key: 'Escape' })
    expect(nav.getAttribute('data-state')).toBe('closed')
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
