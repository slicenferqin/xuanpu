import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { TerminalTabBar } from '@/components/terminal/TerminalTabBar'
import { useBottomTerminalStore } from '@/stores/useBottomTerminalStore'

describe('TerminalTabBar', () => {
  beforeEach(() => {
    useBottomTerminalStore.setState({
      tabsByWorktree: new Map(),
      activeTabByWorktree: new Map(),
      counterByWorktree: new Map()
    })
  })

  it('renders nothing for a worktree with no terminal tabs without an update loop', () => {
    const { container } = render(
      <TerminalTabBar worktreeId="worktree-without-tabs" worktreeCwd="/tmp/worktree" />
    )

    expect(container).toBeEmptyDOMElement()
  })
})
