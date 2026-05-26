import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import simpleGit from 'simple-git'

import type { DatabaseService } from '../db/database'
import type { Worktree, Session } from '../db/types'
import type {
  AgentRuntimeAdapter,
  AgentSdkCapabilities,
  PromptOptions
} from './agent-runtime-types'
import { XUANPU_AGENT_CAPABILITIES } from './agent-runtime-types'
import { createLogger } from './logger'
import { resolveXuanpuAgentModelRef, type XuanpuAgentModelRef } from './xuanpu-agent/model-config'
import {
  XuanpuPiAgentSession,
  type XuanpuAgentToolEndEvent,
  type XuanpuAgentToolStartEvent
} from './xuanpu-agent/runtime'
import { XfpPacketCompiler, type CompilerDecision } from './xuanpu-agent/harness/compiler'
import { buildMessages, SessionAppendOnlyLog } from './xuanpu-agent/harness/build-messages'
import type {
  XfpCommandTraceSection,
  XfpFieldPacket,
  XfpGitState,
  XfpRawRefKind,
  XfpRetrievedMemorySection
} from './xuanpu-agent/xfp/types'
import {
  IdeFieldProvider,
  type FieldContextPackageSection,
  type FieldEpisode,
  type FieldProvider,
  type FieldTurn,
  type FieldWorktree
} from './xuanpu-agent/field'
import { beginSessionRun, emitAgentEvent } from '@shared/lib/normalize-agent-event'
import { createCommandProfiler } from './xuanpu-agent/context/profiler'
import { createCommandCompressor } from './xuanpu-agent/context/compressor-impl'
import type { ArchivePayload } from './xuanpu-agent/harness/tool-call-repair/truncation'
import {
  createMemoryPageProposal,
  listMemoryPagesForContext
} from '../field/memory-page-repository'
import { extractMemoryProposalDrafts } from './xuanpu-agent/memory/memory-extractor'
import {
  selectRetrievedMemoryForContext,
  type XuanpuAgentMemoryRetrievalResult
} from './xuanpu-agent/memory/memory-retrieval'
import {
  detectFrequentTraceCandidates,
  type TraceMaterializationCandidate
} from './xuanpu-agent/memory/trace-materialization'

const log = createLogger({ component: 'XuanpuAgentImplementer' })

interface XuanpuAgentSessionState {
  sessionId: string
  hiveSessionId: string
  worktreePath: string
  status: 'ready' | 'running' | 'closed' | 'error'
  abortController: AbortController | null
  piSession: XuanpuPiAgentSession | null
}

function extractPromptText(
  message:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'file'; mime: string; url: string; filename?: string }
      >
): string {
  if (typeof message === 'string') return message

  return message
    .map((part) => {
      if (part.type === 'text') return part.text
      return `[Attached file: ${part.filename ?? part.url}]`
    })
    .join('\n')
}

export class XuanpuAgentImplementer implements AgentRuntimeAdapter {
  readonly id = 'xuanpu-agent' as const
  readonly capabilities: AgentSdkCapabilities = XUANPU_AGENT_CAPABILITIES

  private mainWindow: BrowserWindow | null = null
  private db: DatabaseService | null = null
  private field: FieldProvider | null = null
  private sessions = new Map<string, XuanpuAgentSessionState>()
  private selectedModelRef: { providerID: string; modelID: string; variant?: string } | null = null

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  setDatabaseService(db: DatabaseService): void {
    this.db = db
    this.field = new IdeFieldProvider(db)
  }

