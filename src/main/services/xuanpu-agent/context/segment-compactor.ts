import type { FieldEpisodeBlockRecord } from '../../../field/episode-block-repository'
import {
  buildRuleBasedEpisodeFromTurns,
  type FieldEpisodeBlockCreate,
  type FieldEpisodeTurnInput
} from '../../../field/episode-block-repository'
import {
  DEFAULT_KEEP_RECENT_MESSAGES,
  selectMessagesForEpisodeFreeze,
  type XuanpuAgentEpisodeFreezeOptions,
  type XuanpuAgentFreezeMessage
} from '../episode-freezer'
import {
  computeProviderNativePreserveSha256,
  ProviderNativeCompactionArchiveStore,
  summarizeProviderNativePreserveData
} from './provider-native-compaction'

export type SegmentCompactionReason =
  | 'context-full'
  | 'handoff'
  | 'provider-native'
  | 'rule-based-fallback'

export interface ProviderNativeCompactAudit {
  provider: string
  firstKeptEntryId?: string | null
  historyReplacementId?: string | null
  preserveData?: unknown
}

export interface SegmentCompactorInput {
  worktreeId: string
  sessionId: string
  taskRunId?: string | null
  contextSegmentId?: string | null
  reason: SegmentCompactionReason
  messages: XuanpuAgentFreezeMessage[]
  existingEpisodes: FieldEpisodeBlockRecord[]
  providerNative?: ProviderNativeCompactAudit | null
  options?: XuanpuAgentEpisodeFreezeOptions
}

export interface SegmentCompactorOptions {
  providerNativeArchiveRoot?: string
  archiveProviderNativePreserveData?: boolean
}

export type SegmentCompactionResult =
  | {
      status: 'skipped'
      reason: 'insufficient-messages'
      selectedMessageIds: string[]
      keptRecentMessageIds: string[]
      firstKeptEntryId: string | null
    }
  | {
      status: 'compacted'
      strategy: 'rule-based-fallback'
      reason: SegmentCompactionReason
      selectedMessageIds: string[]
      keptRecentMessageIds: string[]
      firstKeptEntryId: string | null
      turns: FieldEpisodeTurnInput[]
      episode: FieldEpisodeBlockCreate
      audit: SegmentCompactionAudit
    }

export interface SegmentCompactionAudit {
  version: 1
  strategy: 'rule-based-fallback'
  reason: SegmentCompactionReason
  taskRunId: string | null
  contextSegmentId: string | null
  selectedMessageIds: string[]
  keptRecentMessageIds: string[]
  firstKeptEntryId: string | null
  providerNative: {
    provider: string | null
    firstKeptEntryId: string | null
    historyReplacementId: string | null
    preserveDataSha256: string | null
    preserveDataBytes: number
    preserveDataRef: string | null
    preserveDataPath: string | null
    replacementHistoryCount: number
    compactionItemType: string | null
    replayable: boolean
  }
}

export class SegmentCompactor {
  private readonly options: SegmentCompactorOptions

  constructor(options: SegmentCompactorOptions = {}) {
    this.options = options
  }

  compact(input: SegmentCompactorInput): SegmentCompactionResult {
    const selected = selectMessagesForEpisodeFreeze(
      input.messages,
      input.existingEpisodes,
      input.options
    )
    const keptRecentMessageIds = collectKeptRecentMessageIds(
      input.messages,
      selected,
      input.options
    )
    const firstKeptEntryId =
      input.providerNative?.firstKeptEntryId ?? keptRecentMessageIds[0] ?? null

    if (selected.length === 0) {
      return {
        status: 'skipped',
        reason: 'insufficient-messages',
        selectedMessageIds: [],
        keptRecentMessageIds,
        firstKeptEntryId
      }
    }

    const turns: FieldEpisodeTurnInput[] = selected.map((message) => ({
      messageId: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt ?? null
    }))
    const selectedMessageIds = selected.map((message) => message.id)
    const providerNativeAudit = this.buildProviderNativeAudit(input.providerNative)
    const audit: SegmentCompactionAudit = {
      version: 1,
      strategy: 'rule-based-fallback',
      reason: input.reason,
      taskRunId: input.taskRunId ?? null,
      contextSegmentId: input.contextSegmentId ?? null,
      selectedMessageIds,
      keptRecentMessageIds,
      firstKeptEntryId,
      providerNative: providerNativeAudit
    }
    const episode = buildRuleBasedEpisodeFromTurns({
      worktreeId: input.worktreeId,
      sessionId: input.sessionId,
      title: 'Segment Compaction',
      turns,
      confidence: input.providerNative ? 'high' : 'medium'
    })

    return {
      status: 'compacted',
      strategy: 'rule-based-fallback',
      reason: input.reason,
      selectedMessageIds,
      keptRecentMessageIds,
      firstKeptEntryId,
      turns,
      episode: {
        ...episode,
        metadata: {
          ...(episode.metadata ?? {}),
          segmentCompaction: audit
        }
      },
      audit
    }
  }

  private buildProviderNativeAudit(
    providerNative?: ProviderNativeCompactAudit | null
  ): SegmentCompactionAudit['providerNative'] {
    const preserveData = providerNative?.preserveData
    if (preserveData === undefined) {
      return {
        provider: providerNative?.provider ?? null,
        firstKeptEntryId: providerNative?.firstKeptEntryId ?? null,
        historyReplacementId: providerNative?.historyReplacementId ?? null,
        preserveDataSha256: null,
        preserveDataBytes: 0,
        preserveDataRef: null,
        preserveDataPath: null,
        replacementHistoryCount: 0,
        compactionItemType: null,
        replayable: false
      }
    }

    const encoded = computeProviderNativePreserveSha256(preserveData)
    const replaySummary = summarizeProviderNativePreserveData(
      preserveData,
      providerNative?.provider
    )
    const archive =
      this.options.archiveProviderNativePreserveData === false
        ? null
        : new ProviderNativeCompactionArchiveStore({
            rootDir: this.options.providerNativeArchiveRoot
          }).writePreserveData({
            provider: providerNative?.provider ?? null,
            preserveData
          })

    return {
      provider: providerNative?.provider ?? replaySummary.provider,
      firstKeptEntryId: providerNative?.firstKeptEntryId ?? null,
      historyReplacementId: providerNative?.historyReplacementId ?? null,
      preserveDataSha256: encoded.sha256,
      preserveDataBytes: encoded.bytes,
      preserveDataRef: archive?.ref ?? null,
      preserveDataPath: archive?.path ?? null,
      replacementHistoryCount: replaySummary.replacementHistoryCount,
      compactionItemType: replaySummary.compactionItemType,
      replayable: replaySummary.replayable && Boolean(archive?.ref)
    }
  }
}

function collectKeptRecentMessageIds(
  messages: XuanpuAgentFreezeMessage[],
  selected: Array<{ id: string }>,
  options?: XuanpuAgentEpisodeFreezeOptions
): string[] {
  const keepRecentMessages = options?.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES
  const selectedIds = new Set(selected.map((message) => message.id))
  return messages
    .filter(
      (message): message is XuanpuAgentFreezeMessage & { id: string } =>
        Boolean(message.id) &&
        (message.role === 'user' || message.role === 'assistant') &&
        message.content.trim().length > 0
    )
    .filter((message) => !selectedIds.has(message.id))
    .slice(-keepRecentMessages)
    .map((message) => message.id)
}
