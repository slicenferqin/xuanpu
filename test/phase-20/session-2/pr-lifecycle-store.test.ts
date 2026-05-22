import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useGitStore } from '../../../src/renderer/src/stores/useGitStore'

// Mock useWorktreeStore (required by useGitStore internals)
vi.mock('../../../src/renderer/src/stores/useWorktreeStore', () => ({
  useWorktreeStore: {
    getState: vi.fn(() => ({
      worktreesByProject: new Map()
    }))
  }
}))

describe('Session 2: PR Lifecycle Store State', () => {
  beforeEach(() => {
    useGitStore.setState({
      prCreation: new Map(),
      attachedPR: new Map()
    })
  })

  test('PR lifecycle maps start empty', () => {
    const state = useGitStore.getState()
    expect(state.prCreation).toBeInstanceOf(Map)
    expect(state.attachedPR).toBeInstanceOf(Map)
    expect(state.prCreation.size).toBe(0)
    expect(state.attachedPR.size).toBe(0)
  })

  test('setPrCreation adds an active PR creation entry', () => {
    useGitStore.getState().setPrCreation('wt-1', {
      creating: true,
      sessionId: 'session-123'
    })

    const creation = useGitStore.getState().prCreation.get('wt-1')
    expect(creation).toEqual({
      creating: true,
      sessionId: 'session-123'
    })
  })

  test('setPrCreation updates and clears an existing entry', () => {
    useGitStore.getState().setPrCreation('wt-1', {
      creating: true,
      sessionId: 'session-1'
    })
    useGitStore.getState().setPrCreation('wt-1', {
      creating: true,
      sessionId: 'session-2'
    })

    expect(useGitStore.getState().prCreation.get('wt-1')?.sessionId).toBe('session-2')

    useGitStore.getState().setPrCreation('wt-1', null)
    expect(useGitStore.getState().prCreation.get('wt-1')).toBeUndefined()
  })

  test('setAttachedPR tracks a persisted PR attachment', () => {
    useGitStore.getState().setAttachedPR('wt-1', {
      number: 42,
      url: 'https://github.com/org/repo/pull/42'
    })

    expect(useGitStore.getState().attachedPR.get('wt-1')).toEqual({
      number: 42,
      url: 'https://github.com/org/repo/pull/42'
    })
  })

  test('different worktrees have independent PR lifecycle state', () => {
    useGitStore.getState().setPrCreation('wt-1', {
      creating: true,
      sessionId: 'session-1'
    })
    useGitStore.getState().setAttachedPR('wt-2', {
      number: 2,
      url: 'https://github.com/org/repo/pull/2'
    })

    expect(useGitStore.getState().prCreation.get('wt-1')?.sessionId).toBe('session-1')
    expect(useGitStore.getState().attachedPR.get('wt-1')).toBeUndefined()
    expect(useGitStore.getState().prCreation.get('wt-2')).toBeUndefined()
    expect(useGitStore.getState().attachedPR.get('wt-2')?.number).toBe(2)
  })

  test('setAttachedPR clears an attachment without affecting creation state', () => {
    useGitStore.getState().setPrCreation('wt-1', {
      creating: true,
      sessionId: 'session-1'
    })
    useGitStore.getState().setAttachedPR('wt-1', {
      number: 42,
      url: 'https://github.com/org/repo/pull/42'
    })

    useGitStore.getState().setAttachedPR('wt-1', null)

    expect(useGitStore.getState().attachedPR.get('wt-1')).toBeUndefined()
    expect(useGitStore.getState().prCreation.get('wt-1')?.creating).toBe(true)
  })

  test('PR lifecycle state is in-memory only', () => {
    const freshState = useGitStore.getState()
    expect(freshState.prCreation.size).toBe(0)
    expect(freshState.attachedPR.size).toBe(0)
  })
})
