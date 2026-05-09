import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { MonacoDiffToolbar, type MonacoDiffViewMode } from '@/components/diff/MonacoDiffToolbar'

function renderToolbar(viewMode: MonacoDiffViewMode = 'split') {
  const onViewModeChange = vi.fn()
  render(
    <MonacoDiffToolbar
      fileName="ComposerBar.tsx"
      staged={false}
      isUntracked={false}
      viewMode={viewMode}
      onViewModeChange={onViewModeChange}
      onPrevHunk={vi.fn()}
      onNextHunk={vi.fn()}
      onCopy={vi.fn()}
      onClose={vi.fn()}
    />
  )
  return onViewModeChange
}

describe('Monaco hunk-focused diff view', () => {
  test('toolbar exposes split, inline, and hunk view buttons', () => {
    renderToolbar()

    expect(screen.getByTestId('monaco-diff-view-mode-group')).toBeInTheDocument()
    expect(screen.getByTestId('monaco-diff-view-split')).toBeInTheDocument()
    expect(screen.getByTestId('monaco-diff-view-inline')).toBeInTheDocument()
    expect(screen.getByTestId('monaco-diff-view-hunk')).toBeInTheDocument()
  })

  test('clicking hunk view selects the hunk-focused mode', () => {
    const onViewModeChange = renderToolbar('inline')

    fireEvent.click(screen.getByTestId('monaco-diff-view-hunk'))

    expect(onViewModeChange).toHaveBeenCalledWith('hunk')
  })

  test('MonacoDiffView wires hunk mode to hide unchanged regions', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/diff/MonacoDiffView.tsx'),
      'utf-8'
    )

    expect(source).toContain("const hideUnchangedRegions = viewMode === 'hunk'")
    expect(source).toContain('hideUnchangedRegions: {')
    expect(source).toContain('contextLineCount: 3')
    expect(source).toContain('minimumLineCount: 4')
  })
})
