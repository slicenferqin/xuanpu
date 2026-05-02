import { ipcMain, BrowserWindow } from 'electron'
import { openCodeService } from '../services/opencode-service'
import { createLogger } from '../services/logger'
import { telemetryService } from '../services/telemetry-service'
import type { DatabaseService } from '../db/database'
import type { AgentRuntimeManager } from '../services/agent-runtime-manager'
import type { AgentRuntimeAdapter, PromptOptions } from '../services/agent-runtime-types'
import { ClaudeCodeImplementer } from '../services/claude-code-implementer'
import { emitFieldEvent } from '../field/emit'
import { isFieldCollectionEnabled } from '../field/privacy'
import { buildFieldContextSnapshot } from '../field/context-builder'
import { formatFieldContext } from '../field/context-formatter'
import { cacheLastInjection } from '../field/last-injection-cache'
import { recordCheckpointOnAbort } from '../field/checkpoint-hooks'
import {
  createAgentHandler,
  AgentErrorCode,
  AgentHandlerError,
  resolveRuntimeId,
  type AgentHandlerContext
} from './agent-handler-wrapper'
import {
  abortSchema,
  capabilitiesSchema,
  commandApprovalReplySchema,
  commandSchema,
  commandsSchema,
  connectSchema,
  disconnectSchema,
  forkSchema,
  messagesSchema,
  modelInfoSchema,
  modelsSchema,
  permissionListSchema,
  permissionReplySchema,
  planApproveSchema,
  planRejectSchema,
  promptSchema,
  steerSchema,
  questionRejectSchema,
  questionReplySchema,
  reconnectSchema,
  redoSchema,
  renameSessionSchema,
  sessionInfoSchema,
  setModelSchema,
  undoSchema
} from './agent-handler-schemas'

const log = createLogger({ component: 'AgentHandlers' })

// Phase 22A: injectedWorktrees was a first-prompt-only gate for the legacy
// [Worktree Context] prefix. It's superseded by buildFieldContextSnapshot +
// formatFieldContext, which inject a fresh Field Context on every non-slash
// prompt. The worktree.context note is now one subsection of the Field Context.
// See docs/prd/phase-22a-working-memory.md §4.

type MessagePart =
  | { type: string; text?: string; mime?: string; url?: string; filename?: string }
type MessageOrParts = string | Array<MessagePart>

/** Extract the first text part's content (for slash detection + session.message). */
function getFirstText(m: unknown): string | undefined {
  if (typeof m === 'string') return m
  if (!Array.isArray(m)) return undefined
  const text = m.find((p) => (p as MessagePart).type === 'text') as MessagePart | undefined
  return text?.text
}

/** Prepend a prefix to the first text part (or the whole string) of a message. */
function prependToMessage<T extends MessageOrParts>(m: T, prefix: string): T {
  if (typeof m === 'string') return (prefix + m) as T
  if (!Array.isArray(m)) return m
  const idx = m.findIndex((p) => (p as MessagePart).type === 'text')
  if (idx < 0) {
    return [{ type: 'text', text: prefix }, ...m] as unknown as T
  }
  const part = m[idx] as MessagePart
  if (part.type !== 'text') return m
  const copy = [...m] as MessagePart[]
  copy[idx] = { ...part, text: prefix + (part.text ?? '') }
  return copy as unknown as T
}

// Dedupe concurrent agent:connect calls per hive session. React StrictMode
// double-invokes the renderer effect in dev, and stray callers may also retry —
// without dedupe each call spins up a fresh runtime session (e.g. an extra
// Codex thread) that nobody owns. The entry is cleared once the connect
// settles so genuine reconnects after teardown still work.
const inflightConnects = new Map<string, Promise<{ sessionId: string }>>()

