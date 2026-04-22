import React, { useRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useSessionSmartScroll } from '../../src/renderer/src/hooks/useSessionSmartScroll'
import {
  getSessionViewState,
  setSessionViewState,
  resetSessionViewRegistryForTests
} from '../../src/renderer/src/lib/session-view-registry'

class MockResizeObserver {
  callback: ResizeObserverCallback
  target: Element | null = null

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    resizeObservers.push(this)
  }

  observe = vi.fn((target: Element) => {
    this.target = target
  })

  unobserve = vi.fn()
  disconnect = vi.fn()

  trigger(height: number) {
    if (!this.target) return

    this.callback(
      [
        {
          target: this.target,
          contentRect: {
            height,
            width: 0,
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 0,
            bottom: height,
            toJSON: () => ({})
          }
        }
      ] as unknown as ResizeObserverEntry[],
      this as unknown as ResizeObserver
    )
  }
}

const resizeObservers: MockResizeObserver[] = []
const originalResizeObserver = globalThis.ResizeObserver

interface HarnessProps {
  sessionId: string
  mirrorVersion: number
  contentVersion: number
  ready: boolean
  isStreaming?: boolean
}

function SmartScrollHarness({
  sessionId,
  mirrorVersion,
  contentVersion,
  ready,
  isStreaming = true
}: HarnessProps): React.JSX.Element {
  const bottomAreaRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const smartScroll = useSessionSmartScroll({
    sessionId,
    ready,
    contentVersion,
    mirrorVersion,
    isStreaming,
    bottomAreaRef,
    composerRef
  })

  return (
    <div>
      <div
        ref={smartScroll.scrollContainerRef}
        onScroll={smartScroll.handleScroll}
        onWheel={smartScroll.handleScrollWheel}
        onPointerDown={smartScroll.handleScrollPointerDown}
        onPointerUp={smartScroll.handleScrollPointerUp}
        onPointerCancel={smartScroll.handleScrollPointerCancel}
        data-testid="smart-scroll-scroller"
      >
        <div style={{ height: 1600 }} />
      </div>
      <div ref={bottomAreaRef} data-testid="smart-scroll-bottom-area" />
      <div ref={composerRef} data-testid="smart-scroll-composer" />
      <button onClick={smartScroll.handleScrollToBottomClick} data-testid="smart-scroll-fab-button">
        Jump
      </button>
      <div data-testid="smart-scroll-fab-visible">
        {smartScroll.showScrollFab ? 'yes' : 'no'}
      </div>
      <div data-testid="smart-scroll-fab-count">{smartScroll.scrollFabCount}</div>
      <div data-testid="smart-scroll-fab-offset">{smartScroll.scrollFabBottomOffset}</div>
    </div>
  )
}

function attachScrollMetrics(element: HTMLElement, values: {
  scrollTop: { current: number }
  scrollHeight: { current: number }
  clientHeight: number
}) {
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => values.scrollTop.current,
    set: (value: number) => {
      values.scrollTop.current = value
    }
  })
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => values.scrollHeight.current
  })
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => values.clientHeight
  })
}

function attachHeight(element: HTMLElement, height: number) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      width: 0,
      height,
      top: 0,
      left: 0,
      right: 0,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
  })
}

function getObserverFor(target: Element): MockResizeObserver {
  const observer = resizeObservers.find((item) => item.target === target)
  if (!observer) {
    throw new Error('ResizeObserver target not found')
  }
  return observer
}

