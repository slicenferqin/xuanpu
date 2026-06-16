import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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

export interface ProviderNativeCompactionReplaySummary {
  provider: string | null
  replacementHistoryCount: number
  compactionItemType: string | null
  replayable: boolean
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
