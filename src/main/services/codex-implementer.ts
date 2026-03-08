import type { BrowserWindow } from 'electron'

import type { AgentSdkCapabilities, AgentSdkImplementer } from './agent-sdk-types'
import { CODEX_CAPABILITIES } from './agent-sdk-types'
import {
  getAvailableCodexModels,
  getCodexModelInfo,
  CODEX_DEFAULT_MODEL,
  resolveCodexModelSlug
} from './codex-models'
import { createLogger } from './logger'
import {
  CodexAppServerManager,
  type CodexManagerEvent
} from './codex-app-server-manager'
import { mapCodexEventToStreamEvents } from './codex-event-mapper'
import { asObject, asString } from './codex-utils'
import type { DatabaseService } from '../db/database'

const log = createLogger({ component: 'CodexImplementer' })

// ── Session state ─────────────────────────────────────────────────

export interface CodexSessionState {
  threadId: string
  hiveSessionId: string
  worktreePath: string
  status: 'connecting' | 'ready' | 'running' | 'error' | 'closed'
  messages: unknown[]
  revertMessageID: string | null
  revertDiff: string | null
}

// ── Pending HITL entry (shared by questions and approvals) ────────

interface PendingHitlEntry {
  threadId: string
  hiveSessionId: string
  worktreePath: string
}

export class CodexImplementer implements AgentSdkImplementer {
  readonly id = 'codex' as const
  readonly capabilities: AgentSdkCapabilities = CODEX_CAPABILITIES

  private mainWindow: BrowserWindow | null = null
  private dbService: DatabaseService | null = null
  private selectedModel: string = CODEX_DEFAULT_MODEL
  private selectedVariant: string | undefined
  private manager: CodexAppServerManager = new CodexAppServerManager()
  private sessions = new Map<string, CodexSessionState>()
  private pendingQuestions = new Map<string, PendingHitlEntry>()
  private pendingApprovalSessions = new Map<string, PendingHitlEntry>()

  // ── Window binding ───────────────────────────────────────────────

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  setDatabaseService(db: DatabaseService): void {
    this.dbService = db
  }

  // ── Manager event listener (handles approval/question routing) ──

  private managerListenerAttached = false

  private attachManagerListener(): void {
    if (this.managerListenerAttached) return
    this.managerListenerAttached = true

    this.manager.on('event', (event: CodexManagerEvent) => {
      this.handleManagerEvent(event)
    })
  }

