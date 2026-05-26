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
import { XuanpuPiAgentSession } from './xuanpu-agent/runtime'
import { XfpPacketCompiler, type CompilerDecision } from './xuanpu-agent/harness/compiler'
import { buildMessages, SessionAppendOnlyLog } from './xuanpu-agent/harness/build-messages'
import type { XfpCommandTraceSection, XfpFieldPacket, XfpGitState } from './xuanpu-agent/xfp/types'
import {
  IdeFieldProvider,
  type FieldContextPackageSection,
  type FieldProvider
} from './xuanpu-agent/field'
import { beginSessionRun, emitAgentEvent } from '@shared/lib/normalize-agent-event'
import { createCommandProfiler } from './xuanpu-agent/context/profiler'
import { createCommandCompressor } from './xuanpu-agent/context/compressor-impl'
import type { ArchivePayload } from './xuanpu-agent/harness/tool-call-repair/truncation'

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
    field.persistMessage(session.hiveSessionId, 'user', text)
    session.status = 'running'
    session.abortController = new AbortController()
    this.emitStatus(session.hiveSessionId, 'busy')

    const modelRef = resolveXuanpuAgentModelRef(modelOverride, this.selectedModelRef)

    // ── Build field context via FieldProvider (IDE or CLI) ──
    const gitState = await this.buildGitStateForWorktree(session.worktreePath)
    const commandTrace = this.buildCommandTraceSection(session.hiveSessionId, worktree?.id)
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
        onTextDelta: (delta) => this.emitTextDelta(session.hiveSessionId, delta)
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
          field.persistContextPackage({
            id: compileResult.packet.identity.packetId,
            sessionId: session.hiveSessionId,
            worktreeId: worktree.id,
            runtimeId: this.id,
            modelProviderId: modelRef.providerID,
            modelId: modelRef.modelID,
            budgetProfile: compileResult.packet.budget.profile,
            approxTokens: compileResult.packet.budget.estimatedTokens,
            sections: buildContextPackageSections(compileResult.packet, compileResult.decisions),
            renderedMarkdown: fieldSnapshot.markdown,
            decisions: compileResult.decisions as unknown as Record<string, unknown>
          })
        } catch (err) {
          log.warn('Failed to record context package', {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }

      field.freezeEpisodes(worktree?.id ?? 'unknown', session.hiveSessionId)

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

function buildContextPackageSections(
  packet: XfpFieldPacket,
  decisions: CompilerDecision
): FieldContextPackageSection[] {
  const omittedReasonByName = new Map(
    decisions.omittedSections.map((section) => [section.name, section.reason])
  )
  const names = [
    ...decisions.includedSections,
    ...decisions.omittedSections.map((section) => section.name)
  ]
  const uniqueNames = [...new Set(names)]

  return uniqueNames.map((name) => {
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
    case 'currentGoal':
      return packet.currentGoal
    case 'budget':
      return packet.budget
    default:
      return undefined
  }
}