  async connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }> {
    const sessionId = `xuanpu-agent-${randomUUID()}`
    this.sessions.set(sessionId, {
      sessionId,
      hiveSessionId,
      worktreePath,
      status: 'ready',
      abortController: null,
      piSession: null
    })

    log.info('Connected xuanpu-agent session', { worktreePath, hiveSessionId, sessionId })
    this.emitStatus(hiveSessionId, 'idle')
    return { sessionId }
  }

  async reconnect(
    worktreePath: string,
    agentSessionId: string,
    hiveSessionId: string
  ): Promise<{ success: boolean; sessionStatus?: 'idle' | 'busy' | 'retry' }> {
    this.sessions.set(agentSessionId, {
      sessionId: agentSessionId,
      hiveSessionId,
      worktreePath,
      status: 'ready',
      abortController: null,
      piSession: null
    })
    return { success: true, sessionStatus: 'idle' }
  }

  async disconnect(_worktreePath: string, agentSessionId: string): Promise<void> {
    const session = this.sessions.get(agentSessionId)
    session?.abortController?.abort()
    session?.piSession?.dispose()
    if (session) session.status = 'closed'
    this.sessions.delete(agentSessionId)
  }

  /** M3: Return budget state for the given session (looks up by agentSessionId or hiveSessionId). */
  getBudgetState(sessionId: string): Record<string, unknown> | null {
    // Try direct lookup by agent session ID first
    let session = this.sessions.get(sessionId)
    // Fallback: search by hive session ID
    if (!session) {
      for (const s of this.sessions.values()) {
        if (s.hiveSessionId === sessionId) {
          session = s
          break
        }
      }
    }
    if (!session?.piSession) return null
    return session.piSession.getBudgetState() as unknown as Record<string, unknown>
  }

  async cleanup(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.abortController?.abort()
      session.piSession?.dispose()
    }
    this.sessions.clear()
  }

  async prompt(
    worktreePath: string,
    agentSessionId: string,
    message:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >,
    modelOverride?: { providerID: string; modelID: string; variant?: string },
    _options?: PromptOptions
  ): Promise<void> {
    const session = this.requireSession(agentSessionId, worktreePath)
    const text = extractPromptText(message).trim()
    if (!text) return

    const field = this.requireField()
    const worktree = field.getWorktree(session.worktreePath)
    const priorMessages = field.getPriorTurns(session.hiveSessionId)

    beginSessionRun(session.hiveSessionId)
    const userMessageId = `xuanpu-agent-user-${randomUUID()}`
    field.persistMessage(session.hiveSessionId, 'user', text, { messageId: userMessageId })
    session.status = 'running'
    session.abortController = new AbortController()
    this.emitStatus(session.hiveSessionId, 'busy')

    const modelRef = resolveXuanpuAgentModelRef(modelOverride, this.selectedModelRef)

    // ── Build field context via FieldProvider (IDE or CLI) ──
    const gitState = await this.buildGitStateForWorktree(session.worktreePath)
    const commandTrace = this.buildCommandTraceSection(session.hiveSessionId, worktree?.id)
    const memoryRetrieval = worktree
      ? this.buildMemoryRetrievalSection(text, worktree, session.hiveSessionId)
      : null
    const traceCandidates = commandTrace
      ? detectFrequentTraceCandidates(
          commandTrace.entries.map((entry) => ({
            id: entry.traceId,
            sessionId: session.hiveSessionId,
            worktreeId: worktree?.id ?? null,
            command: entry.command,
            exitCode: entry.exitCode,
            createdAt: entry.capturedAt
          }))
        )
      : []
    const priorBudgetState = session.piSession?.getBudgetState()
    const compressionRatio =
      priorBudgetState && priorBudgetState.totalBeforeBytes > 0
        ? 1 - priorBudgetState.totalAfterBytes / priorBudgetState.totalBeforeBytes
        : null
    const fieldSnapshot = worktree
      ? await field.buildFieldSnapshot(worktree).catch(() => ({
          markdown: null,
          approxTokens: 0,
          wasTruncated: false,
          capturedAt: Date.now()
        }))
      : { markdown: null, approxTokens: 0, wasTruncated: false, capturedAt: Date.now() }

    // ── Compile XFP packet ──
    const compiler = new XfpPacketCompiler()
    const compileResult = compiler.compile(
      (worktree
        ? { id: worktree.id, context: worktree.context, project_id: worktree.projectId }
        : { id: 'unknown', context: null, project_id: 'unknown' }) as unknown as Worktree,
      {
        id: session.hiveSessionId,
        project_id: worktree?.projectId ?? 'unknown'
      } as unknown as Session,
      text,
      {
        gitState,
        focus: fieldSnapshot.markdown
          ? {
              file: null,
              selection: null,
              rawRefs: [
                {
                  kind: 'message',
                  id: `field:${session.hiveSessionId}`,
                  excerpt: fieldSnapshot.markdown.slice(0, 200)
                }
              ]
            }
          : undefined,
        terminal: null,
        tests: null,
        commandTrace,
        retrievedMemory: memoryRetrieval?.section ?? null,
        anchor: null,
        compressionRatio
      }
    )

    // ── Assemble messages via harness buildMessages ──
    const appendOnlyLog = new SessionAppendOnlyLog(
      priorMessages,
      compileResult.packet.identity.packetId
    )

    try {
      const piSession = this.getOrCreatePiSession(session)
      piSession.setWorktreePath(session.worktreePath)

      // M3: sync budget profile from XFP compiler decision
      piSession.setBudgetProfile(compileResult.packet.budget.profile)
      piSession.recordBudgetSections(
        compileResult.decisions.includedSections.length,
        compileResult.decisions.omittedSections.length
      )

      // M2: configure compression (profiler + compressor + archive to command_traces)
      if (this.db) {
        piSession.configureCompression(
          createCommandProfiler(),
          createCommandCompressor(),
          (payload: ArchivePayload) => {
            try {
              this.db!.createCommandTrace({
                traceId: payload.traceId,
                sessionId: session.hiveSessionId,
                worktreeId: worktree?.id,
                command: payload.command,
                cwd: payload.cwd || undefined,
                exitCode: payload.exitCode,
                durationMs: payload.durationMs,
                timedOut: payload.timedOut,
                aborted: payload.aborted,
                rawOutput: payload.rawOutput,
                compressedOutput: payload.compressedOutput,
                compressionRatio: payload.compressionRatio,
                category: payload.category,
                ruleHits: payload.ruleHits.join(',')
              })
            } catch (err) {
              log.warn('Failed to archive command trace', {
                error: err instanceof Error ? err.message : String(err)
              })
            }
          }
        )
      }

      const harnessMessages = buildMessages(compileResult.packet, appendOnlyLog, text)

      const result = await piSession.prompt(harnessMessages, modelRef, {
        onTextDelta: (delta) => this.emitTextDelta(session.hiveSessionId, delta),
        onToolStart: (event) => this.emitToolStart(session.hiveSessionId, event),
        onToolEnd: (event) => this.emitToolEnd(session.hiveSessionId, event)
      })

      const assistantText = result.text.trim()
      const content = assistantText || '(empty response)'
      field.persistMessage(session.hiveSessionId, 'assistant', content, {
        messageId: result.messageId,
        modelProviderId: result.modelRef.providerID,
        modelId: result.modelRef.modelID,
        usage: result.usage,
        rawMessage: result.rawMessage
      })
      this.emitMessageUpdated(session.hiveSessionId, content, {
        messageId: result.messageId,
        modelRef: result.modelRef,
        usage: result.usage,
        contextPackageId: compileResult.packet.identity.packetId
      })

      // Record context package for audit/debug
      if (worktree) {
        try {
          await this.createContextPackage(session, text, modelRef, priorMessages, {
            packet: compileResult.packet,
            decisions: compileResult.decisions,
            fieldSnapshotMarkdown: fieldSnapshot.markdown,
            memoryRetrieval,
            traceCandidates
          })
        } catch (err) {
          log.warn('Failed to record context package', {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }

      if (worktree) {
        this.proposeMemoryFromTurns({
          worktree,
          sessionId: session.hiveSessionId,
          userMessageId,
          userText: text,
          assistantMessageId: result.messageId,
          assistantText: content
        })
      }

      this.freezeOldConversationTurns(session)

      session.status = 'ready'
      session.abortController = null
      this.emitStatus(session.hiveSessionId, 'idle')
    } catch (error) {
      const errorMessage = [
        'xuanpu-agent provider call failed.',
        error instanceof Error ? error.message : String(error),
        `Packet: ${compileResult.packet.identity.packetId}`
      ]
        .filter(Boolean)
        .join('\n')
      field.persistMessage(session.hiveSessionId, 'assistant', errorMessage)
      session.status = 'error'
      session.abortController = null
      this.emitError(session.hiveSessionId, errorMessage)
      this.emitStatus(session.hiveSessionId, 'idle')
      throw new Error(errorMessage)
    }
  }

  async abort(_worktreePath: string, agentSessionId: string): Promise<boolean> {
    const session = this.sessions.get(agentSessionId)
    if (!session?.abortController) return false
    session.abortController.abort()
    session.piSession?.abort()
    session.abortController = null
    session.status = 'ready'
    this.emitStatus(session.hiveSessionId, 'idle')
    return true
  }

  async getMessages(_worktreePath: string, agentSessionId: string): Promise<unknown[]> {
    const session = this.sessions.get(agentSessionId)
    if (!session || !this.db) return []
    return this.db.getSessionMessages(session.hiveSessionId)
  }

  async getAvailableModels(): Promise<unknown> {
    const modelRef =
      process.env.XUANPU_AGENT_MOCK_RESPONSE !== undefined
        ? { providerID: 'xuanpu-agent', modelID: 'xuanpu-agent-mock' }
        : resolveXuanpuAgentModelRef(undefined, this.selectedModelRef)
    const providerName =
      modelRef.providerID === 'xuanpu-agent'
        ? 'Xuanpu Agent'
        : modelRef.providerID.charAt(0).toUpperCase() + modelRef.providerID.slice(1)

    return [
      {
        id: modelRef.providerID,
        name: providerName,
        models: {
          [modelRef.modelID]: {
            id: modelRef.modelID,
            name: modelRef.modelID
          }
        }
      }
    ]
  }

  async getModelInfo(): Promise<null> {
    return null
  }

  setSelectedModel(model: { providerID: string; modelID: string; variant?: string }): void {
    this.selectedModelRef = model
  }

  async getSessionInfo(): Promise<{ revertMessageID: string | null; revertDiff: string | null }> {
    return { revertMessageID: null, revertDiff: null }
  }

  async questionReply(): Promise<void> {}

  async questionReject(): Promise<void> {}

  async permissionReply(): Promise<void> {}

  async permissionList(): Promise<unknown[]> {
    return []
  }

  async undo(): Promise<unknown> {
    throw new Error('UNDO_NOT_SUPPORTED')
  }

  async redo(): Promise<unknown> {
    throw new Error('REDO_NOT_SUPPORTED')
  }

  async listCommands(): Promise<unknown[]> {
    return []
  }

  async sendCommand(): Promise<void> {
    throw new Error('COMMANDS_NOT_SUPPORTED')
  }

  async renameSession(_worktreePath: string, _agentSessionId: string, name: string): Promise<void> {
    if (!this.db) return
    const session = this.sessions.get(_agentSessionId)
    if (!session) return
    this.db.updateSession(session.hiveSessionId, { name })
  }

  private async createContextPackage(
    session: XuanpuAgentSessionState,
    userText: string,
    modelRef: XuanpuAgentModelRef,
    priorMessages: FieldTurn[],
    options: {
      packet?: XfpFieldPacket
      decisions?: CompilerDecision
      fieldSnapshotMarkdown?: string | null
      memoryRetrieval?: {
        section: XfpRetrievedMemorySection | null
        result: XuanpuAgentMemoryRetrievalResult
      } | null
      traceCandidates?: TraceMaterializationCandidate[]
    } = {}
  ): Promise<{
    contextPackageId: string | null
    retrievedEpisodes: FieldEpisode[]
  } | null> {
    const field = this.requireField()
    const worktree = field.getWorktree(session.worktreePath)
    if (!worktree) return null

    const episodeCandidates = field.getEpisodeCandidates(worktree.id, session.hiveSessionId)
    const episodeRetrieval = field.retrieveEpisodes(
      userText,
      episodeCandidates,
      priorMessages,
      session.hiveSessionId
    )
    const packet = options.packet ?? null
    const baseSections =
      packet && options.decisions
        ? buildContextPackageSections(packet, options.decisions, {
            episodeCandidates,
            retrievedEpisodes: episodeRetrieval.included,
            episodeTriggers: episodeRetrieval.triggers,
            memoryRetrieval: options.memoryRetrieval ?? null,
            traceCandidates: options.traceCandidates ?? []
          })
        : [
            ...buildEpisodeContextPackageSections(
              packet?.identity.packetId ?? 'xuanpu-agent-context',
              episodeCandidates,
              episodeRetrieval.included,
              episodeRetrieval.triggers
            )
          ]

    field.persistContextPackage({
      id: packet?.identity.packetId ?? `xuanpu-agent-context-${Date.now()}`,
      sessionId: session.hiveSessionId,
      worktreeId: worktree.id,
      runtimeId: this.id,
      modelProviderId: modelRef.providerID,
      modelId: modelRef.modelID,
      budgetProfile: packet?.budget.profile ?? 'balanced',
      approxTokens:
        packet?.budget.estimatedTokens ??
        baseSections.reduce((total, section) => total + section.approxTokens, 0),
      sections: baseSections,
      renderedMarkdown: options.fieldSnapshotMarkdown ?? null,
      decisions: {
        ...(options.decisions as unknown as Record<string, unknown> | undefined),
        providerExecution: 'enabled',
        visibleTranscriptPolicy: 'persist-user-authored-message-only',
        frozenEpisodeCandidateCount: episodeCandidates.length,
        retrievedEpisodeCount: episodeRetrieval.included.length,
        retrievedEpisodeTokens: episodeRetrieval.included.reduce(
          (total, episode) => total + Math.max(0, episode.tokenEstimate),
          0
        ),
        episodeRetrieval: {
          policy: 'deterministic-gated-episode-retrieval',
          triggers: episodeRetrieval.triggers,
          includedIds: episodeRetrieval.included.map((episode) => episode.id),
          droppedCount: episodeRetrieval.dropped
        },
        retrievedMemoryCount: options.memoryRetrieval?.result.included.length ?? 0,
        retrievedMemoryTokens:
          options.memoryRetrieval?.result.included.reduce(
            (total, item) => total + Math.ceil(item.page.bodyMarkdown.length / 3),
            0
          ) ?? 0,
        memoryRetrieval: options.memoryRetrieval?.result.decisions ?? null,
        traceMaterialization: {
          policy: 'frequent-command-trace-detection',
          candidateCount: options.traceCandidates?.length ?? 0,
          candidates: (options.traceCandidates ?? []).map((candidate) => ({
            signature: candidate.signature,
            occurrenceCount: candidate.occurrenceCount,
            traceIds: candidate.traceIds
          }))
        }
      }
    })

    return {
      contextPackageId: packet?.identity.packetId ?? null,
      retrievedEpisodes: episodeRetrieval.included
    }
  }

  private buildMemoryRetrievalSection(
    userText: string,
    worktree: FieldWorktree,
    sessionId: string
  ): {
    section: XfpRetrievedMemorySection | null
    result: XuanpuAgentMemoryRetrievalResult
  } | null {
    try {
      const pages = listMemoryPagesForContext({
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        sessionId,
        limit: 80
      })
      const result = selectRetrievedMemoryForContext({
        userText,
        pages,
        currentSessionId: sessionId
      })
      if (result.included.length === 0) {
        return { section: null, result }
      }
      return {
        section: {
          entries: result.included.map((item) => ({
            memoryPageId: item.page.id,
            scope: item.page.scope,
            scopeId: item.page.scopeId,
            kind: item.page.kind,
            title: item.page.title,
            bodyMarkdown: item.page.bodyMarkdown,
            retrievalReason: item.retrievalReason,
            rawRefs: [
              { kind: 'memory-page', id: item.page.id, excerpt: item.page.title },
              ...item.page.rawRefs.map((ref) => ({
                kind: rawRefKindFromMemoryRef(ref.type),
                id: ref.id,
                excerpt: ref.excerpt,
                meta: sanitizeRawRefMetadata(ref.metadata)
              }))
            ]
          })),
          totalAvailable: pages.length
        },
        result
      }
    } catch (error) {
      log.warn('Failed to retrieve memory pages', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  private proposeMemoryFromTurns(input: {
    worktree: FieldWorktree
    sessionId: string
    userMessageId: string
    userText: string
    assistantMessageId: string
    assistantText: string
  }): void {
    try {
      const drafts = extractMemoryProposalDrafts({
        scope: 'worktree',
        scopeId: input.worktree.id,
        projectId: input.worktree.projectId,
        worktreeId: input.worktree.id,
        sessionId: input.sessionId,
        turns: [
          {
            messageId: input.userMessageId,
            role: 'user',
            content: input.userText,
            createdAt: Date.now()
          },
          {
            messageId: input.assistantMessageId,
            role: 'assistant',
            content: input.assistantText,
            createdAt: Date.now()
          }
        ],
        source: 'xuanpu-agent-turn',
        proposedBy: 'xuanpu-agent'
      })
      for (const draft of drafts) {
        createMemoryPageProposal(draft)
      }
      if (drafts.length > 0) {
        log.info('Created memory page proposals', {
          sessionId: input.sessionId,
          worktreeId: input.worktree.id,
          count: drafts.length
        })
      }
    } catch (error) {
      log.warn('Failed to create memory page proposals', {
        sessionId: input.sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private freezeOldConversationTurns(session: XuanpuAgentSessionState): void {
    const field = this.requireField()
    const worktree = field.getWorktree(session.worktreePath)
    if (!worktree) return
    field.freezeEpisodes(worktree.id, session.hiveSessionId)
  }

  private requireField(): FieldProvider {
    if (!this.field) {
      throw new Error(
        'XuanpuAgentImplementer: DatabaseService not set. Call setDatabaseService() first.'
      )
    }
    return this.field
  }

  private requireSession(agentSessionId: string, worktreePath: string): XuanpuAgentSessionState {
    const session = this.sessions.get(agentSessionId)
    if (!session) {
      throw new Error(`Unknown xuanpu-agent session: ${agentSessionId}`)
    }
    if (session.worktreePath !== worktreePath) {
      log.warn('xuanpu-agent session worktree mismatch', {
        expected: session.worktreePath,
        actual: worktreePath,
        agentSessionId
      })
    }
    return session
  }

  private buildCommandTraceSection(
    sessionId: string,
    worktreeId: string | undefined
  ): XfpCommandTraceSection | null {
    if (!this.db) return null
    if (typeof this.db.listRecentCommandTraces !== 'function') return null

    const traces = this.db.listRecentCommandTraces({
      sessionId,
      worktreeId,
      limit: 8
    })
    if (traces.entries.length === 0) return null

    return {
      entries: traces.entries.map((trace) => {
        const summary = summarizeCommandTrace(trace.compressedOutput)
        return {
          traceId: trace.id,
          command: trace.command,
          capturedAt: Date.parse(trace.createdAt) || Date.now(),
          exitCode: trace.exitCode,
          durationMs: trace.durationMs,
          compressionRatio: trace.compressionRatio,
          summary,
          rawRefs: [
            {
              kind: 'command-trace',
              id: trace.id,
              excerpt: summary.slice(0, 200),
              meta: {
                rawOutputRef: trace.rawOutputRef,
                rawOutputBytes: trace.rawOutputBytes,
                category: trace.category,
                ruleHits: trace.ruleHits
              }
            }
          ]
        }
      }),
      totalAvailable: traces.totalAvailable
    }
  }

  private async buildGitStateForWorktree(worktreePath: string): Promise<XfpGitState> {
    try {
      const git = simpleGit(worktreePath)
      const status = await git.status(['--untracked-files=normal'])
      const branchName = status.current || 'HEAD'
      const headShort = (await git.revparse(['HEAD'])).trim().slice(0, 7)
      const upstream = status.tracking || null
      const ahead = status.ahead
      const behind = status.behind
      const dirty = !status.isClean()

      const dirtyFiles = status.files.slice(0, 20).map((fileStatus) => {
        const code = fileStatus.index.trim()
        const validCodes = new Set(['M', 'A', 'D', '?', 'C'])
        const statusCode = validCodes.has(code)
          ? (code as 'M' | 'A' | 'D' | '?' | 'C' | '')
          : ('' as const)
        return {
          path: fileStatus.path,
          relativePath: fileStatus.path,
          status: statusCode,
          staged: code !== '?' && code !== ''
        }
      })

      return {
        branchName,
        headShort,
        upstream,
        ahead,
        behind,
        dirty,
        dirtyFiles,
        dirtyTruncated: status.files.length > 20,
        rawRefs: [
          {
            kind: 'git-object',
            id: `git:${worktreePath}:status`,
            meta: { sha: headShort, branch: branchName }
          }
        ]
      }
    } catch {
      return {
        branchName: 'unknown',
        headShort: 'unknown',
        upstream: null,
        ahead: 0,
        behind: 0,
        dirty: false,
        dirtyFiles: [],
        dirtyTruncated: false,
        rawRefs: []
      }
    }
  }

  private getOrCreatePiSession(session: XuanpuAgentSessionState): XuanpuPiAgentSession {
    if (!session.piSession) {
      session.piSession = new XuanpuPiAgentSession(session.sessionId)
    }
    return session.piSession
  }

  private emitTextDelta(hiveSessionId: string, delta: string): void {
    if (!delta) return

    emitAgentEvent(this.mainWindow, {
      type: 'message.part.updated',
      sessionId: hiveSessionId,
      data: {
        part: { type: 'text', text: delta },
        delta
      }
    })
  }

  private emitMessageUpdated(
    hiveSessionId: string,
    content: string,
    options: {
      messageId: string
      modelRef: XuanpuAgentModelRef
      usage?: Record<string, unknown>
      contextPackageId?: string | null
    }
  ): void {
    const timestamp = new Date().toISOString()
    emitAgentEvent(this.mainWindow, {
      type: 'message.updated',
      sessionId: hiveSessionId,
      data: {
        id: options.messageId,
        role: 'assistant',
        content,
        providerID: options.modelRef.providerID,
        modelID: options.modelRef.modelID,
        usage: options.usage,
        contextPackageId: options.contextPackageId,
        info: {
          id: options.messageId,
          role: 'assistant',
          providerID: options.modelRef.providerID,
          modelID: options.modelRef.modelID,
          time: { completed: Date.now() }
        },
        parts: [{ type: 'text', text: content, timestamp }]
      }
    })
  }

  private emitStatus(hiveSessionId: string, status: 'idle' | 'busy' | 'retry'): void {
    const statusPayload = { type: status }
    emitAgentEvent(this.mainWindow, {
      type: 'session.status',
      sessionId: hiveSessionId,
      data: { status: statusPayload }
    })
  }

  private emitError(hiveSessionId: string, message: string): void {
    emitAgentEvent(this.mainWindow, {
      type: 'session.error',
      sessionId: hiveSessionId,
      data: { error: message }
    })
  }

  private emitToolStart(hiveSessionId: string, event: XuanpuAgentToolStartEvent): void {
    emitAgentEvent(this.mainWindow, {
      type: 'message.part.updated',
      sessionId: hiveSessionId,
      data: {
        part: {
          type: 'tool',
          callID: event.toolCallId,
          tool: canonicalToolName(event.toolName),
          toolDisplay: event.toolName,
          state: {
            status: 'running',
            input: normalizeToolInput(event.toolName, event.args),
            time: { start: event.startedAt }
          }
        }
      }
    })
  }

  private emitToolEnd(hiveSessionId: string, event: XuanpuAgentToolEndEvent): void {
    const result = event.result && typeof event.result === 'object' ? event.result : null
    const details =
      result && 'details' in result && typeof (result as { details?: unknown }).details === 'object'
        ? ((result as { details?: Record<string, unknown> }).details ?? {})
        : {}
    const text = extractToolResultText(event.result)
    const status = event.isError ? 'error' : 'completed'
    const input = normalizeToolInput(event.toolName, {
      ...event.args,
      diff: typeof details.diff === 'string' ? details.diff : undefined,
      reverseDiff: typeof details.reverseDiff === 'string' ? details.reverseDiff : undefined,
      filesAffected: Array.isArray(details.filesAffected) ? details.filesAffected : undefined
    })

    emitAgentEvent(this.mainWindow, {
      type: 'message.part.updated',
      sessionId: hiveSessionId,
      data: {
        part: {
          type: 'tool',
          callID: event.toolCallId,
          tool: canonicalToolName(event.toolName),
          toolDisplay: event.toolName,
          state: {
            status,
            input,
            output: event.isError ? undefined : text,
            error: event.isError ? text : undefined,
            result: details,
            metadata: {
              exitCode: typeof details.exitCode === 'number' ? details.exitCode : undefined,
              durationMs: event.endedAt - event.startedAt,
              filesAffected: Array.isArray(details.filesAffected)
                ? details.filesAffected
                : undefined
            },
            time: { start: event.startedAt, end: event.endedAt }
          }
        }
      }
    })
  }
}

function canonicalToolName(toolName: string): string {
  switch (toolName) {
    case 'read_file':
      return 'Read'
    case 'rg_search':
      return 'Grep'
    case 'list_files':
      return 'Glob'
    case 'write_file':
      return 'Write'
    case 'edit_file':
    case 'apply_patch':
    case 'format_file':
      return 'Edit'
    case 'run_test':
      return 'Bash'
    default:
      return toolName
  }
}

function normalizeToolInput(
  toolName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (toolName === 'write_file' && typeof input.path === 'string') {
    return { ...input, file_path: input.path }
  }
  if ((toolName === 'edit_file' || toolName === 'format_file') && typeof input.path === 'string') {
    return { ...input, file_path: input.path }
  }
  if (toolName === 'run_test') {
    return {
      ...input,
      command:
        typeof input.command === 'string'
          ? input.command
          : Array.isArray(input.args)
            ? input.args.join(' ')
            : 'run_test'
    }
  }
  return input
}

function extractToolResultText(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const content = (result as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function summarizeCommandTrace(compressedOutput: string | null): string {
  const text = compressedOutput?.trim()
  if (!text) return '(raw command output archived)'

  const firstContentLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  if (!firstContentLine) return '(raw command output archived)'
  return firstContentLine.length > 300 ? `${firstContentLine.slice(0, 297)}...` : firstContentLine
}

function rawRefKindFromMemoryRef(type: string): XfpRawRefKind {
  switch (type) {
    case 'file':
      return 'file'
    case 'command':
      return 'command-trace'
    case 'episode':
      return 'episode'
    case 'memory_page':
      return 'memory-page'
    case 'field_event':
    case 'session_message':
    case 'manual':
    default:
      return 'message'
  }
}

function sanitizeRawRefMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, string | number | boolean | null> | undefined {
  if (!metadata) return undefined
  const entries = Object.entries(metadata)
    .map(([key, value]) => {
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
      ) {
        return [key, value] as const
      }
      return [key, String(value)] as const
    })
    .slice(0, 20)
  return Object.fromEntries(entries)
}

function buildContextPackageSections(
  packet: XfpFieldPacket,
  decisions: CompilerDecision,
  extras: {
    episodeCandidates?: FieldEpisode[]
    retrievedEpisodes?: FieldEpisode[]
    episodeTriggers?: string[]
    memoryRetrieval?: {
      section: XfpRetrievedMemorySection | null
      result: XuanpuAgentMemoryRetrievalResult
    } | null
    traceCandidates?: TraceMaterializationCandidate[]
  } = {}
): FieldContextPackageSection[] {
  const omittedReasonByName = new Map(
    decisions.omittedSections.map((section) => [section.name, section.reason])
  )
  const names = [
    ...decisions.includedSections,
    ...decisions.omittedSections.map((section) => section.name)
  ]
  const uniqueNames = [...new Set(names)]

  const xfpSections = uniqueNames.map((name) => {
    const included = decisions.includedSections.includes(name)
    return {
      id: `${packet.identity.packetId}:${name}`,
      kind: 'xfp-section',
      title: name,
      included,
      approxTokens: included ? estimateSectionTokens(packet, name) : 0,
      source: 'xuanpu-agent-xfp-compiler',
      reason: included ? 'included by compiler' : omittedReasonByName.get(name),
      metadata: {
        packetId: packet.identity.packetId,
        rawRefCount: countRawRefs(packet, name)
      }
    }
  })

  return [
    ...xfpSections,
    ...buildEpisodeContextPackageSections(
      packet.identity.packetId,
      extras.episodeCandidates ?? [],
      extras.retrievedEpisodes ?? [],
      extras.episodeTriggers ?? []
    ),
    ...buildMemoryContextPackageSections(packet.identity.packetId, extras.memoryRetrieval ?? null),
    ...buildTraceMaterializationContextPackageSections(
      packet.identity.packetId,
      extras.traceCandidates ?? []
    )
  ]
}

function buildEpisodeContextPackageSections(
  packetId: string,
  candidates: FieldEpisode[],
  retrieved: FieldEpisode[],
  triggers: string[]
): FieldContextPackageSection[] {
  const sections: FieldContextPackageSection[] = []
  if (candidates.length > 0) {
    sections.push({
      id: 'frozen-episodes-available',
      kind: 'frozen_episodes',
      title: 'Frozen Episodes Available',
      included: false,
      approxTokens: 0,
      source: 'xuanpu-agent-episode-retrieval',
      reason: 'available for gated retrieval',
      metadata: { packetId, count: candidates.length, ids: candidates.map((episode) => episode.id) }
    })
  }
  if (retrieved.length > 0) {
    sections.push({
      id: 'retrieved-episodes',
      kind: 'retrieved_episodes',
      title: 'Retrieved Episodes',
      included: true,
      approxTokens: retrieved.reduce((total, episode) => total + episode.tokenEstimate, 0),
      source: 'xuanpu-agent-episode-retrieval',
      reason: triggers.length > 0 ? triggers.join(', ') : 'gated retrieval match',
      metadata: { packetId, ids: retrieved.map((episode) => episode.id), triggers }
    })
  }
  return sections
}

function buildMemoryContextPackageSections(
  packetId: string,
  retrieval: {
    section: XfpRetrievedMemorySection | null
    result: XuanpuAgentMemoryRetrievalResult
  } | null
): FieldContextPackageSection[] {
  if (!retrieval) return []
  const included = retrieval.result.included
  return [
    {
      id: `${packetId}:retrieved-memory`,
      kind: 'retrieved_memory',
      title: 'Retrieved Memory',
      included: included.length > 0,
      approxTokens: included.reduce(
        (total, item) => total + Math.ceil(item.page.bodyMarkdown.length / 3),
        0
      ),
      source: 'xuanpu-agent-memory-retrieval',
      reason:
        included.length > 0
          ? included.map((item) => item.retrievalReason).join('; ')
          : 'no accepted memory matched',
      metadata: {
        packetId,
        candidateCount: retrieval.result.decisions.candidateCount,
        includedIds: retrieval.result.decisions.includedIds,
        retrievalReasons: included.map((item) => ({
          id: item.page.id,
          reason: item.retrievalReason
        }))
      }
    }
  ]
}

function buildTraceMaterializationContextPackageSections(
  packetId: string,
  candidates: TraceMaterializationCandidate[]
): FieldContextPackageSection[] {
  if (candidates.length === 0) return []
  return [
    {
      id: `${packetId}:trace-materialization`,
      kind: 'trace_materialization',
      title: 'Trace Materialization Candidates',
      included: false,
      approxTokens: 0,
      source: 'xuanpu-agent-trace-materialization',
      reason: 'high-frequency command traces detected',
      metadata: {
        packetId,
        candidates: candidates.map((candidate) => ({
          signature: candidate.signature,
          occurrenceCount: candidate.occurrenceCount,
          traceIds: candidate.traceIds
        }))
      }
    }
  ]
}

function estimateSectionTokens(packet: XfpFieldPacket, name: string): number {
  const section = readPacketSection(packet, name)
  if (section === undefined || section === null) return 0
  return Math.ceil(JSON.stringify(section).length / 4)
}

function countRawRefs(packet: XfpFieldPacket, name: string): number {
  const section = readPacketSection(packet, name)
  if (!section || typeof section !== 'object') return 0
  const rawRefs = (section as { rawRefs?: unknown }).rawRefs
  if (Array.isArray(rawRefs)) return rawRefs.length
  if (name === 'commandTrace' && Array.isArray(packet.commandTrace?.entries)) {
    return packet.commandTrace.entries.reduce((total, entry) => total + entry.rawRefs.length, 0)
  }
  if (name === 'retrievedMemory' && Array.isArray(packet.retrievedMemory?.entries)) {
    return packet.retrievedMemory.entries.reduce((total, entry) => total + entry.rawRefs.length, 0)
  }
  return 0
}

function readPacketSection(packet: XfpFieldPacket, name: string): unknown {
  switch (name) {
    case 'identity':
      return packet.identity
    case 'anchor':
      return packet.anchor
    case 'gitState':
      return packet.gitState
    case 'focus':
      return packet.focus
    case 'terminal':
      return packet.terminal
    case 'tests':
      return packet.tests
    case 'commandTrace':
      return packet.commandTrace
    case 'retrievedMemory':
      return packet.retrievedMemory
    case 'currentGoal':
      return packet.currentGoal
    case 'budget':
      return packet.budget
    default:
      return undefined
  }
}
