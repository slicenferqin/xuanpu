import { beforeEach, describe, expect, it } from 'vitest'
import {
  getSessionViewState,
  setSessionViewState,
  updateSessionViewState,
  resetSessionViewRegistryForTests
} from '../../src/renderer/src/lib/session-view-registry'

describe('session-view-registry', () => {
  beforeEach(() => {
    resetSessionViewRegistryForTests()
    window.sessionStorage.clear()
  })

  it('returns the default anchor state for unseen sessions', () => {
    expect(getSessionViewState('session-a')).toEqual({
      scrollTop: 0,
      stickyBottom: true,
      manualScrollLocked: false,
      lastSeenVersion: 0
    })
  })

  it('merges partial updates and persists them to sessionStorage', () => {
    setSessionViewState('session-a', {
      scrollTop: 128,
      stickyBottom: false,
      manualScrollLocked: true,
      lastSeenVersion: 5
    })

    updateSessionViewState('session-a', (current) => ({
      ...current,
      scrollTop: 256
    }))

    expect(getSessionViewState('session-a')).toEqual({
      scrollTop: 256,
      stickyBottom: false,
      manualScrollLocked: true,
      lastSeenVersion: 5
    })

    const persisted = window.sessionStorage.getItem('xuanpu:session-view-registry')
    expect(persisted).not.toBeNull()
    expect(JSON.parse(persisted ?? '{}')).toMatchObject({
      'session-a': {
        scrollTop: 256,
        stickyBottom: false,
        manualScrollLocked: true,
        lastSeenVersion: 5
      }
    })
  })

  it('clamps lastSeenVersion when the mirror version rewinds', () => {
    setSessionViewState('session-a', {
      stickyBottom: false,
      manualScrollLocked: true,
      lastSeenVersion: 9
    })

    expect(getSessionViewState('session-a', 3)).toEqual({
      scrollTop: 0,
      stickyBottom: false,
      manualScrollLocked: true,
      lastSeenVersion: 3
    })
  })
})