describe('useSessionSmartScroll', () => {
  beforeEach(() => {
    resetSessionViewRegistryForTests()
    window.sessionStorage.clear()
    resizeObservers.length = 0
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
  })

  afterEach(() => {
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver
    } else {
      // @ts-expect-error test cleanup for optional browser global
      delete globalThis.ResizeObserver
    }
  })

  it('restores a saved non-bottom anchor when the session remounts', () => {
    setSessionViewState('session-a', {
      scrollTop: 240,
      stickyBottom: false,
      manualScrollLocked: true,
      lastSeenVersion: 2
    })

    const { rerender } = render(
      <SmartScrollHarness
        sessionId="session-a"
        mirrorVersion={2}
        contentVersion={1}
        ready={false}
      />
    )

    const scroller = screen.getByTestId('smart-scroll-scroller')
    const scrollTop = { current: 0 }
    const scrollHeight = { current: 1200 }
    attachScrollMetrics(scroller, { scrollTop, scrollHeight, clientHeight: 400 })

    rerender(
      <SmartScrollHarness
        sessionId="session-a"
        mirrorVersion={2}
        contentVersion={1}
        ready={true}
      />
    )

    expect(scrollTop.current).toBe(240)
    expect(getSessionViewState('session-a')).toMatchObject({
      scrollTop: 240,
      stickyBottom: false,
      manualScrollLocked: true,
      lastSeenVersion: 2
    })
  })

  it('keeps sticky-bottom sessions anchored and marks the latest mirror version as seen', () => {
    setSessionViewState('session-a', {
      stickyBottom: true,
      manualScrollLocked: false,
      lastSeenVersion: 1
    })

    const { rerender } = render(
      <SmartScrollHarness
        sessionId="session-a"
        mirrorVersion={4}
        contentVersion={1}
        ready={false}
      />
    )

    const scroller = screen.getByTestId('smart-scroll-scroller')
    const scrollTop = { current: 0 }
    const scrollHeight = { current: 1200 }
    attachScrollMetrics(scroller, { scrollTop, scrollHeight, clientHeight: 400 })

    rerender(
      <SmartScrollHarness
        sessionId="session-a"
        mirrorVersion={4}
        contentVersion={1}
        ready={true}
      />
    )

    expect(scrollTop.current).toBe(1200)
    expect(getSessionViewState('session-a')).toMatchObject({
      stickyBottom: true,
      manualScrollLocked: false,
      lastSeenVersion: 4
    })
    expect(screen.getByTestId('smart-scroll-fab-visible')).toHaveTextContent('no')
  })

  it('shows unread FAB count while manually locked and clears it after jumping to bottom', () => {
    const { rerender } = render(
      <SmartScrollHarness
        sessionId="session-a"
        mirrorVersion={1}
        contentVersion={1}
        ready={false}
      />
    )

    const scroller = screen.getByTestId('smart-scroll-scroller')
    const scrollTop = { current: 0 }
    const scrollHeight = { current: 1200 }
    attachScrollMetrics(scroller, { scrollTop, scrollHeight, clientHeight: 400 })

    rerender(
      <SmartScrollHarness
        sessionId="session-a"
        mirrorVersion={1}
        contentVersion={1}
        ready={true}
      />
    )

    scrollTop.current = 200
    fireEvent.wheel(scroller)
    fireEvent.scroll(scroller)

    rerender(
      <SmartScrollHarness
        sessionId="session-a"
        mirrorVersion={4}
        contentVersion={2}
        ready={true}
      />
    )

    expect(screen.getByTestId('smart-scroll-fab-visible')).toHaveTextContent('yes')
    expect(screen.getByTestId('smart-scroll-fab-count')).toHaveTextContent('3')
    expect(getSessionViewState('session-a')).toMatchObject({
      stickyBottom: false,
      manualScrollLocked: true,
      lastSeenVersion: 1
    })

    fireEvent.click(screen.getByTestId('smart-scroll-fab-button'))

    expect(scrollTop.current).toBe(1200)
    expect(screen.getByTestId('smart-scroll-fab-visible')).toHaveTextContent('no')
    expect(getSessionViewState('session-a')).toMatchObject({
      stickyBottom: true,
      manualScrollLocked: false,
      lastSeenVersion: 4
    })
  })

  it('compensates bottom-area height changes when already anchored near the bottom', () => {
    const { rerender } = render(
      <SmartScrollHarness
        sessionId="session-a"
        mirrorVersion={2}
        contentVersion={1}
        ready={false}
      />
    )

    const scroller = screen.getByTestId('smart-scroll-scroller')
    const bottomArea = screen.getByTestId('smart-scroll-bottom-area')
    const composer = screen.getByTestId('smart-scroll-composer')
    const scrollTop = { current: 0 }
    const scrollHeight = { current: 1200 }
    attachScrollMetrics(scroller, { scrollTop, scrollHeight, clientHeight: 400 })
    attachHeight(bottomArea, 96)
    attachHeight(composer, 80)

    rerender(
      <SmartScrollHarness
        sessionId="session-a"
        mirrorVersion={2}
        contentVersion={1}
        ready={true}
      />
    )

    scrollHeight.current = 1440
    act(() => {
      getObserverFor(composer).trigger(120)
    })

    expect(scrollTop.current).toBe(1440)
    expect(Number(screen.getByTestId('smart-scroll-fab-offset').textContent)).toBeGreaterThanOrEqual(152)
  })

  it('keeps the v1 smart-scroll guard structure in the shared hook source', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../src/renderer/src/hooks/useSessionSmartScroll.ts'
      ),
      'utf-8'
    )

    expect(source).toContain('isProgrammaticScrollRef')
    expect(source).toContain('manualScrollIntentRef')
    expect(source).toContain('pointerDownInScrollerRef')
    expect(source).toContain("scrollToBottom('instant')")
    expect(source).toContain('BOTTOM_AREA_COMPENSATE_THRESHOLD')
  })
})
