import { randomUUID } from 'node:crypto'

import type { XuanpuAgentCliEvent } from './events.js'

export type XuanpuAgentRpcBridgeProtocol = 'json-rpc' | 'acp'

export interface XuanpuAgentJsonRpcRequest {
  jsonrpc?: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

export interface XuanpuAgentRpcBridgePromptInput {
  cwd?: string
  prompt: string
  sessionId?: string
  dryRun?: boolean
  allowWrites?: boolean
  noTools?: boolean
  model?: {
    provider: string
    id: string
  }
}

export interface XuanpuAgentRpcBridgeOptions {
  protocol?: XuanpuAgentRpcBridgeProtocol
  requests: AsyncIterable<string | XuanpuAgentJsonRpcRequest>
  write: (chunk: string) => void
  prompt: (input: XuanpuAgentRpcBridgePromptInput) => AsyncIterable<XuanpuAgentCliEvent>
  makeSessionId?: () => string
}

interface XuanpuAgentRpcBridgeState {
  protocol: XuanpuAgentRpcBridgeProtocol
  sessions: Set<string>
  makeSessionId: () => string
}

export async function runJsonRpcBridge(options: XuanpuAgentRpcBridgeOptions): Promise<void> {
  const state: XuanpuAgentRpcBridgeState = {
    protocol: options.protocol ?? 'json-rpc',
    sessions: new Set(),
    makeSessionId: options.makeSessionId ?? (() => `cli-${randomUUID()}`)
  }

  for await (const raw of options.requests) {
    const request = parseJsonRpcRequest(raw)
    if (!request) {
      options.write(stringifyJsonRpc({ jsonrpc: '2.0', error: makeError(-32700, 'Parse error') }))
      continue
    }

    const response = await handleJsonRpcRequest(request, state, options)
    if (response) options.write(stringifyJsonRpc(response))
    if (request.method === 'exit' || request.method === 'shutdown') break
  }
}

async function handleJsonRpcRequest(
  request: XuanpuAgentJsonRpcRequest,
  state: XuanpuAgentRpcBridgeState,
  options: XuanpuAgentRpcBridgeOptions
): Promise<Record<string, unknown> | null> {
  try {
    switch (request.method) {
      case 'initialize':
      case 'acp/initialize':
        return respond(request, {
          protocol: state.protocol,
          protocolVersion: '2026-06-17',
          serverInfo: {
            name: 'xuanpu-agent',
            runtimeId: 'xuanpu-agent'
          },
          capabilities: {
            sessionNew: true,
            sessionPrompt: true,
            cancel: false,
            eventStream: 'canonical-agent-event'
          }
        })

      case 'session/new':
      case 'acp/session/new': {
        const params = asRecord(request.params)
        const sessionId = asString(params.sessionId) ?? state.makeSessionId()
        state.sessions.add(sessionId)
        return respond(request, {
          sessionId,
          cwd: asString(params.cwd) ?? null
        })
      }

      case 'session/prompt':
      case 'prompt':
      case 'acp/session/prompt':
        return runPromptRequest(request, state, options)

      case 'cancel':
      case 'session/cancel':
      case 'acp/session/cancel':
        return respond(request, {
          cancelled: false,
          reason: 'xuanpu-agent CLI bridge does not yet support in-flight cancellation'
        })

      case 'shutdown':
      case 'exit':
        return respond(request, { ok: true })

      default:
        return {
          jsonrpc: '2.0',
          id: request.id ?? null,
          error: makeError(-32601, `Method not found: ${request.method}`)
        }
    }
  } catch (error) {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: makeError(-32603, error instanceof Error ? error.message : String(error))
    }
  }
}

async function runPromptRequest(
  request: XuanpuAgentJsonRpcRequest,
  state: XuanpuAgentRpcBridgeState,
  options: XuanpuAgentRpcBridgeOptions
): Promise<Record<string, unknown> | null> {
  const params = asRecord(request.params)
  const prompt = asString(params.prompt) ?? asString(params.text)
  if (!prompt?.trim()) {
    return {
      jsonrpc: '2.0',
      id: request.id ?? null,
      error: makeError(-32602, 'session/prompt requires params.prompt')
    }
  }

  const sessionId = asString(params.sessionId) ?? state.makeSessionId()
  state.sessions.add(sessionId)
  let eventCount = 0
  let lastEventType: string | null = null

  for await (const event of options.prompt({
    cwd: asString(params.cwd),
    prompt,
    sessionId,
    dryRun: asBoolean(params.dryRun),
    allowWrites: asBoolean(params.allowWrites),
    noTools: asBoolean(params.noTools),
    model: parseModelParam(params.model)
  })) {
    eventCount += 1
    lastEventType = event.type
    options.write(
      stringifyJsonRpc({
        jsonrpc: '2.0',
        method: state.protocol === 'acp' ? 'acp/session/event' : 'session/event',
        params: {
          sessionId,
          event
        }
      })
    )
  }

  return respond(request, {
    sessionId,
    eventCount,
    lastEventType
  })
}

function respond(
  request: XuanpuAgentJsonRpcRequest,
  result: Record<string, unknown>
): Record<string, unknown> | null {
  if (request.id === undefined) return null
  return {
    jsonrpc: '2.0',
    id: request.id,
    result
  }
}

function parseJsonRpcRequest(
  raw: string | XuanpuAgentJsonRpcRequest
): XuanpuAgentJsonRpcRequest | null {
  if (typeof raw !== 'string') return isJsonRpcRequest(raw) ? raw : null
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return isJsonRpcRequest(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isJsonRpcRequest(value: unknown): value is XuanpuAgentJsonRpcRequest {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.method === 'string'
}

function stringifyJsonRpc(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`
}

function makeError(code: number, message: string): { code: number; message: string } {
  return { code, message }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseModelParam(value: unknown): XuanpuAgentRpcBridgePromptInput['model'] | undefined {
  if (!value) return undefined
  if (typeof value === 'string') {
    const [provider, ...rest] = value.split('/')
    const id = rest.join('/')
    return provider && id ? { provider, id } : undefined
  }
  const record = asRecord(value)
  const provider = asString(record.provider)
  const id = asString(record.id) ?? asString(record.modelID)
  return provider && id ? { provider, id } : undefined
}
