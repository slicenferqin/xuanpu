import type { BrowserWindow } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import {
  isAbsolute as pathIsAbsolute,
  relative as pathRelative,
  resolve as pathResolve
} from 'node:path'
import simpleGit from 'simple-git'

import type { DatabaseService } from '../db/database'
import type { Worktree, Session, SessionActivityCreate } from '../db/types'
import type {
  AgentRuntimeAdapter,
  AgentSdkCapabilities,
  PromptOptions
} from './agent-runtime-types'
import { XUANPU_AGENT_CAPABILITIES } from './agent-runtime-types'
import { createLogger } from './logger'
import { resolveXuanpuAgentModelRef, type XuanpuAgentModelRef } from './xuanpu-agent/model-config'
import { loadXuanpuAgentConfig, type XuanpuAgentConfig } from './xuanpu-agent/config-loader'
import type { XuanpuPiPromptPart } from './xuanpu-agent/context-transform'
import { TaskStateManager } from './xuanpu-agent/task-state-manager'
import {
  XuanpuPiAgentSession,
  type XuanpuAgentToolEndEvent,
  type XuanpuAgentToolStartEvent
} from './xuanpu-agent/runtime'
import {
  getXuanpuAgentAllowedTools,
  getXuanpuAgentSystemPromptLines
} from './xuanpu-agent/tool-policy'
import type { XuanpuAgentHarnessMetrics } from './xuanpu-agent/harness/metrics'
import { XfpPacketCompiler, type CompilerDecision } from './xuanpu-agent/harness/compiler'
import { packContext } from './xuanpu-agent/context/context-packer'
import { listFieldEpisodeBlocks } from '../field/episode-block-repository'
import {
  createAgentTurn,
  createAgentTurnUsageEvent,
  updateAgentTurnStatus
} from '../db/turn-repository'
import {
  accumulateUsage as accumulateTaskRunUsage,
  appendEpoch,
  closeEpoch,
  createTaskRun,
  getActiveTaskRun,
  getTaskRun,
  incrementEpochProviderCallCount,
  renewLease,
  updateEpochStartFillRatio,
  updateTaskRunStatus
} from '../db/task-run-repository'
import { extractUsageTokens } from '../../shared/usage/message'
import type {
  AgentTaskRun,
  EpochCloseReason,
  EpochStatus,
  TaskRunAutonomy
} from '../../shared/types/agent-task-run'
import {
  evaluateLeaseAtBoundary,
  NO_PROGRESS_LIMIT,
  shouldCloseEpoch
} from './xuanpu-agent/task-run-policy'
import { inferTaskRunAutonomyFromPromptText } from './xuanpu-agent/task-run-intent'
import type {
  XfpAnchorSection,
  XfpCommandTraceSection,
  XfpFieldPacket,
  XfpGitState,
  XfpMultiWorktreeSection,
  XfpRawRefKind,
  XfpRetrievedMemorySection,
  XfpRetrievedWorkflowSection,
  XfpReviewContextSection,
  XfpTaskGoal
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
import type { SubtaskResultDetails } from './xuanpu-agent/tools/subtask-tools'
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
  loadTraceWorkflowTemplates,
  materializeTraceWorkflowTemplates,
  retrieveTraceWorkflowsForContext,
  type MaterializedTraceWorkflow,
  type RetrievedTraceWorkflow,
  type TraceMaterializationCandidate
} from './xuanpu-agent/memory/trace-materialization'
import {
  verifyPostResponseClaims,
  type PostResponseClaimVerification
} from './xuanpu-agent/harness/post-response-claim-verifier'
import { generateCheckpoint } from '../field/checkpoint-generator'
import { insertCheckpoint, type CheckpointRecord } from '../field/checkpoint-repository'
import { verifyCheckpoint, type ResumedCheckpointBlock } from '../field/checkpoint-verifier'
import { calculateUsageCost, resolvePricingModelKey } from '@shared/usage/pricing'
import {
  buildImageObservationRefFromBase64,
  formatImageObservationRef,
  MediaOffloadStore
} from './xuanpu-agent/media-offloader'

const log = createLogger({ component: 'XuanpuAgentImplementer' })
const DEFAULT_CONTEXT_WINDOW_TOKENS = 150_000
const LEASE_WINDOW_MS = 20 * 60 * 1000

interface XuanpuAgentSessionState {
  sessionId: string
  hiveSessionId: string
  worktreePath: string
  status: 'ready' | 'running' | 'closed' | 'error'
  abortController: AbortController | null
  piSession: XuanpuPiAgentSession | null
  /** The currently active turn id (Phase 1 — turn-scoped execution boundary). */
  activeTurnId: string | null
  activeTaskRunId: string | null
  activeEpochId: string | null
}

type IncomingPromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string }

interface ParsedPromptInput {
  contextText: string
  promptContent: XuanpuPiPromptPart[]
}

async function parseXuanpuAgentPromptInput(
  message: string | IncomingPromptPart[]
): Promise<ParsedPromptInput> {
  if (typeof message === 'string') {
    return {
      contextText: message,
      promptContent: [{ type: 'text', text: message }]
    }
  }

  const textParts: string[] = []
  const promptContent: XuanpuPiPromptPart[] = []
  const attachmentLines: string[] = []
  const mediaOffloadStore = new MediaOffloadStore()

  for (const part of message) {
    if (part.type === 'text') {
      textParts.push(part.text)
      continue
    }

    const filename = part.filename?.trim() || 'unnamed file'
    const mime = part.mime?.trim() || 'unknown'
    const parsedImage = parseDataUriImage(part.url, mime)
    if (parsedImage) {
      const imageRef = buildImageObservationRefFromBase64({
        data: parsedImage.data,
        mimeType: parsedImage.mimeType,
        filename
      })
      try {
        await mediaOffloadStore.writeImage({
          data: parsedImage.data,
          mimeType: parsedImage.mimeType,
          filename
        })
      } catch (error) {
        log.warn('Failed to offload xuanpu-agent prompt image', {
          filename,
          mimeType: parsedImage.mimeType,
          error: error instanceof Error ? error.message : String(error)
        })
      }

      attachmentLines.push(
        [
          `<file kind="image" name="${escapeAttachmentAttribute(filename)}"`,
          `mime="${escapeAttachmentAttribute(parsedImage.mimeType)}"`,
          `bytes="${imageRef.bytes}"`,
          `sha256="${imageRef.sha256}"`,
          `ref="${escapeAttachmentAttribute(imageRef.mediaRef)}">`,
          'image included in current provider turn only; future provider requests use:',
          formatImageObservationRef(imageRef),
          '</file>'
        ].join(' ')
      )
      promptContent.push({
        type: 'image',
        data: parsedImage.data,
        mimeType: parsedImage.mimeType
      })
      continue
    }

    attachmentLines.push(
      `<file kind="data" name="${escapeAttachmentAttribute(filename)}" mime="${escapeAttachmentAttribute(mime)}">content omitted</file>`
    )
  }

  const metadataText =
    attachmentLines.length > 0
      ? ['<attached_files content="metadata-only">', ...attachmentLines, '</attached_files>'].join(
          '\n'
        )
      : ''
  const text = [...(metadataText ? [metadataText] : []), ...textParts].join('\n\n').trim()

  if (text) {
    promptContent.unshift({ type: 'text', text })
  }

  return {
    contextText: text,
    promptContent
  }
}

function parseDataUriImage(
  url: string,
  fallbackMime: string
): { data: string; mimeType: string } | null {
  if (!url.startsWith('data:')) return null
  const commaIndex = url.indexOf(',')
  if (commaIndex < 0) return null
  const header = url.slice(5, commaIndex)
  const payload = url.slice(commaIndex + 1)
  const isBase64 = header.endsWith(';base64')
  const mimeType = (isBase64 ? header.slice(0, -';base64'.length) : header) || fallbackMime
  if (!mimeType.startsWith('image/')) return null
  try {
    const data = isBase64
      ? payload
      : Buffer.from(decodeURIComponent(payload), 'utf-8').toString('base64')
    return { data, mimeType }
  } catch {
    return null
  }
}

function escapeAttachmentAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export class XuanpuAgentImplementer implements AgentRuntimeAdapter {
  readonly id = 'xuanpu-agent' as const
  readonly capabilities: AgentSdkCapabilities = XUANPU_AGENT_CAPABILITIES

  private mainWindow: BrowserWindow | null = null
  private db: DatabaseService | null = null
  private field: FieldProvider | null = null
  private sessions = new Map<string, XuanpuAgentSessionState>()
  private selectedModelRef: XuanpuAgentModelRef | null = null
  private agentConfig: XuanpuAgentConfig | null = null

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  setDatabaseService(db: DatabaseService): void {
    this.db = db
    this.field = new IdeFieldProvider(db)
  }

  private getAgentConfig(): XuanpuAgentConfig | undefined {
    if (this.agentConfig) return this.agentConfig
    const result = loadXuanpuAgentConfig()
    this.agentConfig = result.config
    return result.config
  }

  async connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }> {
    const sessionId = `xuanpu-agent-${randomUUID()}`
    this.sessions.set(sessionId, {
      sessionId,
      hiveSessionId,
      worktreePath,
      status: 'ready',
      abortController: null,
      piSession: null,
      activeTurnId: null,
      activeTaskRunId: null,
      activeEpochId: null
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
      piSession: null,
      activeTurnId: null,
      activeTaskRunId: null,
      activeEpochId: null
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
    modelOverride?: XuanpuAgentModelRef,
    options?: PromptOptions
  ): Promise<void> {
    const session = this.requireSession(agentSessionId, worktreePath)
    const parsedPrompt = await parseXuanpuAgentPromptInput(message)
    const text = parsedPrompt.contextText.trim()
    if (!text) return
    const sessionMode = options?.mode ?? 'build'

    const field = this.requireField()
    const db = this.requireDatabase()
    const worktree = field.getWorktree(session.worktreePath)
    const fieldSession = field.getSession(session.hiveSessionId)
    const projectId = worktree?.projectId ?? fieldSession?.projectId
    if (!projectId) {
      throw new Error(`xuanpu-agent session has no project binding: ${session.hiveSessionId}`)
    }
    const priorMessages = field.getPriorTurns(session.hiveSessionId)

    beginSessionRun(session.hiveSessionId)
    const userMessageId = `xuanpu-agent-user-${randomUUID()}`
    field.persistMessage(session.hiveSessionId, 'user', text, { messageId: userMessageId })

    const agentConfig = this.getAgentConfig()
    const modelRef = resolveXuanpuAgentModelRef(modelOverride, this.selectedModelRef, agentConfig)
    const explicitTaskRun = options?.taskRunId ? getTaskRun(options.taskRunId, db) : null
    const implicitTaskRun =
      !explicitTaskRun && shouldResumeActiveTaskRunFromPromptText(text)
        ? getActiveTaskRun(session.hiveSessionId, db)
        : null
    const requestedTaskRun =
      explicitTaskRun ?? (implicitTaskRun?.status === 'paused' ? implicitTaskRun : null)
    const reusableTaskRun =
      requestedTaskRun &&
      requestedTaskRun.sessionId === session.hiveSessionId &&
      (requestedTaskRun.status === 'running' || requestedTaskRun.status === 'paused')
        ? requestedTaskRun
        : null
    const requestedAutonomy: TaskRunAutonomy =
      options?.taskRunAutonomy ?? inferTaskRunAutonomyFromPromptText(text) ?? 'short'
    const taskRunAutonomy: TaskRunAutonomy = reusableTaskRun?.autonomy ?? requestedAutonomy
    const taskRun: AgentTaskRun =
      reusableTaskRun ??
      createTaskRun(
        {
          sessionId: session.hiveSessionId,
          worktreeId: worktree?.id ?? null,
          projectId,
          originMessageId: userMessageId,
          autonomy: taskRunAutonomy,
          objective: text,
          leaseExpiresAt:
            taskRunAutonomy === 'short'
              ? null
              : new Date(Date.now() + LEASE_WINDOW_MS).toISOString()
        },
        db
      )
    if (reusableTaskRun?.status === 'paused') {
      updateTaskRunStatus(
        taskRun.id,
        'running',
        {
          leaseExpiresAt:
            taskRun.leaseExpiresAt ??
            (taskRunAutonomy === 'short'
              ? null
              : new Date(Date.now() + LEASE_WINDOW_MS).toISOString())
        },
        db
      )
    }

    let taskStateManager: TaskStateManager | null = null
    try {
      taskStateManager = new TaskStateManager({
        taskRunId: taskRun.id,
        sessionId: session.hiveSessionId,
        db: this.db
      })
      taskStateManager.initialize(taskRun.objective ?? text)
    } catch (error) {
      taskStateManager = null
      log.warn('Failed to initialize xuanpu-agent task state', {
        taskRunId: taskRun.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    const epoch = appendEpoch(
      {
        taskRunId: taskRun.id,
        sessionId: session.hiveSessionId
      },
      db
    )

    // INV-TURN-2: Every prompt creates a turn record. Must not be best-effort.
    const turnId = createAgentTurn(
      {
        sessionId: session.hiveSessionId,
        worktreeId: worktree?.id ?? null,
        projectId,
        runtimeId: 'xuanpu-agent',
        taskRunId: taskRun.id,
        epochId: epoch.id,
        userMessageId,
        modelProviderId: modelRef.providerID,
        modelId: modelRef.modelID,
        modelVariant: modelRef.variant ?? null
      },
      db
    ).id
    session.activeTurnId = turnId
    session.activeTaskRunId = taskRun.id
    session.activeEpochId = epoch.id

    session.status = 'running'
    // NOTE: AbortController is a placeholder for future signal wiring.
    // Actual abort is handled by piSession.abort() below.
    session.abortController = new AbortController()
    this.emitStatus(session.hiveSessionId, 'busy')

    // ── Build field context via FieldProvider (IDE or CLI) ──
    const gitState = await this.buildGitStateForWorktree(session.worktreePath)
    const commandTrace = this.buildCommandTraceSection(session.hiveSessionId, worktree?.id)
    const memoryRetrieval = worktree
      ? this.buildMemoryRetrievalSection(text, worktree, session.hiveSessionId)
      : null
    const resumedCheckpoint = worktree
      ? await this.verifyCheckpointForContext(worktree, session.worktreePath)
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
    const materializedWorkflows =
      worktree && traceCandidates.length > 0
        ? this.materializeTraceWorkflows(session.worktreePath, worktree, traceCandidates)
        : []
    const retrievedWorkflows = worktree
      ? this.buildRetrievedWorkflowSection(
          this.retrieveTraceWorkflows(text, session.worktreePath, materializedWorkflows)
        )
      : null
    const multiWorktree = worktree ? this.buildMultiWorktreeSection(worktree) : null
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
        retrievedWorkflows,
        multiWorktree,
        reviewContext: worktree ? buildReviewContextSection(worktree, gitState) : null,
        anchor: worktree ? buildAnchorSection(worktree, resumedCheckpoint) : null,
        currentGoal: buildCurrentGoalFromCheckpoint(text, session.hiveSessionId, resumedCheckpoint),
        compressionRatio
      }
    )

    // M7.1: Load episode records for packer deduplication.
    // Pre-flight freeze is intentionally not run here: frozen episodes are part
    // of the stable prefix and should only change at epoch / soft-shrink edges.
    const episodeRecords = worktree
      ? listFieldEpisodeBlocks({
          worktreeId: worktree.id,
          sessionId: session.hiveSessionId,
          limit: 200
        })
      : []

    // M7.5: Gated episode retrieval (before packer, so retrieved episodes enter active prompt)
    const episodeCandidates = worktree
      ? field.getEpisodeCandidates(worktree.id, session.hiveSessionId)
      : []
    const episodeRetrieval = field.retrieveEpisodes(
      text,
      episodeCandidates,
      priorMessages,
      session.hiveSessionId
    )
    const retrievedEpisodeEntries = episodeRetrieval.included.map((ep) => {
      const record = episodeRecords.find((r) => r.id === ep.id)
      return {
        episode: record ?? {
          id: ep.id,
          worktreeId: worktree?.id ?? 'unknown',
          sessionId: session.hiveSessionId,
          createdAt: ep.createdAt,
          kind: 'turns' as const,
          title: ep.title,
          summaryMarkdown: ep.summaryMarkdown,
          keyFacts: ep.keyFacts ?? [],
          constraints: ep.constraints ?? [],
          files: ep.files ?? [],
          commands: ep.commands ?? [],
          failures: ep.failures ?? [],
          rawRefs: [],
          tokenEstimate: ep.tokenEstimate,
          confidence: 'medium' as const,
          metadata: {}
        },
        retrievalReason: episodeRetrieval.triggers.join('; ') || 'gated-retrieval'
      }
    })

    // ── M7.1: Assemble messages via Context Packer (replaces buildMessages) ──
    try {
      const piSession = this.getOrCreatePiSession(session)
      piSession.setWorktreePath(session.worktreePath)

      // M3: sync budget profile from XFP compiler decision
      piSession.setBudgetProfile(compileResult.packet.budget.profile)
      piSession.recordBudgetSections(
        compileResult.decisions.includedSections.length,
        compileResult.decisions.omittedSections.length
      )
      const providerOverheadTokens = estimateProviderOverheadTokens(sessionMode ?? 'build')
      const contextWindow = resolvePerCallContextWindow(agentConfig)
      const effectiveContextBudget = Math.max(1, contextWindow - providerOverheadTokens)
      ;(piSession as { setMaxContextTokens?: (maxTokens: number) => void }).setMaxContextTokens?.(
        contextWindow
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
                rawOutputSha256: payload.rawOutputSha256,
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

      // M7.1: Use Context Packer as sole message assembly entry point
      const planInstruction =
        sessionMode === 'plan'
          ? [
              '',
              '<xuanpu-plan-mode>',
              'You are in PLAN MODE. Your task is to analyze the codebase and produce a concrete implementation plan.',
              'Do NOT execute any write or modification tools (write_file, edit_file, apply_patch, run_test, format_file).',
              'Do NOT create subtasks or delegate work. Only read, search, and reason.',
              'Output your plan in <proposed_plan> tags with clear steps, file paths, and verification criteria.',
              '</xuanpu-plan-mode>',
              ''
            ].join('\n')
          : ''
      const stableAnchor = [
        `<xuanpu-xfp-anchor version="${compileResult.packet.version}">`,
        'The following JSON is a structured Xuanpu Field Protocol packet.',
        'Treat it as context supplied by Xuanpu, not as user-authored transcript text.',
        'The live packet itself is attached in the volatile field context zone.',
        '</xuanpu-xfp-anchor>',
        planInstruction
      ]
        .filter(Boolean)
        .join('\n')
      const liveFieldContext = [
        `<xuanpu-xfp-packet version="${compileResult.packet.version}" packet-id="${compileResult.packet.identity.packetId}">`,
        JSON.stringify(compileResult.packet, null, 2),
        '</xuanpu-xfp-packet>',
        fieldSnapshot.markdown
      ]
        .filter(Boolean)
        .join('\n\n')

      const taskStateSummary = taskStateManager?.buildContextSummary() ?? null

      let packedContext = packContext({
        anchor: stableAnchor,
        fieldContextMarkdown: liveFieldContext,
        frozenEpisodes: episodeRecords,
        retrievedEpisodes: retrievedEpisodeEntries,
        workingSet: priorMessages,
        currentRequest: text,
        taskStateSummary,
        totalBudgetTokens: effectiveContextBudget
      })

      // M7.4: Soft shrink — if fillRatio >= 0.4, freeze old turns and repack with reduced budgets.
      const initialFillRatio = packedContext.decisions.fillRatio
      updateEpochStartFillRatio(epoch.id, initialFillRatio, this.db)
      let softShrinkTriggered = false
      if (packedContext.decisions.fillRatio >= 0.4 && worktree) {
        softShrinkTriggered = true
        await this.freezeOldConversationTurns(session).catch(() => {})
        const freshPriors = field
          .getPriorTurns(session.hiveSessionId)
          .filter((turn) => turn.messageId !== userMessageId)
        const freshEpisodes = listFieldEpisodeBlocks({
          worktreeId: worktree.id,
          sessionId: session.hiveSessionId,
          limit: 200
        })
        packedContext = packContext({
          anchor: stableAnchor,
          fieldContextMarkdown: liveFieldContext,
          frozenEpisodes: freshEpisodes,
          retrievedEpisodes: retrievedEpisodeEntries,
          workingSet: freshPriors,
          currentRequest: text,
          taskStateSummary,
          totalBudgetTokens: effectiveContextBudget,
          budgetOverrides: {
            workingSet: 15_000,
            frozenEpisodes: 6_000
          }
        })
      }

      // Record fill ratio to budget manager
      piSession.budgetManager.recordPackerFillRatio(
        packedContext.decisions.fillRatio,
        packedContext.decisions.totalTokens
      )

      const promptMessage = {
        ...packedContext.providerPromptMessage,
        content:
          parsedPrompt.promptContent.length > 0
            ? parsedPrompt.promptContent
            : packedContext.providerPromptMessage.content
      }
      const harnessMessages = [...packedContext.providerContextMessages, promptMessage]

      const observedPaths = new Set<string>()
      const completedToolCalls: XuanpuAgentToolEndEvent[] = []
      let toolResultCount = 0
      let latestAssistantText = ''
      const providerCallEvents: Array<{ sourceEventId: string; cost: number }> = []
      let taskRunCost = 0
      let noProgressCalls = 0
      let lastProgressSignal = 0
      let beforeYieldCount = 0
      let leaseExpiresAt = taskRun.leaseExpiresAt
      let epochClosed = false
      let taskRunContinuationQueued = false
      let taskRunPaused = false
      let taskRunPauseReason: string | null = null
      const promptIsNoProgressRecovery = isNoProgressRecoveryContinuationPrompt(text)
      const epochStartedAt = Date.now()
      const dbSessionForUsage = this.db?.getSession(session.hiveSessionId)
      const currentEpochFillRatio = (): number => {
        const runtimeFillRatio = piSession.budgetManager.state.fillRatio
        return typeof runtimeFillRatio === 'number' && runtimeFillRatio > 0
          ? runtimeFillRatio
          : packedContext.decisions.fillRatio
      }
      const closeEpochOnce = async (
        reason: EpochCloseReason,
        status?: EpochStatus
      ): Promise<string | null> => {
        if (epochClosed) return null

        const checkpointId =
          worktree && (reason === 'compact' || reason === 'checkpoint' || reason === 'watchdog')
            ? await this.persistEpochCheckpoint({
                session,
                worktree,
                taskRunId: taskRun.id,
                epochId: epoch.id,
                reason,
                objective: taskRun.objective ?? text,
                latestAssistantText,
                gitState
              })
            : null
        closeEpoch(
          epoch.id,
          {
            status: status ?? epochStatusForCloseReason(reason),
            checkpointId,
            endFillRatio: currentEpochFillRatio(),
            closeReason: reason
          },
          this.db
        )
        epochClosed = true
        return checkpointId
      }
      const pauseTaskRun = async (reason: string): Promise<void> => {
        await closeEpochOnce('watchdog', 'failed')
        updateTaskRunStatus(taskRun.id, 'paused', { errorMessage: reason }, this.db)
        taskRunPaused = true
        taskRunPauseReason = reason
      }
      const queueNoProgressRecovery = async (): Promise<void> => {
        await closeEpochOnce('watchdog', 'checkpointed')
        queueContinuation(
          buildNoProgressRecoveryContinuationPrompt({
            objective: taskRun.objective ?? text,
            latestAssistantText
          })
        )
      }
      const evaluateLease = async (): Promise<boolean> => {
        if (!leaseExpiresAt) return true
        const leaseDeadlineMs = Date.parse(leaseExpiresAt)
        if (!Number.isFinite(leaseDeadlineMs) || Date.now() < leaseDeadlineMs) return true

        const decision = evaluateLeaseAtBoundary({
          autonomy: taskRunAutonomy,
          noProgressCalls,
          costSinceStart: taskRunCost,
          hasPendingRiskyWrite: false
        })
        if (decision.action === 'renew') {
          renewLease(taskRun.id, decision.nextExpiresAt, this.db)
          leaseExpiresAt = decision.nextExpiresAt
          return true
        }

        await closeEpochOnce('checkpoint', 'checkpointed')
        updateTaskRunStatus(
          taskRun.id,
          'paused',
          {
            errorMessage:
              decision.action === 'pause'
                ? decision.reason
                : `Approval required: ${decision.prompt}`
          },
          this.db
        )
        taskRunPaused = true
        taskRunPauseReason =
          decision.action === 'pause' ? decision.reason : `Approval required: ${decision.prompt}`
        return false
      }
      const queueContinuation = (content?: string): void => {
        if (taskRunContinuationQueued || taskRunPaused || taskRunAutonomy === 'short') return
        if (!this.db) return
        try {
          this.db.createSessionPendingMessage({
            session_id: session.hiveSessionId,
            agent_session_id: session.sessionId,
            runtime_id: 'xuanpu-agent',
            content: content ?? buildEpochContinuationPrompt(taskRun.objective ?? text),
            prompt_options_json: JSON.stringify({
              mode: sessionMode,
              taskRunAutonomy,
              taskRunId: taskRun.id
            }),
            model_json: JSON.stringify(modelRef)
          })
          taskRunContinuationQueued = true
        } catch (error) {
          log.warn('Failed to enqueue xuanpu-agent epoch continuation', {
            taskRunId: taskRun.id,
            epochId: epoch.id,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
      piSession.setFollowUpMode('one-at-a-time')
      piSession.setOnBeforeYield(async () => {
        beforeYieldCount++
        const progressSignal = observedPaths.size + toolResultCount
        if (progressSignal <= lastProgressSignal) {
          noProgressCalls++
        } else {
          noProgressCalls = 0
        }
        lastProgressSignal = progressSignal

        if (taskRunAutonomy !== 'short' && isCompleteLongTaskResponse(latestAssistantText)) return

        if (taskRunAutonomy !== 'short' && noProgressCalls >= NO_PROGRESS_LIMIT) {
          const hasConcreteProgress = progressSignal > 0
          if (promptIsNoProgressRecovery && !hasConcreteProgress) {
            await pauseTaskRun('no progress after recovery')
          } else if (promptIsNoProgressRecovery) {
            await closeEpochOnce('checkpoint', 'checkpointed')
            queueContinuation()
          } else {
            await queueNoProgressRecovery()
          }
          return
        }

        const leaseOk = await evaluateLease()
        if (!leaseOk) return

        const providerCallCount = Math.max(providerCallEvents.length, beforeYieldCount)
        const boundary = shouldCloseEpoch({
          fillRatio: currentEpochFillRatio(),
          providerCallCount,
          elapsedMs: Date.now() - epochStartedAt,
          autonomy: taskRunAutonomy
        })

        if (boundary.close) {
          await closeEpochOnce(boundary.reason)
          if (taskRunAutonomy !== 'short' && boundary.reason !== 'turn_end') {
            queueContinuation()
          }
          return
        }

        if (taskRunAutonomy !== 'short' && !piSession.hasQueuedMessages()) {
          piSession.followUp({
            role: 'user',
            content: [
              { type: 'text', text: buildInEpochFollowUpPrompt(taskRun.objective ?? text) }
            ],
            timestamp: Date.now()
          })
        }
      })
      const result = await piSession.prompt(
        harnessMessages,
        modelRef,
        {
          onTextDelta: (delta, meta) => {
            latestAssistantText += delta
            this.emitTextDelta(session.hiveSessionId, delta, meta.turnId, meta.eventSequence)
          },
          onToolStart: (event, meta) => {
            if (event.toolName === 'xfp_delegate_subtask') {
              this.emitSubtaskStart(session.hiveSessionId, event, meta.turnId, meta.eventSequence)
            }
            this.persistToolStart(session.hiveSessionId, event, meta.turnId)
            this.emitToolStart(session.hiveSessionId, event, meta.turnId, meta.eventSequence)
          },
          onToolEnd: (event, meta) => {
            completedToolCalls.push(event)
            if (!event.isError) {
              toolResultCount++
              collectObservedToolPaths(
                session.worktreePath,
                event.toolName,
                event.args,
                event.result,
                observedPaths
              )
            }
            const subtaskDetails = extractSubtaskDetails(event.result)
            if (subtaskDetails) {
              this.emitSubtaskEnd(
                session.hiveSessionId,
                event,
                subtaskDetails,
                meta.turnId,
                meta.eventSequence
              )
            }
            this.persistToolEnd(session.hiveSessionId, event, meta.turnId)
            this.emitToolEnd(session.hiveSessionId, event, meta.turnId, meta.eventSequence)
          },
          onProviderCall: (call) => {
            const tokenCounts = extractUsageTokens({ usage: call.usage })
            if (!tokenCounts) return
            const inputTokens = tokenCounts.input ?? 0
            const outputTokens = tokenCounts.output ?? 0
            const cacheRead = tokenCounts.cacheRead ?? 0
            const cacheWrite = tokenCounts.cacheWrite ?? 0
            const total = inputTokens + outputTokens + cacheRead + cacheWrite
            if (total <= 0) return

            const sourceEventId = `${turnId}:provider-call:${call.providerCallSeq}`
            const modelKey = resolvePricingModelKey(call.modelID, call.providerID)
            const cost = calculateUsageCost(
              modelKey,
              {
                input: inputTokens,
                output: outputTokens,
                cacheRead,
                cacheWrite
              },
              'xuanpu-agent'
            )
            const occurredAt = new Date().toISOString()
            try {
              createAgentTurnUsageEvent(
                {
                  turnId,
                  sessionId: session.hiveSessionId,
                  sourceEventId,
                  providerId: call.providerID,
                  modelId: call.modelID,
                  inputTokens,
                  outputTokens,
                  cacheWriteTokens: cacheWrite,
                  cacheReadTokens: cacheRead,
                  totalTokens: total,
                  cost,
                  rawUsageJson: JSON.stringify(call.usage),
                  epochId: epoch.id,
                  providerCallSeq: call.providerCallSeq,
                  reasoningEffort: call.reasoningEffort ?? modelRef.reasoningEffort ?? null,
                  actualPrefixHash:
                    call.actualPrefixHash || packedContext.decisions.actualPrefixHash,
                  occurredAt
                },
                this.db
              )
              incrementEpochProviderCallCount(epoch.id, this.db)
              accumulateTaskRunUsage(taskRun.id, { inputTokens, outputTokens, cost }, this.db)
              taskRunCost += cost
              providerCallEvents.push({ sourceEventId, cost })

              if (this.db && dbSessionForUsage) {
                this.db.upsertUsageEntry({
                  session_id: session.hiveSessionId,
                  project_id: dbSessionForUsage.project_id,
                  worktree_id: dbSessionForUsage.worktree_id ?? null,
                  agent_sdk: 'xuanpu-agent',
                  source_kind: 'xuanpu-agent-provider-call',
                  source_message_id: sourceEventId,
                  provider_id: call.providerID,
                  model_id: modelKey,
                  model_label: call.modelID,
                  input_tokens: inputTokens,
                  output_tokens: outputTokens,
                  cache_write_tokens: cacheWrite,
                  cache_read_tokens: cacheRead,
                  total_tokens: total,
                  cost,
                  occurred_at: occurredAt
                })
              }
            } catch (err) {
              log.warn('Failed to persist provider-call usage event', {
                error: err instanceof Error ? err.message : String(err)
              })
            }
          }
        },
        sessionMode,
        turnId,
        {
          profile:
            packedContext.decisions.fillRatio > 0.5
              ? 'focused'
              : packedContext.decisions.fillRatio > 0.15
                ? 'balanced'
                : 'extended',
          managedApproxTokens: packedContext.decisions.totalTokens,
          providerEstimatedInputTokens:
            packedContext.decisions.totalTokens + providerOverheadTokens,
          maxContextTokens: contextWindow,
          fillRatio: packedContext.decisions.fillRatio
        },
        packedContext.decisions.actualPrefixHash,
        compileResult.packet.identity.packetId
      )

      const assistantText = result.text.trim()
      const content = assistantText || '(empty response)'
      latestAssistantText = content
      const claimVerification = verifyPostResponseClaims({
        text: content,
        worktreePath: session.worktreePath,
        observedPaths
      })
      field.persistMessage(session.hiveSessionId, 'assistant', content, {
        messageId: result.messageId,
        modelProviderId: result.modelRef.providerID,
        modelId: result.modelRef.modelID,
        usage: result.usage,
        rawMessage: result.rawMessage
      })

      // Phase 1: Mark turn as completed.
      if (session.activeTurnId) {
        updateAgentTurnStatus(
          session.activeTurnId,
          'completed',
          {
            assistantMessageId: result.messageId
          },
          this.db
        )
      }

      try {
        taskStateManager?.updateFromTurn({
          userMessage: text,
          assistantMessage: content,
          toolCalls: completedToolCalls.map((toolCall) => ({
            name: toolCall.toolName,
            args: toolCall.args,
            result: extractToolResultText(toolCall.result),
            isError: toolCall.isError
          })),
          filesChanged: Array.from(observedPaths),
          errors: completedToolCalls
            .filter((toolCall) => toolCall.isError)
            .map(
              (toolCall) => extractToolResultText(toolCall.result) || `${toolCall.toolName} failed`
            )
        })
      } catch (error) {
        log.warn('Failed to update xuanpu-agent task state', {
          taskRunId: taskRun.id,
          error: error instanceof Error ? error.message : String(error)
        })
      }

      this.emitMessageUpdated(session.hiveSessionId, content, {
        messageId: result.messageId,
        modelRef: result.modelRef,
        usage: result.usage,
        contextPackageId: compileResult.packet.identity.packetId,
        turnId: result.turnId
      })

      // ── INV-TURN-4: Three-layer context_usage ──
      const rawUsage = (result.usage ?? {}) as Record<string, unknown>
      const tokenCounts = extractUsageTokens({ usage: rawUsage })
      const inputTokens = tokenCounts?.input ?? 0
      const outputTokens = tokenCounts?.output ?? null
      const cacheRead = tokenCounts?.cacheRead ?? null
      const cacheWrite = tokenCounts?.cacheWrite ?? null
      const runtimeContextWindow = piSession.budgetManager.state.maxTokens
      const managedTokens = packedContext.decisions.totalTokens
      const providerActualInput = tokenCounts?.input ?? null
      const providerActualCacheRead = tokenCounts?.cacheRead ?? null

      emitAgentEvent(this.mainWindow, {
        type: 'session.context_usage',
        sessionId: session.hiveSessionId,
        runtimeId: this.id,
        turnId: result.turnId,
        origin: 'system',
        data: {
          managedContext: {
            approxTokens: managedTokens,
            maxContextTokens: runtimeContextWindow,
            fillRatio: packedContext.decisions.fillRatio,
            includedMessages: packedContext.providerContextMessages.length + 1,
            source: 'context-packer'
          },
          providerRequest: {
            estimatedInputTokens: managedTokens + providerOverheadTokens,
            providerRequestHash: result.snapshotHash ?? packedContext.decisions.actualPrefixHash,
            prefixHash: packedContext.decisions.actualPrefixHash ?? null,
            messageCount: packedContext.providerContextMessages.length + 1,
            source: 'provider-request-snapshot'
          },
          providerActual: {
            inputTokens: providerActualInput,
            outputTokens,
            cacheReadTokens: providerActualCacheRead,
            cacheWriteTokens: cacheWrite,
            source: tokenCounts ? 'provider-usage' : 'unavailable'
          },
          model: { providerID: result.modelRef.providerID, modelID: result.modelRef.modelID }
        }
      })

      // ── INV-TURN-4: Per-turn usage ledger ──
      if (providerCallEvents.length === 0 && tokenCounts) {
        const total = inputTokens + outputTokens + cacheRead + cacheWrite
        if (total > 0) {
          try {
            createAgentTurnUsageEvent(
              {
                turnId,
                sessionId: session.hiveSessionId,
                sourceEventId: result.messageId,
                providerId: result.modelRef.providerID,
                modelId: result.modelRef.modelID,
                inputTokens,
                outputTokens,
                cacheWriteTokens: cacheWrite,
                cacheReadTokens: cacheRead,
                totalTokens: total,
                rawUsageJson: JSON.stringify(rawUsage),
                epochId: epoch.id,
                providerCallSeq: 0,
                reasoningEffort: modelRef.reasoningEffort ?? null,
                actualPrefixHash: packedContext.decisions.actualPrefixHash,
                occurredAt: new Date().toISOString()
              },
              this.db
            )
          } catch (err) {
            log.warn('Failed to persist turn usage event', {
              error: err instanceof Error ? err.message : String(err)
            })
          }
        }
      }

      // Persist usage entry for cost tracking
      if (providerCallEvents.length === 0 && this.db && tokenCounts) {
        try {
          const dbSession = this.db.getSession(session.hiveSessionId)
          if (dbSession) {
            const total = inputTokens + outputTokens + cacheRead + cacheWrite
            if (total > 0) {
              const modelKey = resolvePricingModelKey(
                result.modelRef.modelID,
                result.modelRef.providerID
              )
              const cost = calculateUsageCost(
                modelKey,
                {
                  input: inputTokens,
                  output: outputTokens,
                  cacheRead: cacheRead,
                  cacheWrite: cacheWrite
                },
                'xuanpu-agent'
              )
              incrementEpochProviderCallCount(epoch.id, this.db)
              accumulateTaskRunUsage(taskRun.id, { inputTokens, outputTokens, cost }, this.db)
              taskRunCost += cost
              this.db.upsertUsageEntry({
                session_id: session.hiveSessionId,
                project_id: dbSession.project_id,
                worktree_id: dbSession.worktree_id ?? null,
                agent_sdk: 'xuanpu-agent',
                source_kind: 'xuanpu-agent-message',
                source_message_id: result.messageId,
                provider_id: result.modelRef.providerID,
                model_id: modelKey,
                model_label: result.modelRef.modelID,
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_write_tokens: cacheWrite,
                cache_read_tokens: cacheRead,
                total_tokens: total,
                cost,
                occurred_at: new Date().toISOString()
              })
            }
          }
        } catch (err) {
          log.warn('Failed to persist xuanpu-agent usage entry', {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }

      // Plan mode: emit plan.ready if model produced a structured plan
      if (sessionMode === 'plan' && assistantText) {
        const planText = extractProposedPlan(assistantText) ?? assistantText
        const requestId = `xuanpu-agent-plan:${session.hiveSessionId}:${Date.now()}`
        if (this.db) {
          try {
            this.db.upsertSessionActivity({
              id: requestId,
              session_id: session.hiveSessionId,
              agent_session_id: session.hiveSessionId,
              thread_id: session.hiveSessionId,
              turn_id: session.activeTurnId ?? result.messageId,
              item_id: result.messageId,
              request_id: requestId,
              kind: 'plan.ready',
              tone: 'info',
              summary: 'Plan ready',
              payload_json: JSON.stringify({
                plan: planText,
                toolUseID: result.messageId,
                requestId
              })
            })
          } catch (err) {
            log.warn('Failed to persist plan.ready activity', {
              error: err instanceof Error ? err.message : String(err)
            })
          }
        }
        emitAgentEvent(this.mainWindow, {
          type: 'plan.ready',
          sessionId: session.hiveSessionId,
          runtimeId: this.id,
          turnId: result.turnId,
          origin: 'system',
          data: { id: requestId, requestId, plan: planText, toolUseID: result.messageId }
        })
      }

      if (!claimVerification.passed && claimVerification.correctionText) {
        const verifierMessageId = `xuanpu-agent-claim-verifier-${randomUUID()}`
        field.persistMessage(session.hiveSessionId, 'assistant', claimVerification.correctionText, {
          messageId: verifierMessageId,
          modelProviderId: result.modelRef.providerID,
          modelId: result.modelRef.modelID,
          rawMessage: {
            verifier: 'post-response-claim-verifier',
            unverifiedClaims: claimVerification.unverifiedClaims
          }
        })
        this.emitMessageUpdated(session.hiveSessionId, claimVerification.correctionText, {
          messageId: verifierMessageId,
          modelRef: result.modelRef,
          contextPackageId: compileResult.packet.identity.packetId,
          turnId: result.turnId
        })
      }

      // Record context package for audit/debug (M7.2: derive from packer output)
      if (worktree) {
        try {
          await this.createContextPackage(session, text, modelRef, priorMessages, {
            packet: compileResult.packet,
            decisions: compileResult.decisions,
            fieldSnapshotMarkdown: fieldSnapshot.markdown,
            memoryRetrieval,
            traceCandidates,
            materializedWorkflows,
            retrievedWorkflows:
              retrievedWorkflows?.entries.map((entry) => ({
                workflowId: entry.workflowId,
                retrievalReason: entry.retrievalReason
              })) ?? [],
            resumedCheckpoint,
            claimVerification,
            harnessMetrics: result.harnessMetrics,
            packerOutput: packedContext,
            softShrinkMeta: { triggered: softShrinkTriggered, initialFillRatio },
            sessionMode,
            turnId: result.turnId,
            snapshotHash: result.snapshotHash
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

      const shouldContinueIncompleteLongTask =
        taskRunAutonomy !== 'short' && isIncompleteLongTaskResponse(content)
      const completedLongTaskResponse =
        taskRunAutonomy !== 'short' && isCompleteLongTaskResponse(content)

      if (shouldContinueIncompleteLongTask && !epochClosed) {
        await closeEpochOnce('turn_end')
        queueContinuation(
          buildIncompleteResponseContinuationPrompt({
            objective: taskRun.objective ?? text,
            latestAssistantText: content
          })
        )
      }

      if (!epochClosed) {
        const providerCallCount = Math.max(providerCallEvents.length, beforeYieldCount)
        const boundary = shouldCloseEpoch({
          fillRatio: currentEpochFillRatio(),
          providerCallCount,
          elapsedMs: Date.now() - epochStartedAt,
          autonomy: taskRunAutonomy
        })
        const reason: EpochCloseReason = softShrinkTriggered ? 'compact' : boundary.reason
        if (softShrinkTriggered || boundary.close || taskRunAutonomy === 'short') {
          await closeEpochOnce(reason)
          if (taskRunAutonomy !== 'short' && reason !== 'turn_end') {
            queueContinuation()
          }
        }
      }
      if (completedLongTaskResponse && !epochClosed) {
        await closeEpochOnce('turn_end')
      }
      if (
        (!taskRunPaused || (taskRunPauseReason === 'no progress' && completedLongTaskResponse)) &&
        !taskRunContinuationQueued
      ) {
        updateTaskRunStatus(taskRun.id, 'completed', undefined, this.db)
      }
      session.activeTurnId = null
      session.activeTaskRunId = null
      session.activeEpochId = null
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

      // Phase 1: Mark turn as failed.
      if (session.activeTurnId) {
        updateAgentTurnStatus(session.activeTurnId, 'failed', { errorMessage }, this.db)
      }
      if (session.activeEpochId) {
        closeEpoch(
          session.activeEpochId,
          {
            status: 'failed',
            endFillRatio: null,
            closeReason: 'watchdog'
          },
          this.db
        )
      }
      if (session.activeTaskRunId) {
        updateTaskRunStatus(session.activeTaskRunId, 'failed', { errorMessage }, this.db)
      }

      field.persistMessage(session.hiveSessionId, 'assistant', errorMessage)
      session.status = 'error'
      session.abortController = null
      session.activeTurnId = null
      session.activeTaskRunId = null
      session.activeEpochId = null
      this.emitError(session.hiveSessionId, errorMessage)
      this.emitStatus(session.hiveSessionId, 'idle')
      throw new Error(errorMessage)
    } finally {
      // Tool mode restoration is handled by runtime.prompt() internally
    }
  }

  async abort(_worktreePath: string, agentSessionId: string): Promise<boolean> {
    const session = this.sessions.get(agentSessionId)
    if (!session) return false
    if (!session.abortController) {
      session.status = 'ready'
      this.emitStatus(session.hiveSessionId, 'idle')
      return true
    }

    // Phase 1: Mark active turn as aborted.
    if (session.activeTurnId) {
      updateAgentTurnStatus(
        session.activeTurnId,
        'aborted',
        {
          errorMessage: 'Aborted by user'
        },
        this.db
      )
      session.activeTurnId = null
    }
    if (session.activeEpochId) {
      closeEpoch(
        session.activeEpochId,
        {
          status: 'failed',
          endFillRatio: null,
          closeReason: 'watchdog'
        },
        this.db
      )
      session.activeEpochId = null
    }
    if (session.activeTaskRunId) {
      updateTaskRunStatus(
        session.activeTaskRunId,
        'aborted',
        { errorMessage: 'Aborted by user' },
        this.db
      )
      session.activeTaskRunId = null
    }

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
        : resolveXuanpuAgentModelRef(undefined, this.selectedModelRef, this.getAgentConfig())
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

  setSelectedModel(model: XuanpuAgentModelRef): void {
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
      materializedWorkflows?: MaterializedTraceWorkflow[]
      retrievedWorkflows?: Array<{ workflowId: string; retrievalReason: string }>
      resumedCheckpoint?: ResumedCheckpointBlock | null
      claimVerification?: PostResponseClaimVerification
      harnessMetrics?: XuanpuAgentHarnessMetrics | null
      /** M7.2: Packer output — when provided, skip internal retrieval. */
      packerOutput?: {
        providerContextMessages: unknown[]
        providerPromptMessage: unknown
        decisions: Record<string, unknown>
        includedRetrievedEpisodes?: unknown[]
      }
      /** M7.4: Soft shrink metadata. */
      softShrinkMeta?: { triggered: boolean; initialFillRatio: number }
      /** Session mode from PromptOptions ('build' | 'plan'). */
      sessionMode?: 'build' | 'plan'
      /** INV-TURN-5: Turn-scoped id for cross-referencing snapshots. */
      turnId?: string
      /** INV-TURN-5: Provider request snapshot hash for audit alignment. */
      snapshotHash?: string
    } = {}
  ): Promise<{
    contextPackageId: string | null
    retrievedEpisodes: FieldEpisode[]
  } | null> {
    const field = this.requireField()
    const worktree = field.getWorktree(session.worktreePath)
    if (!worktree) return null

    // M7.2: When packer output is provided, use its decisions instead of re-doing retrieval
    let episodeCandidates: FieldEpisode[]
    let episodeRetrieval: { included: FieldEpisode[]; dropped: number; triggers: string[] }
    if (options.packerOutput) {
      // Packer already did retrieval — derive from packer output
      const packerRetrieved = options.packerOutput.decisions.zones.retrievedEpisodes
      episodeCandidates = []
      episodeRetrieval = {
        included: (options.packerOutput.includedRetrievedEpisodes ?? []).map(
          (e) => e.episode as unknown as FieldEpisode
        ),
        dropped: packerRetrieved.dropped,
        triggers: packerRetrieved.reasons
      }
    } else {
      episodeCandidates = field.getEpisodeCandidates(worktree.id, session.hiveSessionId)
      episodeRetrieval = field.retrieveEpisodes(
        userText,
        episodeCandidates,
        priorMessages,
        session.hiveSessionId
      )
    }
    const packet = options.packet ?? null
    const baseSections =
      packet && options.decisions
        ? buildContextPackageSections(packet, options.decisions, {
            episodeCandidates,
            retrievedEpisodes: episodeRetrieval.included,
            episodeTriggers: episodeRetrieval.triggers,
            memoryRetrieval: options.memoryRetrieval ?? null,
            traceCandidates: options.traceCandidates ?? [],
            materializedWorkflows: options.materializedWorkflows ?? [],
            retrievedWorkflows: options.retrievedWorkflows ?? [],
            resumedCheckpoint: options.resumedCheckpoint ?? null,
            claimVerification: options.claimVerification,
            harnessMetrics: options.harnessMetrics ?? null
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
          materializedCount: options.materializedWorkflows?.length ?? 0,
          candidates: (options.traceCandidates ?? []).map((candidate) => ({
            signature: candidate.signature,
            occurrenceCount: candidate.occurrenceCount,
            traceIds: candidate.traceIds
          })),
          workflows: (options.materializedWorkflows ?? []).map((workflow) => ({
            workflowId: workflow.template.id,
            relativePath: workflow.relativePath,
            status: workflow.status,
            signature: workflow.template.signature
          }))
        },
        workflowRetrieval: {
          policy: 'materialized-trace-workflow-retrieval',
          included: options.retrievedWorkflows ?? []
        },
        checkpointResume: options.resumedCheckpoint
          ? {
              source: options.resumedCheckpoint.source,
              createdAt: options.resumedCheckpoint.createdAt,
              warningCount: options.resumedCheckpoint.warnings.length,
              hotFiles: options.resumedCheckpoint.hotFiles
            }
          : null,
        postResponseClaimVerification: options.claimVerification
          ? {
              passed: options.claimVerification.passed,
              claimCount: options.claimVerification.claims.length,
              unverifiedClaims: options.claimVerification.unverifiedClaims.map((claim) => ({
                kind: claim.kind,
                value: claim.value
              }))
            }
          : null,
        harnessMetrics: options.harnessMetrics ?? null,
        prefixHash: options.packerOutput?.decisions?.prefixHash ?? null,
        softShrink: options.softShrinkMeta
          ? {
              triggered: options.softShrinkMeta.triggered,
              initialFillRatio: options.softShrinkMeta.initialFillRatio,
              finalFillRatio: options.packerOutput?.decisions?.fillRatio ?? null
            }
          : null,
        workingSetAudit: options.packerOutput?.decisions?.zones?.workingSet
          ? {
              includedMessageIds:
                options.packerOutput.decisions.zones.workingSet.includedMessageIds ?? [],
              droppedMessageIds:
                options.packerOutput.decisions.zones.workingSet.droppedMessageIds ?? [],
              dedupedCount: options.packerOutput.decisions.zones.workingSet.dedupedCount ?? 0
            }
          : null,
        sessionMode: options.sessionMode ?? 'build',
        // INV-TURN-5: Cross-reference fields for snapshot alignment
        turnId: options.turnId ?? null,
        providerRequestHash: options.snapshotHash ?? null,
        providerEstimatedInputTokens:
          options.packerOutput?.decisions?.totalTokens != null
            ? options.packerOutput.decisions.totalTokens +
              estimateProviderOverheadTokens(options.sessionMode ?? 'build')
            : null,
        includedMessageIds:
          options.packerOutput?.decisions?.zones?.workingSet?.includedMessageIds ?? null,
        omittedMessageIds:
          options.packerOutput?.decisions?.zones?.workingSet?.droppedMessageIds ?? null
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

  private async verifyCheckpointForContext(
    worktree: FieldWorktree,
    worktreePath: string
  ): Promise<ResumedCheckpointBlock | null> {
    try {
      return await verifyCheckpoint({
        worktreeId: worktree.id,
        worktreePath
      })
    } catch (error) {
      log.warn('Failed to verify checkpoint for xuanpu-agent context', {
        worktreeId: worktree.id,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  private materializeTraceWorkflows(
    worktreePath: string,
    worktree: FieldWorktree,
    candidates: TraceMaterializationCandidate[]
  ): MaterializedTraceWorkflow[] {
    try {
      return materializeTraceWorkflowTemplates({
        worktreePath,
        projectId: worktree.projectId,
        worktreeId: worktree.id,
        candidates
      })
    } catch (error) {
      log.warn('Failed to materialize trace workflows', {
        worktreeId: worktree.id,
        error: error instanceof Error ? error.message : String(error)
      })
      return []
    }
  }

  private retrieveTraceWorkflows(
    userText: string,
    worktreePath: string,
    materialized: MaterializedTraceWorkflow[]
  ): RetrievedTraceWorkflow[] {
    try {
      const loaded = loadTraceWorkflowTemplates(worktreePath)
      const byId = new Map(loaded.map((workflow) => [workflow.template.id, workflow]))
      for (const item of materialized) {
        byId.set(item.template.id, {
          template: item.template,
          filePath: item.filePath,
          relativePath: item.relativePath,
          retrievalReason: 'materialized from frequent command traces',
          score: 0
        })
      }
      return retrieveTraceWorkflowsForContext({
        userText,
        workflows: [...byId.values()]
      })
    } catch (error) {
      log.warn('Failed to retrieve trace workflows', {
        error: error instanceof Error ? error.message : String(error)
      })
      return []
    }
  }

  private buildRetrievedWorkflowSection(
    workflows: RetrievedTraceWorkflow[]
  ): XfpRetrievedWorkflowSection | null {
    if (workflows.length === 0) return null

    return {
      entries: workflows.map((workflow) => {
        const step = workflow.template.steps[0]
        return {
          workflowId: workflow.template.id,
          title: workflow.template.title,
          signature: workflow.template.signature,
          commandTemplate: step?.commandTemplate ?? workflow.template.signature,
          parameters: step?.parameters ?? [],
          path: workflow.relativePath,
          retrievalReason: workflow.retrievalReason,
          occurrenceCount: workflow.template.occurrenceCount,
          successRate: workflow.template.successRate,
          rawRefs: [
            {
              kind: 'file',
              id: workflow.relativePath,
              excerpt: workflow.template.title,
              meta: { absPath: workflow.filePath }
            },
            ...workflow.template.sourceTraceIds.slice(0, 5).map((traceId) => ({
              kind: 'command-trace' as const,
              id: traceId
            }))
          ]
        }
      }),
      totalAvailable: workflows.length
    }
  }

  private buildMultiWorktreeSection(worktree: FieldWorktree): XfpMultiWorktreeSection | null {
    if (!this.db || typeof this.db.getWorktreesByProject !== 'function') return null

    try {
      const rows =
        typeof this.db.getActiveWorktreesByProject === 'function'
          ? this.db.getActiveWorktreesByProject(worktree.projectId)
          : this.db.getWorktreesByProject(worktree.projectId)
      if (rows.length <= 1) return null
      const boundedRows = [
        ...rows.filter((row) => row.id === worktree.id),
        ...rows.filter((row) => row.id !== worktree.id)
      ].slice(0, 12)
      const entries = boundedRows.map((row) => ({
        worktreeId: row.id,
        name: row.name,
        path: row.path,
        branchName: row.branch_name || 'unknown',
        isCurrent: row.id === worktree.id,
        lastMessageAt: normalizeNullableTimestamp(row.last_message_at),
        attachedPrNumber: row.github_pr_number ?? null,
        attachedPrUrl: row.github_pr_url ?? null,
        rawRefs: [
          {
            kind: 'git-object' as const,
            id: `worktree:${row.id}`,
            meta: {
              branch: row.branch_name || null,
              current: row.id === worktree.id
            }
          }
        ]
      }))

      return {
        entries,
        totalAvailable: rows.length
      }
    } catch (error) {
      log.warn('Failed to build multi-worktree context', {
        worktreeId: worktree.id,
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

  private async freezeOldConversationTurns(session: XuanpuAgentSessionState): Promise<void> {
    const field = this.requireField()
    const worktree = field.getWorktree(session.worktreePath)
    if (!worktree) return
    await field.freezeEpisodes(worktree.id, session.hiveSessionId)
  }

  private async persistEpochCheckpoint(input: {
    session: XuanpuAgentSessionState
    worktree: FieldWorktree
    taskRunId: string
    epochId: string
    reason: EpochCloseReason
    objective: string
    latestAssistantText: string
    gitState: XfpGitState
  }): Promise<string | null> {
    try {
      const generated = await generateCheckpoint({
        worktreeId: input.worktree.id,
        worktreePath: input.session.worktreePath,
        sessionId: input.session.hiveSessionId,
        source: 'epoch'
      })
      const checkpoint: CheckpointRecord =
        generated ??
        buildFallbackEpochCheckpoint({
          worktreeId: input.worktree.id,
          sessionId: input.session.hiveSessionId,
          reason: input.reason,
          objective: input.objective,
          latestAssistantText: input.latestAssistantText,
          gitState: input.gitState
        })
      const taskCheckpoint: CheckpointRecord = {
        ...checkpoint,
        source: 'epoch',
        taskRunId: input.taskRunId,
        epochId: input.epochId,
        checkpointPurpose: 'task-epoch'
      }
      return insertCheckpoint(taskCheckpoint) ? taskCheckpoint.id : null
    } catch (error) {
      log.warn('Failed to persist xuanpu-agent epoch checkpoint', {
        taskRunId: input.taskRunId,
        epochId: input.epochId,
        error: error instanceof Error ? error.message : String(error)
      })
      return null
    }
  }

  private requireField(): FieldProvider {
    if (!this.field) {
      throw new Error(
        'XuanpuAgentImplementer: DatabaseService not set. Call setDatabaseService() first.'
      )
    }
    return this.field
  }

  private requireDatabase(): DatabaseService {
    if (!this.db) {
      throw new Error(
        'XuanpuAgentImplementer: DatabaseService not set. Call setDatabaseService() first.'
      )
    }
    return this.db
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
                rawOutputSha256: trace.rawOutputSha256,
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
    } catch (err) {
      log.warn('buildGitStateForWorktree: git probe failed, returning default state', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err)
      })
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
      session.piSession = new XuanpuPiAgentSession(session.hiveSessionId, this.getAgentConfig())
    }
    return session.piSession
  }

  private emitTextDelta(
    hiveSessionId: string,
    delta: string,
    turnId?: string,
    eventSequence?: number
  ): void {
    if (!delta) return

    emitAgentEvent(this.mainWindow, {
      type: 'message.part.updated',
      sessionId: hiveSessionId,
      runtimeId: this.id,
      turnId,
      origin: 'model',
      eventSequence,
      data: {
        part: { type: 'text', text: delta },
        delta,
        turnId
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
      turnId?: string
    }
  ): void {
    const timestamp = new Date().toISOString()
    emitAgentEvent(this.mainWindow, {
      type: 'message.updated',
      sessionId: hiveSessionId,
      runtimeId: this.id,
      turnId: options.turnId,
      origin: 'model',
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
      runtimeId: this.id,
      origin: 'system',
      data: { status: statusPayload }
    })
  }

  private emitError(hiveSessionId: string, message: string): void {
    emitAgentEvent(this.mainWindow, {
      type: 'session.error',
      sessionId: hiveSessionId,
      runtimeId: this.id,
      origin: 'system',
      data: { error: message }
    })
  }

  private persistToolStart(
    hiveSessionId: string,
    event: XuanpuAgentToolStartEvent,
    turnId?: string
  ): void {
    const input = normalizeToolInput(event.toolName, event.args)
    this.persistSessionActivity(
      {
        id: buildToolActivityId(hiveSessionId, turnId, event.toolCallId, 'started'),
        session_id: hiveSessionId,
        agent_session_id: hiveSessionId,
        thread_id: hiveSessionId,
        turn_id: turnId ?? null,
        item_id: event.toolCallId,
        kind: 'tool.started',
        tone: 'tool',
        summary: event.toolName,
        payload_json: JSON.stringify({
          item: {
            toolName: canonicalToolName(event.toolName),
            rawToolName: event.toolName,
            callID: event.toolCallId,
            input,
            status: 'running',
            time: { start: event.startedAt }
          },
          source: 'xuanpu-agent'
        }),
        created_at: toIsoTimestamp(event.startedAt)
      },
      'tool.started'
    )
  }

  private persistToolEnd(
    hiveSessionId: string,
    event: XuanpuAgentToolEndEvent,
    turnId?: string
  ): void {
    const result = event.result && typeof event.result === 'object' ? event.result : null
    const details =
      result && 'details' in result && typeof (result as { details?: unknown }).details === 'object'
        ? ((result as { details?: Record<string, unknown> }).details ?? {})
        : {}
    const text = extractToolResultText(event.result)
    const input = normalizeToolInput(event.toolName, {
      ...event.args,
      diff: typeof details.diff === 'string' ? details.diff : undefined,
      reverseDiff: typeof details.reverseDiff === 'string' ? details.reverseDiff : undefined,
      filesAffected: Array.isArray(details.filesAffected) ? details.filesAffected : undefined
    })
    const failed = event.isError === true

    this.persistSessionActivity(
      {
        id: buildToolActivityId(
          hiveSessionId,
          turnId,
          event.toolCallId,
          failed ? 'failed' : 'completed'
        ),
        session_id: hiveSessionId,
        agent_session_id: hiveSessionId,
        thread_id: hiveSessionId,
        turn_id: turnId ?? null,
        item_id: event.toolCallId,
        kind: failed ? 'tool.failed' : 'tool.completed',
        tone: failed ? 'error' : 'tool',
        summary: event.toolName,
        payload_json: JSON.stringify({
          item: {
            toolName: canonicalToolName(event.toolName),
            rawToolName: event.toolName,
            callID: event.toolCallId,
            input,
            output: failed ? undefined : text,
            error: failed ? text : undefined,
            result: details,
            status: failed ? 'error' : 'completed',
            metadata: {
              exitCode: typeof details.exitCode === 'number' ? details.exitCode : undefined,
              durationMs: event.endedAt - event.startedAt,
              filesAffected: Array.isArray(details.filesAffected)
                ? details.filesAffected
                : undefined
            },
            time: { start: event.startedAt, end: event.endedAt }
          },
          source: 'xuanpu-agent'
        }),
        created_at: toIsoTimestamp(event.endedAt)
      },
      failed ? 'tool.failed' : 'tool.completed'
    )
  }

  private persistSessionActivity(activity: SessionActivityCreate, label: string): void {
    if (!this.db) return
    try {
      this.db.upsertSessionActivity(activity)
    } catch (err) {
      log.warn(`Failed to persist xuanpu-agent ${label} activity`, {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  private emitToolStart(
    hiveSessionId: string,
    event: XuanpuAgentToolStartEvent,
    turnId?: string,
    eventSequence?: number
  ): void {
    emitAgentEvent(this.mainWindow, {
      type: 'message.part.updated',
      sessionId: hiveSessionId,
      runtimeId: this.id,
      turnId,
      origin: 'tool',
      eventSequence,
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

  private emitToolEnd(
    hiveSessionId: string,
    event: XuanpuAgentToolEndEvent,
    turnId?: string,
    eventSequence?: number
  ): void {
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
      runtimeId: this.id,
      turnId,
      origin: 'tool',
      eventSequence,
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

  private emitSubtaskStart(
    hiveSessionId: string,
    event: XuanpuAgentToolStartEvent,
    turnId?: string,
    eventSequence?: number
  ): void {
    emitAgentEvent(this.mainWindow, {
      type: 'message.part.updated',
      sessionId: hiveSessionId,
      runtimeId: this.id,
      turnId,
      origin: 'tool',
      eventSequence,
      data: {
        part: {
          type: 'subtask',
          callID: event.toolCallId,
          description: (event.args.description as string) ?? 'Subtask',
          agent: (event.args.agent as string) ?? 'general',
          state: {
            status: 'running',
            time: { start: event.startedAt }
          }
        }
      }
    })
  }

  private emitSubtaskEnd(
    hiveSessionId: string,
    event: XuanpuAgentToolEndEvent,
    details: SubtaskResultDetails,
    turnId?: string,
    eventSequence?: number
  ): void {
    emitAgentEvent(this.mainWindow, {
      type: 'message.part.updated',
      sessionId: hiveSessionId,
      runtimeId: this.id,
      turnId,
      origin: 'tool',
      eventSequence,
      data: {
        part: {
          type: 'subtask',
          callID: event.toolCallId,
          childSessionId: details.childSessionId,
          description: details.description,
          agent: details.agent,
          state: {
            status: details.status,
            error: details.error,
            result: extractToolResultText(event.result),
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

function buildToolActivityId(
  hiveSessionId: string,
  turnId: string | undefined,
  toolCallId: string,
  phase: 'started' | 'completed' | 'failed'
): string {
  return `xuanpu-agent-tool:${hiveSessionId}:${turnId ?? 'unscoped'}:${toolCallId}:${phase}`
}

function toIsoTimestamp(timestamp: number): string {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date().toISOString()
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

function buildAnchorSection(
  worktree: FieldWorktree,
  checkpoint: ResumedCheckpointBlock | null
): XfpAnchorSection | null {
  const worktreeNotes = worktree.context?.trim() || null
  const checkpointMarkdown = checkpoint ? renderCheckpointResumeMarkdown(checkpoint) : null
  if (!worktreeNotes && !checkpointMarkdown) return null

  return {
    pinnedFactsMarkdown: null,
    worktreeNotesMarkdown: [worktreeNotes, checkpointMarkdown].filter(Boolean).join('\n\n'),
    updatedAt: checkpoint?.createdAt ?? Date.now(),
    rawRefs: [
      ...(worktreeNotes
        ? [{ kind: 'memory-page' as const, id: `worktree:${worktree.id}:context` }]
        : []),
      ...(checkpoint
        ? [
            {
              kind: 'checkpoint' as const,
              id: `checkpoint:${worktree.id}:${checkpoint.createdAt}`,
              excerpt: checkpoint.summary.slice(0, 200)
            }
          ]
        : [])
    ]
  }
}

function buildReviewContextSection(
  worktree: FieldWorktree,
  gitState: XfpGitState
): XfpReviewContextSection | null {
  const attachedPullRequest =
    worktree.githubPrNumber && worktree.githubPrUrl
      ? {
          number: worktree.githubPrNumber,
          url: worktree.githubPrUrl
        }
      : null
  const compareTarget = gitState.upstream ?? null
  const shouldInclude = Boolean(attachedPullRequest || compareTarget || gitState.dirty)
  if (!shouldInclude) return null

  return {
    currentBranch: gitState.branchName,
    compareTarget,
    attachedPullRequest,
    dirtyFileCount: gitState.dirtyFiles.length,
    rawRefs: [
      {
        kind: 'git-object',
        id: `git:branch:${gitState.branchName}`,
        meta: {
          upstream: gitState.upstream,
          ahead: gitState.ahead,
          behind: gitState.behind
        }
      },
      ...(attachedPullRequest
        ? [
            {
              kind: 'message' as const,
              id: `github-pr:${attachedPullRequest.number}`,
              excerpt: attachedPullRequest.url
            }
          ]
        : [])
    ]
  }
}

function normalizeNullableTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function buildCurrentGoalFromCheckpoint(
  userText: string,
  sessionId: string,
  checkpoint: ResumedCheckpointBlock | null
): XfpTaskGoal | undefined {
  if (!checkpoint?.currentGoal || !isResumeIntent(userText)) return undefined
  return {
    objective: checkpoint.currentGoal,
    source: 'checkpoint',
    successCriteria: checkpoint.nextAction ? `Resume next action: ${checkpoint.nextAction}` : null,
    rawRefs: [
      { kind: 'message', id: `session:${sessionId}:current-user-message`, excerpt: userText },
      {
        kind: 'checkpoint',
        id: `checkpoint:${sessionId}:${checkpoint.createdAt}`,
        excerpt: checkpoint.summary.slice(0, 200)
      }
    ]
  }
}

function isResumeIntent(text: string): boolean {
  return /^(?:继续|接着|继续做|继续修)(?:\s|$)|^(?:resume|continue|keep going|go on)\b/i.test(
    text.trim()
  )
}

function renderCheckpointResumeMarkdown(checkpoint: ResumedCheckpointBlock): string {
  return [
    '## Resumed Checkpoint',
    checkpoint.summary,
    checkpoint.currentGoal ? `- Current goal (heuristic): ${checkpoint.currentGoal}` : null,
    checkpoint.nextAction ? `- Next action (heuristic): ${checkpoint.nextAction}` : null,
    checkpoint.blockingReason ? `- Blocking reason: ${checkpoint.blockingReason}` : null,
    checkpoint.hotFiles.length > 0 ? `- Hot files: ${checkpoint.hotFiles.join(', ')}` : null,
    checkpoint.warnings.length > 0 ? `- Warnings: ${checkpoint.warnings.join('; ')}` : null
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}

function epochStatusForCloseReason(reason: EpochCloseReason): EpochStatus {
  if (reason === 'compact') return 'compacted'
  if (reason === 'checkpoint') return 'checkpointed'
  if (reason === 'watchdog') return 'failed'
  return 'closed'
}

function buildInEpochFollowUpPrompt(objective: string): string {
  return [
    '<xuanpu-task-run-continuation scope="same-epoch">',
    `Objective: ${objective}`,
    'Continue from the current accumulated context. If the task is complete, respond with the final concise summary and do not invent extra work. Otherwise, perform the next concrete step.',
    '</xuanpu-task-run-continuation>'
  ].join('\n')
}

function isIncompleteLongTaskResponse(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized) return false

  return [
    /响应预算.*(?:已到|用完|耗尽|不足)/,
    /本次响应预算已到/,
    /尚未完成/,
    /(?:任务|目标|工作|审计|检查|实现|修复).{0,8}(?:未|尚未|没有|还没|还没有)完成/,
    /未完成.*(?:阶段|任务|用例|检查|审计|测试)/,
    /只完成到/,
    /只(?:读|读取|完成)到/,
    /还(?:没|没有).*完成/,
    /need to continue/,
    /not (?:yet )?(?:complete|completed|finished)/,
    /response budget.*(?:reached|exhausted|insufficient|limit)/
  ].some((pattern) => pattern.test(normalized))
}

function isCompleteLongTaskResponse(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized || isIncompleteLongTaskResponse(normalized)) return false

  return [
    /任务.{0,12}(?:已|已经)完成/,
    /(?:审计|检查|核查|实现|修复|工作|目标).{0,12}(?:已|已经)完成/,
    /(?:不继续新增工作|无需继续|不需要继续)/,
    /\b(?:task|objective|audit|implementation|work)\s+(?:is\s+|was\s+|has\s+been\s+)?(?:complete|completed|finished)\b/,
    /\b(?:no further work|nothing more to do)\b/
  ].some((pattern) => pattern.test(normalized))
}

function shouldResumeActiveTaskRunFromPromptText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized) return false

  return [
    /^继续\b/,
    /^请继续\b/,
    /继续(?:当前|这个|上个|上一|跑|执行|推进|完成|处理|剩下|余下|后续)/,
    /(?:跑完|完成|处理).{0,12}(?:剩下|余下|剩余|后续)/,
    /(?:接着|续跑|继续跑)/,
    /\b(?:resume|continue)\b/
  ].some((pattern) => pattern.test(normalized))
}

function tailForContinuation(text: string, maxChars = 1600): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return trimmed
  return trimmed.slice(trimmed.length - maxChars)
}

function buildIncompleteResponseContinuationPrompt(input: {
  objective: string
  latestAssistantText: string
}): string {
  return [
    '继续当前 xuanpu-agent task run。',
    '',
    '<xuanpu-task-run-continuation scope="next-turn" reason="incomplete-response">',
    `Objective: ${input.objective}`,
    '',
    'The previous assistant response explicitly said the task was not complete or that the response budget was reached. Continue from the last completed step. Do not restart from scratch and do not stop until the objective is complete or a runtime boundary asks you to yield.',
    '',
    '<previous-assistant-tail>',
    tailForContinuation(input.latestAssistantText),
    '</previous-assistant-tail>',
    '</xuanpu-task-run-continuation>'
  ].join('\n')
}

function buildNoProgressRecoveryContinuationPrompt(input: {
  objective: string
  latestAssistantText: string
}): string {
  return [
    '继续当前 xuanpu-agent task run。',
    '',
    '<xuanpu-task-run-continuation scope="next-epoch" reason="no-progress-recovery">',
    `Objective: ${input.objective}`,
    '',
    'The previous epoch reached the no-progress watchdog without a successful tool result or verified file observation. Recover by performing concrete work, not by only reporting status.',
    '',
    'Recovery protocol:',
    '1. Inspect the existing target artifacts related to this objective, especially any output directory, manifest.json, or README.md named by the task or prior response.',
    '2. If the task uses a manifest, read it when present; if it is required but missing, create or update it with partial status before broad summarization.',
    '3. Choose the first missing concrete artifact or source-grounded step, then complete at least one successful read/write cycle before summarizing.',
    '4. If a tool call failed, adjust the arguments or narrow the search. Do not repeat an invalid call shape.',
    '5. Do not claim a file, section, or manifest entry is complete unless it exists and matches the requested status.',
    '',
    '<previous-assistant-tail>',
    tailForContinuation(input.latestAssistantText),
    '</previous-assistant-tail>',
    '</xuanpu-task-run-continuation>'
  ].join('\n')
}

function buildEpochContinuationPrompt(objective: string): string {
  return [
    '继续当前 xuanpu-agent task run。',
    '',
    `<xuanpu-task-run-continuation scope="next-epoch" reason="epoch-boundary">`,
    `Objective: ${objective}`,
    'Resume from the latest task-epoch checkpoint and continue with the next concrete step. Do not restart from scratch.',
    'Before summarizing, verify existing artifacts related to the objective, including any output directory, manifest.json, or README.md already produced.',
    'Pick the next missing concrete step and perform successful tool-backed work before claiming progress.',
    'If a manifest or index is part of the objective, keep partial/incomplete items marked honestly.',
    '</xuanpu-task-run-continuation>'
  ].join('\n')
}

function isNoProgressRecoveryContinuationPrompt(text: string): boolean {
  return /<xuanpu-task-run-continuation\b[^>]*reason=["']no-progress-recovery["']/i.test(text)
}

function buildFallbackEpochCheckpoint(input: {
  worktreeId: string
  sessionId: string
  reason: EpochCloseReason
  objective: string
  latestAssistantText: string
  gitState: XfpGitState
}): CheckpointRecord {
  const createdAt = Date.now()
  const summary = [
    `xuanpu-agent epoch closed with reason: ${input.reason}.`,
    input.latestAssistantText
      ? `Latest assistant progress: ${truncateText(input.latestAssistantText, 400)}`
      : null
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
  const nextAction =
    input.reason === 'turn_end'
      ? null
      : 'Resume from this task-epoch checkpoint and continue the current objective.'
  return {
    id: randomUUID(),
    createdAt,
    worktreeId: input.worktreeId,
    sessionId: input.sessionId,
    branch: input.gitState.branchName || null,
    repoHead: input.gitState.headShort || null,
    source: 'epoch',
    summary,
    currentGoal: truncateText(input.objective, 500),
    nextAction,
    blockingReason: input.reason === 'watchdog' ? 'watchdog' : null,
    hotFiles: input.gitState.dirtyFiles.slice(0, 5).map((file) => file.path),
    hotFileDigests: null,
    packetHash: createEpochCheckpointHash({
      createdAt,
      sessionId: input.sessionId,
      objective: input.objective,
      reason: input.reason,
      summary
    })
  }
}

function createEpochCheckpointHash(input: Record<string, unknown>): string {
  return createHash('sha1').update(JSON.stringify(input)).digest('hex')
}

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, maxLength - 3)}...`
}

function collectObservedToolPaths(
  worktreePath: string,
  toolName: string,
  args: Record<string, unknown>,
  result: unknown,
  observed: Set<string>
): void {
  const candidates: unknown[] = [args.path, args.filePath, args.file_path]
  if (Array.isArray(args.paths)) candidates.push(...args.paths)

  const details =
    result && typeof result === 'object' && 'details' in result
      ? (result as { details?: Record<string, unknown> }).details
      : null
  if (details) {
    candidates.push(details.path)
    if (Array.isArray(details.paths)) candidates.push(...details.paths)
    if (Array.isArray(details.filesAffected)) candidates.push(...details.filesAffected)
  }

  for (const candidate of candidates) {
    if (typeof candidate === 'string') addObservedPath(worktreePath, candidate, observed)
  }

  if (toolName === 'git_diff') observed.add('.git')
}

function addObservedPath(worktreePath: string, value: string, observed: Set<string>): void {
  const trimmed = value
    .trim()
    .replace(/^\.\/+/, '')
    .replace(/\\/g, '/')
  if (!trimmed || trimmed.includes('\0')) return
  try {
    const root = pathResolve(worktreePath)
    const abs = pathIsAbsolute(trimmed) ? pathResolve(trimmed) : pathResolve(root, trimmed)
    const relative = pathRelative(root, abs).replace(/\\/g, '/')
    if (!relative || relative.startsWith('..') || pathIsAbsolute(relative)) return
    observed.add(relative)
  } catch {
    if (!trimmed.startsWith('..')) observed.add(trimmed)
  }
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
    materializedWorkflows?: MaterializedTraceWorkflow[]
    retrievedWorkflows?: Array<{ workflowId: string; retrievalReason: string }>
    resumedCheckpoint?: ResumedCheckpointBlock | null
    claimVerification?: PostResponseClaimVerification
    harnessMetrics?: XuanpuAgentHarnessMetrics | null
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
      extras.traceCandidates ?? [],
      extras.materializedWorkflows ?? []
    ),
    ...buildWorkflowRetrievalContextPackageSections(
      packet.identity.packetId,
      packet.retrievedWorkflows,
      extras.retrievedWorkflows ?? []
    ),
    ...buildCheckpointContextPackageSections(
      packet.identity.packetId,
      extras.resumedCheckpoint ?? null
    ),
    ...buildClaimVerifierContextPackageSections(
      packet.identity.packetId,
      extras.claimVerification ?? null
    ),
    ...buildHarnessMetricsContextPackageSections(
      packet.identity.packetId,
      extras.harnessMetrics ?? null
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
  candidates: TraceMaterializationCandidate[],
  workflows: MaterializedTraceWorkflow[]
): FieldContextPackageSection[] {
  if (candidates.length === 0 && workflows.length === 0) return []
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
        })),
        workflows: workflows.map((workflow) => ({
          workflowId: workflow.template.id,
          relativePath: workflow.relativePath,
          status: workflow.status
        }))
      }
    }
  ]
}

function buildWorkflowRetrievalContextPackageSections(
  packetId: string,
  section: XfpRetrievedWorkflowSection | null,
  retrievalDecisions: Array<{ workflowId: string; retrievalReason: string }>
): FieldContextPackageSection[] {
  if (!section && retrievalDecisions.length === 0) return []
  const entries = section?.entries ?? []
  return [
    {
      id: `${packetId}:retrieved-workflows`,
      kind: 'retrieved_workflows',
      title: 'Retrieved Workflows',
      included: entries.length > 0,
      approxTokens: entries.reduce(
        (total, entry) => total + Math.ceil(JSON.stringify(entry).length / 4),
        0
      ),
      source: 'xuanpu-agent-trace-workflow-retrieval',
      reason:
        entries.length > 0
          ? entries.map((entry) => entry.retrievalReason).join('; ')
          : 'no materialized workflow matched',
      metadata: {
        packetId,
        includedIds: entries.map((entry) => entry.workflowId),
        retrievalDecisions
      }
    }
  ]
}

function buildCheckpointContextPackageSections(
  packetId: string,
  checkpoint: ResumedCheckpointBlock | null
): FieldContextPackageSection[] {
  if (!checkpoint) return []
  return [
    {
      id: `${packetId}:checkpoint-resume`,
      kind: 'checkpoint_resume',
      title: 'Checkpoint Resume',
      included: true,
      approxTokens: Math.ceil(renderCheckpointResumeMarkdown(checkpoint).length / 4),
      source: 'xuanpu-agent-checkpoint-verifier',
      reason: 'verified checkpoint is fresh enough for resume context',
      metadata: {
        packetId,
        source: checkpoint.source,
        createdAt: checkpoint.createdAt,
        warnings: checkpoint.warnings,
        hotFiles: checkpoint.hotFiles
      }
    }
  ]
}

function buildClaimVerifierContextPackageSections(
  packetId: string,
  verification: PostResponseClaimVerification | null
): FieldContextPackageSection[] {
  if (!verification) return []
  return [
    {
      id: `${packetId}:post-response-claim-verifier`,
      kind: 'claim_verifier',
      title: 'Post-response Claim Verifier',
      included: true,
      approxTokens: 0,
      source: 'xuanpu-agent-post-response-claim-verifier',
      reason: verification.passed ? 'all file-path claims verified' : 'correction turn injected',
      metadata: {
        packetId,
        passed: verification.passed,
        claimCount: verification.claims.length,
        unverifiedClaims: verification.unverifiedClaims.map((claim) => ({
          kind: claim.kind,
          value: claim.value
        }))
      }
    }
  ]
}

function buildHarnessMetricsContextPackageSections(
  packetId: string,
  metrics: XuanpuAgentHarnessMetrics | null
): FieldContextPackageSection[] {
  if (!metrics) return []
  return [
    {
      id: `${packetId}:harness-metrics`,
      kind: 'harness_metrics',
      title: 'Harness Metrics',
      included: true,
      approxTokens: Math.ceil(JSON.stringify(metrics).length / 4),
      source: 'xuanpu-agent-m6-metrics',
      reason: 'cache, parallel-safe, and compaction metrics captured for postmortem',
      metadata: {
        packetId,
        cacheHitRatio: metrics.cache.hitRatio,
        cacheSource: metrics.cache.source,
        parallelSafeRatio: metrics.parallelTools.parallelSafeRatio,
        totalToolCalls: metrics.parallelTools.totalToolCalls,
        shrinkCount: metrics.compaction.shrinkCount,
        emergencyShrunk: metrics.compaction.emergencyShrunk,
        compressionRatio: metrics.compaction.compressionRatio
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
  if (name === 'retrievedWorkflows' && Array.isArray(packet.retrievedWorkflows?.entries)) {
    return packet.retrievedWorkflows.entries.reduce(
      (total, entry) => total + entry.rawRefs.length,
      0
    )
  }
  if (name === 'multiWorktree' && Array.isArray(packet.multiWorktree?.entries)) {
    return packet.multiWorktree.entries.reduce((total, entry) => total + entry.rawRefs.length, 0)
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
    case 'retrievedWorkflows':
      return packet.retrievedWorkflows
    case 'multiWorktree':
      return packet.multiWorktree
    case 'reviewContext':
      return packet.reviewContext
    case 'currentGoal':
      return packet.currentGoal
    case 'budget':
      return packet.budget
    default:
      return undefined
  }
}

function extractSubtaskDetails(result: unknown): SubtaskResultDetails | null {
  if (!result || typeof result !== 'object') return null
  const details = (result as { details?: unknown }).details
  if (!details || typeof details !== 'object') return null
  const record = details as Record<string, unknown>
  if (record.subtask !== true) return null
  if (typeof record.childSessionId !== 'string') return null
  return record as unknown as SubtaskResultDetails
}

/** Extract plan markdown from <proposed_plan> tags, or null if not found. */
function extractProposedPlan(text: string): string | null {
  const match = text.match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i)
  return match ? (match[1]?.trim() ?? null) : null
}

/**
 * Estimate additional tokens consumed by system prompt + tools schema
 * that the Context Packer does NOT account for (it only measures zone content).
 * This is the gap between managedApproxTokens and what the provider actually
 * sees as input tokens.
 */
function estimateProviderOverheadTokens(sessionMode: 'build' | 'plan'): number {
  const systemPromptLines = getXuanpuAgentSystemPromptLines()
  const systemPromptText = systemPromptLines.join('\n')
  const systemTokens = Math.ceil(Buffer.byteLength(systemPromptText, 'utf-8') / 4)
  const tools = getXuanpuAgentAllowedTools()
  const toolsJson = JSON.stringify(
    tools.map((t: unknown) => {
      const tool = t as { name: string; description?: string; parameters?: unknown }
      return {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.parameters ?? {}
      }
    })
  )
  const toolsTokens = Math.ceil(Buffer.byteLength(toolsJson, 'utf-8') / 4)
  // plan mode uses a subset — reflect that proportionally
  const modeFactor = sessionMode === 'plan' ? 0.4 : 1.0
  return Math.round((systemTokens + toolsTokens) * modeFactor)
}

function resolvePerCallContextWindow(config?: XuanpuAgentConfig): number {
  const configured = config?.context?.contextWindow
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured)
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS
}
