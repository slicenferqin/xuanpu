import { AddressInfo } from 'net'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VoiceTranscriptionSessionOptions } from '../../src/shared/types/voice'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

import { FunAsrClient } from '../../src/main/services/voice/funasr-client'

const servers: WebSocketServer[] = []

function defaultOptions(wsUrl: string): VoiceTranscriptionSessionOptions {
  return {
    wsUrl,
    mode: '2pass',
    sampleRate: 16000,
    chunkSize: [5, 10, 5],
    useItn: true,
    hotwords: []
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    if (server.address() == null) {
      resolve()
      return
    }
    server.close(() => resolve())
  })
}

async function createServer(
  onConnection: (ws: import('ws').WebSocket) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = new WebSocketServer({ port: 0 })
  servers.push(server)
  server.on('connection', onConnection)

  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address() as AddressInfo
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () => closeServer(server)
  }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)))
})

describe('FunAsrClient', () => {
  it('rejects when the WebSocket endpoint cannot be reached', async () => {
    const server = await createServer((ws) => ws.close())
    const port = Number(new URL(server.url).port)
    await server.close()

    const client = new FunAsrClient()
    await expect(
      client.connect(defaultOptions(`ws://127.0.0.1:${port}`), {
        onTranscript: vi.fn(),
        onError: vi.fn()
      })
    ).rejects.toThrow()
  })

  it('suppresses a late final transcript after committing the partial fallback', async () => {
    const finalTexts: string[] = []
    const server = await createServer((ws) => {
      ws.on('message', (data) => {
        if (typeof data !== 'string' && !Buffer.isBuffer(data)) return
        const text = data.toString()
        if (!text.startsWith('{')) return
        const parsed = JSON.parse(text) as { is_speaking?: boolean }
        if (parsed.is_speaking === true) {
          ws.send(JSON.stringify({ mode: '2pass-online', text: '你好' }))
        }
        if (parsed.is_speaking === false) {
          setTimeout(() => {
            ws.send(JSON.stringify({ mode: '2pass-offline', text: '你好世界' }))
          }, 2100)
        }
      })
    })

    const client = new FunAsrClient()
    const sessionId = await client.connect(defaultOptions(server.url), {
      onTranscript: (event) => {
        if (event.type === 'final') finalTexts.push(event.text)
      },
      onError: vi.fn()
    })

    client.finishUtterance(sessionId)
    await delay(2500)
    client.disconnect(sessionId)

    expect(finalTexts).toEqual(['你好'])
  })
})
