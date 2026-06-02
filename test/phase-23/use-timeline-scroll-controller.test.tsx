import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTimelineScrollController } from '../../src/renderer/src/hooks/useTimelineScrollController'
import { resetScrollAnchorRegistryForTests } from '../../src/renderer/src/lib/session-scroll-registry'

interface HarnessProps {
  contentVersion?: number
  metricsVersion?: number | string
  mirrorVersion?: number
  isStreaming?: boolean
  ready?: boolean
  bottomReadableInset?: number
}

function TimelineScrollHarness({
  contentVersion = 1,
  metricsVersion = 1,
  mirrorVersion = 1,
  isStreaming = false,
  ready = false,
  bottomReadableInset = 72
}: HarnessProps): React.JSX.Element {
  const controller = useTimelineScrollController({
    sessionId: 'timeline-controller-test',
    ready,
    contentVersion,
    metricsVersion,
    mirrorVersion,
    isStreaming,
    bottomReadableInset
  })

  return (
    <div>
      <div
        ref={controller.scrollContainerRef}
        data-testid="timeline-scroller"
        onScroll={controller.handleScroll}
        onWheel={controller.handleScrollWheel}
        onPointerDown={controller.handleScrollPointerDown}
        onPointerUp={controller.handleScrollPointerUp}
        onPointerCancel={controller.handleScrollPointerCancel}
      >
        <div ref={controller.timelineContentRef} data-testid="timeline-content">
          <section data-round-anchor="true" data-round-id="round-a" data-testid="round-a" />
          <section data-round-anchor="true" data-round-id="round-b" data-testid="round-b" />
          <div ref={controller.tailSentinelRef} data-testid="tail-sentinel" />
          <div data-clear-screen-spacer="true" data-testid="clear-screen-spacer" />
        </div>
      </div>
      <button
        type="button"
        onClick={() => controller.requestClearScreenScroll('round-b')}
        data-testid="request-clear-screen"
      >
        Request
      </button>
      <button
        type="button"
        onClick={() => controller.scrollToRound('round-b', { behavior: 'instant' })}
        data-testid="scroll-to-round"
      >
        Round
      </button>
      <button
        type="button"
        onClick={controller.handleScrollToBottomClick}
        data-testid="jump-to-bottom"
      >
        Tail
      </button>
      <div data-testid="clear-screen-inset">{controller.focusFillerHeight}</div>
      <div data-testid="active-round-id">{controller.activeRoundId ?? ''}</div>
      <div data-testid="scroll-mode">{controller.scrollMode}</div>
      <div data-testid="tail-readable">{String(controller.tailReadable)}</div>
      <div data-testid="show-jump-to-bottom">{String(controller.showJumpToBottom)}</div>
    </div>
  )
}

function attachScrollMetrics(
  element: HTMLElement,
  metrics: {
    scrollTop: { current: number }
    scrollHeight: { current: number }
    clientHeight: number
  }
): void {
  Object.defineProperties(element, {
    scrollTop: {
      configurable: true,
      get: () => metrics.scrollTop.current,
      set: (value: number) => {
        metrics.scrollTop.current = value
      }
    },
    scrollHeight: {
      configurable: true,
      get: () => metrics.scrollHeight.current
    },
    clientHeight: {
      configurable: true,
      get: () => metrics.clientHeight
    }
  })
}

function mockRect(element: HTMLElement, top: number, height: number): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 100,
    width: 100,
    height,
    toJSON: () => ({})
  } as DOMRect)
}

