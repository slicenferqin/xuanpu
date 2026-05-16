import { useCallback, useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { toast } from '@/lib/toast'
import { startVoiceAudioCapture, type VoiceAudioCapture } from '@/lib/voice/audio-capture'
import type { VoiceRuntimeProgress, VoiceTranscriptEvent } from '@shared/types/voice'

export type VoiceInputState = 'idle' | 'preparing' | 'recording' | 'stopping' | 'error'

const VOICE_START_CANCELLED = 'VOICE_START_CANCELLED'

export interface UseVoiceInputResult {
  state: VoiceInputState
  partialText: string
  progress: VoiceRuntimeProgress | null
  start: () => Promise<void>
  stop: () => Promise<void>
}

export function useVoiceInput(onFinalText: (text: string) => void): UseVoiceInputResult {
  const voiceInput = useSettingsStore((s) => s.voiceInput)
  const [state, setState] = useState<VoiceInputState>('idle')
  const [partialText, setPartialText] = useState('')
  const [progress, setProgress] = useState<VoiceRuntimeProgress | null>(null)
  const sessionRef = useRef<string | null>(null)
  const stateRef = useRef<VoiceInputState>('idle')
  const captureRef = useRef<VoiceAudioCapture | null>(null)
  const onFinalTextRef = useRef(onFinalText)
  const sentStatsRef = useRef({ chunkCount: 0, byteCount: 0 })
  const stopRequestedRef = useRef(false)

  const setVoiceState = useCallback((next: VoiceInputState) => {
    stateRef.current = next
    setState(next)
  }, [])

  const cleanupActiveRecording = useCallback(async () => {
    captureRef.current?.stop()
    captureRef.current = null
    const sessionId = sessionRef.current
    sessionRef.current = null
    if (sessionId) {
      await window.voiceOps.disconnectTranscription(sessionId).catch(() => {})
    }
  }, [])

  useEffect(() => {
    onFinalTextRef.current = onFinalText
  }, [onFinalText])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    const unsubscribeProgress = window.voiceOps.onRuntimeProgress((next) => {
      setProgress(next)
    })
    const unsubscribeTranscript = window.voiceOps.onTranscript((event: VoiceTranscriptEvent) => {
      if (event.sessionId !== sessionRef.current) return
      if (event.type === 'partial') {
        setPartialText(event.text)
        return
      }
      setPartialText('')
      onFinalTextRef.current(event.text)
    })
    const unsubscribeError = window.voiceOps.onVoiceError((event) => {
      if (event.sessionId && event.sessionId !== sessionRef.current) return
      void cleanupActiveRecording()
      setVoiceState('error')
      toast.error(event.message)
      setTimeout(() => {
        if (stateRef.current === 'error') setVoiceState('idle')
      }, 800)
    })

    return () => {
      unsubscribeProgress()
      unsubscribeTranscript()
      unsubscribeError()
    }
  }, [cleanupActiveRecording, setVoiceState])

  useEffect(() => {
    return () => {
      void cleanupActiveRecording()
    }
  }, [cleanupActiveRecording])

  const throwIfStopRequested = useCallback(() => {
    if (stopRequestedRef.current) {
      throw new Error(VOICE_START_CANCELLED)
    }
  }, [])

  const stop = useCallback(async () => {
    const currentState = stateRef.current
    if (currentState !== 'preparing' && currentState !== 'recording' && currentState !== 'error') {
      return
    }
    stopRequestedRef.current = true
    setVoiceState('stopping')
    captureRef.current?.stop()
    captureRef.current = null
    console.debug('[VoiceInput] capture stopped', sentStatsRef.current)

    const sessionId = sessionRef.current
    if (sessionId) {
      await window.voiceOps.finishUtterance(sessionId).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error))
      })
      setTimeout(() => {
        if (sessionRef.current === sessionId) {
          window.voiceOps.disconnectTranscription(sessionId).catch(() => {})
          sessionRef.current = null
        }
      }, 3000)
    }

    setVoiceState('idle')
  }, [setVoiceState])

  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return

    setVoiceState('preparing')
    setPartialText('')
    stopRequestedRef.current = false

    try {
      const runtime = voiceInput.autoInstallRuntime
        ? await window.voiceOps.ensureRuntime(voiceInput)
        : await window.voiceOps.detectRuntime(voiceInput)
      throwIfStopRequested()
      if (runtime.status !== 'ready') {
        const message = runtime.error || runtime.message || 'FunASR runtime is not ready'
        if (runtime.status === 'error') throw new Error(message)
        setVoiceState('idle')
        toast.warning(message, { duration: 6000 })
        return
      }

      const permission = await window.voiceOps.getMicrophonePermissionStatus()
      throwIfStopRequested()
      if (permission !== 'granted' && permission !== 'unknown') {
        const nextPermission = await window.voiceOps.requestMicrophonePermission()
        throwIfStopRequested()
        if (nextPermission !== 'granted' && nextPermission !== 'unknown') {
          throw new Error('Microphone permission was not granted')
        }
      }

      const session = await window.voiceOps.connectTranscription({
        wsUrl: runtime.wsUrl || voiceInput.funasr.wsUrl,
        mode: voiceInput.funasr.mode,
        sampleRate: voiceInput.funasr.sampleRate,
        chunkSize: voiceInput.funasr.chunkSize,
        useItn: voiceInput.funasr.useItn,
        hotwords: voiceInput.funasr.hotwords
      })
      sessionRef.current = session.sessionId
      sentStatsRef.current = { chunkCount: 0, byteCount: 0 }
      throwIfStopRequested()

      captureRef.current = await startVoiceAudioCapture(
        (chunk) => {
          const sessionId = sessionRef.current
          if (!sessionId) return
          sentStatsRef.current.chunkCount += 1
          sentStatsRef.current.byteCount += chunk.byteLength
          if (sentStatsRef.current.chunkCount <= 5 || sentStatsRef.current.chunkCount % 50 === 0) {
            console.debug('[VoiceInput] sending audio chunk', {
              sessionId,
              chunkBytes: chunk.byteLength,
              ...sentStatsRef.current
            })
          }
          window.voiceOps.sendAudioChunk(sessionId, chunk).catch((error) => {
            console.debug('[VoiceInput] failed to send audio chunk', {
              sessionId,
              error: error instanceof Error ? error.message : String(error)
            })
          })
        },
        (event) => {
          console.debug('[VoiceInput] audio capture', event)
        }
      )
      throwIfStopRequested()
      setVoiceState('recording')
    } catch (error) {
      await cleanupActiveRecording()
      if (error instanceof Error && error.message === VOICE_START_CANCELLED) {
        setVoiceState('idle')
        return
      }
      setVoiceState('error')
      toast.error(error instanceof Error ? error.message : String(error))
      setTimeout(() => {
        if (stateRef.current === 'error') setVoiceState('idle')
      }, 800)
    }
  }, [cleanupActiveRecording, setVoiceState, throwIfStopRequested, voiceInput])

  return {
    state,
    partialText,
    progress,
    start,
    stop
  }
}
