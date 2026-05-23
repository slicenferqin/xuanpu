import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ContextBudgetDebugger } from '../../src/renderer/src/components/sessions/ContextBudgetDebugger'

function installFieldOpsMock(): Window['fieldOps'] {
  const fieldOps = {
    listContextPackages: vi.fn().mockImplementation(async (query: { sessionId?: string }) =>
      query.sessionId === 'hive-session'
        ? [
            {
              id: 'pkg-123456789',
              sessionId: 'hive-session',
              worktreeId: 'worktree-1',
              runtimeId: 'xuanpu-agent',
              modelProviderId: 'anthropic',
              modelId: 'claude-haiku-4-5',
              createdAt: 1000,
              budgetProfile: 'balanced',
              approxTokens: 256,
              sections: [
                {
                  id: 'current-field',
                  kind: 'current_field',
                  title: 'Current Field',
                  included: true,
                  approxTokens: 96,
                  source: 'field-context'
                },
                {
                  id: 'retrieved-episodes',
                  kind: 'retrieved_episodes',
                  title: 'Retrieved Episodes',
                  included: false,
                  approxTokens: 0,
                  source: 'field_episode_blocks',
                  reason: 'Gated retrieval did not match this turn'
                }
              ],
              renderedMarkdown: null,
              renderedMarkdownStored: false,
              decisions: {
                renderedMarkdownPolicy: 'omitted-by-default',
                retrievedEpisodeCount: 0,
                frozenEpisodeCandidateCount: 2
              }
            }
          ]
        : []
    )
  } as unknown as Window['fieldOps']

  Object.defineProperty(window, 'fieldOps', {
    configurable: true,
    writable: true,
    value: fieldOps
  })

  return fieldOps
}

describe('ContextBudgetDebugger', () => {
  let fieldOps: Window['fieldOps']

  beforeEach(() => {
    fieldOps = installFieldOpsMock()
  })

  it('loads xuanpu-agent context packages with privacy-preserving markdown reads', async () => {
    render(
      <ContextBudgetDebugger
        sessionId="hive-session"
        runtimeSessionId="runtime-session"
        worktreeId="worktree-1"
      />
    )

    fireEvent.click(screen.getByText('Context Budget'))

    await waitFor(() => {
      expect(fieldOps.listContextPackages).toHaveBeenCalledWith({
        worktreeId: 'worktree-1',
        sessionId: 'runtime-session',
        runtimeId: 'xuanpu-agent',
        includeRenderedMarkdown: false,
        limit: 5
      })
      expect(fieldOps.listContextPackages).toHaveBeenCalledWith({
        worktreeId: 'worktree-1',
        sessionId: 'hive-session',
        runtimeId: 'xuanpu-agent',
        includeRenderedMarkdown: false,
        limit: 5
      })
    })

    expect(await screen.findByText('Current Field')).toBeInTheDocument()
    expect(screen.getByText('Retrieved Episodes')).toBeInTheDocument()
    expect(screen.getAllByText(/balanced/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/~256 tokens/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/omitted-by-default/).length).toBeGreaterThan(0)
  })
})
