import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FieldContextDebug } from '../../src/renderer/src/components/sessions/FieldContextDebug'

function installFieldOpsMock(): Window['fieldOps'] {
  const fieldOps = {
    reportWorktreeSwitch: vi.fn(),
    reportFileOpen: vi.fn(),
    reportFileFocus: vi.fn(),
    reportFileSelection: vi.fn(),
    getLastInjection: vi.fn().mockResolvedValue(null),
    getXfpAuditEvents: vi.fn().mockResolvedValue([]),
    getEpisodicMemory: vi.fn().mockResolvedValue(null),
    getSemanticMemory: vi.fn().mockResolvedValue(null),
    getCheckpoint: vi.fn().mockResolvedValue(null),
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
              approxTokens: 128,
              sections: [
                {
                  id: 'anchor',
                  kind: 'anchor',
                  title: 'Xuanpu Agent Context Anchor',
                  included: true,
                  approxTokens: 24
                },
                {
                  id: 'working-set',
                  kind: 'working_set',
                  title: 'Recent Visible Turns',
                  included: false,
                  approxTokens: 0,
                  reason: 'dropped old turns'
                }
              ],
              renderedMarkdown: null,
              renderedMarkdownStored: false,
              decisions: { phase: 'phase-1-no-tools-provider' }
            }
          ]
        : []
    ),
    listEpisodeBlocks: vi.fn().mockImplementation(async (query: { sessionId?: string }) =>
      query.sessionId === 'hive-session'
        ? [
            {
              id: 'episode-123456789',
              worktreeId: 'worktree-1',
              sessionId: 'hive-session',
              createdAt: 2000,
              kind: 'turns',
              title: 'Frozen Conversation Turns',
              summaryMarkdown: '## Frozen Conversation Turns\n\n- **user:** keep pnpm',
              keyFacts: [],
              constraints: ['keep using pnpm'],
              files: ['src/main/services/xuanpu-agent/runtime.ts'],
              commands: ['pnpm vitest run test/phase-24/xuanpu-agent-runtime.test.ts'],
              failures: [],
              rawRefs: [{ type: 'session_message', id: 'm-1', role: 'user' }],
              tokenEstimate: 64,
              confidence: 'medium'
            }
          ]
        : []
    ),
    getPinnedFacts: vi.fn().mockResolvedValue(null),
    updatePinnedFacts: vi.fn(),
    regenerateEpisodic: vi.fn().mockResolvedValue(null),
    clearEpisodic: vi.fn().mockResolvedValue({ deleted: false })
  } as unknown as Window['fieldOps']

  Object.defineProperty(window, 'fieldOps', {
    configurable: true,
    writable: true,
    value: fieldOps
  })

  return fieldOps
}

describe('FieldContextDebug managed context tabs', () => {
  let fieldOps: Window['fieldOps']

  beforeEach(() => {
    fieldOps = installFieldOpsMock()
  })

  it('loads xuanpu-agent context packages and episode blocks using the fallback Hive session id', async () => {
    render(
      <FieldContextDebug
        sessionId="runtime-session"
        fallbackSessionIds={['hive-session']}
        worktreeId="worktree-1"
      />
    )

    fireEvent.click(screen.getByText('XFP Inspector'))

    await waitFor(() => {
      expect(fieldOps.listContextPackages).toHaveBeenCalledWith({
        worktreeId: 'worktree-1',
        sessionId: 'runtime-session',
        runtimeId: 'xuanpu-agent',
        includeRenderedMarkdown: true,
        limit: 5
      })
      expect(fieldOps.listContextPackages).toHaveBeenCalledWith({
        worktreeId: 'worktree-1',
        sessionId: 'hive-session',
        runtimeId: 'xuanpu-agent',
        includeRenderedMarkdown: true,
        limit: 5
      })
    })

    fireEvent.click(screen.getByText('Managed Context'))
    expect(await screen.findByText('Xuanpu Agent Context Anchor')).toBeInTheDocument()
    expect(screen.getByText(/Recent Visible Turns/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('Episode Blocks'))
    expect(await screen.findByText('Frozen Conversation Turns')).toBeInTheDocument()
    expect(screen.getByText(/keep using pnpm/)).toBeInTheDocument()
  })
})