export function registerAgentHandlers(
  mainWindow: BrowserWindow,
  runtimeManager?: AgentRuntimeManager,
  dbService?: DatabaseService
): void {
  // Build a strict context for wrapper-based handlers. Throws at startup if
  // runtimeManager/dbService are missing so we fail loudly rather than silently
  // returning success:false at runtime. Legacy non-wrapper handlers below keep
  // their existing nullable-ish checks during the gradual migration.
  if (!runtimeManager || !dbService) {
    throw new Error('registerAgentHandlers requires runtimeManager + dbService')
  }
  // Forward the main window to every registered adapter — each implementation
  // may need a BrowserWindow reference to push streaming events.
  runtimeManager.setMainWindow(mainWindow)
  const ctx: AgentHandlerContext = { runtimeManager, dbService }

  // Connect to runtime for a worktree (lazy starts server if needed)
  ipcMain.handle(
    'agent:connect',
    createAgentHandler(ctx, {
      channel: 'agent:connect',
      schema: connectSchema,
      handler: async ([worktreePath, hiveSessionId], c) => {
        log.info('IPC: agent:connect', { worktreePath, hiveSessionId })

        const runtimeId = c.dbService.getSession(hiveSessionId)?.agent_sdk ?? 'opencode'
        log.info('IPC: agent:connect runtime resolution', { hiveSessionId, runtimeId })
        // Terminal sessions have no AI backend — short-circuit
        if (runtimeId === 'terminal') {
          return { sessionId: hiveSessionId }
        }
        const impl = c.runtimeManager.getImplementer(runtimeId)

        // Dedupe concurrent connects for the same hive session so StrictMode
        // double-mount doesn't create duplicate runtime sessions.
        const existing = inflightConnects.get(hiveSessionId)
        if (existing) {
          log.info('IPC: agent:connect reusing in-flight connect', { hiveSessionId })
          const reused = await existing
          return { ...reused }
        }

        const connectPromise = (async () => {
          const result = await impl.connect(worktreePath, hiveSessionId)
          // Persist opencode_session_id atomically in the main process so
          // resolveRuntimeId() can route subsequent prompts/reconnects without
          // depending on the renderer winning a state race.
          if (result?.sessionId && result.sessionId !== hiveSessionId) {
            try {
              c.dbService.updateSession(hiveSessionId, {
                opencode_session_id: result.sessionId
              })
            } catch (err) {
              log.warn('Failed to persist opencode_session_id after connect', {
                hiveSessionId,
                runtimeSessionId: result.sessionId,
                error: err instanceof Error ? err.message : String(err)
              })
            }
          }
          return result
        })()

        inflightConnects.set(hiveSessionId, connectPromise)
        try {
          const result = await connectPromise
          telemetryService.track('session_started', { runtime_id: runtimeId })
          return { ...result }
        } finally {
          inflightConnects.delete(hiveSessionId)
        }
      }
    })
  )

  // Reconnect to existing OpenCode session
  ipcMain.handle(
    'agent:reconnect',
    createAgentHandler(ctx, {
      channel: 'agent:reconnect',
      schema: reconnectSchema,
      handler: async ([worktreePath, runtimeSessionId, hiveSessionId], c) => {
        log.info('IPC: agent:reconnect', { worktreePath, runtimeSessionId, hiveSessionId })
        const runtimeId = resolveRuntimeId(c, runtimeSessionId)
        if (runtimeId === 'terminal') {
          return { sessionStatus: 'idle' as const }
        }
        const impl = c.runtimeManager.getImplementer(runtimeId)
        const result = await impl.reconnect(worktreePath, runtimeSessionId, hiveSessionId)
        // Strip the inner `success` so the wrapper's success envelope wins
        // (adapter returns success:false on reconnect failure — treat as error path)
        const { success: innerSuccess, ...rest } = result
        if (!innerSuccess) {
          throw new Error('reconnect failed')
        }
        return rest
      }
    })
  )

  // Send a prompt (response streams via onStream)
  // Accepts either { worktreePath, sessionId, parts } object or positional (worktreePath, sessionId, message) for backward compat
  ipcMain.handle(
    'agent:prompt',
    createAgentHandler(ctx, {
      channel: 'agent:prompt',
      schema: promptSchema,
      handler: async (args, c) => {
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
          if (rawOptions) {
            options = {}
            if (typeof rawOptions.codexFastMode === 'boolean') {
              options.codexFastMode = rawOptions.codexFastMode
            }
            if (rawOptions.mode === 'build' || rawOptions.mode === 'plan') {
              options.mode = rawOptions.mode
            }
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
          if (rawOptions) {
            options = {}
            if (typeof rawOptions.codexFastMode === 'boolean') {
              options.codexFastMode = rawOptions.codexFastMode
            }
            if (rawOptions.mode === 'build' || rawOptions.mode === 'plan') {
              options.mode = rawOptions.mode
            }
          }
        }

        // Phase 22A: inject Field Context (working memory snapshot) as a prefix
        // to the user message. This replaces the Phase 21 first-prompt-only
        // [Worktree Context] injection. See docs/prd/phase-22a-working-memory.md.
        //
        // Key invariants:
        //   1. `originalMessage` is what gets captured as session.message and
        //      used anywhere the user-authored content matters (UI, titles).
        //   2. `messageOrParts` is what we actually send to the runtime —
        //      injected only if the prompt is NOT a slash command and we have
        //      either field context or a worktree note to add.
        //   3. Slash commands (/using-superpowers, /compact, /init, ...) are
        //      SDK internals. Prefixing them breaks SDK command detection.
        const originalMessage = messageOrParts

        const firstTextRaw = getFirstText(messageOrParts)?.trimStart()
        const isSlashCommand = firstTextRaw?.startsWith('/') ?? false

        if (!isSlashCommand) {
          try {
            const worktreeFromDb = c.dbService.getWorktreeByPath(worktreePath)
            if (worktreeFromDb) {
              let prefix: string | null = null
              let injectionTokens = 0

              if (isFieldCollectionEnabled()) {
                const snapshot = await buildFieldContextSnapshot({
                  worktreeId: worktreeFromDb.id
                })
                if (snapshot) {
                  const formatted = formatFieldContext(snapshot)
                  prefix = `${formatted.markdown}\n\n[User Message]\n`
                  injectionTokens = formatted.approxTokens
                  // Cache under both the runtime session id (what the SDK
                  // knows) and the Hive session id (what the renderer UI
                  // knows), so debug lookups from either side resolve.
                  const hiveSession = c.dbService.getSessionByOpenCodeSessionId(runtimeSessionId)
                  const hiveSessionId = hiveSession?.id ?? null
                  cacheLastInjection(
                    [runtimeSessionId, hiveSessionId],
                    formatted.markdown,
                    formatted.approxTokens
                  )
                  log.info('Field injection', {
                    worktreePath,
                    runtimeSessionId,
                    hiveSessionId,
                    tokens: formatted.approxTokens,
                    chars: formatted.markdown.length,
                    truncated: formatted.wasTruncated
                  })
                  log.debug('Field injection body', { body: formatted.markdown })
                }
              } else if (worktreeFromDb.context) {
                // Privacy gate is off but user has authored a worktree note —
                // honor it (the note is user-authored, not event-derived data).
                prefix = `[Worktree Context]\n${worktreeFromDb.context}\n\n[User Message]\n`
              }

              if (prefix) {
                messageOrParts = prependToMessage(messageOrParts, prefix)
              }
              void injectionTokens // suppress unused warning when prefix is null
            }
          } catch (err) {
            log.warn('Field injection failed; sending prompt without it', {
              worktreePath,
              runtimeSessionId,
              error: err instanceof Error ? err.message : String(err)
            })
          }
        }

        log.info('IPC: agent:prompt', {
          worktreePath,
          runtimeSessionId,
          partsCount: Array.isArray(messageOrParts) ? messageOrParts.length : 1,
          model,
          options
        })

        const runtimeId = resolveRuntimeId(c, runtimeSessionId)
        log.info('IPC: agent:prompt runtime resolution', { runtimeSessionId, runtimeId })
        if (runtimeId === 'terminal') return {}
        const impl = c.runtimeManager.getImplementer(runtimeId)
        await impl.prompt(worktreePath, runtimeSessionId, messageOrParts, model, options)
        telemetryService.track('prompt_sent', { runtime_id: runtimeId })

        // Phase 21 + 22A: emit session.message with ORIGINAL text (no Field Context
        // prefix) so dump scripts, memory layers, and any future introspection see
        // what the user actually typed — not the injected envelope.
        try {
          const text = getFirstText(originalMessage) ?? ''
          const attachmentCount = Array.isArray(originalMessage)
            ? originalMessage.filter((p) => p.type === 'file').length
            : 0
          const worktree = c.dbService.getWorktreeByPath(worktreePath)
          emitFieldEvent({
            type: 'session.message',
            worktreeId: worktree?.id ?? null,
            projectId: worktree?.project_id ?? null,
            sessionId: null,
            relatedEventId: null,
            payload: {
              agentSdk: runtimeId as 'opencode' | 'claude-code' | 'codex',
              agentSessionId: runtimeSessionId,
              text: text.slice(0, 1024),
              attachmentCount,
              ...(model ? { modelOverride: model } : {})
            }
          })
        } catch (err) {
          log.warn('field: session.message emit failed', {
            error: err instanceof Error ? err.message : String(err)
          })
        }

        return {}
      }
    })
  )

  // Steer an actively running turn without interrupting it (Codex-only in this wave).
  ipcMain.handle(
    'agent:steer',
    createAgentHandler(ctx, {
      channel: 'agent:steer',
      schema: steerSchema,
      handler: async (args, c) => {
        let worktreePath: string
        let runtimeSessionId: string
        let messageOrParts:
          | string
          | Array<{ type: string; text?: string; mime?: string; url?: string; filename?: string }>
        let model: { providerID: string; modelID: string; variant?: string } | undefined
        let options: PromptOptions | undefined

        if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
          const obj = args[0] as Record<string, unknown>
          worktreePath = obj.worktreePath as string
          runtimeSessionId = obj.sessionId as string
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

        log.info('IPC: agent:steer', {
          worktreePath,
          runtimeSessionId,
          partsCount: Array.isArray(messageOrParts) ? messageOrParts.length : 1
        })

        const runtimeId = resolveRuntimeId(c, runtimeSessionId)
        if (runtimeId === 'terminal') {
          throw new AgentHandlerError(
            AgentErrorCode.STEER_NOT_SUPPORTED,
            'Terminal sessions do not support steering'
          )
        }

        const impl = c.runtimeManager.getImplementer(runtimeId)
        if (!impl.capabilities.supportsSteer || !impl.steer) {
          throw new AgentHandlerError(
            AgentErrorCode.STEER_NOT_SUPPORTED,
            `Runtime ${runtimeId} does not support steering`
          )
        }

        await impl.steer(worktreePath, runtimeSessionId, messageOrParts, model, options)
        return {}
      }
    })
  )

  // Disconnect session (may kill server if last session for worktree)
  ipcMain.handle(
    'agent:disconnect',
    createAgentHandler(ctx, {
      channel: 'agent:disconnect',
      schema: disconnectSchema,
      handler: async ([worktreePath, runtimeSessionId], c) => {
        log.info('IPC: agent:disconnect', { worktreePath, runtimeSessionId })
        const runtimeId = resolveRuntimeId(c, runtimeSessionId)
        if (runtimeId === 'terminal') return {}
        const impl = c.runtimeManager.getImplementer(runtimeId)
        await impl.disconnect(worktreePath, runtimeSessionId)
        return {}
      }
    })
  )

  // Get available models from all configured providers
  ipcMain.handle(
    'agent:models',
    createAgentHandler(ctx, {
      channel: 'agent:models',
      schema: modelsSchema,
      handler: async ([opts], c) => {
        log.info('IPC: agent:models', { runtimeId: opts?.runtimeId })
        const runtimeId = opts?.runtimeId ?? 'opencode'
        if (runtimeId === 'terminal') return { providers: {} }
        const impl = c.runtimeManager.getImplementer(runtimeId)
        const providers = await impl.getAvailableModels()
        return { providers }
      }
    })
  )

  // Set the selected model
  ipcMain.handle(
    'agent:setModel',
    createAgentHandler(ctx, {
      channel: 'agent:setModel',
      schema: setModelSchema,
      handler: async ([model], c) => {
        log.info('IPC: agent:setModel', {
          model: model ? model.modelID : null,
          runtimeId: model?.runtimeId
        })
        // Handle null (clear global model) — route to opencode by default
        if (model === null) {
          const openCodeImpl = c.runtimeManager.getImplementer('opencode')
          // Adapter declares clearSelectedModel as optional — only opencode implements
          openCodeImpl.clearSelectedModel?.()
          return {}
        }

        const runtimeId = model.runtimeId ?? 'opencode'
        if (runtimeId === 'terminal') return {}
        const impl = c.runtimeManager.getImplementer(runtimeId)
        impl.setSelectedModel(model)
        return {}
      }
    })
  )

  // Get model info (name, context limit)
  ipcMain.handle(
    'agent:modelInfo',
    createAgentHandler(ctx, {
      channel: 'agent:modelInfo',
      schema: modelInfoSchema,
      handler: async ([{ worktreePath, modelId, runtimeId }], c) => {
        log.info('IPC: agent:modelInfo', { worktreePath, modelId, runtimeId })
        const resolvedRuntimeId = runtimeId ?? 'opencode'
        if (resolvedRuntimeId === 'terminal') {
          throw new Error('Terminal sessions have no model')
        }
        const impl = c.runtimeManager.getImplementer(resolvedRuntimeId)
        const model = await impl.getModelInfo(worktreePath, modelId)
        if (!model) {
          throw new Error('Model not found')
        }
        return { model }
      }
    })
  )

  // Get session info (revert state)
  ipcMain.handle(
    'agent:sessionInfo',
    createAgentHandler(ctx, {
      channel: 'agent:sessionInfo',
      schema: sessionInfoSchema,
      handler: async ([{ worktreePath, sessionId }], c) => {
        log.info('IPC: agent:sessionInfo', { worktreePath, sessionId })
        const runtimeId = resolveRuntimeId(c, sessionId)
        if (runtimeId === 'terminal') {
          return { revertMessageID: null, revertDiff: null }
        }
        const impl = c.runtimeManager.getImplementer(runtimeId)
        const result = await impl.getSessionInfo(worktreePath, sessionId)
        return { ...result }
      }
    })
  )

  // List available slash commands
  ipcMain.handle(
    'agent:commands',
    createAgentHandler(ctx, {
      channel: 'agent:commands',
      schema: commandsSchema,
      handler: async ([{ worktreePath, sessionId }], c) => {
        log.info('IPC: agent:commands', { worktreePath, sessionId })

        // For pending:: sessions (not yet materialized in DB), try Claude Code
        // implementer as it may have cached commands from previous sessions.
        if (sessionId?.startsWith('pending::')) {
          const impl = c.runtimeManager.getImplementer('claude-code')
          const commands = await impl.listCommands(worktreePath)
          if (commands.length > 0) {
            return { commands }
          }
        }

        const runtimeId = sessionId ? resolveRuntimeId(c, sessionId) : 'opencode'
        if (runtimeId === 'terminal') return { commands: [] }
        const impl = c.runtimeManager.getImplementer(runtimeId)
        const commands = await impl.listCommands(worktreePath)
        return { commands }
      }
    })
  )

  // Send a slash command to a session via the SDK command endpoint
  ipcMain.handle(
    'agent:command',
    createAgentHandler(ctx, {
      channel: 'agent:command',
      schema: commandSchema,
      handler: async ([{ worktreePath, sessionId, command, args }], c) => {
        log.info('IPC: agent:command', { worktreePath, sessionId, command, args })
        const runtimeId = resolveRuntimeId(c, sessionId)
        if (runtimeId === 'terminal') return {}
        const impl = c.runtimeManager.getImplementer(runtimeId)
        await impl.sendCommand(worktreePath, sessionId, command, args)
        return {}
      }
    })
  )

  // Undo last message state via runtime revert API
  ipcMain.handle(
    'agent:undo',
    createAgentHandler(ctx, {
      channel: 'agent:undo',
      schema: undoSchema,
      handler: async ([{ worktreePath, sessionId }], c) => {
        log.info('IPC: agent:undo', { worktreePath, sessionId })
        const runtimeId = resolveRuntimeId(c, sessionId)
        if (runtimeId === 'terminal') return {}
        const impl = c.runtimeManager.getImplementer(runtimeId)
        const result = await impl.undo(worktreePath, sessionId, '')
        return { ...(result as Record<string, unknown>) }
      }
    })
  )

  // Redo last undone message state via runtime unrevert/revert API
  ipcMain.handle(
    'agent:redo',
    createAgentHandler(ctx, {
      channel: 'agent:redo',
      schema: redoSchema,
      handler: async ([{ worktreePath, sessionId }], c) => {
        log.info('IPC: agent:redo', { worktreePath, sessionId })
        const runtimeId = resolveRuntimeId(c, sessionId)
        if (runtimeId === 'terminal') return {}
        const impl = c.runtimeManager.getImplementer(runtimeId)
        const result = await impl.redo(worktreePath, sessionId, '')
        return { ...(result as Record<string, unknown>) }
      }
    })
  )

  // Get runtime capabilities for a session
  ipcMain.handle(
    'agent:capabilities',
    createAgentHandler(ctx, {
      channel: 'agent:capabilities',
      schema: capabilitiesSchema,
      handler: async ([{ sessionId }], c) => {
        if (sessionId) {
          const runtimeId = c.dbService.getRuntimeIdForSession(sessionId)
          if (runtimeId) {
            return { capabilities: c.runtimeManager.getCapabilities(runtimeId) }
          }
        }
        // Default to opencode capabilities
        return { capabilities: c.runtimeManager.getCapabilities('opencode') }
      }
    })
  )

  // Reply to a pending question from the AI
  ipcMain.handle(
    'agent:question:reply',
    createAgentHandler(ctx, {
      channel: 'agent:question:reply',
      schema: questionReplySchema,
      handler: async ([{ requestId, answers, worktreePath }], c) => {
        log.info('IPC: agent:question:reply', { requestId })
        // Route by pending-question lookup since requestId doesn't carry runtime id.
        // Iterate all registered agents; first owner wins. OpenCode takes the
        // fallback slot (it doesn't implement hasPendingQuestion today).
        let fallback: AgentRuntimeAdapter | null = null
        for (const impl of c.runtimeManager.listAgents()) {
          if (!impl.hasPendingQuestion) {
            if (impl.id === 'opencode') fallback = impl
            continue
          }
          if (impl.hasPendingQuestion(requestId)) {
            await impl.questionReply(requestId, answers, worktreePath)
            return {}
          }
        }
        if (fallback) {
          await fallback.questionReply(requestId, answers, worktreePath)
          return {}
        }
        throw new Error(`No agent owns pending question: ${requestId}`)
      }
    })
  )

  // Reject/dismiss a pending question from the AI
  ipcMain.handle(
    'agent:question:reject',
    createAgentHandler(ctx, {
      channel: 'agent:question:reject',
      schema: questionRejectSchema,
      handler: async ([{ requestId, worktreePath }], c) => {
        log.info('IPC: agent:question:reject', { requestId })
        let fallback: AgentRuntimeAdapter | null = null
        for (const impl of c.runtimeManager.listAgents()) {
          if (!impl.hasPendingQuestion) {
            if (impl.id === 'opencode') fallback = impl
            continue
          }
          if (impl.hasPendingQuestion(requestId)) {
            await impl.questionReject(requestId, worktreePath)
            return {}
          }
        }
        if (fallback) {
          await fallback.questionReject(requestId, worktreePath)
          return {}
        }
        throw new Error(`No agent owns pending question: ${requestId}`)
      }
    })
  )

  // Approve a pending plan (ExitPlanMode) — unblocks the SDK to implement
  ipcMain.handle(
    'agent:plan:approve',
    createAgentHandler(ctx, {
      channel: 'agent:plan:approve',
      schema: planApproveSchema,
      handler: async ([{ worktreePath, hiveSessionId, requestId }], c) => {
        log.info('IPC: agent:plan:approve', { hiveSessionId, requestId })
        // TODO(codex): Generalize when Codex implements this HITL flow
        const claudeImpl = c.runtimeManager.getImplementer('claude-code') as ClaudeCodeImplementer
        if (
          (requestId && claudeImpl.hasPendingPlan(requestId)) ||
          claudeImpl.hasPendingPlanForSession(hiveSessionId)
        ) {
          await claudeImpl.planApprove(worktreePath, hiveSessionId, requestId)
          return {}
        }
        throw new Error('No pending plan found')
      }
    })
  )

  // Reject a pending plan with user feedback — Claude will revise.
  // For codex, plan.ready is synthetic (the turn has already completed), so
  // there's no SDK to unblock. We accept the reject IPC as a no-op so the
  // renderer can use a single code path without runtime branching.
  ipcMain.handle(
    'agent:plan:reject',
    createAgentHandler(ctx, {
      channel: 'agent:plan:reject',
      schema: planRejectSchema,
      handler: async ([{ worktreePath, hiveSessionId, feedback, requestId }], c) => {
        log.info('IPC: agent:plan:reject', {
          hiveSessionId,
          requestId,
          feedbackLength: feedback.length
        })
        const claudeImpl = c.runtimeManager.getImplementer('claude-code') as ClaudeCodeImplementer
        const claudeHandled =
          (requestId && claudeImpl.hasPendingPlan(requestId)) ||
          claudeImpl.hasPendingPlanForSession(hiveSessionId)
        if (claudeHandled) {
          await claudeImpl.planReject(worktreePath, hiveSessionId, feedback, requestId)
        }
        // Always persist a plan.resolved activity so the durable timeline
        // flips the plan card from "Requires Approval" to a resolved state
        // on next read. The same activity covers both claude-code (paired
        // with the SDK reject above) and codex (where plan.ready was
        // synthetic and there's no SDK call needed).
        try {
          const session = c.dbService.getSession(hiveSessionId)
          if (session && requestId) {
            c.dbService.upsertSessionActivity({
              id: `${requestId}:resolved`,
              session_id: hiveSessionId,
              agent_session_id: session.opencode_session_id ?? hiveSessionId,
              thread_id: session.opencode_session_id ?? hiveSessionId,
              turn_id: null,
              item_id: null,
              request_id: requestId,
              kind: 'plan.resolved',
              tone: 'info',
              summary: 'Plan rejected by user',
              payload_json: JSON.stringify({
                resolution: 'rejected',
                feedback,
                requestId
              })
            })
          }
        } catch (err) {
          log.warn('agent:plan:reject persistence failed', {
            hiveSessionId,
            error: err instanceof Error ? err.message : String(err)
          })
        }
        return {}
      }
    })
  )

  // Reply to a pending permission request
  ipcMain.handle(
    'agent:permission:reply',
    createAgentHandler(ctx, {
      channel: 'agent:permission:reply',
      schema: permissionReplySchema,
      handler: async ([{ requestId, reply, worktreePath, message }], c) => {
        log.info('IPC: agent:permission:reply', { requestId, reply })
        // Route by pending-approval lookup. OpenCode is the fallback: it doesn't
        // implement hasPendingApproval today, and its permission flow owns
        // requests that never passed through another adapter.
        let fallback: AgentRuntimeAdapter | null = null
        for (const impl of c.runtimeManager.listAgents()) {
          if (!impl.hasPendingApproval) {
            if (impl.id === 'opencode') fallback = impl
            continue
          }
          if (impl.hasPendingApproval(requestId)) {
            await impl.permissionReply(requestId, reply, worktreePath, message)
            return {}
          }
        }
        if (fallback) {
          await fallback.permissionReply(requestId, reply, worktreePath, message)
          return {}
        }
        throw new Error(`No agent owns pending approval: ${requestId}`)
      }
    })
  )

  // List all pending permission requests
  ipcMain.handle(
    'agent:permission:list',
    createAgentHandler(ctx, {
      channel: 'agent:permission:list',
      schema: permissionListSchema,
      handler: async ([{ worktreePath }], c) => {
        log.info('IPC: agent:permission:list')
        // Aggregate permissions from every registered agent.
        const aggregated: unknown[] = []
        for (const impl of c.runtimeManager.listAgents()) {
          try {
            const permissions = await impl.permissionList(worktreePath)
            aggregated.push(...permissions)
          } catch (err) {
            log.debug('permissionList failed for agent; skipping', {
              agent: impl.id,
              err: err instanceof Error ? err.message : String(err)
            })
          }
        }
        return { permissions: aggregated }
      }
    })
  )

  // Reply to a pending command approval request (for command filter system)
  ipcMain.handle(
    'agent:commandApprovalReply',
    createAgentHandler(ctx, {
      channel: 'agent:commandApprovalReply',
      schema: commandApprovalReplySchema,
      handler: async ([{ requestId, approved, remember, pattern, patterns }], c) => {
        log.info('IPC: agent:commandApprovalReply', {
          requestId,
          approved,
          remember,
          pattern,
          patterns
        })
        // TODO(codex): Generalize when Codex implements this HITL flow
        // Route to Claude Code implementer (command approval is Claude Code specific)
        const impl = c.runtimeManager.getImplementer('claude-code')
        if (impl instanceof ClaudeCodeImplementer) {
          impl.handleApprovalReply(requestId, approved, remember, pattern, patterns)
          return {}
        }
        throw new Error('Claude Code implementer not available')
      }
    })
  )

  // Rename a session's title via the runtime's PATCH API
  ipcMain.handle(
    'agent:renameSession',
    createAgentHandler(ctx, {
      channel: 'agent:renameSession',
      schema: renameSessionSchema,
      handler: async ([{ runtimeSessionId, title, worktreePath }], c) => {
        log.info('IPC: agent:renameSession', { runtimeSessionId, title })
        const runtimeId = resolveRuntimeId(c, runtimeSessionId)
        if (runtimeId === 'terminal') return {}
        const impl = c.runtimeManager.getImplementer(runtimeId)
        await impl.renameSession(worktreePath ?? '', runtimeSessionId, title)
        return {}
      }
    })
  )

  // Fork an existing session at an optional message boundary.
  // Routes through the adapter's optional forkSession method; non-supporting
  // agents surface a clean FORK_NOT_SUPPORTED error.
  ipcMain.handle(
    'agent:fork',
    createAgentHandler(ctx, {
      channel: 'agent:fork',
      schema: forkSchema,
      handler: async ([{ worktreePath, sessionId, messageId }], c) => {
        log.info('IPC: agent:fork', { worktreePath, sessionId, messageId })
        const runtimeId = resolveRuntimeId(c, sessionId)
        if (runtimeId === 'terminal') {
          throw new Error('Terminal sessions cannot be forked')
        }
        const impl = c.runtimeManager.getImplementer(runtimeId)
        if (!impl.forkSession) {
          throw new Error(`Runtime ${runtimeId} does not support forkSession`)
        }
        const result = await impl.forkSession(worktreePath, sessionId, messageId)
        return { ...result }
      }
    })
  )

  // Get messages from a session
  ipcMain.handle(
    'agent:messages',
    createAgentHandler(ctx, {
      channel: 'agent:messages',
      schema: messagesSchema,
      handler: async ([worktreePath, runtimeSessionId], c) => {
        log.info('IPC: agent:messages', { worktreePath, runtimeSessionId })
        const runtimeId = resolveRuntimeId(c, runtimeSessionId)
        if (runtimeId === 'terminal') return { messages: [] as unknown[] }
        const impl = c.runtimeManager.getImplementer(runtimeId)
        const messages = await impl.getMessages(worktreePath, runtimeSessionId)
        return { messages }
      }
    })
  )

  // Abort a streaming session
  ipcMain.handle(
    'agent:abort',
    createAgentHandler(ctx, {
      channel: 'agent:abort',
      schema: abortSchema,
      handler: async ([worktreePath, runtimeSessionId], c) => {
        log.info('IPC: agent:abort', { worktreePath, runtimeSessionId })
        const runtimeId = resolveRuntimeId(c, runtimeSessionId)
        if (runtimeId === 'terminal') return {}
        const impl = c.runtimeManager.getImplementer(runtimeId)
        const ok = await impl.abort(worktreePath, runtimeSessionId)
        // Phase 24C: fire-and-forget checkpoint generation. Failure must
        // never block the user-visible abort response.
        setImmediate(() => {
          recordCheckpointOnAbort(worktreePath, runtimeSessionId).catch((err) => {
            log.warn('checkpoint on abort failed', {
              err: err instanceof Error ? err.message : String(err)
            })
          })
        })
        return { aborted: ok }
      }
    })
  )

  log.info('Agent IPC handlers registered')
}

export async function cleanupAgentHandlers(runtimeManager?: AgentRuntimeManager): Promise<void> {
  log.info('Cleaning up agent runtime services')
  if (runtimeManager) {
    await runtimeManager.cleanupAll()
  } else {
    await openCodeService.cleanup()
  }
}
