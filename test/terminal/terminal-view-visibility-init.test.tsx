import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { TerminalView } from '../../src/renderer/src/components/terminal/TerminalView'
import { useLayoutStore } from '../../src/renderer/src/stores/useLayoutStore'
import { useSettingsStore } from '../../src/renderer/src/stores/useSettingsStore'

const mountMock = vi.fn()
const disposeMock = vi.fn()
const focusMock = vi.fn()
const clearMock = vi.fn()
const setVisibleMock = vi.fn()
const updateThemeMock = vi.fn()
const searchNextMock = vi.fn()
const searchPreviousMock = vi.fn()
const searchCloseMock = vi.fn()
const fitMock = vi.fn()
const updateFontFamilyMock = vi.fn()

vi.mock('@/components/terminal/backends/XtermBackend', () => {
  class MockXtermBackend {
    readonly type = 'xterm' as const
    readonly supportsSearch = true
    onSearchToggle?: () => void

    mount = mountMock
    dispose = disposeMock
    focus = focusMock
    clear = clearMock
    setVisible = setVisibleMock
    updateTheme = updateThemeMock
    searchNext = searchNextMock
    searchPrevious = searchPreviousMock
    searchClose = searchCloseMock
    fit = fitMock
    updateFontFamily = updateFontFamilyMock
    resize = vi.fn()
  }

  return { XtermBackend: MockXtermBackend }
})

vi.mock('@/components/terminal/backends/GhosttyBackend', () => {
  class MockGhosttyBackend {
    readonly type = 'ghostty' as const
    readonly supportsSearch = false

    mount = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    clear = vi.fn()
    setVisible = vi.fn()
    resize = vi.fn()
  }

  return { GhosttyBackend: MockGhosttyBackend }
})

describe('TerminalView visibility-aware init', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()

    useLayoutStore.setState({ ghosttyOverlaySuppressed: false })
    useSettingsStore.setState({
      embeddedTerminalBackend: 'xterm',
      ghosttyFontSize: 14,
      terminalFontFamily: ''
    })

    Object.defineProperty(window, 'terminalOps', {
      writable: true,
      configurable: true,
      value: {
        getConfig: vi.fn().mockResolvedValue({}),
        destroy: vi.fn().mockResolvedValue(undefined)
      }
    })
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
  })

  test('does not mount backend until terminal becomes visible', async () => {
    const view = render(
      <TerminalView terminalId="term-1" worktreeId="wt-1" cwd="/tmp/project" isVisible={false} />
    )

    const container = view.getByTestId('terminal-view-container') as HTMLDivElement
    Object.defineProperty(container, 'offsetWidth', { configurable: true, value: 640 })
    Object.defineProperty(container, 'offsetHeight', { configurable: true, value: 320 })

    expect(mountMock).not.toHaveBeenCalled()

    await act(async () => {
      view.rerender(
        <TerminalView terminalId="term-1" worktreeId="wt-1" cwd="/tmp/project" isVisible />
      )
      await vi.runAllTimersAsync()
    })

    expect(mountMock).toHaveBeenCalledTimes(1)
  })

  test('retries mount after container receives a visible size', async () => {
    const view = render(
      <TerminalView terminalId="term-2" worktreeId="wt-1" cwd="/tmp/project" isVisible />
    )

    const container = view.getByTestId('terminal-view-container') as HTMLDivElement
    Object.defineProperty(container, 'offsetWidth', { configurable: true, value: 0 })
    Object.defineProperty(container, 'offsetHeight', { configurable: true, value: 0 })

    await act(async () => {
      view.rerender(
        <TerminalView terminalId="term-2" worktreeId="wt-1" cwd="/tmp/project" isVisible />
      )
      await vi.runOnlyPendingTimersAsync()
    })

    expect(mountMock).not.toHaveBeenCalled()

    Object.defineProperty(container, 'offsetWidth', { configurable: true, value: 720 })
    Object.defineProperty(container, 'offsetHeight', { configurable: true, value: 360 })

    await act(async () => {
      await vi.runOnlyPendingTimersAsync()
    })

    expect(mountMock).toHaveBeenCalledTimes(1)
  })
})
