import { describe, test, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '../utils/render'
import { AppLayout } from '@/components/layout'
import { useLayoutStore, LAYOUT_CONSTRAINTS } from '@/stores/useLayoutStore'
import { useThemeStore } from '@/stores/useThemeStore'

describe('Session 2: Application Layout', () => {
  beforeEach(() => {
    // Reset stores before each test
    useLayoutStore.setState({
      leftSidebarWidth: LAYOUT_CONSTRAINTS.leftSidebar.default,
      leftSidebarCollapsed: false,
      rightSidebarWidth: LAYOUT_CONSTRAINTS.rightSidebar.default,
      rightSidebarCollapsed: false,
      rightContextTab: 'overview'
    })
    useThemeStore.setState({ themeId: 'mocha', followSystem: false, isLoading: false })
    localStorage.clear()
  })

  test('Three-panel layout renders', () => {
    render(<AppLayout />)

    expect(screen.getByTestId('left-sidebar')).toBeInTheDocument()
    expect(screen.getByTestId('main-pane')).toBeInTheDocument()
    expect(screen.getByTestId('right-sidebar')).toBeInTheDocument()
  })

  test('Left sidebar has correct default width', () => {
    render(<AppLayout />)

    const leftSidebar = screen.getByTestId('left-sidebar')
    expect(leftSidebar).toHaveAttribute('data-width', '240')
    expect(leftSidebar).toHaveStyle({ width: '240px' })
  })

  test('Left sidebar respects min/max constraints', () => {
    const { setLeftSidebarWidth } = useLayoutStore.getState()

    // Try to set below minimum
    setLeftSidebarWidth(100)
    expect(useLayoutStore.getState().leftSidebarWidth).toBe(LAYOUT_CONSTRAINTS.leftSidebar.min)

    // Try to set above maximum
    setLeftSidebarWidth(500)
    expect(useLayoutStore.getState().leftSidebarWidth).toBe(LAYOUT_CONSTRAINTS.leftSidebar.max)

    // Valid width should be set correctly
    setLeftSidebarWidth(300)
    expect(useLayoutStore.getState().leftSidebarWidth).toBe(300)
  })

  test('Right sidebar collapses and expands', async () => {
    render(<AppLayout />)

    // Initially visible
    expect(screen.getByTestId('right-sidebar')).toBeInTheDocument()

    // Click toggle button in header
    const toggleButton = screen.getByTestId('right-sidebar-toggle')
    fireEvent.click(toggleButton)

    // Should be collapsed (hidden element)
    await waitFor(() => {
      expect(screen.getByTestId('right-sidebar-collapsed')).toBeInTheDocument()
      expect(screen.queryByTestId('right-sidebar')).not.toBeInTheDocument()
    })

    // Click toggle again to expand
    fireEvent.click(toggleButton)

    // Should be visible again
    await waitFor(() => {
      expect(screen.getByTestId('right-sidebar')).toBeInTheDocument()
      expect(screen.queryByTestId('right-sidebar-collapsed')).not.toBeInTheDocument()
    })
  })

  test('Left sidebar collapses and expands from the header toggle', async () => {
    render(<AppLayout />)

    expect(screen.getByTestId('left-sidebar')).toBeInTheDocument()

    const toggleButton = screen.getByTestId('left-sidebar-toggle')
    fireEvent.click(toggleButton)

    await waitFor(() => {
      expect(screen.getByTestId('left-sidebar-collapsed')).toBeInTheDocument()
      expect(screen.queryByTestId('left-sidebar')).not.toBeInTheDocument()
    })

    fireEvent.click(toggleButton)

    await waitFor(() => {
      expect(screen.getByTestId('left-sidebar')).toBeInTheDocument()
      expect(screen.queryByTestId('left-sidebar-collapsed')).not.toBeInTheDocument()
    })
  })

  test('Right sidebar shows file tree component', () => {
    useLayoutStore.getState().setRightContextTab('files')
    render(<AppLayout />)

    // File tree panel should be rendered (with no selected worktree message)
    expect(screen.getByTestId('context-panel-tab-files')).toHaveAttribute('data-active', 'true')
    expect(screen.getByText('Select a worktree')).toBeInTheDocument()
  })

  test('Panel sizes persist to localStorage', () => {
    const { setLeftSidebarWidth } = useLayoutStore.getState()
    setLeftSidebarWidth(300)

    // The persist middleware should have saved to localStorage
    const stored = localStorage.getItem('hive-layout')
    expect(stored).not.toBeNull()

    const parsed = JSON.parse(stored!)
    expect(parsed.state.leftSidebarWidth).toBe(300)
  })

  test('Theme store switches theme presets', async () => {
    const { setTheme } = useThemeStore.getState()

    // Switch to light
    setTheme('latte')
    expect(useThemeStore.getState().themeId).toBe('latte')
    expect(document.documentElement.classList.contains('light')).toBe(true)

    // Switch to system
    useThemeStore.getState().setFollowSystem(true)
    expect(useThemeStore.getState().followSystem).toBe(true)

    // Switch back to dark
    setTheme('mocha')
    expect(useThemeStore.getState().themeId).toBe('mocha')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  test('Main pane fills remaining space', () => {
    render(<AppLayout />)

    const mainPane = screen.getByTestId('main-pane')
    // Main pane should have flex-1 class which makes it fill remaining space
    expect(mainPane).toHaveClass('flex-1')
  })

  test('Header renders with app title', () => {
    render(<AppLayout />)

    expect(screen.getByTestId('header')).toBeInTheDocument()
    expect(screen.getByText('Xuanpu')).toBeInTheDocument()
  })

  test('Resize handles are present', () => {
    render(<AppLayout />)

    expect(screen.getByTestId('resize-handle-left')).toBeInTheDocument()
    expect(screen.getByTestId('resize-handle-right')).toBeInTheDocument()
  })

  test('Layout content container exists', () => {
    render(<AppLayout />)

    const layoutContent = screen.getByTestId('layout-content')
    expect(layoutContent).toBeInTheDocument()
    expect(layoutContent).toHaveClass('flex')
  })

  test('Right sidebar can be closed via header toggle button', async () => {
    render(<AppLayout />)

    const closeButton = screen.getByTestId('right-sidebar-toggle')
    fireEvent.click(closeButton)

    await waitFor(() => {
      expect(screen.getByTestId('right-sidebar-collapsed')).toBeInTheDocument()
    })
  })

  test('Theme persists to localStorage', () => {
    const { setTheme } = useThemeStore.getState()
    setTheme('latte')

    const stored = localStorage.getItem('hive-theme')
    expect(stored).not.toBeNull()

    const parsed = JSON.parse(stored!)
    expect(parsed.state.themeId).toBe('latte')
  })
})
