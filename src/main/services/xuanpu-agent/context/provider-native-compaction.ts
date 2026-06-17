import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { stableStringify } from '../turn/provider-request-builder'

export const OPENAI_REMOTE_COMPACTION_PRESERVE_KEY = 'openaiRemoteCompaction'

const DEFAULT_PROVIDER_NATIVE_COMPACTION_ROOT = join(
  homedir(),
  '.xuanpu',
  'archive',
  'provider-native-compaction'
)
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api'

export interface ProviderNativeCompactionReplaySummary {
  provider: string | null
  replacementHistoryCount: number
  compactionItemType: string | null
  replayable: boolean
}

export interface OpenAiRemoteCompactionPreserveData {
  provider?: string
  replacementHistory: Array<Record<string, unknown>>
  compactionItem: {
    type: 'compaction' | 'compaction_summary'
    encrypted_content?: string
    summary?: string
  }
}

export interface OpenAiRemoteCompactionConversationTurn {
  role: 'user' | 'assistant'
  content: string
  messageId?: string | null
}

export interface OpenAiRemoteCompactionModelRef {
  providerID: string
  modelID: string
  baseUrl?: string
  contextWindow?: number
  headers?: Record<string, string>
}

export interface OpenAiRemoteCompactionRequestInput {
  model: OpenAiRemoteCompactionModelRef
  apiKey: string
  input: Array<Record<string, unknown>>
  instructions: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface OpenAiRemoteCompactionRequestResult {
  endpoint: string
  request: {
    model: string
    input: Array<Record<string, unknown>>
    instructions: string
  }
  preserveData: {
    [OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: OpenAiRemoteCompactionPreserveData
  }
}

export interface ProviderNativeCompactionArchiveRecord extends ProviderNativeCompactionReplaySummary {
  ref: string
  path: string
  sha256: string
  bytes: number
}

export interface ProviderNativeCompactionReplayRef extends ProviderNativeCompactionArchiveRecord {
  source: 'frozen-episode' | 'retrieved-episode'
  episodeId: string
  historyReplacementId: string | null
  firstKeptEntryId: string | null
}

export interface ProviderNativeCompactionArchiveStoreOptions {
  rootDir?: string
}

export function getDefaultProviderNativeCompactionRoot(): string {
  return DEFAULT_PROVIDER_NATIVE_COMPACTION_ROOT
}

export function summarizeProviderNativePreserveData(
  preserveData: unknown,
  fallbackProvider?: string | null
): ProviderNativeCompactionReplaySummary {
  const openAi = extractOpenAiRemoteCompactionData(preserveData)
  if (openAi) {
    return {
      provider: openAi.provider ?? fallbackProvider ?? null,
      replacementHistoryCount: openAi.replacementHistory.length,
      compactionItemType: openAi.compactionItem.type,
      replayable: true
    }
  }

  return {
    provider: fallbackProvider ?? null,
    replacementHistoryCount: 0,
    compactionItemType: null,
    replayable: false
  }
}

export function shouldUseOpenAiRemoteCompaction(providerID: string): boolean {
  return providerID === 'openai' || providerID === 'openai-codex'
}

export function resolveOpenAiRemoteCompactionEndpoint(
  model: OpenAiRemoteCompactionModelRef
): string {
  if (model.providerID === 'openai-codex') {
    const rawBase = model.baseUrl?.trim() || DEFAULT_OPENAI_CODEX_BASE_URL
    const base = rawBase.replace(/\/+$/, '')
    if (/\/codex(?:\/v\d+)?$/.test(base)) return `${base}/responses/compact`
    return `${base}/codex/responses/compact`
  }

  const rawBase = model.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL
  const base = rawBase.replace(/\/+$/, '')
  if (base.endsWith('/v1')) return `${base}/responses/compact`
  return `${base}/v1/responses/compact`
}

export function buildOpenAiRemoteCompactionNativeInput(
  turns: OpenAiRemoteCompactionConversationTurn[],
  previousReplacementHistory?: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const input = previousReplacementHistory ? [...previousReplacementHistory] : []
  let fallbackIndex = 0

  for (const turn of turns) {
    const text = turn.content.trim()
    if (!text) continue

    if (turn.role === 'assistant') {
      input.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
        status: 'completed',
        id: normalizeOpenAiMessageId(turn.messageId, fallbackIndex)
      })
    } else {
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }]
      })
    }
    fallbackIndex += 1
  }

  return input
}

