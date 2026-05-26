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
import { XfpPacketCompiler } from './xuanpu-agent/harness/compiler'
import {
  buildMessages,
  SessionAppendOnlyLog
} from './xuanpu-agent/harness/build-messages'
import type { XfpGitState } from './xuanpu-agent/xfp/types'
import {
  IdeFieldProvider,
  type FieldProvider
} from './xuanpu-agent/field'
import { beginSessionRun, emitAgentEvent } from '@shared/lib/normalize-agent-event'

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
      { id: session.hiveSessionId, project_id: worktree?.projectId ?? 'unknown' } as unknown as Session,
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
        commandTrace: null,
        anchor: null
      }
    )

    // ── Assemble messages via harness buildMessages ──
    const appendOnlyLog = new SessionAppendOnlyLog(
      priorMessages,
      compileResult.packet.identity.packetId
    )

    try {
      const piSession = this.getOrCreatePiSession(session)

      const harnessMessages = buildMessages(
        compileResult.packet,
        appendOnlyLog,
        text
      )

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
            sections: [],
            renderedMarkdown: fieldSnapshot.markdown,
            decisions: compileResult.decisions as unknown as Record<string, unknown>
          })
        } catch (err) {
          log.warn('Failed to record context package', {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }

      field.freezeEpisodes(
        worktree?.id ?? 'unknown',
        session.hiveSessionId
      )

      session.status = 'ready'
      session.abortController = null
      this.emitStatus(session.hiveSessionId, 'idle')
    } catch (error) {
      const errorMessage = [
        'xuanpu-agent no-tools provider call failed.',
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
      throw new Error('XuanpuAgentImplementer: DatabaseService not set. Call setDatabaseService() first.')
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
        const statusCode = validCodes.has(code) ? (code as 'M' | 'A' | 'D' | '?' | 'C' | '') : ('' as const)
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
