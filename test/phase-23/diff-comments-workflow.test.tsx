import { render, waitFor } from '@testing-library/react'
import { describe, expect, test, beforeEach, vi } from 'vitest'
import { DiffCommentsViewer } from '@/components/diff-comments/DiffCommentsViewer'
import { useDiffCommentStore } from '@/stores/useDiffCommentStore'
import type { DiffComment } from '@shared/types/git'

const baseComment: DiffComment = {
  id: 'comment-1',
  worktreeId: 'wt-1',
  filePath: 'src/App.tsx',
  side: 'modified',
  lineNumber: 12,
  compareBranch: null,
  staged: false,
  body: 'Check this branch condition.',
  resolved: false,
  createdAt: 1000,
  updatedAt: 1000
}

function installDbMock(overrides: Partial<typeof window.db.diffComment> = {}): void {
  const diffComment = {
    list: vi.fn().mockResolvedValue([baseComment]),
    create: vi.fn().mockResolvedValue({ ...baseComment, id: 'comment-2', body: 'New note' }),
    update: vi.fn().mockResolvedValue({ ...baseComment, body: 'Updated note' }),
    delete: vi.fn().mockResolvedValue(true),
    ...overrides
  }

  Object.defineProperty(window, 'db', {
    writable: true,
    configurable: true,
    value: { ...(window.db ?? {}), diffComment }
  })
}

describe('diff comments workflow', () => {
  beforeEach(() => {
    installDbMock()
    useDiffCommentStore.setState({
      commentsByFile: new Map(),
      worktreeComments: new Map(),
      loadingKeys: new Set(),
      errorByKey: new Map(),
      attachedComments: []
    })
  })

  test('loads and mutates file-scoped diff comments through the preload API', async () => {
    await useDiffCommentStore.getState().loadComments('wt-1', 'src/App.tsx')

    expect(window.db.diffComment.list).toHaveBeenCalledWith('wt-1', {
      filePath: 'src/App.tsx',
      staged: false,
      compareBranch: null
    })
    expect(useDiffCommentStore.getState().getFileComments('wt-1', 'src/App.tsx')).toEqual([
      baseComment
    ])

    await useDiffCommentStore.getState().createComment({
      worktreeId: 'wt-1',
      filePath: 'src/App.tsx',
      side: 'modified',
      lineNumber: 14,
      compareBranch: null,
      staged: false,
      body: 'New note'
    })

    expect(window.db.diffComment.create).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      filePath: 'src/App.tsx',
      side: 'modified',
      lineNumber: 14,
      compareBranch: null,
      staged: false,
      body: 'New note'
    })
    expect(useDiffCommentStore.getState().getFileComments('wt-1', 'src/App.tsx')).toHaveLength(2)

    useDiffCommentStore.getState().attachComment(baseComment)
    expect(useDiffCommentStore.getState().attachedComments).toHaveLength(1)

    await useDiffCommentStore.getState().updateComment('comment-1', { body: 'Updated note' })
    expect(useDiffCommentStore.getState().attachedComments[0].body).toBe('Updated note')

    await useDiffCommentStore.getState().deleteComment('comment-1')
    expect(useDiffCommentStore.getState().attachedComments).toHaveLength(0)
  })

  test('keeps comments isolated by staged state and compare branch', async () => {
    const stagedComment: DiffComment = { ...baseComment, id: 'comment-staged', staged: true }
    const branchComment: DiffComment = {
      ...baseComment,
      id: 'comment-branch',
      compareBranch: 'main'
    }
    const list = vi.fn().mockImplementation(
      (
        _worktreeId: string,
        options?: {
          filePath?: string
          staged?: boolean
          compareBranch?: string | null
        }
      ) => {
        if (options?.staged) return Promise.resolve([stagedComment])
        if (options?.compareBranch === 'main') return Promise.resolve([branchComment])
        return Promise.resolve([baseComment])
      }
    )
    installDbMock({ list })

    await useDiffCommentStore.getState().loadComments('wt-1', 'src/App.tsx', {
      staged: false,
      compareBranch: null
    })
    await useDiffCommentStore.getState().loadComments('wt-1', 'src/App.tsx', {
      staged: true,
      compareBranch: null
    })
    await useDiffCommentStore.getState().loadComments('wt-1', 'src/App.tsx', {
      staged: false,
      compareBranch: 'main'
    })

    expect(
      useDiffCommentStore.getState().getFileComments('wt-1', 'src/App.tsx', {
        staged: false,
        compareBranch: null
      })
    ).toEqual([baseComment])
    expect(
      useDiffCommentStore.getState().getFileComments('wt-1', 'src/App.tsx', {
        staged: true,
        compareBranch: null
      })
    ).toEqual([stagedComment])
    expect(
      useDiffCommentStore.getState().getFileComments('wt-1', 'src/App.tsx', {
        staged: false,
        compareBranch: 'main'
      })
    ).toEqual([branchComment])
  })

  test('renders an empty worktree comment list without unstable selector churn', async () => {
    const list = vi.fn().mockResolvedValue([])
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    installDbMock({ list })

    try {
      render(<DiffCommentsViewer worktreeId="wt-empty" worktreePath="/tmp/repo" />)

      await waitFor(() => expect(list).toHaveBeenCalledWith('wt-empty'))

      const errors = consoleError.mock.calls.map((args) => args.join(' ')).join('\n')
      expect(errors).not.toContain('Maximum update depth exceeded')
      expect(errors).not.toContain('getSnapshot should be cached')
    } finally {
      consoleError.mockRestore()
    }
  })

  test('Monaco and SessionView are wired to create and send diff comment context', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const monacoSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/diff/MonacoDiffView.tsx'),
      'utf-8'
    )
    const sessionSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/sessions/SessionView.tsx'),
      'utf-8'
    )
    const sessionShellSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/session-hq/SessionShell.tsx'),
      'utf-8'
    )
    const sidebarSource = fs.readFileSync(
      path.resolve(__dirname, '../../src/renderer/src/components/file-tree/FileSidebar.tsx'),
      'utf-8'
    )

    expect(monacoSource).toContain('<DiffCommentGutter')
    expect(monacoSource).toContain('onAddComment={canUseDiffComments')
    expect(sessionSource).toContain('<diff-comment file=')
    expect(sessionSource).toContain('<DiffCommentAttachments />')
    expect(sessionShellSource).toContain('buildLocalDiffCommentContext')
    expect(sessionShellSource).toContain('const contentToSend = diffCommentContext + content')
    expect(sessionShellSource).toContain('<DiffCommentAttachments />')
    expect(sessionShellSource).toContain('contextAttachmentSlot={<DiffCommentAttachments />}')
    expect(sidebarSource).toContain('<DiffCommentsViewer')
  })
})
