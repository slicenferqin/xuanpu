import { beforeEach, describe, expect, test, vi } from 'vitest'
import { act } from '@testing-library/react'

const mockDestroy = vi.fn()

Object.defineProperty(window, 'terminalOps', {
  writable: true,
  configurable: true,
  value: {
    create: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    destroy: mockDestroy,
    onData: vi.fn().mockReturnValue(() => {}),
    onExit: vi.fn().mockReturnValue(() => {})
  }
})

import { useTerminalStore } from '../../src/renderer/src/stores/useTerminalStore'

describe('useTerminalStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    act(() => {
      useTerminalStore.setState({ terminals: new Map() })
    })
  })

  describe('createTerminal', () => {
    test('marks a terminal as creating while backend owns PTY creation', async () => {
      const result = await useTerminalStore.getState().createTerminal('term-1', '/tmp/project')

      expect(result).toEqual({ success: true })
      expect(useTerminalStore.getState().terminals.get('term-1')).toEqual({
        status: 'creating'
      })
      expect(window.terminalOps.create).not.toHaveBeenCalled()
      expect(window.terminalOps.onExit).not.toHaveBeenCalled()
    })

    test('does not reset an already running terminal', async () => {
      act(() => {
        useTerminalStore.getState().setTerminalStatus('term-running', 'running')
      })

      const result = await useTerminalStore
        .getState()
        .createTerminal('term-running', '/tmp/project')

      expect(result).toEqual({ success: true })
      expect(useTerminalStore.getState().terminals.get('term-running')).toEqual({
        status: 'running',
        exitCode: undefined
      })
    })
  })

  describe('destroyTerminal', () => {
    test('destroys terminal and removes it from state', async () => {
      await useTerminalStore.getState().createTerminal('term-destroy', '/tmp')
      expect(useTerminalStore.getState().terminals.has('term-destroy')).toBe(true)

      await useTerminalStore.getState().destroyTerminal('term-destroy')

      expect(mockDestroy).toHaveBeenCalledWith('term-destroy')
      expect(useTerminalStore.getState().terminals.has('term-destroy')).toBe(false)
    })

    test('removes terminal state even if destroy IPC throws', async () => {
      mockDestroy.mockRejectedValueOnce(new Error('already dead'))
      await useTerminalStore.getState().createTerminal('term-destroy-err', '/tmp')

      await useTerminalStore.getState().destroyTerminal('term-destroy-err')

      expect(useTerminalStore.getState().terminals.has('term-destroy-err')).toBe(false)
    })
  })

  describe('restartTerminal', () => {
    test('destroys the previous terminal and returns it to creating state', async () => {
      act(() => {
        useTerminalStore.getState().setTerminalStatus('term-restart', 'running')
      })

      const result = await useTerminalStore.getState().restartTerminal('term-restart', '/tmp')

      expect(result).toEqual({ success: true })
      expect(mockDestroy).toHaveBeenCalledWith('term-restart')
      expect(useTerminalStore.getState().terminals.get('term-restart')).toEqual({
        status: 'creating'
      })
    })
  })

  describe('setTerminalStatus', () => {
    test('sets terminal status', () => {
      act(() => {
        useTerminalStore.getState().setTerminalStatus('term-status', 'running')
      })

      expect(useTerminalStore.getState().terminals.get('term-status')).toEqual({
        status: 'running',
        exitCode: undefined
      })
    })

    test('sets terminal status with exit code', () => {
      act(() => {
        useTerminalStore.getState().setTerminalStatus('term-exit-status', 'exited', 1)
      })

      expect(useTerminalStore.getState().terminals.get('term-exit-status')).toEqual({
        status: 'exited',
        exitCode: 1
      })
    })
  })

  describe('getTerminal', () => {
    test('returns terminal info for existing terminal', async () => {
      await useTerminalStore.getState().createTerminal('term-get', '/tmp')

      expect(useTerminalStore.getState().getTerminal('term-get')).toEqual({
        status: 'creating'
      })
    })

    test('returns undefined for non-existent terminal', () => {
      expect(useTerminalStore.getState().getTerminal('nonexistent')).toBeUndefined()
    })
  })

  describe('isTerminalAlive', () => {
    test('returns true only for running terminals', async () => {
      await useTerminalStore.getState().createTerminal('term-alive', '/tmp')
      expect(useTerminalStore.getState().isTerminalAlive('term-alive')).toBe(false)

      act(() => {
        useTerminalStore.getState().setTerminalStatus('term-alive', 'running')
      })

      expect(useTerminalStore.getState().isTerminalAlive('term-alive')).toBe(true)
    })
  })
})
