/**
 * IdeFieldProvider — FieldProvider backed by 玄圃 IDE infrastructure.
 *
 * Wraps existing DB calls, field context builder, episode repository, and
 * gated retrieval behind the field-agnostic FieldProvider interface so the
 * harness never imports IDE-specific modules directly.
 *
 * CLI 模式只需换成 CliFieldProvider（simple-git + 文件存储），harness 层零改动。
 */
import type { DatabaseService } from '../../../db/database'
import type { SessionMessage } from '../../../db/types'
import { buildFieldContextSnapshot } from '../../../field/context-builder'
import { formatFieldContext } from '../../../field/context-formatter'
import { listFieldEpisodeBlocks } from '../../../field/episode-block-repository'
import { createFieldContextPackage } from '../../../field/context-package-repository'
import { selectRetrievedEpisodesForContext } from '../episode-retrieval'
import { summarizeEpisode } from '../context/episode-summarizer'
import { SegmentCompactor } from '../context/segment-compactor'
import {
  buildOpenAiRemoteCompactionNativeInput,
  extractProviderNativeReplayRefs,
  readOpenAiRemoteCompactionPreserveData,
  requestOpenAiRemoteCompaction,
  shouldUseOpenAiRemoteCompaction
} from '../context/provider-native-compaction'
import type { XuanpuAgentModelRef } from '../model-config'
import { loadXuanpuAgentConfig } from '../config-loader'
import { createLogger } from '../../logger'
import type {
  FieldProvider,
  FieldWorktree,
  FieldSession,
  FieldTurn,
  FieldEpisode,
  FieldContextSnapshot,
  FieldContextPackage,
  FieldEpisodeRetrieval
} from './provider'

const log = createLogger({ component: 'IdeFieldProvider' })

export class IdeFieldProvider implements FieldProvider {
  constructor(private readonly db: DatabaseService) {}

  // ── Read ──────────────────────────────────────────────────────────────

