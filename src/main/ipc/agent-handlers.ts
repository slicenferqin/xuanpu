import { ipcMain, BrowserWindow } from 'electron'
import { openCodeService } from '../services/opencode-service'
import { createLogger } from '../services/logger'
import { telemetryService } from '../services/telemetry-service'
import type { DatabaseService } from '../db/database'
import type { AgentRuntimeManager } from '../services/agent-runtime-manager'
import type { PromptOptions } from '../services/agent-runtime-types'
import { ClaudeCodeImplementer } from '../services/claude-code-implementer'
import { CodexImplementer } from '../services/codex-implementer'

const log = createLogger({ component: 'AgentHandlers' })

// Track worktree paths that have already received context injection for their
// current session. We key by worktreePath (not runtimeSessionId) because
// Claude Code sessions start with a `pending::` ID that materializes to a real
// SDK ID after the first prompt — using the session ID would cause re-injection
// when the ID changes.
const injectedWorktrees = new Set<string>()

export function registerAgentHandlers(
  mainWindow: BrowserWindow,
  runtimeManager?: AgentRuntimeManager,
  dbService?: DatabaseService
): void {
  // Set the main window for event forwarding
  openCodeService.setMainWindow(mainWindow)

  // Connect to runtime for a worktree (lazy starts server if needed)
  ipcMain.handle(
    'agent:connect',
    async (_event, worktreePath: string, hiveSessionId: string) => {
      log.info('IPC: agent:connect', { worktreePath, hiveSessionId })
      // New session on this worktree — allow context injection for the first prompt
      injectedWorktrees.delete(worktreePath)
      try {
        const runtimeId = dbService?.getSession(hiveSessionId)?.agent_sdk ?? 'opencode'
        log.info('IPC: agent:connect runtime resolution', { hiveSessionId, runtimeId })
        // Terminal sessions have no AI backend — short-circuit
        if (runtimeId === 'terminal') {
          return { success: true, sessionId: hiveSessionId }
        }
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }
        const impl = runtimeManager.getImplementer(runtimeId)
        const result = await impl.connect(worktreePath, hiveSessionId)
        telemetryService.track('session_started', { runtime_id: runtimeId })
        return { success: true, ...result }
      } catch (error) {
        log.error('IPC: agent:connect failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Reconnect to existing OpenCode session
  ipcMain.handle(
    'agent:reconnect',
    async (_event, worktreePath: string, runtimeSessionId: string, hiveSessionId: string) => {
      log.info('IPC: agent:reconnect', { worktreePath, runtimeSessionId, hiveSessionId })
      try {
        const runtimeId = dbService?.getRuntimeIdForSession(runtimeSessionId) ?? 'opencode'
        // Terminal sessions have no AI backend — short-circuit
        if (runtimeId === 'terminal') {
          return { success: true, sessionStatus: 'idle' as const }
        }
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }
        const impl = runtimeManager.getImplementer(runtimeId)
        const result = await impl.reconnect(worktreePath, runtimeSessionId, hiveSessionId)
        return result
      } catch (error) {
        log.error('IPC: agent:reconnect failed', { error })
        return { success: false }
      }
    }
  )

  // Send a prompt (response streams via onStream)
  // Accepts either { worktreePath, sessionId, parts } object or positional (worktreePath, sessionId, message) for backward compat
  ipcMain.handle('agent:prompt', async (_event, ...args: unknown[]) => {
    let worktreePath: string
    let runtimeSessionId: string
    let messageOrParts:
      | string
      | Array<{ type: string; text?: string; mime?: string; url?: string; filename?: string }>
    let model: { providerID: string; modelID: string; variant?: string } | undefined
    let options: PromptOptions | undefined

    // Support object-style call: { worktreePath, sessionId, parts }
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      const obj = args[0] as Record<string, unknown>
      worktreePath = obj.worktreePath as string
      runtimeSessionId = obj.sessionId as string
      // Backward compat: accept message string or parts array
      messageOrParts = (obj.parts as typeof messageOrParts) || [
        { type: 'text', text: obj.message as string }
      ]
      const rawModel = obj.model as Record<string, unknown> | undefined
      if (
        rawModel &&
        typeof rawModel.providerID === 'string' &&
        typeof rawModel.modelID === 'string'
      ) {
        model = {
          providerID: rawModel.providerID,
          modelID: rawModel.modelID,
          variant: typeof rawModel.variant === 'string' ? rawModel.variant : undefined
        }
      }
      const rawOptions = obj.options as Record<string, unknown> | undefined
      if (rawOptions && typeof rawOptions.codexFastMode === 'boolean') {
        options = { codexFastMode: rawOptions.codexFastMode }
      }
    } else {
      // Legacy positional args: (worktreePath, sessionId, message)
      worktreePath = args[0] as string
      runtimeSessionId = args[1] as string
      messageOrParts = args[2] as string
      const rawModel = args[3] as Record<string, unknown> | undefined
      if (
        rawModel &&
        typeof rawModel.providerID === 'string' &&
        typeof rawModel.modelID === 'string'
      ) {
        model = {
          providerID: rawModel.providerID,
          modelID: rawModel.modelID,
          variant: typeof rawModel.variant === 'string' ? rawModel.variant : undefined
        }
      }
      const rawOptions = args[4] as Record<string, unknown> | undefined
      if (rawOptions && typeof rawOptions.codexFastMode === 'boolean') {
        options = { codexFastMode: rawOptions.codexFastMode }
      }
    }

    // Inject worktree context on first prompt of each session.
    // We track by worktreePath (not runtimeSessionId) because Claude Code
    // sessions start with a pending:: ID that materializes to a real ID after
    // the first prompt — tracking by session ID would miss the transition.
    if (!injectedWorktrees.has(worktreePath) && dbService) {
      // Skip worktree context injection for Supercharge sessions — the plan
      // content that follows already has full context and the worktree context
      // just pollutes it.
      const firstTextPart = Array.isArray(messageOrParts)
        ? messageOrParts.find((p) => p.type === 'text')?.text?.trim()
        : typeof messageOrParts === 'string'
          ? messageOrParts.trim()
          : undefined
      if (firstTextPart?.startsWith('/using-superpowers')) {
        injectedWorktrees.add(worktreePath)
      } else {
        try {
          const worktree = dbService.getWorktreeByPath(worktreePath)
          if (worktree?.context) {
            log.info('Injecting worktree context into first prompt', {
              worktreePath,
              runtimeSessionId,
              contextLength: worktree.context.length
            })
            const contextPrefix = `[Worktree Context]\n${worktree.context}\n\n[User Message]\n`
            if (typeof messageOrParts === 'string') {
              messageOrParts = contextPrefix + messageOrParts
            } else if (Array.isArray(messageOrParts)) {
              // Find the first text part and prepend context
              const textPartIndex = messageOrParts.findIndex((p) => p.type === 'text')
              if (textPartIndex >= 0) {
                const textPart = messageOrParts[textPartIndex]
                if (textPart.type === 'text' && textPart.text) {
                  messageOrParts = [...messageOrParts]
                  messageOrParts[textPartIndex] = {
                    ...textPart,
                    text: contextPrefix + textPart.text
                  }
                }
              }
            }
          }
          // Mark as injected after successful lookup (even if no context to inject)
          injectedWorktrees.add(worktreePath)
        } catch (err) {
          // Don't add to injectedWorktrees — allow retry on next prompt
          log.warn('Failed to inject worktree context', {
            worktreePath,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }
    }

    log.info('IPC: agent:prompt', {
      worktreePath,
      runtimeSessionId,
      partsCount: Array.isArray(messageOrParts) ? messageOrParts.length : 1,
      model,
      options
    })
    try {
      const runtimeId = dbService?.getRuntimeIdForSession(runtimeSessionId) ?? 'opencode'
      log.info('IPC: agent:prompt runtime resolution', { runtimeSessionId, runtimeId })
      if (runtimeId === 'terminal') {
        return { success: true }
      }
      if (!runtimeManager) {
        throw new Error('runtimeManager is required')
      }
      const impl = runtimeManager.getImplementer(runtimeId)
      await impl.prompt(worktreePath, runtimeSessionId, messageOrParts, model, options)
      telemetryService.track('prompt_sent', { runtime_id: runtimeId })
      return { success: true }
    } catch (error) {
      log.error('IPC: agent:prompt failed', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // Disconnect session (may kill server if last session for worktree)
  ipcMain.handle(
    'agent:disconnect',
    async (_event, worktreePath: string, runtimeSessionId: string) => {
      log.info('IPC: agent:disconnect', { worktreePath, runtimeSessionId })
      injectedWorktrees.delete(worktreePath)
      try {
        const runtimeId = dbService?.getRuntimeIdForSession(runtimeSessionId) ?? 'opencode'
        if (runtimeId === 'terminal') {
          return { success: true }
        }
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }
        const impl = runtimeManager.getImplementer(runtimeId)
        await impl.disconnect(worktreePath, runtimeSessionId)
        return { success: true }
      } catch (error) {
        log.error('IPC: agent:disconnect failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Get available models from all configured providers
  ipcMain.handle(
    'agent:models',
    async (_event, opts?: { runtimeId?: 'opencode' | 'claude-code' | 'codex' | 'terminal' }) => {
      log.info('IPC: agent:models', { runtimeId: opts?.runtimeId })
      try {
        const runtimeId = opts?.runtimeId ?? 'opencode'
        if (runtimeId === 'terminal') {
          return { success: true, providers: {} }
        }
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }
        const impl = runtimeManager.getImplementer(runtimeId)
        const providers = await impl.getAvailableModels()
        return { success: true, providers }
      } catch (error) {
        log.error('IPC: agent:models failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          providers: {}
        }
      }
    }
  )

  // Set the selected model
  ipcMain.handle(
    'agent:setModel',
    async (
      _event,
      model: {
        providerID: string
        modelID: string
        variant?: string
        runtimeId?: 'opencode' | 'claude-code' | 'codex' | 'terminal'
      } | null
    ) => {
      log.info('IPC: agent:setModel', {
        model: model ? model.modelID : null,
        runtimeId: model?.runtimeId
      })
      try {
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }
        // Handle null (clear global model) — route to opencode by default
        if (model === null) {
          const openCodeImpl = runtimeManager.getImplementer('opencode')
          // Use duck typing to access the optional clearSelectedModel method
          const maybeClear = (openCodeImpl as unknown as { clearSelectedModel?: () => void })
            .clearSelectedModel
          if (typeof maybeClear === 'function') {
            maybeClear.call(openCodeImpl)
          }
          return { success: true }
        }

        const runtimeId = model.runtimeId ?? 'opencode'
        if (runtimeId === 'terminal') {
          return { success: true }
        }
        const impl = runtimeManager.getImplementer(runtimeId)
        impl.setSelectedModel(model)
        return { success: true }
      } catch (error) {
        log.error('IPC: agent:setModel failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Get model info (name, context limit)
  ipcMain.handle(
    'agent:modelInfo',
    async (
      _event,
      {
        worktreePath,
        modelId,
        runtimeId
      }: {
        worktreePath: string
        modelId: string
        runtimeId?: 'opencode' | 'claude-code' | 'codex' | 'terminal'
      }
    ) => {
      log.info('IPC: agent:modelInfo', { worktreePath, modelId, runtimeId })
      try {
        const resolvedRuntimeId = runtimeId ?? 'opencode'
        if (resolvedRuntimeId === 'terminal') {
          return { success: false, error: 'Terminal sessions have no model' }
        }
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }
        const impl = runtimeManager.getImplementer(resolvedRuntimeId)
        const model = await impl.getModelInfo(worktreePath, modelId)
        if (!model) {
          return { success: false, error: 'Model not found' }
        }
        return { success: true, model }
      } catch (error) {
        log.error('IPC: agent:modelInfo failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Get session info (revert state)
  ipcMain.handle(
    'agent:sessionInfo',
    async (_event, { worktreePath, sessionId }: { worktreePath: string; sessionId: string }) => {
      log.info('IPC: agent:sessionInfo', { worktreePath, sessionId })
      try {
        const runtimeId = dbService?.getRuntimeIdForSession(sessionId) ?? 'opencode'
        if (runtimeId === 'terminal') {
          return { success: true, revertMessageID: null, revertDiff: null }
        }
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }
        const impl = runtimeManager.getImplementer(runtimeId)
        const result = await impl.getSessionInfo(worktreePath, sessionId)
        return { success: true, ...result }
      } catch (error) {
        log.error('IPC: agent:sessionInfo failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // List available slash commands
  ipcMain.handle(
    'agent:commands',
    async (_event, { worktreePath, sessionId }: { worktreePath: string; sessionId?: string }) => {
      log.info('IPC: agent:commands', { worktreePath, sessionId })
      try {
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }

        // For pending:: sessions (not yet materialized in DB), try Claude Code
        // implementer as it may have cached commands from previous sessions.
        if (sessionId?.startsWith('pending::')) {
          const impl = runtimeManager.getImplementer('claude-code')
          const commands = await impl.listCommands(worktreePath)
          if (commands.length > 0) {
            return { success: true, commands }
          }
        }

        const runtimeId = sessionId
          ? dbService?.getRuntimeIdForSession(sessionId) ?? 'opencode'
          : 'opencode'
        if (runtimeId === 'terminal') {
          return { success: true, commands: [] }
        }
        const impl = runtimeManager.getImplementer(runtimeId)
        const commands = await impl.listCommands(worktreePath)
        return { success: true, commands }
      } catch (error) {
        log.error('IPC: agent:commands failed', { error })
        return {
          success: false,
          commands: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Send a slash command to a session via the SDK command endpoint
  ipcMain.handle(
    'agent:command',
    async (
      _event,
      {
        worktreePath,
        sessionId,
        command,
        args
      }: {
        worktreePath: string
        sessionId: string
        command: string
        args: string
        model?: { providerID: string; modelID: string; variant?: string }
      }
    ) => {
      log.info('IPC: agent:command', { worktreePath, sessionId, command, args })
      try {
        const runtimeId = dbService?.getRuntimeIdForSession(sessionId) ?? 'opencode'
        if (runtimeId === 'terminal') {
          return { success: true }
        }
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }
        const impl = runtimeManager.getImplementer(runtimeId)
        await impl.sendCommand(worktreePath, sessionId, command, args)
        return { success: true }
      } catch (error) {
        log.error('IPC: agent:command failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Undo last message state via runtime revert API
  ipcMain.handle(
    'agent:undo',
    async (_event, { worktreePath, sessionId }: { worktreePath: string; sessionId: string }) => {
      log.info('IPC: agent:undo', { worktreePath, sessionId })
      try {
        const runtimeId = dbService?.getRuntimeIdForSession(sessionId) ?? 'opencode'
        if (runtimeId === 'terminal') {
          return { success: true }
        }
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }
        const impl = runtimeManager.getImplementer(runtimeId)
        const result = await impl.undo(worktreePath, sessionId, '')
        return { success: true, ...(result as Record<string, unknown>) }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        log.error('IPC: agent:undo failed', err)
        return {
          success: false,
          error: err.message
        }
      }
    }
  )

  // Redo last undone message state via runtime unrevert/revert API
  ipcMain.handle(
    'agent:redo',
    async (_event, { worktreePath, sessionId }: { worktreePath: string; sessionId: string }) => {
      log.info('IPC: agent:redo', { worktreePath, sessionId })
      try {
        const runtimeId = dbService?.getRuntimeIdForSession(sessionId) ?? 'opencode'
        if (runtimeId === 'terminal') {
          return { success: true }
        }
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }
        const impl = runtimeManager.getImplementer(runtimeId)
        const result = await impl.redo(worktreePath, sessionId, '')
        return { success: true, ...(result as Record<string, unknown>) }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        log.error('IPC: agent:redo failed', err)
        return {
          success: false,
          error: err.message
        }
      }
    }
  )

  // Get runtime capabilities for a session
  ipcMain.handle('agent:capabilities', async (_event, { sessionId }: { sessionId?: string }) => {
    try {
      if (runtimeManager && dbService && sessionId) {
        const runtimeId = dbService.getRuntimeIdForSession(sessionId)
        if (runtimeId) {
          return { success: true, capabilities: runtimeManager.getCapabilities(runtimeId) }
        }
      }
      // Default to opencode capabilities
      const defaultCaps = runtimeManager?.getCapabilities('opencode') ?? null
      return { success: true, capabilities: defaultCaps }
    } catch (error) {
      log.error('IPC: agent:capabilities failed', { error })
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  })

  // Reply to a pending question from the AI
  ipcMain.handle(
    'agent:question:reply',
    async (
      _event,
      {
        requestId,
        answers,
        worktreePath
      }: { requestId: string; answers: string[][]; worktreePath?: string }
    ) => {
      log.info('IPC: agent:question:reply', { requestId })
      try {
        // Route to Claude Code implementer if this is a Claude Code question
        if (runtimeManager) {
          const claudeImpl = runtimeManager.getImplementer('claude-code') as ClaudeCodeImplementer
          if (claudeImpl.hasPendingQuestion(requestId)) {
            await claudeImpl.questionReply(requestId, answers, worktreePath)
            return { success: true }
          }

          // Route to Codex implementer if this is a Codex question
          try {
            const codexImpl = runtimeManager.getImplementer('codex') as CodexImplementer
            if (codexImpl.hasPendingQuestion(requestId)) {
              await codexImpl.questionReply(requestId, answers, worktreePath)
              return { success: true }
            }
          } catch {
            // Codex implementer not registered, continue
          }

          // Fall through to OpenCode adapter
          const openCodeImpl = runtimeManager.getImplementer('opencode')
          await openCodeImpl.questionReply(requestId, answers, worktreePath)
          return { success: true }
        }
        throw new Error('runtimeManager is required')
      } catch (error) {
        log.error('IPC: agent:question:reply failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Reject/dismiss a pending question from the AI
  ipcMain.handle(
    'agent:question:reject',
    async (_event, { requestId, worktreePath }: { requestId: string; worktreePath?: string }) => {
      log.info('IPC: agent:question:reject', { requestId })
      try {
        // Route to Claude Code implementer if this is a Claude Code question
        if (runtimeManager) {
          const claudeImpl = runtimeManager.getImplementer('claude-code') as ClaudeCodeImplementer
          if (claudeImpl.hasPendingQuestion(requestId)) {
            await claudeImpl.questionReject(requestId, worktreePath)
            return { success: true }
          }

          // Route to Codex implementer if this is a Codex question
          try {
            const codexImpl = runtimeManager.getImplementer('codex') as CodexImplementer
            if (codexImpl.hasPendingQuestion(requestId)) {
              await codexImpl.questionReject(requestId, worktreePath)
              return { success: true }
            }
          } catch {
            // Codex implementer not registered, continue
          }

          // Fall through to OpenCode adapter
          const openCodeImpl = runtimeManager.getImplementer('opencode')
          await openCodeImpl.questionReject(requestId, worktreePath)
          return { success: true }
        }
        throw new Error('runtimeManager is required')
      } catch (error) {
        log.error('IPC: agent:question:reject failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Approve a pending plan (ExitPlanMode) — unblocks the SDK to implement
  ipcMain.handle(
    'agent:plan:approve',
    async (
      _event,
      {
        worktreePath,
        hiveSessionId,
        requestId
      }: { worktreePath: string; hiveSessionId: string; requestId?: string }
    ) => {
      log.info('IPC: agent:plan:approve', { hiveSessionId, requestId })
      try {
        // TODO(codex): Generalize when Codex implements this HITL flow
        if (runtimeManager) {
          const claudeImpl = runtimeManager.getImplementer('claude-code') as ClaudeCodeImplementer
          if (
            (requestId && claudeImpl.hasPendingPlan(requestId)) ||
            claudeImpl.hasPendingPlanForSession(hiveSessionId)
          ) {
            await claudeImpl.planApprove(worktreePath, hiveSessionId, requestId)
            return { success: true }
          }
        }
        return { success: false, error: 'No pending plan found' }
      } catch (error) {
        log.error('IPC: agent:plan:approve failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Reject a pending plan with user feedback — Claude will revise
  ipcMain.handle(
    'agent:plan:reject',
    async (
      _event,
      {
        worktreePath,
        hiveSessionId,
        feedback,
        requestId
      }: { worktreePath: string; hiveSessionId: string; feedback: string; requestId?: string }
    ) => {
      log.info('IPC: agent:plan:reject', {
        hiveSessionId,
        requestId,
        feedbackLength: feedback.length
      })
      try {
        // TODO(codex): Generalize when Codex implements this HITL flow
        if (runtimeManager) {
          const claudeImpl = runtimeManager.getImplementer('claude-code') as ClaudeCodeImplementer
          if (
            (requestId && claudeImpl.hasPendingPlan(requestId)) ||
            claudeImpl.hasPendingPlanForSession(hiveSessionId)
          ) {
            await claudeImpl.planReject(worktreePath, hiveSessionId, feedback, requestId)
            return { success: true }
          }
        }
        return { success: false, error: 'No pending plan found' }
      } catch (error) {
        log.error('IPC: agent:plan:reject failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Reply to a pending permission request
  ipcMain.handle(
    'agent:permission:reply',
    async (
      _event,
      {
        requestId,
        reply,
        worktreePath,
        message
      }: {
        requestId: string
        reply: 'once' | 'always' | 'reject'
        worktreePath?: string
        message?: string
      }
    ) => {
      log.info('IPC: agent:permission:reply', { requestId, reply })
      try {
        // Route to Codex implementer if this is a Codex approval
        if (runtimeManager) {
          try {
            const codexImpl = runtimeManager.getImplementer('codex') as CodexImplementer
            if (codexImpl.hasPendingApproval(requestId)) {
              await codexImpl.permissionReply(requestId, reply, worktreePath)
              return { success: true }
            }
          } catch {
            // Codex implementer not registered, continue
          }
        }
        // Fall through to OpenCode (uses extra `message` arg not in the adapter interface)
        await openCodeService.permissionReply(requestId, reply, worktreePath, message)
        return { success: true }
      } catch (error) {
        log.error('IPC: agent:permission:reply failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // List all pending permission requests
  ipcMain.handle(
    'agent:permission:list',
    async (_event, { worktreePath }: { worktreePath?: string }) => {
      log.info('IPC: agent:permission:list')
      try {
        // Aggregate permissions from all implementers
        let permissions: unknown[] = []
        if (runtimeManager) {
          const openCodeImpl = runtimeManager.getImplementer('opencode')
          permissions = await openCodeImpl.permissionList(worktreePath)

          // Also include Codex pending approvals
          try {
            const codexImpl = runtimeManager.getImplementer('codex') as CodexImplementer
            const codexPermissions = await codexImpl.permissionList(worktreePath)
            permissions = [...permissions, ...codexPermissions]
          } catch {
            // Codex implementer not registered, continue
          }
        }

        return { success: true, permissions }
      } catch (error) {
        log.error('IPC: agent:permission:list failed', { error })
        return {
          success: false,
          permissions: [],
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Reply to a pending command approval request (for command filter system)
  ipcMain.handle(
    'agent:commandApprovalReply',
    async (
      _event,
      {
        requestId,
        approved,
        remember,
        pattern,
        worktreePath: _worktreePath,
        patterns
      }: {
        requestId: string
        approved: boolean
        remember?: 'allow' | 'block'
        pattern?: string
        worktreePath?: string
        patterns?: string[]
      }
    ) => {
      log.info('IPC: agent:commandApprovalReply', {
        requestId,
        approved,
        remember,
        pattern,
        patterns
      })
      try {
        // TODO(codex): Generalize when Codex implements this HITL flow
        // Route to Claude Code implementer (command approval is Claude Code specific)
        if (runtimeManager) {
          const impl = runtimeManager.getImplementer('claude-code')
          if (impl instanceof ClaudeCodeImplementer) {
            impl.handleApprovalReply(requestId, approved, remember, pattern, patterns)
            return { success: true }
          }
        }
        throw new Error('Claude Code implementer not available')
      } catch (error) {
        log.error('IPC: agent:commandApprovalReply failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Rename a session's title via the runtime's PATCH API
  ipcMain.handle(
    'agent:renameSession',
    async (
      _event,
      {
        runtimeSessionId,
        title,
        worktreePath
      }: { runtimeSessionId: string; title: string; worktreePath?: string }
    ) => {
      log.info('IPC: agent:renameSession', { runtimeSessionId, title })
      try {
        const runtimeId = dbService?.getRuntimeIdForSession(runtimeSessionId) ?? 'opencode'
        if (runtimeId === 'terminal') {
          return { success: true }
        }
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }
        const impl = runtimeManager.getImplementer(runtimeId)
        await impl.renameSession(worktreePath ?? '', runtimeSessionId, title)
        return { success: true }
      } catch (error) {
        log.error('IPC: agent:renameSession failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Fork an existing session at an optional message boundary.
  // NOTE: forkSession is OpenCode-specific today; not part of AgentRuntimeAdapter interface.
  ipcMain.handle(
    'agent:fork',
    async (
      _event,
      {
        worktreePath,
        sessionId,
        messageId
      }: { worktreePath: string; sessionId: string; messageId?: string }
    ) => {
      log.info('IPC: agent:fork', { worktreePath, sessionId, messageId })
      try {
        const result = await openCodeService.forkSession(worktreePath, sessionId, messageId)
        return { success: true, ...result }
      } catch (error) {
        log.error('IPC: agent:fork failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Get messages from a session
  ipcMain.handle(
    'agent:messages',
    async (_event, worktreePath: string, runtimeSessionId: string) => {
      log.info('IPC: agent:messages', { worktreePath, runtimeSessionId })
      try {
        const runtimeId = dbService?.getRuntimeIdForSession(runtimeSessionId) ?? 'opencode'
        if (runtimeId === 'terminal') {
          return { success: true, messages: [] }
        }
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }
        const impl = runtimeManager.getImplementer(runtimeId)
        const messages = await impl.getMessages(worktreePath, runtimeSessionId)
        return { success: true, messages }
      } catch (error) {
        log.error('IPC: agent:messages failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          messages: []
        }
      }
    }
  )

  // Abort a streaming session
  ipcMain.handle(
    'agent:abort',
    async (_event, worktreePath: string, runtimeSessionId: string) => {
      log.info('IPC: agent:abort', { worktreePath, runtimeSessionId })
      try {
        const runtimeId = dbService?.getRuntimeIdForSession(runtimeSessionId) ?? 'opencode'
        if (runtimeId === 'terminal') {
          return { success: true }
        }
        if (!runtimeManager) {
          throw new Error('runtimeManager is required')
        }
        const impl = runtimeManager.getImplementer(runtimeId)
        const result = await impl.abort(worktreePath, runtimeSessionId)
        return { success: result }
      } catch (error) {
        log.error('IPC: agent:abort failed', { error })
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  log.info('Agent IPC handlers registered')
}

export async function cleanupAgentHandlers(runtimeManager?: AgentRuntimeManager): Promise<void> {
  log.info('Cleaning up agent runtime services')
  injectedWorktrees.clear()
  if (runtimeManager) {
    await runtimeManager.cleanupAll()
  } else {
    await openCodeService.cleanup()
  }
}
