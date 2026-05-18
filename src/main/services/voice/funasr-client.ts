import { randomUUID } from 'crypto'
import WebSocket from 'ws'
import {
  type VoiceHotword,
  type VoiceTranscriptEvent,
  type VoiceTranscriptionSessionOptions
} from '@shared/types/voice'
import {
  appendFunAsrPartialText,
  finalizeFunAsrText,
  parseFunAsrMessage
} from '@shared/lib/voice-funasr'
import { createLogger } from '../logger'

const log = createLogger({ component: 'FunAsrClient' })
const TRANSCRIPTION_CONNECT_TIMEOUT_MS = 10000

type AudioChunk = ArrayBuffer | ArrayBufferView

interface TranscriptionHandlers {
  onTranscript: (event: VoiceTranscriptEvent) => void
  onError: (message: string) => void
  onClose?: () => void
}

interface ActiveSession {
  id: string
  ws: WebSocket
  options: VoiceTranscriptionSessionOptions
  handlers: TranscriptionHandlers
  partialText: string
  chunkCount: number
  byteCount: number
  transcriptCount: number
  finalTranscriptCount: number
  fallbackCommitted: boolean
  startedAt: number
  firstChunkAt?: number
  partialFallbackTimer?: ReturnType<typeof setTimeout>
}

function serializeHotwords(hotwords: VoiceHotword[]): string {
  return hotwords
    .filter((item) => item.enabled && item.text.trim())
    .map((item) => `${item.text.trim()} ${item.weight || 20}`)
    .join('\n')
}

function normalizeAudioChunk(chunk: AudioChunk): Buffer | null {
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk)
  if (ArrayBuffer.isView(chunk)) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  return null
}

function getRawMode(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const mode = (raw as { mode?: unknown }).mode
  return typeof mode === 'string' ? mode : undefined
}

export class FunAsrClient {
  private sessions = new Map<string, ActiveSession>()

  async healthCheck(wsUrl: string, timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl)
      let settled = false
      const finish = (ready: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ws.close()
        resolve(ready)
      }
      const timer = setTimeout(() => {
        finish(false)
      }, timeoutMs)

      ws.once('open', () => {
        finish(true)
      })

