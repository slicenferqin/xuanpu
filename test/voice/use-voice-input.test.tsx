import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  VoiceErrorEvent,
  VoiceRuntimeProgress,
  VoiceTranscriptEvent
} from '../../src/shared/types/voice'

const audioCaptureMock = vi.hoisted(() => ({
  startVoiceAudioCapture: vi.fn()
}))

vi.mock('@/lib/voice/audio-capture', () => ({
  startVoiceAudioCapture: audioCaptureMock.startVoiceAudioCapture
}))

vi.mock('@/lib/toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn()
  }
}))

import { useVoiceInput } from '../../src/renderer/src/hooks/useVoiceInput'

describe('useVoiceInput', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    audioCaptureMock.startVoiceAudioCapture.mockReset()
    audioCaptureMock.startVoiceAudioCapture.mockImplementation(async () => ({
      stop: vi.fn()
    }))

    let connectCount = 0
    Object.defineProperty(window, 'voiceOps', {
      configurable: true,
      writable: true,
      value: {
        ensureRuntime: vi.fn().mockResolvedValue({
          provider: 'managed',
          status: 'ready',
          wsUrl: 'ws://127.0.0.1:10095'
        }),
        detectRuntime: vi.fn(),
        getMicrophonePermissionStatus: vi.fn().mockResolvedValue('granted'),
        requestMicrophonePermission: vi.fn(),
        connectTranscription: vi.fn().mockImplementation(async () => {
          connectCount += 1
          return { sessionId: `session-${connectCount}` }
        }),
        finishUtterance: vi.fn().mockResolvedValue(undefined),
        disconnectTranscription: vi.fn().mockResolvedValue(undefined),
        sendAudioChunk: vi.fn().mockResolvedValue(undefined),
        onRuntimeProgress: vi.fn((_handler: (event: VoiceRuntimeProgress) => void) => vi.fn()),
        onTranscript: vi.fn((_handler: (event: VoiceTranscriptEvent) => void) => vi.fn()),
        onVoiceError: vi.fn((_handler: (event: VoiceErrorEvent) => void) => vi.fn())
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('disconnects the stopped session even when a new session starts before delayed cleanup', async () => {
    const { result, unmount } = renderHook(() => useVoiceInput(vi.fn()))

    await act(async () => {
      await result.current.start()
    })
    expect(result.current.state).toBe('recording')

    await act(async () => {
      await result.current.stop()
    })
    expect(result.current.state).toBe('idle')

    await act(async () => {
      await result.current.start()
    })
    expect(result.current.state).toBe('recording')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(window.voiceOps.disconnectTranscription).toHaveBeenCalledWith('session-1')
    expect(window.voiceOps.disconnectTranscription).not.toHaveBeenCalledWith('session-2')

    unmount()
  })
})