describe('useTimelineScrollController', () => {
  beforeEach(() => {
    resetScrollAnchorRegistryForTests()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('owns clear-screen pending scroll and aligns the requested round to the viewport top', async () => {
    const { rerender } = render(<TimelineScrollHarness />)

    const scroller = screen.getByTestId('timeline-scroller')
    const content = screen.getByTestId('timeline-content')
    const roundA = screen.getByTestId('round-a')
    const roundB = screen.getByTestId('round-b')
    const spacer = screen.getByTestId('clear-screen-spacer')
    const scrollTop = { current: 0 }
    const scrollHeight = { current: 1300 }

    attachScrollMetrics(scroller, { scrollTop, scrollHeight, clientHeight: 500 })
    mockRect(scroller, 0, 500)
    mockRect(content, 0, 900)
    mockRect(roundA, 0, 300)
    mockRect(roundB, 720, 60)
    mockRect(spacer, 820, 80)

    fireEvent.click(screen.getByTestId('request-clear-screen'))
    rerender(<TimelineScrollHarness contentVersion={2} metricsVersion={2} />)

    expect(scrollTop.current).toBe(696)
    await waitFor(() => expect(screen.getByTestId('clear-screen-inset').textContent).toBe('304'))
    expect(screen.getByTestId('active-round-id').textContent).toBe('round-b')
  })

  it('keeps round anchor navigation inside the controller', () => {
    render(<TimelineScrollHarness />)

    const scroller = screen.getByTestId('timeline-scroller')
    const content = screen.getByTestId('timeline-content')
    const roundA = screen.getByTestId('round-a')
    const roundB = screen.getByTestId('round-b')
    const spacer = screen.getByTestId('clear-screen-spacer')
    const scrollTop = { current: 20 }
    const scrollHeight = { current: 1300 }

    attachScrollMetrics(scroller, { scrollTop, scrollHeight, clientHeight: 500 })
    mockRect(scroller, 0, 500)
    mockRect(content, 0, 900)
    mockRect(roundA, 0, 300)
    mockRect(roundB, 420, 60)
    mockRect(spacer, 820, 80)

    fireEvent.click(screen.getByTestId('scroll-to-round'))

    expect(scrollTop.current).toBe(416)
    expect(screen.getByTestId('active-round-id').textContent).toBe('round-b')
  })

  it('derives the active round from the scroll position', () => {
    const { rerender } = render(<TimelineScrollHarness metricsVersion={1} />)

    const scroller = screen.getByTestId('timeline-scroller')
    const content = screen.getByTestId('timeline-content')
    const roundA = screen.getByTestId('round-a')
    const roundB = screen.getByTestId('round-b')
    const spacer = screen.getByTestId('clear-screen-spacer')
    const scrollTop = { current: 0 }
    const scrollHeight = { current: 1300 }

    attachScrollMetrics(scroller, { scrollTop, scrollHeight, clientHeight: 500 })
    mockRect(scroller, 0, 500)
    mockRect(content, 0, 900)
    mockRect(roundA, 20, 300)
    mockRect(roundB, 420, 60)
    mockRect(spacer, 820, 80)

    rerender(<TimelineScrollHarness metricsVersion={2} />)
    expect(screen.getByTestId('active-round-id').textContent).toBe('round-a')

    mockRect(roundA, -520, 300)
    mockRect(roundB, 80, 60)
    fireEvent.scroll(scroller)

    expect(screen.getByTestId('active-round-id').textContent).toBe('round-b')
  })

  it('keeps the latest round active while streaming', () => {
    const { rerender } = render(<TimelineScrollHarness metricsVersion={1} isStreaming />)

    const scroller = screen.getByTestId('timeline-scroller')
    const content = screen.getByTestId('timeline-content')
    const roundA = screen.getByTestId('round-a')
    const roundB = screen.getByTestId('round-b')
    const spacer = screen.getByTestId('clear-screen-spacer')
    const scrollTop = { current: 0 }
    const scrollHeight = { current: 1300 }

    attachScrollMetrics(scroller, { scrollTop, scrollHeight, clientHeight: 500 })
    mockRect(scroller, 0, 500)
    mockRect(content, 0, 900)
    mockRect(roundA, 20, 300)
    mockRect(roundB, 420, 60)
    mockRect(spacer, 820, 80)

    rerender(<TimelineScrollHarness metricsVersion={2} isStreaming />)

    expect(screen.getByTestId('active-round-id').textContent).toBe('round-b')
  })

  it('does not exit round-focus before first filler measurement', async () => {
    const { rerender } = render(<TimelineScrollHarness />)

    const scroller = screen.getByTestId('timeline-scroller')
    const content = screen.getByTestId('timeline-content')
    const roundA = screen.getByTestId('round-a')
    const roundB = screen.getByTestId('round-b')
    const spacer = screen.getByTestId('clear-screen-spacer')

    attachScrollMetrics(scroller, {
      scrollTop: { current: 0 },
      scrollHeight: { current: 1300 },
      clientHeight: 500
    })
    mockRect(scroller, 0, 500)
    mockRect(content, 0, 900)
    mockRect(roundA, 0, 300)
    mockRect(roundB, 720, 60)
    mockRect(spacer, 820, 80)

    // Enter round-focus
    fireEvent.click(screen.getByTestId('request-clear-screen'))

    // Trigger metrics update
    rerender(<TimelineScrollHarness contentVersion={2} metricsVersion={2} />)

    // After measurement, filler should be computed (not stuck at 0)
    await waitFor(() => expect(screen.getByTestId('clear-screen-inset').textContent).toBe('304'))
  })

  it('scrolls to the tail-readable position when FAB is clicked with overlay inset', () => {
    render(<TimelineScrollHarness bottomReadableInset={120} />)

    const scroller = screen.getByTestId('timeline-scroller')
    const content = screen.getByTestId('timeline-content')
    const roundA = screen.getByTestId('round-a')
    const roundB = screen.getByTestId('round-b')
    const tailSentinel = screen.getByTestId('tail-sentinel')
    const spacer = screen.getByTestId('clear-screen-spacer')
    const scrollTop = { current: 0 }

    attachScrollMetrics(scroller, { scrollTop, scrollHeight: { current: 1600 }, clientHeight: 500 })
    mockRect(scroller, 0, 500)
    mockRect(content, 0, 1200)
    mockRect(roundA, 0, 300)
    mockRect(roundB, 420, 60)
    mockRect(tailSentinel, 520, 0)
    mockRect(spacer, 820, 80)

    fireEvent.click(screen.getByTestId('jump-to-bottom'))

    expect(scrollTop.current).toBe(140)
    expect(screen.getByTestId('clear-screen-inset').textContent).toBe('0')
  })

  it('does not show the jump FAB after clear-screen when the real tail is readable', async () => {
    const { rerender } = render(<TimelineScrollHarness bottomReadableInset={120} />)

    const scroller = screen.getByTestId('timeline-scroller')
    const content = screen.getByTestId('timeline-content')
    const roundA = screen.getByTestId('round-a')
    const roundB = screen.getByTestId('round-b')
    const tailSentinel = screen.getByTestId('tail-sentinel')
    const spacer = screen.getByTestId('clear-screen-spacer')
    const scrollTop = { current: 0 }

    attachScrollMetrics(scroller, { scrollTop, scrollHeight: { current: 900 }, clientHeight: 500 })
    mockRect(scroller, 0, 500)
    mockRect(content, 0, 620)
    mockRect(roundA, 0, 180)
    mockRect(roundB, 220, 60)
    mockRect(tailSentinel, 360, 0)
    mockRect(spacer, 540, 80)

    fireEvent.click(screen.getByTestId('request-clear-screen'))
    rerender(
      <TimelineScrollHarness bottomReadableInset={120} contentVersion={2} metricsVersion={2} />
    )

    await waitFor(() => expect(screen.getByTestId('scroll-mode').textContent).toBe('round-focus'))
    expect(screen.getByTestId('tail-readable').textContent).toBe('true')
    expect(screen.getByTestId('show-jump-to-bottom').textContent).toBe('false')
  })

  it('does not show the jump FAB for history mode alone when the real tail is readable', async () => {
    const { rerender } = render(<TimelineScrollHarness bottomReadableInset={120} />)

    const scroller = screen.getByTestId('timeline-scroller')
    const content = screen.getByTestId('timeline-content')
    const roundA = screen.getByTestId('round-a')
    const roundB = screen.getByTestId('round-b')
    const tailSentinel = screen.getByTestId('tail-sentinel')
    const spacer = screen.getByTestId('clear-screen-spacer')
    const scrollTop = { current: 0 }

    attachScrollMetrics(scroller, { scrollTop, scrollHeight: { current: 900 }, clientHeight: 500 })
    mockRect(scroller, 0, 500)
    mockRect(content, 0, 620)
    mockRect(roundA, 0, 180)
    mockRect(roundB, 220, 60)
    mockRect(tailSentinel, 360, 0)
    mockRect(spacer, 540, 80)

    fireEvent.click(screen.getByTestId('request-clear-screen'))
    rerender(
      <TimelineScrollHarness bottomReadableInset={120} contentVersion={2} metricsVersion={2} />
    )
    await waitFor(() => expect(screen.getByTestId('scroll-mode').textContent).toBe('round-focus'))

    fireEvent.wheel(scroller)

    await waitFor(() => expect(screen.getByTestId('scroll-mode').textContent).toBe('history'))
    expect(screen.getByTestId('tail-readable').textContent).toBe('true')
    expect(screen.getByTestId('show-jump-to-bottom').textContent).toBe('false')
  })

  it('shows the jump FAB only when the real tail is below the readable area', async () => {
    const { rerender } = render(
      <TimelineScrollHarness bottomReadableInset={120} contentVersion={1} metricsVersion={1} />
    )

    const scroller = screen.getByTestId('timeline-scroller')
    const content = screen.getByTestId('timeline-content')
    const roundA = screen.getByTestId('round-a')
    const roundB = screen.getByTestId('round-b')
    const tailSentinel = screen.getByTestId('tail-sentinel')
    const spacer = screen.getByTestId('clear-screen-spacer')

    attachScrollMetrics(scroller, {
      scrollTop: { current: 0 },
      scrollHeight: { current: 900 },
      clientHeight: 500
    })
    mockRect(scroller, 0, 500)
    mockRect(content, 0, 620)
    mockRect(roundA, 0, 180)
    mockRect(roundB, 220, 60)
    mockRect(tailSentinel, 430, 0)
    mockRect(spacer, 540, 80)

    rerender(
      <TimelineScrollHarness bottomReadableInset={120} contentVersion={2} metricsVersion={2} />
    )

    await waitFor(() => expect(screen.getByTestId('tail-readable').textContent).toBe('false'))
    expect(screen.getByTestId('show-jump-to-bottom').textContent).toBe('true')
  })

  it('keeps the tail readable as streaming content grows under the overlay', () => {
    const { rerender } = render(
      <TimelineScrollHarness
        bottomReadableInset={120}
        ready
        contentVersion={1}
        metricsVersion={1}
      />
    )

    const scroller = screen.getByTestId('timeline-scroller')
    const content = screen.getByTestId('timeline-content')
    const roundA = screen.getByTestId('round-a')
    const roundB = screen.getByTestId('round-b')
    const tailSentinel = screen.getByTestId('tail-sentinel')
    const spacer = screen.getByTestId('clear-screen-spacer')
    const scrollTop = { current: 0 }

    attachScrollMetrics(scroller, { scrollTop, scrollHeight: { current: 1300 }, clientHeight: 500 })
    mockRect(scroller, 0, 500)
    mockRect(content, 0, 900)
    mockRect(roundA, 0, 300)
    mockRect(roundB, 420, 60)
    mockRect(tailSentinel, 360, 0)
    mockRect(spacer, 820, 80)

    rerender(
      <TimelineScrollHarness
        bottomReadableInset={120}
        ready
        contentVersion={2}
        metricsVersion={2}
      />
    )

    mockRect(content, 0, 1200)
    mockRect(tailSentinel, 520, 0)
    attachScrollMetrics(scroller, { scrollTop, scrollHeight: { current: 1600 }, clientHeight: 500 })

    rerender(
      <TimelineScrollHarness
        bottomReadableInset={120}
        ready
        contentVersion={3}
        metricsVersion={3}
      />
    )

    expect(scrollTop.current).toBe(140)
  })
})