  private handleManagerEvent(event: CodexManagerEvent): void {
    // Clean up stale pending entries when a session closes
    if (
      event.kind === 'session' &&
      (event.method === 'session/closed' || event.method === 'session/exited')
    ) {
      this.cleanupPendingForThread(event.threadId)
      return
    }

    // Only handle request events (approvals + user inputs)
    if (event.kind !== 'request') return

    // Find the session for this event's threadId
    let targetSession: CodexSessionState | undefined
    for (const session of this.sessions.values()) {
      if (session.threadId === event.threadId) {
        targetSession = session
        break
      }
    }
    if (!targetSession) return

    const requestId = event.requestId
    if (!requestId) return

    // Handle approval requests
    if (
      event.method === 'item/commandExecution/requestApproval' ||
      event.method === 'item/fileChange/requestApproval' ||
      event.method === 'item/fileRead/requestApproval'
    ) {
      this.pendingApprovalSessions.set(requestId, {
        threadId: targetSession.threadId,
        hiveSessionId: targetSession.hiveSessionId,
        worktreePath: targetSession.worktreePath
      })

      const payload = asObject(event.payload)
      this.sendToRenderer('opencode:stream', {
        type: 'request.opened',
        sessionId: targetSession.hiveSessionId,
        data: {
          requestId,
          method: event.method,
          payload,
          turnId: event.turnId,
          itemId: event.itemId
        }
      })
      return
    }

    // Handle user input requests (questions)
    if (event.method === 'item/tool/requestUserInput') {
      this.pendingQuestions.set(requestId, {
        threadId: targetSession.threadId,
        hiveSessionId: targetSession.hiveSessionId,
        worktreePath: targetSession.worktreePath
      })

      const payload = asObject(event.payload)
      const questions = (payload?.questions ?? []) as unknown[]

      this.sendToRenderer('opencode:stream', {
        type: 'question.asked',
        sessionId: targetSession.hiveSessionId,
        data: {
          requestId,
          id: requestId,
          questions
        }
      })
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  async connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }> {
    const resolvedModel = resolveCodexModelSlug(this.selectedModel)
    log.info('Connecting', { worktreePath, hiveSessionId, model: resolvedModel })

    // Ensure the manager event listener is attached for HITL flows
    this.attachManagerListener()

    const providerSession = await this.manager.startSession({
      cwd: worktreePath,
      model: resolvedModel
    })

    const threadId = providerSession.threadId
    if (!threadId) {
      throw new Error('Codex session started but no thread ID was returned.')
    }

    const key = this.getSessionKey(worktreePath, threadId)
    const state: CodexSessionState = {
      threadId,
      hiveSessionId,
      worktreePath,
      status: this.mapProviderStatus(providerSession.status),
      messages: [],
      revertMessageID: null,
      revertDiff: null
    }
    this.sessions.set(key, state)

    // Notify renderer that the session has materialized
    this.sendToRenderer('opencode:stream', {
      type: 'session.materialized',
      sessionId: hiveSessionId,
      data: { newSessionId: threadId, wasFork: false }
    })

    log.info('Connected', { worktreePath, hiveSessionId, threadId })
    return { sessionId: threadId }
  }

  async reconnect(
    worktreePath: string,
    agentSessionId: string,
    hiveSessionId: string
  ): Promise<{
    success: boolean
    sessionStatus?: 'idle' | 'busy' | 'retry'
    revertMessageID?: string | null
  }> {
    const key = this.getSessionKey(worktreePath, agentSessionId)

    // If session already exists locally, just update the hiveSessionId
    const existing = this.sessions.get(key)
    if (existing) {
      existing.hiveSessionId = hiveSessionId
      const sessionStatus = this.statusToHive(existing.status)
      log.info('Reconnect: session already registered, updated hiveSessionId', {
        worktreePath,
        agentSessionId,
        hiveSessionId,
        sessionStatus
      })
      return { success: true, sessionStatus, revertMessageID: null }
    }

    // Otherwise, start a new session with thread resume
    try {
      const resolvedModel = resolveCodexModelSlug(this.selectedModel)
      const providerSession = await this.manager.startSession({
        cwd: worktreePath,
        model: resolvedModel,
        resumeThreadId: agentSessionId
      })

      const threadId = providerSession.threadId
      if (!threadId) {
        throw new Error('Codex session started but no thread ID was returned.')
      }

      const newKey = this.getSessionKey(worktreePath, threadId)
      const state: CodexSessionState = {
        threadId,
        hiveSessionId,
        worktreePath,
        status: this.mapProviderStatus(providerSession.status),
        messages: [],
        revertMessageID: null,
        revertDiff: null
      }
      this.sessions.set(newKey, state)

      log.info('Reconnected via thread resume', { worktreePath, agentSessionId, threadId })
      return { success: true, sessionStatus: this.statusToHive(state.status), revertMessageID: null }
    } catch (error) {
      log.error(
        'Reconnect failed',
        error instanceof Error ? error : new Error(String(error)),
        { worktreePath, agentSessionId }
      )
      return { success: false }
    }
  }

  async disconnect(worktreePath: string, agentSessionId: string): Promise<void> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)

    if (!session) {
      log.warn('Disconnect: session not found, ignoring', { worktreePath, agentSessionId })
      return
    }

    // Stop the manager session
    this.manager.stopSession(agentSessionId)

    // Clean up local state
    this.sessions.delete(key)
    this.cleanupPendingForThread(agentSessionId)

