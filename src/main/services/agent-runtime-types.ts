import type { BrowserWindow } from 'electron'

export type AgentRuntimeId = 'opencode' | 'claude-code' | 'codex' | 'terminal'

export interface AgentRuntimeCapabilities {
  supportsUndo: boolean
  supportsRedo: boolean
  supportsCommands: boolean
  supportsPermissionRequests: boolean
  supportsQuestionPrompts: boolean
  supportsModelSelection: boolean
  supportsReconnect: boolean
  supportsPartialStreaming: boolean
}

export interface PromptOptions {
  codexFastMode?: boolean
}

export interface AgentRuntimeAdapter {
  readonly id: AgentRuntimeId
  readonly capabilities: AgentRuntimeCapabilities

  // Lifecycle
  connect(worktreePath: string, hiveSessionId: string): Promise<{ sessionId: string }>
  reconnect(
    worktreePath: string,
    agentSessionId: string,
    hiveSessionId: string
  ): Promise<{
    success: boolean
    sessionStatus?: 'idle' | 'busy' | 'retry'
    revertMessageID?: string | null
  }>
  disconnect(worktreePath: string, agentSessionId: string): Promise<void>
  cleanup(): Promise<void>

  // Messaging
  prompt(
    worktreePath: string,
    agentSessionId: string,
    message:
      | string
      | Array<
          | { type: 'text'; text: string }
          | { type: 'file'; mime: string; url: string; filename?: string }
        >,
    modelOverride?: { providerID: string; modelID: string; variant?: string },
    options?: PromptOptions
  ): Promise<void>
  abort(worktreePath: string, agentSessionId: string): Promise<boolean>
  getMessages(worktreePath: string, agentSessionId: string): Promise<unknown[]>

  // Models
  getAvailableModels(): Promise<unknown>
  getModelInfo(
    worktreePath: string,
    modelId: string
  ): Promise<{
    id: string
    name: string
    limit: { context: number; input?: number; output: number }
  } | null>
  setSelectedModel(model: { providerID: string; modelID: string; variant?: string }): void
  /**
   * Clear the globally-selected model override. Optional because only OpenCode
   * tracks a global model; other agents select per-prompt and treat this as a
   * no-op. Always safe to call.
   */
  clearSelectedModel?(): void

  // Session info
  getSessionInfo(
    worktreePath: string,
    agentSessionId: string
  ): Promise<{
    revertMessageID: string | null
    revertDiff: string | null
  }>

  // Human-in-the-loop
  questionReply(requestId: string, answers: string[][], worktreePath?: string): Promise<void>
  questionReject(requestId: string, worktreePath?: string): Promise<void>
  /**
   * Reply to a permission request. `message` is an optional extra payload used
   * by OpenCode's permission API; other agents ignore it.
   */
  permissionReply(
    requestId: string,
    decision: 'once' | 'always' | 'reject',
    worktreePath?: string,
    message?: string
  ): Promise<void>
  permissionList(worktreePath?: string): Promise<unknown[]>
  /**
   * Whether this adapter currently owns a pending question with the given id.
   * Optional — only implementers that emit question prompts (claude-code,
   * codex, opencode) need to override. The handler uses this to route
   * reply/reject without a runtime tag on the requestId.
   */
  hasPendingQuestion?(requestId: string): boolean
  /** Same as hasPendingQuestion but for permission/approval flows. */
  hasPendingApproval?(requestId: string): boolean

  // Undo/Redo
  undo(worktreePath: string, agentSessionId: string, hiveSessionId: string): Promise<unknown>
  redo(worktreePath: string, agentSessionId: string, hiveSessionId: string): Promise<unknown>

  // Commands
  listCommands(worktreePath: string): Promise<unknown[]>
  sendCommand(
    worktreePath: string,
    agentSessionId: string,
    command: string,
    args?: string
  ): Promise<void>

  // Session management
  renameSession(worktreePath: string, agentSessionId: string, name: string): Promise<void>
  /**
   * Fork an existing session at an optional message boundary. Returns the new
   * session id. Only OpenCode currently supports this; other agents should
   * throw `FORK_NOT_SUPPORTED`.
   */
  forkSession?(
    worktreePath: string,
    agentSessionId: string,
    messageId?: string
  ): Promise<{ sessionId: string }>

  // Window binding (for event forwarding to renderer)
  setMainWindow(window: BrowserWindow): void
}

export const OPENCODE_CAPABILITIES: AgentRuntimeCapabilities = {
  supportsUndo: true,
  supportsRedo: true,
  supportsCommands: true,
  supportsPermissionRequests: true,
  supportsQuestionPrompts: true,
  supportsModelSelection: true,
  supportsReconnect: true,
  supportsPartialStreaming: true
}

export const CLAUDE_CODE_CAPABILITIES: AgentRuntimeCapabilities = {
  supportsUndo: true,
  supportsRedo: false,
  supportsCommands: true,
  supportsPermissionRequests: true,
  supportsQuestionPrompts: true,
  supportsModelSelection: true,
  supportsReconnect: true,
  supportsPartialStreaming: true
}

export const CODEX_CAPABILITIES: AgentRuntimeCapabilities = {
  supportsUndo: true,
  supportsRedo: false,
  supportsCommands: false,
  supportsPermissionRequests: true,
  supportsQuestionPrompts: true,
  supportsModelSelection: true,
  supportsReconnect: true,
  supportsPartialStreaming: true
}

export const TERMINAL_CAPABILITIES: AgentRuntimeCapabilities = {
  supportsUndo: false,
  supportsRedo: false,
  supportsCommands: false,
  supportsPermissionRequests: false,
  supportsQuestionPrompts: false,
  supportsModelSelection: false,
  supportsReconnect: false,
  supportsPartialStreaming: false
}

// Backward compatibility: AgentSdk* types are aliases of AgentRuntime* types
export type AgentSdkId = AgentRuntimeId
export type AgentSdkCapabilities = AgentRuntimeCapabilities
export type AgentSdkImplementer = AgentRuntimeAdapter
