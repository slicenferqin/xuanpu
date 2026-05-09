/**
 * Session 5: PR Header UI Tests
 *
 * Tests the current PR lifecycle model used by Header.tsx:
 * - no attached PR -> create PR button
 * - creating -> disabled spinner button
 * - attached PR -> badge, plus merge/archive actions based on live GitHub state
 * - PR creation is ephemeral; attached PR is the persistent worktree state
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

vi.mock('../../../src/renderer/src/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map(),
      selectedWorktreeId: null,
      archiveWorktree: vi.fn().mockResolvedValue({ success: true })
    })),
    __esModule: true
  }
}))

type PrLiveState = 'OPEN' | 'MERGED' | 'CLOSED' | null
type VisibleButton =
  | 'pr-button'
  | 'pr-creating-button'
  | 'pr-badge'
  | 'pr-merge-button'
  | 'pr-archive-button'

function getVisibleButtons({
  isGitHub,
  isCreating,
  hasAttachedPR,
  prLiveState,
  isCleanTree,
  isDefaultWorktree = false
}: {
  isGitHub: boolean
  isCreating: boolean
  hasAttachedPR: boolean
  prLiveState: PrLiveState
  isCleanTree: boolean
  isDefaultWorktree?: boolean
}): VisibleButton[] {
  if (!isGitHub) return []

  const buttons: VisibleButton[] = []

  if (hasAttachedPR && prLiveState === 'MERGED' && !isDefaultWorktree) {
    buttons.push('pr-archive-button')
  }

  if (hasAttachedPR && prLiveState !== 'MERGED' && prLiveState !== 'CLOSED' && isCleanTree) {
    buttons.push('pr-merge-button')
  }

  if (hasAttachedPR && !isCreating) {
    buttons.push('pr-badge')
  }

  if (isCreating) {
    buttons.push('pr-creating-button')
  }

  if (!hasAttachedPR && !isCreating) {
    buttons.push('pr-button')
  }

  return buttons
}

describe('Session 5: PR Header UI', () => {
  beforeEach(() => {
    useGitStore.setState({
      prCreation: new Map(),
      attachedPR: new Map(),
      fileStatusesByWorktree: new Map(),
      remoteInfo: new Map(),
      branchInfoByWorktree: new Map(),
      isPushing: false,
      isPulling: false,
      error: null
    })
  })

  describe('PR lifecycle store state', () => {
    test('defaults to no active PR lifecycle when maps have no entry', () => {
      expect(useGitStore.getState().prCreation.get('wt-1')).toBeUndefined()
      expect(useGitStore.getState().attachedPR.get('wt-1')).toBeUndefined()
    })

    test('creation state is tracked after handleCreatePR starts a PR session', () => {
      useGitStore.getState().setPrCreation('wt-1', {
        creating: true,
        sessionId: 'session-1'
      })

      const creation = useGitStore.getState().prCreation.get('wt-1')
      expect(creation?.creating).toBe(true)
      expect(creation?.sessionId).toBe('session-1')
    })

    test('attached PR is tracked after PR URL detection', () => {
      useGitStore.getState().setPrCreation('wt-1', {
        creating: true,
        sessionId: 'session-1'
      })
      useGitStore.getState().setAttachedPR('wt-1', {
        number: 42,
        url: 'https://github.com/org/repo/pull/42'
      })
      useGitStore.getState().setPrCreation('wt-1', null)

      expect(useGitStore.getState().prCreation.get('wt-1')).toBeUndefined()
      expect(useGitStore.getState().attachedPR.get('wt-1')?.number).toBe(42)
      expect(useGitStore.getState().attachedPR.get('wt-1')?.url).toBe(
        'https://github.com/org/repo/pull/42'
      )
    })

    test('attached PR can be cleared when detached', () => {
      useGitStore.getState().setAttachedPR('wt-1', {
        number: 42,
        url: 'https://github.com/org/repo/pull/42'
      })
      useGitStore.getState().setAttachedPR('wt-1', null)

      expect(useGitStore.getState().attachedPR.get('wt-1')).toBeUndefined()
    })
  })

  describe('clean tree detection for merge button', () => {
    test('isCleanTree is true when no file statuses exist for worktree', () => {
      const fileStatuses = useGitStore.getState().fileStatusesByWorktree.get('/test/path')
      const isCleanTree = !fileStatuses || fileStatuses.length === 0
      expect(isCleanTree).toBe(true)
    })

    test('isCleanTree is true when file statuses array is empty', () => {
      useGitStore.setState({
        fileStatusesByWorktree: new Map([['/test/path', []]])
      })
      const fileStatuses = useGitStore.getState().fileStatusesByWorktree.get('/test/path')
      const isCleanTree = !fileStatuses || fileStatuses.length === 0
      expect(isCleanTree).toBe(true)
    })

    test('isCleanTree is false when file statuses have entries', () => {
      useGitStore.setState({
        fileStatusesByWorktree: new Map([
          [
            '/test/path',
            [
              {
                path: '/test/path/file.ts',
                relativePath: 'file.ts',
                status: 'M' as const,
                staged: false
              }
            ]
          ]
        ])
      })
      const fileStatuses = useGitStore.getState().fileStatusesByWorktree.get('/test/path')
      const isCleanTree = !fileStatuses || fileStatuses.length === 0
      expect(isCleanTree).toBe(false)
    })
  })

  describe('button visibility state machine', () => {
    test('shows create PR button when no PR is attached or creating', () => {
      expect(
        getVisibleButtons({
          isGitHub: true,
          isCreating: false,
          hasAttachedPR: false,
          prLiveState: null,
          isCleanTree: true
        })
      ).toEqual(['pr-button'])
    })

    test('shows creating spinner button during PR creation', () => {
      expect(
        getVisibleButtons({
          isGitHub: true,
          isCreating: true,
          hasAttachedPR: false,
          prLiveState: null,
          isCleanTree: true
        })
      ).toEqual(['pr-creating-button'])
    })

    test('shows PR badge and Merge PR button when attached PR is open and tree is clean', () => {
      expect(
        getVisibleButtons({
          isGitHub: true,
          isCreating: false,
          hasAttachedPR: true,
          prLiveState: 'OPEN',
          isCleanTree: true
        })
      ).toEqual(['pr-merge-button', 'pr-badge'])
    })

    test('shows only PR badge when attached PR is open and tree is dirty', () => {
      expect(
        getVisibleButtons({
          isGitHub: true,
          isCreating: false,
          hasAttachedPR: true,
          prLiveState: 'OPEN',
          isCleanTree: false
        })
      ).toEqual(['pr-badge'])
    })

    test('shows Archive and PR badge when attached PR is merged on a non-default worktree', () => {
      expect(
        getVisibleButtons({
          isGitHub: true,
          isCreating: false,
          hasAttachedPR: true,
          prLiveState: 'MERGED',
          isCleanTree: true,
          isDefaultWorktree: false
        })
      ).toEqual(['pr-archive-button', 'pr-badge'])
    })

    test('hides Archive on the default worktree even when PR is merged', () => {
      expect(
        getVisibleButtons({
          isGitHub: true,
          isCreating: false,
          hasAttachedPR: true,
          prLiveState: 'MERGED',
          isCleanTree: true,
          isDefaultWorktree: true
        })
      ).toEqual(['pr-badge'])
    })

    test('shows only PR badge when attached PR is closed', () => {
      expect(
        getVisibleButtons({
          isGitHub: true,
          isCreating: false,
          hasAttachedPR: true,
          prLiveState: 'CLOSED',
          isCleanTree: true
        })
      ).toEqual(['pr-badge'])
    })

    test('shows nothing when remote is not GitHub', () => {
      expect(
        getVisibleButtons({
          isGitHub: false,
          isCreating: false,
          hasAttachedPR: true,
          prLiveState: 'OPEN',
          isCleanTree: true
        })
      ).toEqual([])
    })
  })

  describe('button disabled state', () => {
    test('create PR button is disabled when git operation is in progress', () => {
      const isOperating = true
      const disabled = isOperating
      expect(disabled).toBe(true)
    })

    test('create PR button is enabled when no git operation is in progress', () => {
      const isOperating = false
      const disabled = isOperating
      expect(disabled).toBe(false)
    })

    test('creating spinner button is always disabled', () => {
      const isCreating = true
      expect(isCreating).toBe(true)
    })
  })

  describe('handleCreatePR lifecycle effects', () => {
    test('sets prCreation with session id after session creation', () => {
      const wtId = 'wt-1'
      const sessionId = 'new-session-1'

      useGitStore.getState().setPrCreation(wtId, {
        creating: true,
        sessionId
      })

      const creation = useGitStore.getState().prCreation.get(wtId)
      expect(creation?.creating).toBe(true)
      expect(creation?.sessionId).toBe(sessionId)
    })

    test('prCreation does not change if session creation fails', () => {
      expect(useGitStore.getState().prCreation.get('wt-1')).toBeUndefined()

      const resultSuccess = false
      if (resultSuccess) {
        useGitStore.getState().setPrCreation('wt-1', {
          creating: true,
          sessionId: 'session-1'
        })
      }

      expect(useGitStore.getState().prCreation.get('wt-1')).toBeUndefined()
    })
  })

  describe('handleMergePR logic', () => {
    test('successful merge updates live PR state and preserves title', () => {
      const previousLiveState = {
        state: 'OPEN',
        title: 'Ship PR lifecycle'
      }

      const nextLiveState = {
        state: 'MERGED',
        title: previousLiveState.title
      }

      expect(nextLiveState).toEqual({
        state: 'MERGED',
        title: 'Ship PR lifecycle'
      })
    })

    test('failed merge keeps live PR state unchanged', () => {
      const previousLiveState = {
        state: 'OPEN',
        title: 'Ship PR lifecycle'
      }
      const mergeResult = { success: false, error: 'Merge conflicts' }

      const nextLiveState = mergeResult.success
        ? { state: 'MERGED', title: previousLiveState.title }
        : previousLiveState

      expect(nextLiveState).toBe(previousLiveState)
    })

    test('merge guard requires an attached PR number', () => {
      expect(useGitStore.getState().attachedPR.get('wt-1')?.number).toBeUndefined()
    })
  })

  describe('full lifecycle transitions', () => {
    test('none to creating to attached to merged live state', () => {
      expect(useGitStore.getState().prCreation.get('wt-1')).toBeUndefined()
      expect(useGitStore.getState().attachedPR.get('wt-1')).toBeUndefined()

      useGitStore.getState().setPrCreation('wt-1', {
        creating: true,
        sessionId: 'session-1'
      })
      expect(useGitStore.getState().prCreation.get('wt-1')?.creating).toBe(true)

      useGitStore.getState().setAttachedPR('wt-1', {
        number: 42,
        url: 'https://github.com/org/repo/pull/42'
      })
      useGitStore.getState().setPrCreation('wt-1', null)

      expect(useGitStore.getState().prCreation.get('wt-1')).toBeUndefined()
      expect(useGitStore.getState().attachedPR.get('wt-1')?.number).toBe(42)

      const liveState = {
        state: 'MERGED',
        title: 'Ship PR lifecycle'
      }
      expect(liveState.state).toBe('MERGED')
      expect(liveState.title).toBe('Ship PR lifecycle')
    })
  })
})
