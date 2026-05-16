import { BrowserWindow, ipcMain } from 'electron'
import type {
  VoiceErrorEvent,
  VoiceRuntimeConfig,
  VoiceTranscriptionSessionOptions,
  VoiceTranscriptionSession
} from '@shared/types/voice'
import { createLogger } from '../services'
import { voiceRuntimeManager } from '../services/voice/voice-runtime-manager'

const log = createLogger({ component: 'VoiceHandlers' })

let registered = false
let activeMainWindow: BrowserWindow | null = null

function sendToVoiceWindow(channel: string, payload: unknown): void {
  if (!activeMainWindow || activeMainWindow.isDestroyed()) return
  if (activeMainWindow.webContents.isDestroyed()) return
  activeMainWindow.webContents.send(channel, payload)
}

function emitVoiceError(event: VoiceErrorEvent): void {
  sendToVoiceWindow('voice:error', event)
}

export function registerVoiceHandlers(mainWindow: BrowserWindow): void {
  activeMainWindow = mainWindow
  voiceRuntimeManager.setMainWindow(mainWindow)
  if (registered) return
  registered = true

  ipcMain.handle('voice:detectRuntime', async (_event, config?: VoiceRuntimeConfig) => {
    try {
      return await voiceRuntimeManager.detect(config)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('Voice runtime detection failed', { error: message })
      return {
        provider: 'managed' as const,
        status: 'error' as const,
        wsUrl: 'ws://127.0.0.1:10095',
        message: 'Failed to detect FunASR runtime',
        error: message
      }
    }
  })

  ipcMain.handle('voice:ensureRuntime', async (_event, config?: VoiceRuntimeConfig) => {
    try {
      return await voiceRuntimeManager.ensureReady(config)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('Voice runtime ensure failed', { error: message })
      return {
        provider: 'managed' as const,
        status: 'error' as const,
        wsUrl: 'ws://127.0.0.1:10095',
        message: 'Failed to prepare FunASR runtime',
        error: message
      }
    }
  })

  ipcMain.handle('voice:startRuntime', async (_event, config?: VoiceRuntimeConfig) => {
    return voiceRuntimeManager.ensureReady(config)
  })

  ipcMain.handle('voice:stopRuntime', async () => {
    try {
      await voiceRuntimeManager.stopRuntime()
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('voice:getRuntimeLogs', async () => voiceRuntimeManager.getLogs())

  ipcMain.handle('voice:getMicrophonePermissionStatus', () =>
    voiceRuntimeManager.getMicrophonePermissionStatus()
  )

  ipcMain.handle('voice:requestMicrophonePermission', () =>
    voiceRuntimeManager.requestMicrophonePermission()
  )

  ipcMain.handle(
    'voice:connectTranscription',
    async (
      _event,
      options: VoiceTranscriptionSessionOptions
    ): Promise<VoiceTranscriptionSession> => {
      const activeSession = { id: undefined as string | undefined }
      const sessionId = await voiceRuntimeManager.funasr.connect(options, {
        onTranscript: (event) => sendToVoiceWindow('voice:transcript', event),
        onError: (message) =>
          emitVoiceError(activeSession.id ? { sessionId: activeSession.id, message } : { message })
      })
      activeSession.id = sessionId
      return { sessionId }
    }
  )

  ipcMain.handle('voice:sendAudioChunk', (_event, sessionId: string, chunk: ArrayBuffer) => {
    voiceRuntimeManager.funasr.sendAudioChunk(sessionId, chunk)
  })

  ipcMain.handle('voice:finishUtterance', (_event, sessionId: string) => {
    voiceRuntimeManager.funasr.finishUtterance(sessionId)
  })

  ipcMain.handle('voice:disconnectTranscription', (_event, sessionId: string) => {
    voiceRuntimeManager.funasr.disconnect(sessionId)
  })
}

export async function cleanupVoiceRuntime(): Promise<void> {
  await voiceRuntimeManager.shutdown()
}
