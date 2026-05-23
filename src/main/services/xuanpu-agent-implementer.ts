import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'

import type { DatabaseService } from '../db/database'
import type {
  AgentRuntimeAdapter,
  AgentSdkCapabilities,
  PromptOptions
} from './agent-runtime-types'
import { XUANPU_AGENT_CAPABILITIES } from './agent-runtime-types'
import { createLogger } from './logger'
import { buildFieldContextSnapshot } from '../field/context-builder'
import { formatFieldContext } from '../field/context-formatter'
import {
  createFieldContextPackage,
  type FieldContextPackageRecord,
  type FieldContextPackageSection
} from '../field/context-package-repository'
import { resolveXuanpuAgentModelRef, type XuanpuAgentModelRef } from './xuanpu-agent/model-config'
import { XuanpuPiAgentSession } from './xuanpu-agent/runtime'
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
  private dbService: DatabaseService | null = null
  private sessions = new Map<string, XuanpuAgentSessionState>()
  private selectedModelRef: { providerID: string; modelID: string; variant?: string } | null = null

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  setDatabaseService(db: DatabaseService): void {
    this.dbService = db
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

    beginSessionRun(session.hiveSessionId)
    this.persistMessage(session.hiveSessionId, 'user', text)
    session.status = 'running'
    session.abortController = new AbortController()
    this.emitStatus(session.hiveSessionId, 'busy')

    const modelRef = resolveXuanpuAgentModelRef(modelOverride, this.selectedModelRef)
    const contextPackage = await this.createContextPackage(session, text, modelRef).catch(
      (error) => {
        log.warn('Failed to record xuanpu-agent context package', {
          hiveSessionId: session.hiveSessionId,
          error: error instanceof Error ? error.message : String(error)
        })
        return null
      }
    )

    try {
      const piSession = this.getOrCreatePiSession(session)
      const result = await piSession.prompt(text, modelRef, {
        onTextDelta: (delta) => this.emitTextDelta(session.hiveSessionId, delta)
      })

      const assistantText = result.text.trim()
      const content = assistantText || '(empty response)'
      this.persistMessage(session.hiveSessionId, 'assistant', content, {
        messageId: result.messageId,
        modelRef: result.modelRef,
        usage: result.usage,
        rawMessage: result.rawMessage
      })
      this.emitMessageUpdated(session.hiveSessionId, content, {
        messageId: result.messageId,
        modelRef: result.modelRef,
        usage: result.usage,
        contextPackageId: contextPackage?.id ?? null
      })

      session.status = 'ready'
      session.abortController = null
      this.emitStatus(session.hiveSessionId, 'idle')
    } catch (error) {
      const errorMessage = [
        'xuanpu-agent no-tools provider call failed.',
        error instanceof Error ? error.message : String(error),
        contextPackage?.id ? `Context package: ${contextPackage.id}` : null
      ]
        .filter(Boolean)
        .join('\n')
      this.persistMessage(session.hiveSessionId, 'assistant', errorMessage)
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
    if (!session || !this.dbService) return []
    return this.dbService.getSessionMessages(session.hiveSessionId)
  }

  async getAvailableModels(): Promise<unknown> {
    return {
      providers: {
        'xuanpu-agent': {
          id: 'xuanpu-agent',
          name: 'Xuanpu Agent',
          models: this.selectedModelRef
            ? [
                {
                  id: this.selectedModelRef.modelID,
                  name: this.selectedModelRef.modelID,
                  providerID: this.selectedModelRef.providerID,
                  variant: this.selectedModelRef.variant
                }
              ]
            : []
        }
      }
    }
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
    if (!this.dbService) return
    const session = this.sessions.get(_agentSessionId)
    if (!session) return
    this.dbService.updateSession(session.hiveSessionId, { name })
  }

  private async createContextPackage(
    session: XuanpuAgentSessionState,
    userText: string,
    modelRef: XuanpuAgentModelRef
  ): Promise<FieldContextPackageRecord | null> {
    if (!this.dbService) return null

    const worktree = this.dbService.getWorktreeByPath(session.worktreePath)
    if (!worktree) return null

    const sections: FieldContextPackageSection[] = []
    let renderedMarkdown: string | null = null
    let approxTokens = estimateTokens(userText)
    let fieldContextTokens = 0
    let fieldContextAvailable = false
    let fieldContextTruncated = false

    const snapshot = await buildFieldContextSnapshot({ worktreeId: worktree.id })
    if (snapshot) {
      const formatted = formatFieldContext(snapshot, { tokenBudget: 1500 })
      renderedMarkdown = formatted.markdown
      fieldContextTokens = formatted.approxTokens
      fieldContextAvailable = true
      fieldContextTruncated = formatted.wasTruncated
      approxTokens += formatted.approxTokens
      sections.push({
        id: 'current-field',
        kind: 'current_field',
        title: 'Current Field',
        included: true,
        approxTokens: formatted.approxTokens,
        source: 'field-context',
        metadata: {
          wasTruncated: formatted.wasTruncated,
          windowMs: snapshot.windowMs,
          asOf: snapshot.asOf
        }
      })
    } else {
      sections.push({
        id: 'current-field',
        kind: 'current_field',
        title: 'Current Field',
        included: false,
        approxTokens: 0,
        source: 'field-context',
        reason: 'Field collection disabled or no snapshot available'
      })
    }

    sections.push({
      id: 'working-set-current-user',
      kind: 'working_set',
      title: 'Current User Message',
      included: true,
      approxTokens: estimateTokens(userText),
      source: 'prompt'
    })

    return createFieldContextPackage({
      sessionId: session.hiveSessionId,
      worktreeId: worktree.id,
      runtimeId: this.id,
      modelProviderId: modelRef?.providerID ?? null,
      modelId: modelRef?.modelID ?? null,
      budgetProfile: 'balanced',
      approxTokens,
      sections,
      renderedMarkdown,
      decisions: {
        phase: 'phase-1-no-tools-provider',
        providerExecution: 'enabled',
        fieldContextAvailable,
        fieldContextTokens,
        fieldContextTruncated,
        userMessageChars: userText.length,
        visibleTranscriptPolicy: 'persist-user-authored-message-only'
      }
    })
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

  private getOrCreatePiSession(session: XuanpuAgentSessionState): XuanpuPiAgentSession {
    if (!session.piSession) {
      session.piSession = new XuanpuPiAgentSession(session.sessionId)
    }
    return session.piSession
  }

  private persistMessage(
    hiveSessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    options?: {
      messageId?: string
      modelRef?: XuanpuAgentModelRef
      usage?: Record<string, unknown>
      rawMessage?: unknown
    }
  ): void {
    const messageId = options?.messageId ?? `xuanpu-agent-${randomUUID()}`
    const timestamp = new Date().toISOString()
    const parts = [{ type: 'text', text: content, timestamp }]
    const payload = {
      id: messageId,
      role,
      content,
      parts,
      providerID: options?.modelRef?.providerID,
      modelID: options?.modelRef?.modelID,
      usage: options?.usage,
      raw: options?.rawMessage
    }

    this.dbService?.createSessionMessage({
      session_id: hiveSessionId,
      role,
      content,
      opencode_message_id: messageId,
      opencode_message_json: JSON.stringify(payload),
      opencode_parts_json: JSON.stringify(parts),
      created_at: timestamp
    })
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}