      ws.once('error', () => {
        finish(false)
      })
    })
  }

  connect(
    options: VoiceTranscriptionSessionOptions,
    handlers: TranscriptionHandlers
  ): Promise<string> {
    const id = randomUUID()

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(options.wsUrl)
      let connected = false
      let rejected = false

      const rejectBeforeConnect = (error: Error): void => {
        if (connected || rejected) return
        rejected = true
        clearTimeout(connectTimer)
        ws.terminate()
        reject(error)
      }

      const connectTimer = setTimeout(() => {
        rejectBeforeConnect(
          new Error(`Timed out connecting to FunASR WebSocket: ${options.wsUrl}`)
        )
      }, TRANSCRIPTION_CONNECT_TIMEOUT_MS)

      const handleSocketError = (error: Error): void => {
        if (!connected) {
          rejectBeforeConnect(error)
          return
        }
        handlers.onError(error.message)
      }

      const handleSocketClose = (code: number, reason: Buffer): void => {
        clearTimeout(connectTimer)
        if (!connected) {
          if (!rejected) {
            rejected = true
            const detail = reason.toString().trim()
            reject(
              new Error(
                `FunASR WebSocket closed before connecting${detail ? `: ${detail}` : ` (${code})`}`
              )
            )
          }
          return
        }

        const active = this.sessions.get(id)
        if (active) {
          this.emitPartialFallback(active, 'socket-close')
          this.clearPartialFallback(active)
          log.info('FunASR transcription session closed', this.getSessionStats(active))
          this.sessions.delete(id)
        }
        handlers.onClose?.()
      }

      ws.once('open', () => {
        clearTimeout(connectTimer)
        if (rejected) return
        const active: ActiveSession = {
          id,
          ws,
          options,
          handlers,
          partialText: '',
          chunkCount: 0,
          byteCount: 0,
          transcriptCount: 0,
          finalTranscriptCount: 0,
          fallbackCommitted: false,
          startedAt: Date.now()
        }
        this.sessions.set(id, active)
        try {
          ws.send(
            JSON.stringify({
              mode: options.mode,
              wav_name: `xuanpu-${id}`,
              wav_format: 'pcm',
              is_speaking: true,
              audio_fs: options.sampleRate,
              chunk_size: options.chunkSize,
              itn: options.useItn,
              hotwords: serializeHotwords(options.hotwords)
            })
          )
        } catch (error) {
          this.sessions.delete(id)
          rejectBeforeConnect(error instanceof Error ? error : new Error(String(error)))
          return
        }

        log.info('FunASR transcription session connected', {
          sessionId: id,
          wsUrl: options.wsUrl,
          sampleRate: options.sampleRate,
          chunkSize: options.chunkSize,
          hotwordCount: options.hotwords.filter((item) => item.enabled && item.text.trim()).length
        })
        connected = true
        resolve(id)
      })

      ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString())
          const event = parseFunAsrMessage(id, parsed)
          if (!event) return

          const active = this.sessions.get(id)
          if (!active) return
          active.transcriptCount += 1
          log.debug('FunASR transcript received', {
            sessionId: id,
            type: event.type,
            mode: getRawMode(event.raw),
            textLength: event.text.length,
            transcriptCount: active.transcriptCount
          })
          if (event.type === 'partial') {
            active.partialText = appendFunAsrPartialText(active.partialText, event.text)
            handlers.onTranscript({ ...event, text: active.partialText })
            return
          }

          if (active.fallbackCommitted) {
            log.debug('Suppressing late FunASR final after partial fallback', {
              sessionId: id,
              textLength: event.text.length
            })
            return
          }

          active.finalTranscriptCount += 1
          this.clearPartialFallback(active)
          const text = finalizeFunAsrText(active.partialText, event.text)
          active.partialText = ''
          if (text) handlers.onTranscript({ ...event, text })
        } catch (error) {
          log.debug('Failed to parse FunASR message', {
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })

      ws.once('error', (error) => {
        handleSocketError(error instanceof Error ? error : new Error(String(error)))
      })

      ws.once('close', handleSocketClose)
    })
  }

  sendAudioChunk(sessionId: string, chunk: AudioChunk): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.ws.readyState !== WebSocket.OPEN) return
    const buffer = normalizeAudioChunk(chunk)
    if (!buffer || buffer.byteLength === 0) return
    session.chunkCount += 1
    session.byteCount += buffer.byteLength
    session.firstChunkAt ??= Date.now()
    if (session.chunkCount <= 5 || session.chunkCount % 50 === 0) {
      log.debug('FunASR audio chunk sent', {
        sessionId,
        chunkBytes: buffer.byteLength,
        chunkCount: session.chunkCount,
        byteCount: session.byteCount
      })
    }
    session.ws.send(buffer)
  }

  finishUtterance(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.ws.readyState !== WebSocket.OPEN) return
    log.info('Finishing FunASR utterance', this.getSessionStats(session))
    if (session.chunkCount === 0 && Date.now() - session.startedAt > 1000) {
      session.handlers.onError(
        'No microphone audio was captured. Check the input device and try again.'
      )
    }
    session.ws.send(JSON.stringify({ is_speaking: false }))
    this.schedulePartialFallback(session)
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.clearPartialFallback(session)
    this.emitPartialFallback(session, 'disconnect')
    log.info('Disconnecting FunASR transcription session', this.getSessionStats(session))
    session.ws.close()
    this.sessions.delete(sessionId)
  }

  disconnectAll(): void {
    for (const id of this.sessions.keys()) {
      this.disconnect(id)
    }
  }

  private schedulePartialFallback(session: ActiveSession): void {
    this.clearPartialFallback(session)
    session.partialFallbackTimer = setTimeout(() => {
      const active = this.sessions.get(session.id)
      if (!active) return
      this.emitPartialFallback(active, 'finish-timeout')
    }, 1800)
  }

  private emitPartialFallback(session: ActiveSession, reason: string): void {
    if (session.finalTranscriptCount > 0) return
    const text = session.partialText.trim()
    if (!text) return
    session.finalTranscriptCount += 1
    session.fallbackCommitted = true
    session.partialText = ''
    log.info('Committing FunASR partial transcript fallback', {
      ...this.getSessionStats(session),
      reason,
      textLength: text.length
    })
    session.handlers.onTranscript({
      sessionId: session.id,
      type: 'final',
      text,
      raw: { source: 'partial-fallback', reason }
    })
  }

  private clearPartialFallback(session: ActiveSession): void {
    if (!session.partialFallbackTimer) return
    clearTimeout(session.partialFallbackTimer)
    session.partialFallbackTimer = undefined
  }

  private getSessionStats(session: ActiveSession): Record<string, unknown> {
    return {
      sessionId: session.id,
      chunkCount: session.chunkCount,
      byteCount: session.byteCount,
      transcriptCount: session.transcriptCount,
      finalTranscriptCount: session.finalTranscriptCount,
      durationMs: Date.now() - session.startedAt,
      firstChunkDelayMs: session.firstChunkAt ? session.firstChunkAt - session.startedAt : null
    }
  }
}