    log.info('Disconnected', { worktreePath, agentSessionId })
  }

  async cleanup(): Promise<void> {
    log.info('Cleaning up CodexImplementer state', { sessionCount: this.sessions.size })

    // Stop all manager sessions
    this.manager.stopAll()

    // Clear local state
    this.sessions.clear()
    this.pendingQuestions.clear()
    this.pendingApprovalSessions.clear()
    this.managerListenerAttached = false
    this.mainWindow = null
    this.selectedModel = CODEX_DEFAULT_MODEL
    this.selectedVariant = undefined
  }

  // ── Messaging ────────────────────────────────────────────────────

  async prompt(
    worktreePath: string,
    agentSessionId: string,
    message:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >,
    modelOverride?: { providerID: string; modelID: string; variant?: string }
  ): Promise<void> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)
    if (!session) {
      throw new Error(
        `Prompt failed: session not found for ${worktreePath} / ${agentSessionId}`
      )
    }

    // Extract text from message
    let text: string
    if (typeof message === 'string') {
      text = message
    } else {
      text = message
        .filter((part) => part.type === 'text')
        .map((part) => (part as { type: 'text'; text: string }).text)
        .join('\n')
    }

    if (!text.trim()) {
      log.warn('Prompt: empty text, ignoring', { worktreePath, agentSessionId })
      return
    }

    // Inject synthetic user message so getMessages() returns it
    const syntheticTimestamp = new Date().toISOString()
    session.messages.push({
      role: 'user',
      parts: [{ type: 'text', text, timestamp: syntheticTimestamp }],
      timestamp: syntheticTimestamp
    })

    // Emit busy status
    session.status = 'running'
    this.emitStatus(session.hiveSessionId, 'busy')

    log.info('Prompt: starting', {
      worktreePath,
      agentSessionId,
      hiveSessionId: session.hiveSessionId,
      textLength: text.length
    })

    // Set up event listener for streaming
    let assistantText = ''
    let reasoningText = ''
    let turnCompleted = false
    let turnFailed = false

    const handleEvent = (event: CodexManagerEvent) => {
      // Only handle events for this thread
      if (event.threadId !== session.threadId) return

      const streamEvents = mapCodexEventToStreamEvents(event, session.hiveSessionId)
      for (const streamEvent of streamEvents) {
        this.sendToRenderer('opencode:stream', streamEvent)
      }

      // Accumulate text for message history
      if (event.method === 'content.delta') {
        const payload = event.payload as Record<string, unknown> | undefined
        const delta = payload?.delta as Record<string, unknown> | undefined
        const deltaType = delta?.type as string | undefined

        const deltaText = (delta?.text as string)
          ?? (payload?.assistantText as string)
          ?? (payload?.reasoningText as string)
          ?? event.textDelta
          ?? ''

        if (deltaType === 'reasoning' || payload?.reasoningText) {
          reasoningText += deltaText
        } else {
          assistantText += deltaText
        }
      }

      // Detect turn completion and whether it failed
      if (event.method === 'turn/completed') {
        turnCompleted = true
        const payload = event.payload as Record<string, unknown> | undefined
        const turnObj = payload?.turn as Record<string, unknown> | undefined
        const status = (turnObj?.status as string) ?? (payload?.state as string)
        if (status === 'failed') {
          turnFailed = true
        }
      }
    }

    this.manager.on('event', handleEvent)

    try {
      const model = resolveCodexModelSlug(modelOverride?.modelID ?? this.selectedModel)

      await this.manager.sendTurn(session.threadId, {
        text,
        model
      })

      // Wait for turn completion (the sendTurn starts the turn, but
      // events stream asynchronously via the manager's event emitter)
      await this.waitForTurnCompletion(session, () => turnCompleted)

      // Store assistant message
      const assistantParts: unknown[] = []
      if (assistantText) {
        assistantParts.push({
          type: 'text',
          text: assistantText,
          timestamp: new Date().toISOString()
        })
      }
      if (reasoningText) {
        assistantParts.push({
          type: 'reasoning',
          text: reasoningText,
          timestamp: new Date().toISOString()
        })
      }

      if (assistantParts.length > 0) {
        session.messages.push({
          role: 'assistant',
          parts: assistantParts,
          timestamp: new Date().toISOString()
        })
      }

      session.status = turnFailed ? 'error' : 'ready'
      this.emitStatus(session.hiveSessionId, 'idle')

      log.info('Prompt: completed', {
        worktreePath,
        agentSessionId,
        assistantTextLength: assistantText.length,
        reasoningTextLength: reasoningText.length
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      log.error(
        'Prompt streaming error',
        error instanceof Error ? error : new Error(errorMessage),
        { worktreePath, agentSessionId, error: errorMessage }
      )

      session.status = 'error'
      this.sendToRenderer('opencode:stream', {
        type: 'session.error',
        sessionId: session.hiveSessionId,
        data: { error: errorMessage }
      })
      this.emitStatus(session.hiveSessionId, 'idle')
    } finally {
      this.manager.removeListener('event', handleEvent)
    }
  }

  async abort(worktreePath: string, agentSessionId: string): Promise<boolean> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)
    if (!session) {
      log.warn('Abort: session not found', { worktreePath, agentSessionId })
      return false
    }

    try {
      await this.manager.interruptTurn(session.threadId)
    } catch (error) {
      log.warn('Abort: interruptTurn failed, continuing cleanup', {
        worktreePath,
        agentSessionId,
        error: error instanceof Error ? error.message : String(error)
      })
    }

    session.status = 'ready'
    this.emitStatus(session.hiveSessionId, 'idle')
    return true
  }

  async getMessages(worktreePath: string, agentSessionId: string): Promise<unknown[]> {
    const key = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(key)
    if (!session) {
      log.warn('getMessages: session not found', { worktreePath, agentSessionId })
      return []
    }

    // Return in-memory messages if available
    if (session.messages.length > 0) {
      return [...session.messages]
    }

    // Fallback: try reading from thread via the server
    if (session.status !== 'closed') {
      try {
        const threadSnapshot = await this.manager.readThread(session.threadId)
        const parsed = this.parseThreadSnapshot(threadSnapshot)
        if (parsed.length > 0) {
          session.messages = parsed
          log.info('getMessages: warmed in-memory cache from thread/read', {
            agentSessionId,
            count: parsed.length
          })
          return [...parsed]
        }
      } catch (error) {
        log.warn('getMessages: readThread fallback failed', {
          agentSessionId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return []
  }

  // ── Models ───────────────────────────────────────────────────────

  async getAvailableModels(): Promise<unknown> {
    return getAvailableCodexModels()
  }

  async getModelInfo(
    _worktreePath: string,
    modelId: string
  ): Promise<{
    id: string
    name: string
    limit: { context: number; input?: number; output: number }
  } | null> {
    return getCodexModelInfo(modelId)
  }

  setSelectedModel(model: { providerID: string; modelID: string; variant?: string }): void {
    this.selectedModel = resolveCodexModelSlug(model.modelID)
    this.selectedVariant = model.variant
    log.info('Selected model set', {
      raw: model.modelID,
      resolved: this.selectedModel,
      variant: model.variant
    })
  }

  // ── Session info ─────────────────────────────────────────────────

  async getSessionInfo(
    worktreePath: string,
    agentSessionId: string
  ): Promise<{
    revertMessageID: string | null
    revertDiff: string | null
  }> {
    const sessionKey = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(sessionKey)
    return {
      revertMessageID: session?.revertMessageID ?? null,
      revertDiff: session?.revertDiff ?? null
    }
  }

  // ── Human-in-the-loop ────────────────────────────────────────────

  async questionReply(
    requestId: string,
    answers: string[][],
    _worktreePath?: string
  ): Promise<void> {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) {
      throw new Error(`No pending question found for requestId: ${requestId}`)
    }

    // Convert string[][] answers to the format Codex expects
    const codexAnswers = answers.map(([id, answer]) => ({
      id: id ?? requestId,
      answer: answer ?? ''
    }))

    log.info('questionReply: responding to pending question', {
      requestId,
      hiveSessionId: pending.hiveSessionId,
      answerCount: codexAnswers.length
    })

    this.manager.respondToUserInput(pending.threadId, requestId, codexAnswers)
    this.pendingQuestions.delete(requestId)

    this.sendToRenderer('opencode:stream', {
      type: 'question.replied',
      sessionId: pending.hiveSessionId,
      data: { requestId, id: requestId }
    })
  }

  async questionReject(requestId: string, _worktreePath?: string): Promise<void> {
    const pending = this.pendingQuestions.get(requestId)
    if (!pending) {
      throw new Error(`No pending question found for requestId: ${requestId}`)
    }

    log.info('questionReject: rejecting pending question', {
      requestId,
      hiveSessionId: pending.hiveSessionId
    })

    this.manager.rejectUserInput(pending.threadId, requestId)
    this.pendingQuestions.delete(requestId)

    this.sendToRenderer('opencode:stream', {
      type: 'question.rejected',
      sessionId: pending.hiveSessionId,
      data: { requestId, id: requestId }
    })
  }

  async permissionReply(
    requestId: string,
    decision: 'once' | 'always' | 'reject',
    _worktreePath?: string
  ): Promise<void> {
    const pending = this.pendingApprovalSessions.get(requestId)
    if (!pending) {
      throw new Error(`No pending approval found for requestId: ${requestId}`)
    }

    log.info('permissionReply: responding to pending approval', {
      requestId,
      hiveSessionId: pending.hiveSessionId,
      decision
    })

    this.manager.respondToApproval(pending.threadId, requestId, decision)
    this.pendingApprovalSessions.delete(requestId)

    this.sendToRenderer('opencode:stream', {
      type: 'request.resolved',
      sessionId: pending.hiveSessionId,
      data: { requestId, id: requestId, decision }
    })
  }

  async permissionList(_worktreePath?: string): Promise<unknown[]> {
    // Aggregate pending approvals across all sessions
    const result: unknown[] = []
    for (const session of this.sessions.values()) {
      const approvals = this.manager.getPendingApprovals(session.threadId)
      for (const approval of approvals) {
        result.push({
          requestId: approval.requestId,
          method: approval.method,
          threadId: approval.threadId,
          turnId: approval.turnId,
          itemId: approval.itemId
        })
      }
    }
    return result
  }

  /** Check if a question requestId belongs to this implementer */
  hasPendingQuestion(requestId: string): boolean {
    return this.pendingQuestions.has(requestId)
  }

  /** Check if a permission requestId belongs to this implementer */
  hasPendingApproval(requestId: string): boolean {
    return this.pendingApprovalSessions.has(requestId)
  }

  // ── Undo/Redo ────────────────────────────────────────────────────

  async undo(
    worktreePath: string,
    agentSessionId: string,
    _hiveSessionId: string
  ): Promise<{ revertMessageID: string; restoredPrompt: string; revertDiff: string | null }> {
    const sessionKey = this.getSessionKey(worktreePath, agentSessionId)
    const session = this.sessions.get(sessionKey)
    if (!session) {
      throw new Error(`Undo failed: session not found for ${worktreePath} / ${agentSessionId}`)
    }

    if (session.messages.length === 0) {
      throw new Error('Nothing to undo')
    }

    // Rollback 1 turn via the Codex server
    const snapshot = await this.manager.rollbackThread(session.threadId, 1)

    // Try to extract the last user prompt from in-memory messages
    const restoredPrompt = this.extractLastUserPrompt(session)

    // Pop the last exchange (assistant + user) from in-memory messages
    // Find the last user message boundary
    const revertMessageID = this.popLastExchange(session)

    // Store revert state
    session.revertMessageID = revertMessageID
    session.revertDiff = null

    // Emit session info update to renderer
    this.sendToRenderer('opencode:stream', {
      type: 'session.updated',
      sessionId: session.hiveSessionId,
      data: { revertMessageID }
    })

    log.info('Undo completed', {
      worktreePath,
      agentSessionId,
      revertMessageID,
      restoredPrompt: restoredPrompt.slice(0, 50),
      snapshotReceived: !!snapshot
    })

    return { revertMessageID, restoredPrompt, revertDiff: null }
  }

  async redo(
    _worktreePath: string,
    _agentSessionId: string,
    _hiveSessionId: string
  ): Promise<unknown> {
    throw new Error('Redo is not supported for Codex sessions')
  }

  // ── Commands ─────────────────────────────────────────────────────

  async listCommands(_worktreePath: string): Promise<unknown[]> {
    throw new Error('CodexImplementer.listCommands() not yet implemented')
  }

  async sendCommand(
    _worktreePath: string,
    _agentSessionId: string,
    _command: string,
    _args?: string
  ): Promise<void> {
    throw new Error('CodexImplementer.sendCommand() not yet implemented')
  }

  // ── Session management ───────────────────────────────────────────

  async renameSession(
    _worktreePath: string,
    agentSessionId: string,
    name: string
  ): Promise<void> {
    // Codex has no server-side rename — just update Hive's local DB
    if (!this.dbService) {
      log.warn('renameSession: no dbService available', { agentSessionId })
      return
    }

    // Find hive session by matching agentSessionId (threadId)
    const sessionKey = this.findSessionKeyByAgentId(agentSessionId)
    if (sessionKey) {
      const session = this.sessions.get(sessionKey)
      if (session?.hiveSessionId) {
        try {
          this.dbService.updateSession(session.hiveSessionId, { name })
          log.info('renameSession: updated title in DB', {
            hiveSessionId: session.hiveSessionId,
            name
          })
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err))
          log.error('renameSession: failed to update title', error, {
            hiveSessionId: session.hiveSessionId
          })
        }
      }
    } else {
      log.warn('renameSession: session not found in active map', { agentSessionId })
    }
  }

  // ── Internal helpers (exposed for testing) ───────────────────────

  /** @internal */
  getSelectedModel(): string {
    return this.selectedModel
  }

  /** @internal */
  getSelectedVariant(): string | undefined {
    return this.selectedVariant
  }

  /** @internal */
  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  /** @internal */
  getManager(): CodexAppServerManager {
    return this.manager
  }

  /** @internal */
  getSessions(): Map<string, CodexSessionState> {
    return this.sessions
  }

  /** @internal */
  getPendingQuestions(): Map<string, PendingHitlEntry> {
    return this.pendingQuestions
  }

  /** @internal */
  getPendingApprovalSessions(): Map<string, PendingHitlEntry> {
    return this.pendingApprovalSessions
  }

  // ── Private helpers ──────────────────────────────────────────────

  private cleanupPendingForThread(threadId: string): void {
    for (const [reqId, entry] of this.pendingQuestions.entries()) {
      if (entry.threadId === threadId) {
        this.pendingQuestions.delete(reqId)
      }
    }
    for (const [reqId, entry] of this.pendingApprovalSessions.entries()) {
      if (entry.threadId === threadId) {
        this.pendingApprovalSessions.delete(reqId)
      }
    }
  }

  private getSessionKey(worktreePath: string, agentSessionId: string): string {
    return `${worktreePath}::${agentSessionId}`
  }

  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data)
    } else {
      log.debug('sendToRenderer: no window (headless)')
    }
  }

  private mapProviderStatus(
    status: 'connecting' | 'ready' | 'running' | 'error' | 'closed'
  ): CodexSessionState['status'] {
    return status
  }

  private statusToHive(
    status: CodexSessionState['status']
  ): 'idle' | 'busy' | 'retry' {
    if (status === 'running') return 'busy'
    return 'idle'
  }

  private emitStatus(
    hiveSessionId: string,
    status: 'idle' | 'busy' | 'retry',
    extra?: { attempt?: number; message?: string; next?: number }
  ): void {
    const statusPayload = { type: status, ...extra }
    this.sendToRenderer('opencode:stream', {
      type: 'session.status',
      sessionId: hiveSessionId,
      data: { status: statusPayload },
      statusPayload
    })
  }

  private waitForTurnCompletion(
    session: CodexSessionState,
    isComplete: () => boolean,
    timeoutMs = 300_000
  ): Promise<void> {
    if (isComplete()) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Turn timed out'))
      }, timeoutMs)

      const checkEvent = (event: CodexManagerEvent) => {
        if (event.threadId !== session.threadId) return

        if (event.method === 'turn/completed') {
          cleanup()
          resolve()
          return
        }

        // Reject immediately on error events so prompt() doesn't hang
        // when the Codex process crashes or enters an unrecoverable state.
        if (event.kind === 'error') {
          cleanup()
          reject(new Error(event.message ?? 'Codex process error'))
          return
        }

        const isErrorStateChange =
          (event.method === 'session.state.changed' ||
            event.method === 'session/state/changed') &&
          (event.payload as Record<string, unknown> | undefined)?.state === 'error'

        if (isErrorStateChange) {
          const payload = event.payload as Record<string, unknown>
          const reason = (payload?.reason as string)
            ?? (payload?.error as string)
            ?? event.message
            ?? 'Session entered error state'
          cleanup()
          reject(new Error(reason))
        }
      }

      const cleanup = () => {
        clearTimeout(timer)
        this.manager.removeListener('event', checkEvent)
      }

      this.manager.on('event', checkEvent)

      // Check again in case it completed between the start and listener setup
      if (isComplete()) {
        cleanup()
        resolve()
      }
    })
  }

  /** Find a session key by its agentSessionId (threadId) */
  private findSessionKeyByAgentId(agentSessionId: string): string | null {
    for (const [key, session] of this.sessions.entries()) {
      if (session.threadId === agentSessionId) {
        return key
      }
    }
    return null
  }

  /** Extract the last user prompt text from in-memory messages */
  private extractLastUserPrompt(session: CodexSessionState): string {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const msg = asObject(session.messages[i])
      if (msg?.role === 'user') {
        const parts = msg.parts as unknown[] | undefined
        if (Array.isArray(parts)) {
          for (const part of parts) {
            const partObj = asObject(part)
            if (partObj?.type === 'text' && typeof partObj.text === 'string') {
              return partObj.text
            }
          }
        }
      }
    }
    return ''
  }

  /**
   * Pop the last user+assistant exchange from in-memory messages.
   * Returns the ID/timestamp of the new last message (the revert boundary),
   * or a synthetic boundary ID if no messages remain.
   */
  private popLastExchange(session: CodexSessionState): string {
    // Remove trailing assistant message(s)
    while (session.messages.length > 0) {
      const last = asObject(session.messages[session.messages.length - 1])
      if (last?.role === 'assistant') {
        session.messages.pop()
      } else {
        break
      }
    }

    // Remove the trailing user message
    if (session.messages.length > 0) {
      const last = asObject(session.messages[session.messages.length - 1])
      if (last?.role === 'user') {
        session.messages.pop()
      }
    }

    // Return the ID of what's now the last message, or a synthetic boundary
    if (session.messages.length > 0) {
      const last = asObject(session.messages[session.messages.length - 1])
      return asString(last?.id)
        ?? asString(last?.timestamp)
        ?? `revert-${session.messages.length}`
    }

    return 'revert-0'
  }

  /** Parse a thread/read snapshot into a message array for getMessages() */
  private parseThreadSnapshot(snapshot: unknown): unknown[] {
    const obj = asObject(snapshot)
    if (!obj) return []

    const threadObj = asObject(obj.thread) ?? obj
    const turns = threadObj.turns as unknown[] | undefined
    if (!Array.isArray(turns)) return []

    const messages: unknown[] = []
    for (const turn of turns) {
      const turnObj = asObject(turn)
      if (!turnObj) continue

      // Extract user input
      const input = turnObj.input as unknown[] | undefined
      if (Array.isArray(input)) {
        const textParts: unknown[] = []
        for (const item of input) {
          const itemObj = asObject(item)
          if (itemObj?.type === 'text' && typeof itemObj.text === 'string') {
            textParts.push({
              type: 'text',
              text: itemObj.text,
              timestamp: asString(turnObj.createdAt) ?? new Date().toISOString()
            })
          }
        }
        if (textParts.length > 0) {
          messages.push({
            role: 'user',
            parts: textParts,
            timestamp: asString(turnObj.createdAt) ?? new Date().toISOString()
          })
        }
      }

      // Extract assistant output
      const output = turnObj.output as unknown[] | undefined
      const outputText = asString(turnObj.outputText)
      if (outputText) {
        messages.push({
          role: 'assistant',
          parts: [{
            type: 'text',
            text: outputText,
            timestamp: asString(turnObj.updatedAt) ?? new Date().toISOString()
          }],
          timestamp: asString(turnObj.updatedAt) ?? new Date().toISOString()
        })
      } else if (Array.isArray(output)) {
        const assistantParts: unknown[] = []
        for (const item of output) {
          const itemObj = asObject(item)
          if (!itemObj) continue
          if (itemObj.type === 'text' && typeof itemObj.text === 'string') {
            assistantParts.push({
              type: 'text',
              text: itemObj.text,
              timestamp: asString(turnObj.updatedAt) ?? new Date().toISOString()
            })
          }
        }
        if (assistantParts.length > 0) {
          messages.push({
            role: 'assistant',
            parts: assistantParts,
            timestamp: asString(turnObj.updatedAt) ?? new Date().toISOString()
          })
        }
      }
    }

    return messages
  }
}
