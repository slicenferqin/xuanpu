import { describe, test, expect, beforeEach, vi } from 'vitest'
import { PR_URL_PATTERN } from '../../../src/renderer/src/hooks/usePRDetection'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

// Mock useWorktreeStore (required by useGitStore internals)
vi.mock('../../../src/renderer/src/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map()
    }))
  }
}))

function attachDetectedPr(worktreeId: string, text: string): void {
  const creation = useGitStore.getState().prCreation.get(worktreeId)
  const match = text.match(PR_URL_PATTERN)
  if (!creation?.creating || !match) return

  useGitStore.getState().setAttachedPR(worktreeId, {
    number: parseInt(match[1], 10),
    url: match[0]
  })
  useGitStore.getState().setPrCreation(worktreeId, null)
}

describe('Session 4: PR Detection Hook', () => {
  beforeEach(() => {
    useGitStore.setState({
      prCreation: new Map(),
      attachedPR: new Map()
    })
  })

  describe('PR_URL_PATTERN', () => {
    test('matches standard GitHub PR URLs', () => {
      const match = 'https://github.com/myorg/myrepo/pull/42'.match(PR_URL_PATTERN)
      expect(match).not.toBeNull()
      expect(match![1]).toBe('42')
    })

    test('extracts number from URL embedded in text', () => {
      const text = 'Created PR: https://github.com/org/repo/pull/123 successfully'
      const match = text.match(PR_URL_PATTERN)
      expect(match).not.toBeNull()
      expect(match![1]).toBe('123')
    })

    test('does not match non-GitHub URLs', () => {
      expect('https://gitlab.com/org/repo/pull/42'.match(PR_URL_PATTERN)).toBeNull()
    })

    test('does not match GitHub URLs without /pull/ path', () => {
      expect('https://github.com/org/repo/issues/42'.match(PR_URL_PATTERN)).toBeNull()
    })

    test('matches PR URL with large number', () => {
      const match = 'https://github.com/org/repo/pull/99999'.match(PR_URL_PATTERN)
      expect(match).not.toBeNull()
      expect(match![1]).toBe('99999')
    })

    test('matches PR URL in markdown link', () => {
      const text = '[PR #42](https://github.com/org/repo/pull/42)'
      const match = text.match(PR_URL_PATTERN)
      expect(match).not.toBeNull()
      expect(match![1]).toBe('42')
    })

    test('matches PR URL with complex org/repo names', () => {
      const match = 'https://github.com/my-org/my-repo.js/pull/7'.match(PR_URL_PATTERN)
      expect(match).not.toBeNull()
      expect(match![1]).toBe('7')
    })

    test('does not match partial URLs', () => {
      expect('github.com/org/repo/pull/42'.match(PR_URL_PATTERN)).toBeNull()
    })
  })

  describe('PR detection lifecycle side effects', () => {
    test('moves from creating to attached when a PR URL is detected', () => {
      useGitStore.getState().setPrCreation('wt-1', {
        creating: true,
        sessionId: 'session-1'
      })

      attachDetectedPr('wt-1', 'I created a pull request: https://github.com/org/repo/pull/42')

      expect(useGitStore.getState().prCreation.get('wt-1')).toBeUndefined()
      expect(useGitStore.getState().attachedPR.get('wt-1')).toEqual({
        number: 42,
        url: 'https://github.com/org/repo/pull/42'
      })
    })

    test('does not attach when PR creation is not active', () => {
      attachDetectedPr('wt-1', 'Created PR: https://github.com/org/repo/pull/99')

      expect(useGitStore.getState().prCreation.get('wt-1')).toBeUndefined()
      expect(useGitStore.getState().attachedPR.get('wt-1')).toBeUndefined()
    })

    test('does not attach when no PR URL is found in text', () => {
      useGitStore.getState().setPrCreation('wt-1', {
        creating: true,
        sessionId: 'session-1'
      })

      attachDetectedPr('wt-1', 'I am working on creating the pull request now...')

      expect(useGitStore.getState().prCreation.get('wt-1')?.creating).toBe(true)
      expect(useGitStore.getState().attachedPR.get('wt-1')).toBeUndefined()
    })

    test('detects PR URL in tool output from gh pr create', () => {
      useGitStore.getState().setPrCreation('wt-1', {
        creating: true,
        sessionId: 'session-1'
      })

      attachDetectedPr(
        'wt-1',
        'Creating pull request for feature-branch into main\nhttps://github.com/org/repo/pull/55'
      )

      expect(useGitStore.getState().attachedPR.get('wt-1')).toEqual({
        number: 55,
        url: 'https://github.com/org/repo/pull/55'
      })
    })

    test('detects PR URL across accumulated streaming deltas', () => {
      useGitStore.getState().setPrCreation('wt-1', {
        creating: true,
        sessionId: 'session-1'
      })

      let accumulated = ''
      for (const delta of [
        'I created the PR at ',
        'https://github.com/',
        'org/repo/pull/',
        '123',
        ' successfully!'
      ]) {
        accumulated += delta
        attachDetectedPr('wt-1', accumulated)
      }

      expect(useGitStore.getState().attachedPR.get('wt-1')).toEqual({
        number: 123,
        url: 'https://github.com/org/repo/pull/123'
      })
    })
  })
})