  getWorktree(path: string): FieldWorktree | null {
    const row = this.db.getWorktreeByPath(path)
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      context: row.context ?? null,
      projectId: row.project_id,
      branchName: row.branch_name ?? null,
      lastMessageAt: row.last_message_at ?? null,
      githubPrNumber: row.github_pr_number ?? null,
      githubPrUrl: row.github_pr_url ?? null
    }
  }

  getSession(sessionId: string): FieldSession | null {
    const row = this.db.getSession(sessionId)
    if (!row) return null
    return {
      id: row.id,
      projectId: row.project_id
    }
  }

  getPriorTurns(sessionId: string): FieldTurn[] {
    return this.db
      .getSessionMessages(sessionId)
      .filter(isConversationMessage)
      .map((msg) => ({
        messageId: msg.opencode_message_id ?? msg.id,
        role: msg.role,
        content: msg.content,
        createdAt:
          typeof msg.created_at === 'number'
            ? msg.created_at
            : msg.created_at
              ? Date.parse(msg.created_at)
              : Date.now()
      }))
  }

  async buildFieldSnapshot(worktree: FieldWorktree): Promise<FieldContextSnapshot> {
    const snapshot = await buildFieldContextSnapshot({
      worktreeId: worktree.id
    })

    if (!snapshot) {
      return {
        markdown: null,
        approxTokens: 0,
        wasTruncated: false,
        capturedAt: Date.now()
      }
    }

    const formatted = formatFieldContext(snapshot, { tokenBudget: 1500 })
    return {
      markdown: formatted.markdown,
      approxTokens: formatted.approxTokens,
      wasTruncated: formatted.wasTruncated,
      capturedAt: snapshot.asOf
    }
  }

  getEpisodeCandidates(worktreeId: string, _sessionId: string): FieldEpisode[] {
    try {
      return listFieldEpisodeBlocks({ worktreeId, limit: 25 }).map(
        (episode) =>
          ({
            id: episode.id,
            title: episode.title ?? null,
            summaryMarkdown: episode.summaryMarkdown,
            tokenEstimate: episode.tokenEstimate ?? 0,
            createdAt: episode.createdAt ?? Date.now(),
            sessionId: episode.sessionId ?? null,
            keyFacts: episode.keyFacts,
            constraints: episode.constraints,
            files: episode.files,
            commands: episode.commands,
            failures: episode.failures
          }) as FieldEpisode
      )
    } catch (error) {
      log.warn('Failed to load episode candidates', {
        worktreeId,
        error: error instanceof Error ? error.message : String(error)
      })
      return []
    }
  }

  retrieveEpisodes(
    userText: string,
    candidates: FieldEpisode[],
    priorTurns: FieldTurn[],
    currentSessionId: string
  ): FieldEpisodeRetrieval {
    const result = selectRetrievedEpisodesForContext({
      userText,
      episodes: candidates.map((ep) => ({
        id: ep.id,
        title: ep.title,
        summaryMarkdown: ep.summaryMarkdown,
        tokenEstimate: ep.tokenEstimate,
        createdAt: ep.createdAt,
        sessionId: ep.sessionId ?? null,
        kind: 'turns',
        worktreeId: '',
        keyFacts: ep.keyFacts ?? [],
        constraints: ep.constraints ?? [],
        files: ep.files ?? [],
        commands: ep.commands ?? [],
        failures: ep.failures ?? [],
        rawRefs: [],
        confidence: 'medium'
      })) as unknown as Parameters<typeof selectRetrievedEpisodesForContext>[0]['episodes'],
      priorMessages: priorTurns.map((t) => ({
        role: t.role,
        content: t.content,
        createdAt: t.createdAt
      })),
      currentSessionId
    })

    return {
      included: result.included.map((ep) => ({
        id: ep.id,
        title: ep.title ?? null,
        summaryMarkdown: ep.summaryMarkdown,
        tokenEstimate: ep.tokenEstimate ?? 0,
        createdAt: ep.createdAt ?? Date.now()
      })),
      dropped: result.decisions.droppedCount,
      triggers: result.decisions.triggers ?? []
    }
  }

  // ── Write ─────────────────────────────────────────────────────────────

  persistMessage(
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    meta?: {
      messageId?: string
      modelProviderId?: string
      modelId?: string
      usage?: Record<string, unknown>
      rawMessage?: unknown
    }
  ): void {
    const messageId = meta?.messageId ?? `xuanpu-agent-${Date.now()}`
    const timestamp = new Date().toISOString()
    const parts = [{ type: 'text', text: content, timestamp }]
    const payload = {
      id: messageId,
      role,
      content,
      parts,
      providerID: meta?.modelProviderId,
      modelID: meta?.modelId,
      usage: meta?.usage,
      raw: meta?.rawMessage
    }

    this.db.createSessionMessage({
      session_id: sessionId,
      role,
      content,
      opencode_message_id: messageId,
      opencode_message_json: JSON.stringify(payload),
      opencode_parts_json: JSON.stringify(parts),
      created_at: timestamp
    })
  }

  persistContextPackage(pkg: FieldContextPackage): void {
    createFieldContextPackage({
      sessionId: pkg.sessionId,
      worktreeId: pkg.worktreeId,
      runtimeId: pkg.runtimeId,
      modelProviderId: pkg.modelProviderId,
      modelId: pkg.modelId,
      budgetProfile: pkg.budgetProfile as 'focused' | 'balanced' | 'extended',
      approxTokens: pkg.approxTokens,
      sections: pkg.sections.map((s) => ({
        id: s.id,
        kind: s.kind,
        title: s.title,
        included: s.included,
        approxTokens: s.approxTokens,
        source: s.source,
        reason: s.reason,
        metadata: s.metadata
      })) as unknown as Parameters<typeof createFieldContextPackage>[0]['sections'],
      renderedMarkdown: pkg.renderedMarkdown,
      decisions: pkg.decisions
    })
  }

  async freezeEpisodes(worktreeId: string, sessionId: string): Promise<void> {
    try {
      const messages = this.db.getSessionMessages(sessionId)
      const existingEpisodes = listFieldEpisodeBlocks({
        worktreeId,
        sessionId,
        limit: 200
      })
      const compactorInput = {
        worktreeId,
        sessionId,
        reason: 'context-full' as const,
        messages: messages.map((msg) => ({
          id: msg.opencode_message_id ?? msg.id,
          role: msg.role,
          content: msg.content,
          createdAt: msg.created_at
        })),
        existingEpisodes
      }
      let compaction = new SegmentCompactor().compact(compactorInput)

      if (compaction.status === 'skipped') return

      // Resolve compaction model from settings
      const resolution = await this.resolveCompactionResolution()
      const providerNative = await this.tryOpenAiRemoteCompaction({
        compaction,
        existingEpisodes,
        resolution
      })
      if (providerNative) {
        const providerNativeCompaction = new SegmentCompactor().compact({
          ...compactorInput,
          reason: 'provider-native',
          providerNative
        })
        if (providerNativeCompaction.status === 'compacted') {
          compaction = providerNativeCompaction
        }
      }

      const episode = await summarizeEpisode({
        worktreeId,
        sessionId,
        title: 'Frozen Conversation Turns',
        turns: compaction.turns,
        resolution
      })

      // summarizeEpisode returns FieldEpisodeBlockCreate; persist it
      const { createFieldEpisodeBlock } = await import('../../../field/episode-block-repository')
      createFieldEpisodeBlock({
        ...episode,
        metadata: {
          ...(episode.metadata ?? {}),
          segmentCompaction: compaction.audit
        }
      })

      log.info('Frozen conversation episode', {
        sessionId,
        worktreeId,
        messageCount: compaction.selectedMessageIds.length,
        firstKeptEntryId: compaction.firstKeptEntryId,
        modelSource: resolution.source,
        providerNativeReplayable:
          compaction.audit.providerNative.replayable &&
          Boolean(compaction.audit.providerNative.preserveDataRef)
      })
    } catch (error) {
      log.warn('Failed to freeze episodes', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private async tryOpenAiRemoteCompaction(input: {
    compaction: Extract<ReturnType<SegmentCompactor['compact']>, { status: 'compacted' }>
    existingEpisodes: ReturnType<typeof listFieldEpisodeBlocks>
    resolution: Awaited<ReturnType<IdeFieldProvider['resolveCompactionResolution']>>
  }) {
    const modelRef = input.resolution.modelRef
    if (!modelRef || !shouldUseOpenAiRemoteCompaction(modelRef.providerID)) return null
    const apiKey = input.resolution.resolvedApiKey
    if (!apiKey) return null

    const previous = findLatestOpenAiRemoteCompactionHistory(
      input.existingEpisodes,
      modelRef.providerID
    )
    const compactInput = buildOpenAiRemoteCompactionNativeInput(
      input.compaction.turns.map((turn) => ({
        role: turn.role,
        content: turn.content,
        messageId: turn.messageId
      })),
      previous?.replacementHistory
    )
    if (compactInput.length === 0) return null

    try {
      const remote = await requestOpenAiRemoteCompaction({
        model: {
          providerID: modelRef.providerID,
          modelID: modelRef.modelID,
          ...extractOpenAiRemoteCompactionModelOptions(input.resolution.model)
        },
        apiKey,
        input: compactInput,
        instructions:
          'Compact this Xuanpu Agent segment. Preserve provider-native reasoning state when available.'
      })
      return {
        provider: modelRef.providerID,
        firstKeptEntryId: input.compaction.firstKeptEntryId,
        historyReplacementId: previous?.ref ?? null,
        preserveData: remote.preserveData
      }
    } catch (error) {
      log.warn('OpenAI remote compaction failed; falling back to local episode summary', {
        provider: modelRef.providerID,
        model: modelRef.modelID,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  beginRun(sessionId: string): void {
    // beginSessionRun is called by the implementer via @shared/lib/normalize-agent-event
    // No-op here — field provider doesn't own event emission
    void sessionId
  }

  private async resolveCompactionResolution() {
    const { APP_SETTINGS_DB_KEY } = await import('../../../../shared/types/settings')
    const { resolveCompactionModel } = await import('../context/compaction-model')

    let compactionModel: XuanpuAgentModelRef | null = null
    let mainModel: XuanpuAgentModelRef | null = null

    try {
      const raw = this.db.getSetting(APP_SETTINGS_DB_KEY)
      if (raw) {
        const settings = JSON.parse(raw) as Record<string, unknown>
        const cm = settings.xuanpuAgentCompactionModel as
          | { providerID?: string; modelID?: string }
          | null
          | undefined
        if (cm?.providerID && cm?.modelID) {
          compactionModel = { providerID: cm.providerID, modelID: cm.modelID }
        }
        const sm = settings.selectedModel as
          | { providerID?: string; modelID?: string }
          | null
          | undefined
        if (sm?.providerID && sm?.modelID) {
          mainModel = { providerID: sm.providerID, modelID: sm.modelID }
        }
      }
    } catch {
      // Settings read failure — proceed with nulls (will fall back to rule-based)
    }

    // Priority 2: Config file compactionModel (if DB settings didn't specify one)
    let agentConfig: XuanpuAgentConfig | undefined
    if (!compactionModel) {
      try {
        const { config } = loadXuanpuAgentConfig()
        agentConfig = config
        if (config.compactionModel) {
          compactionModel = config.compactionModel
        }
        // Also use config mainModel if DB settings didn't specify one
        if (!mainModel) {
          mainModel = config.mainModel
        }
      } catch {
        // Config load failure — proceed with DB values
      }
    } else {
      // Still load config for API key resolution even if compactionModel came from DB
      try {
        const { config } = loadXuanpuAgentConfig()
        agentConfig = config
      } catch {
        // Config load failure — proceed without config-based API keys
      }
    }

    return resolveCompactionModel(compactionModel, mainModel ?? undefined, agentConfig)
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function extractOpenAiRemoteCompactionModelOptions(model: unknown): {
  baseUrl?: string
  contextWindow?: number
  headers?: Record<string, string>
} {
  if (!model || typeof model !== 'object') return {}
  const record = model as Record<string, unknown>
  const options: { baseUrl?: string; contextWindow?: number; headers?: Record<string, string> } = {}
  if (typeof record.baseUrl === 'string') options.baseUrl = record.baseUrl
  if (typeof record.contextWindow === 'number') options.contextWindow = record.contextWindow
  if (record.headers && typeof record.headers === 'object') {
    const headers = Object.entries(record.headers as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
    if (headers.length > 0) options.headers = Object.fromEntries(headers)
  }
  return options
}

function findLatestOpenAiRemoteCompactionHistory(
  episodes: ReturnType<typeof listFieldEpisodeBlocks>,
  providerID: string
) {
  for (const episode of [...episodes].sort((a, b) => b.createdAt - a.createdAt)) {
    const ref = extractProviderNativeReplayRefs({
      episodeId: episode.id,
      source: 'frozen-episode',
      metadata: episode.metadata
    }).find((candidate) => candidate.replayable && candidate.provider === providerID)
    if (!ref) continue
    const preserveData = readOpenAiRemoteCompactionPreserveData(ref.path)
    if (preserveData?.provider === providerID) {
      return {
        ref: ref.ref,
        replacementHistory: preserveData.replacementHistory
      }
    }
  }
  return null
}

function isConversationMessage(
  msg: SessionMessage
): msg is SessionMessage & { role: 'user' | 'assistant' } {
  return (msg.role === 'user' || msg.role === 'assistant') && msg.content.trim().length > 0
}
