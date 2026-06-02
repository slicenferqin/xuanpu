import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getScrollAnchorState,
  removeScrollAnchorState,
  setScrollAnchorState,
  updateScrollAnchorState,
  resetScrollAnchorRegistryForTests
} from '../../src/renderer/src/lib/session-scroll-registry'

describe('session-scroll-registry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetScrollAnchorRegistryForTests()
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the default anchor state for unseen sessions', () => {
    expect(getScrollAnchorState('session-a')).toEqual({
      scrollTop: 0,
      stickyBottom: true,
      manualScrollLocked: false,
      lastSeenVersion: 0
    })
  })

  it('merges partial updates and persists them to sessionStorage', () => {
    setScrollAnchorState('session-a', {
      scrollTop: 128,
      stickyBottom: false,
      manualScrollLocked: true,
      lastSeenVersion: 5
    })

    updateScrollAnchorState('session-a', (current) => ({
      ...current,
      scrollTop: 256
    }))

    vi.runAllTimers()

    expect(getScrollAnchorState('session-a')).toEqual({
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

  it('removes deleted sessions from the registry and persisted storage', () => {
    setScrollAnchorState('session-a', {
      scrollTop: 128,
      stickyBottom: false,
      manualScrollLocked: true,
      lastSeenVersion: 5
    })
    setScrollAnchorState('session-b', {
      scrollTop: 64,
      stickyBottom: true,
      manualScrollLocked: false,
      lastSeenVersion: 2
    })
    vi.runAllTimers()

    removeScrollAnchorState('session-a')
    vi.runAllTimers()

    expect(JSON.parse(window.sessionStorage.getItem('xuanpu:session-view-registry') ?? '{}')).toEqual({
      'session-b': {
        scrollTop: 64,
        stickyBottom: true,
        manualScrollLocked: false,
        lastSeenVersion: 2
      }
    })
  })

  it('debounces storage persistence across rapid updates', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')

    setScrollAnchorState('session-a', {
      scrollTop: 10,
      stickyBottom: false,
      manualScrollLocked: true,
      lastSeenVersion: 1
    })
    updateScrollAnchorState('session-a', (current) => ({
      ...current,
      scrollTop: 20
    }))
    updateScrollAnchorState('session-a', (current) => ({
      ...current,
      scrollTop: 30
    }))

    expect(setItemSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(249)
    expect(setItemSpy).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(setItemSpy).toHaveBeenCalledTimes(1)
    expect(JSON.parse(window.sessionStorage.getItem('xuanpu:session-view-registry') ?? '{}')).toMatchObject({
      'session-a': {
        scrollTop: 30,
        stickyBottom: false,
        manualScrollLocked: true,
        lastSeenVersion: 1
      }
    })

    setItemSpy.mockRestore()
  })

  it('clamps lastSeenVersion when the mirror version rewinds', () => {
    setScrollAnchorState('session-a', {
      stickyBottom: false,
      manualScrollLocked: true,
      lastSeenVersion: 9
    })
    vi.runAllTimers()

    expect(getScrollAnchorState('session-a', 3)).toEqual({
      scrollTop: 0,
      stickyBottom: false,
      manualScrollLocked: true,
      lastSeenVersion: 3
    })
  })
})