export async function requestOpenAiRemoteCompaction(
  input: OpenAiRemoteCompactionRequestInput
): Promise<OpenAiRemoteCompactionRequestResult> {
  if (!shouldUseOpenAiRemoteCompaction(input.model.providerID)) {
    throw new Error(`OpenAI remote compaction is not supported for ${input.model.providerID}`)
  }
  if (!input.apiKey.trim()) throw new Error('OpenAI remote compaction requires an API key')

  const endpoint = resolveOpenAiRemoteCompactionEndpoint(input.model)
  const request = {
    model: input.model.modelID,
    input: trimOpenAiCompactInput(
      input.input,
      input.model.contextWindow ?? Number.MAX_SAFE_INTEGER,
      input.instructions
    ),
    instructions: input.instructions
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${input.apiKey}`,
    ...(input.model.headers ?? {})
  }
  if (input.model.providerID === 'openai-codex') {
    headers['openai-beta'] = headers['openai-beta'] ?? 'responses=experimental'
  }

  const fetchImpl = input.fetchImpl ?? fetch
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers,
    body: stableStringify(request),
    signal: input.signal
  })
  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(
      `OpenAI remote compaction failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ''}`
    )
  }

  const data = (await response.json()) as { output?: unknown } | undefined
  const output = Array.isArray(data?.output) ? data.output : []
  const replacementHistory = output.filter(
    (item): item is Record<string, unknown> =>
      !!item &&
      typeof item === 'object' &&
      shouldKeepOpenAiCompactOutputItem(item as Record<string, unknown>)
  )
  const compactionItem = findOpenAiCompactionItem(replacementHistory)
  if (!compactionItem) throw new Error('OpenAI remote compaction response missing compaction item')

  return {
    endpoint,
    request,
    preserveData: {
      [OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: {
        provider: input.model.providerID,
        replacementHistory,
        compactionItem
      }
    }
  }
}

export function readOpenAiRemoteCompactionPreserveData(
  path: string
): OpenAiRemoteCompactionPreserveData | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return parseOpenAiRemoteCompactionPreserveData(parsed)
  } catch {
    return null
  }
}

export function computeProviderNativePreserveSha256(preserveData: unknown): {
  text: string
  sha256: string
  bytes: number
} {
  const text = stableStringify(preserveData)
  return {
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text, 'utf-8')
  }
}

export class ProviderNativeCompactionArchiveStore {
  private readonly rootDir: string

  constructor(options: ProviderNativeCompactionArchiveStoreOptions = {}) {
    this.rootDir = options.rootDir ?? DEFAULT_PROVIDER_NATIVE_COMPACTION_ROOT
  }

  writePreserveData(input: {
    provider?: string | null
    preserveData: unknown
  }): ProviderNativeCompactionArchiveRecord {
    const encoded = computeProviderNativePreserveSha256(input.preserveData)
    const summary = summarizeProviderNativePreserveData(input.preserveData, input.provider)
    const path = join(this.rootDir, `${encoded.sha256}.json`)
    const tmpPath = `${path}.${randomUUID().slice(0, 8)}.tmp`

    mkdirSync(this.rootDir, { recursive: true })
    if (!existsSync(path)) {
      writeFileSync(tmpPath, encoded.text, 'utf-8')
      try {
        renameSync(tmpPath, path)
      } catch (error) {
        try {
          unlinkSync(tmpPath)
        } catch {
          // Best-effort cleanup; the original rename error decides the outcome.
        }
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
      }
    }

    return {
      ...summary,
      ref: `provider-native-compaction:${encoded.sha256}`,
      path,
      sha256: encoded.sha256,
      bytes: encoded.bytes
    }
  }
}

export function extractProviderNativeReplayRefs(input: {
  episodeId: string
  source: ProviderNativeCompactionReplayRef['source']
  metadata?: Record<string, unknown> | null
}): ProviderNativeCompactionReplayRef[] {
  const audit = getSegmentCompactionAudit(input.metadata)
  const providerNative = audit?.providerNative
  if (!providerNative || typeof providerNative !== 'object') return []
  const ref = providerNative as Record<string, unknown>
  if (typeof ref.preserveDataRef !== 'string') return []
  if (typeof ref.preserveDataSha256 !== 'string') return []
  if (typeof ref.preserveDataPath !== 'string') return []

  return [
    {
      source: input.source,
      episodeId: input.episodeId,
      provider: typeof ref.provider === 'string' ? ref.provider : null,
      ref: ref.preserveDataRef,
      path: ref.preserveDataPath,
      sha256: ref.preserveDataSha256,
      bytes: typeof ref.preserveDataBytes === 'number' ? ref.preserveDataBytes : 0,
      replacementHistoryCount:
        typeof ref.replacementHistoryCount === 'number' ? ref.replacementHistoryCount : 0,
      compactionItemType:
        typeof ref.compactionItemType === 'string' ? ref.compactionItemType : null,
      replayable: ref.replayable === true,
      historyReplacementId:
        typeof ref.historyReplacementId === 'string' ? ref.historyReplacementId : null,
      firstKeptEntryId: typeof ref.firstKeptEntryId === 'string' ? ref.firstKeptEntryId : null
    }
  ]
}

function getSegmentCompactionAudit(
  metadata?: Record<string, unknown> | null
): Record<string, unknown> | null {
  const audit = metadata?.segmentCompaction
  return audit && typeof audit === 'object' ? (audit as Record<string, unknown>) : null
}

function extractOpenAiRemoteCompactionData(preserveData: unknown): {
  provider?: string
  replacementHistory: Array<Record<string, unknown>>
  compactionItem: { type: string }
} | null {
  if (!preserveData || typeof preserveData !== 'object') return null
  const record = preserveData as Record<string, unknown>
  const candidate = record[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]
  if (!candidate || typeof candidate !== 'object') return null
  const remote = candidate as Record<string, unknown>
  if (!Array.isArray(remote.replacementHistory)) return null
  const compactionItem = remote.compactionItem
  if (!compactionItem || typeof compactionItem !== 'object') return null
  const item = compactionItem as Record<string, unknown>
  if (item.type !== 'compaction' && item.type !== 'compaction_summary') return null
  if (item.type === 'compaction' && typeof item.encrypted_content !== 'string') return null

  return {
    provider: typeof remote.provider === 'string' ? remote.provider : undefined,
    replacementHistory: remote.replacementHistory.filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object'
    ),
    compactionItem: { type: item.type }
  }
}

function estimateOpenAiCompactInputTokens(
  input: Array<Record<string, unknown>>,
  instructions: string
): number {
  let chars = instructions.length
  for (const item of input) chars += stableStringify(item).length
  return Math.ceil(chars / 4)
}

function shouldTrimOpenAiCompactInputItem(item: Record<string, unknown>): boolean {
  return (
    item.type === 'function_call_output' ||
    item.type === 'custom_tool_call_output' ||
    (item.type === 'message' && item.role === 'developer')
  )
}

function trimOpenAiCompactInput(
  input: Array<Record<string, unknown>>,
  contextWindow: number,
  instructions: string
): Array<Record<string, unknown>> {
  const trimmed = [...input]
  while (
    trimmed.length > 0 &&
    estimateOpenAiCompactInputTokens(trimmed, instructions) > contextWindow
  ) {
    const last = trimmed.at(-1)
    if (!last || !shouldTrimOpenAiCompactInputItem(last)) break
    if (last.type === 'function_call_output' || last.type === 'custom_tool_call_output') {
      const callId = typeof last.call_id === 'string' ? last.call_id : undefined
      const callType =
        last.type === 'custom_tool_call_output' ? 'custom_tool_call' : 'function_call'
      trimmed.pop()
      if (callId) {
        const matchingCallIndex = trimmed.findLastIndex(
          (item) => item.type === callType && item.call_id === callId
        )
        if (matchingCallIndex >= 0) trimmed.splice(matchingCallIndex, 1)
      }
      continue
    }
    trimmed.pop()
  }
  return trimmed
}

function shouldKeepOpenAiCompactOutputUserMessage(item: Record<string, unknown>): boolean {
  if (item.role !== 'user') return false
  const content = item.content
  if (!Array.isArray(content) || content.length === 0) return false
  const contextualFragmentPatterns = [
    [/^<system-reminder>[\s\S]*<\/system-reminder>$/i, /<system-reminder>/i],
    [/^#\s*AGENTS\.md instructions for\b[\s\S]*<\/INSTRUCTIONS>$/i, /# AGENTS.md instructions/],
    [/^<environment-context>[\s\S]*<\/environment-context>$/i, /<environment-context>/i],
    [/^<skill>[\s\S]*<\/skill>$/i, /<skill>/i],
    [/^<user-shell-command>[\s\S]*<\/user-shell-command>$/i, /<user-shell-command>/i],
    [/^<turn-aborted>[\s\S]*<\/turn-aborted>$/i, /<turn-aborted>/i],
    [/^<subagent-notification>[\s\S]*<\/subagent-notification>$/i, /<subagent-notification>/i]
  ] as const
  return content.every((part) => {
    if (!part || typeof part !== 'object') return false
    const record = part as Record<string, unknown>
    if (record.type === 'input_image') return true
    if (record.type !== 'input_text' || typeof record.text !== 'string') return false
    const trimmed = record.text.trim()
    if (trimmed.length === 0) return false
    return !contextualFragmentPatterns.some(
      ([strictPattern, markerPattern]) => strictPattern.test(trimmed) || markerPattern.test(trimmed)
    )
  })
}

function shouldKeepOpenAiCompactOutputItem(item: Record<string, unknown>): boolean {
  if (item.type === 'compaction' || item.type === 'compaction_summary') return true
  if (item.type !== 'message') return false
  if (item.role === 'developer') return false
  if (item.role === 'assistant') return true
  return shouldKeepOpenAiCompactOutputUserMessage(item)
}

function findOpenAiCompactionItem(
  replacementHistory: Array<Record<string, unknown>>
): OpenAiRemoteCompactionPreserveData['compactionItem'] | null {
  for (let index = replacementHistory.length - 1; index >= 0; index--) {
    const item = replacementHistory[index]
    if (item.type === 'compaction' && typeof item.encrypted_content === 'string') {
      return {
        type: 'compaction',
        encrypted_content: item.encrypted_content
      }
    }
    if (item.type === 'compaction_summary') {
      return {
        type: 'compaction_summary',
        summary: typeof item.summary === 'string' ? item.summary : undefined
      }
    }
  }
  return null
}

function parseOpenAiRemoteCompactionPreserveData(
  preserveData: unknown
): OpenAiRemoteCompactionPreserveData | null {
  if (!preserveData || typeof preserveData !== 'object') return null
  const record = preserveData as Record<string, unknown>
  const remote = record[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]
  if (!remote || typeof remote !== 'object') return null
  const data = remote as Record<string, unknown>
  if (!Array.isArray(data.replacementHistory)) return null
  const item = data.compactionItem
  if (!item || typeof item !== 'object') return null
  const compactionItem = item as Record<string, unknown>
  const type = compactionItem.type
  if (type !== 'compaction' && type !== 'compaction_summary') return null
  if (type === 'compaction' && typeof compactionItem.encrypted_content !== 'string') return null

  return {
    provider: typeof data.provider === 'string' ? data.provider : undefined,
    replacementHistory: data.replacementHistory.filter(
      (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object'
    ),
    compactionItem:
      type === 'compaction'
        ? {
            type,
            encrypted_content: compactionItem.encrypted_content as string
          }
        : {
            type,
            summary: typeof compactionItem.summary === 'string' ? compactionItem.summary : undefined
          }
  }
}

function normalizeOpenAiMessageId(
  messageId: string | null | undefined,
  fallbackIndex: number
): string {
  if (!messageId) return `msg_${fallbackIndex}`
  const normalized = messageId.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (normalized.length > 0 && normalized.length <= 64) return normalized
  return `msg_${createHash('sha256').update(messageId).digest('hex').slice(0, 24)}`
}
