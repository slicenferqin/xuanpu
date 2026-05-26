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
import {
  createRuleBasedEpisodeFromTurns,
  listFieldEpisodeBlocks
} from '../../../field/episode-block-repository'
import { createFieldContextPackage } from '../../../field/context-package-repository'
import { selectRetrievedEpisodesForContext } from '../episode-retrieval'
import { selectMessagesForEpisodeFreeze } from '../episode-freezer'
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

  freezeEpisodes(worktreeId: string, sessionId: string): void {
    try {
      const messages = this.db.getSessionMessages(sessionId)
      const existingEpisodes = listFieldEpisodeBlocks({
        worktreeId,
        sessionId,
        limit: 200
      })
      const selected = selectMessagesForEpisodeFreeze(
        messages.map((msg) => ({
          id: msg.opencode_message_id ?? msg.id,
          role: msg.role,
          content: msg.content,
          createdAt: msg.created_at
        })),
        existingEpisodes
      )

      if (selected.length === 0) return

      const episode = createRuleBasedEpisodeFromTurns({
        worktreeId,
        sessionId,
        title: 'Frozen Conversation Turns',
        turns: selected.map((msg) => ({
          messageId: msg.id ?? '',
          role: msg.role,
          content: msg.content,
          createdAt: msg.createdAt
        }))
      })

      log.info('Frozen conversation episode', {
        sessionId,
        worktreeId,
        episodeId: episode.id,
        messageCount: selected.length
      })
    } catch (error) {
      log.warn('Failed to freeze episodes', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  beginRun(sessionId: string): void {
    // beginSessionRun is called by the implementer via @shared/lib/normalize-agent-event
    // No-op here — field provider doesn't own event emission
    void sessionId
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

function isConversationMessage(
  msg: SessionMessage
): msg is SessionMessage & { role: 'user' | 'assistant' } {
  return (msg.role === 'user' || msg.role === 'assistant') && msg.content.trim().length > 0
}
