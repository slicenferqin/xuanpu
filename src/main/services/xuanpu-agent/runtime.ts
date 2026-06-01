import { loadPiAgentCoreModule } from './pi-agent-core-loader'
import {
  assertXuanpuAgentProviderCredential,
  resolveConfiguredApiKey,
  resolvePiModel,
  type XuanpuAgentModelRef
} from './model-config'
import type { XuanpuAgentConfig } from './config-loader'
import type { XuanpuPiPromptMessage } from './context-transform'
import {
  assertXuanpuAgentAllowedTools,
  getXuanpuAgentAllowedTools,
  getXuanpuAgentSystemPromptLines,
  isXuanpuAgentParallelSafeTool
} from './tool-policy'
import { READ_ONLY_TOOLS, XFP_FIELD_TOOLS } from './tools'
import { StormDetector } from './harness/tool-call-repair/storm'
import { ToolOutputTruncator, type ArchivePayload } from './harness/tool-call-repair/truncation'
import { buildXuanpuAgentHarnessMetrics, type XuanpuAgentHarnessMetrics } from './harness/metrics'
import type { CommandProfiler, CommandCompressor } from './context/compressor'
import {
  ContextBudgetManager,
  type BudgetProfile,
  type BudgetState
} from './context/budget-manager'
import { buildProviderRequest } from './turn/provider-request-builder'
import { recordProviderRequestSnapshot } from './turn/provider-request-recorder'
import type { XuanpuTurnBudget } from './turn/turn-snapshot'
import { getAgentTurnContextSnapshot, updateAgentTurnContextSnapshot } from '../../db/turn-repository'

interface PiTextContent {
  type: 'text'
  text: string
}

interface PiThinkingContent {
  type: 'thinking'
  thinking: string
}

interface PiAssistantMessage {
  role?: string
  content?: Array<PiTextContent | PiThinkingContent | Record<string, unknown>>
  provider?: string
  model?: string
  usage?: Record<string, unknown>
  errorMessage?: string
  timestamp?: number
}

interface PiAgentEvent {
  type?: string
  message?: PiAssistantMessage
  messages?: PiAssistantMessage[]
  toolCallId?: string
  toolName?: string
  args?: Record<string, unknown>
  result?: unknown
  isError?: boolean
}

interface PiAgentState {
  error?: string
  messages?: PiAssistantMessage[]
}

interface PiAgentLike {
  state: PiAgentState
  setModel(model: unknown): void
  setSystemPrompt(prompt: string[]): void
  setTools(tools: unknown[]): void
  replaceMessages(msgs: XuanpuPiPromptMessage[]): void
  subscribe(listener: (event: PiAgentEvent) => void): () => void
  prompt(input: string | XuanpuPiPromptMessage[]): Promise<void>
  abort(): void
}

type PiAgentConstructor = new (options?: Record<string, unknown>) => PiAgentLike

export interface XuanpuAgentPromptEventHandlers {
  onTextDelta?: (delta: string, meta: { turnId?: string; eventSequence: number }) => void
  onToolStart?: (event: XuanpuAgentToolStartEvent, meta: { turnId?: string; eventSequence: number }) => void
  onToolEnd?: (event: XuanpuAgentToolEndEvent, meta: { turnId?: string; eventSequence: number }) => void
}

export interface XuanpuAgentToolStartEvent {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  startedAt: number
}

export interface XuanpuAgentToolEndEvent {
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  result: unknown
  isError: boolean
  startedAt: number
  endedAt: number
}

export interface XuanpuAgentPromptResult {
  messageId: string
  text: string
  modelRef: XuanpuAgentModelRef
  usage?: Record<string, unknown>
  rawMessage?: PiAssistantMessage
  harnessMetrics: XuanpuAgentHarnessMetrics
  /** Provider request snapshot hash (INV-TURN-5). */
  snapshotHash?: string
  /** Turn-scoped id — cross-references snapshots, context packages, and usage events. */
  turnId?: string
}

export class XuanpuPiAgentSession {
  private agent: PiAgentLike | null = null
  private unsubscribe: (() => void) | null = null
  private lastModelKey: string | null = null
  private _worktreePath: string | null = null
  private prompting = false

  /** M1.5: 工具调用去重检测。挂载为 beforeToolCall 钩子。 */
  readonly stormDetector = new StormDetector({ windowSize: 5, threshold: 3 })

  /** M1.5: 命令输出截断（head/tail MVP）。挂载为 afterToolCall 钩子。 */
  readonly toolTruncator = new ToolOutputTruncator({
    charThreshold: 12_000,
    headLines: 500,
    tailLines: 500
  })

  /** M3: 上下文自动收缩管理器。挂载为 transformContext 钩子。 */
  readonly budgetManager = new ContextBudgetManager()

  constructor(
    private readonly sessionId: string,
    private readonly agentConfig?: XuanpuAgentConfig
  ) {}

  /** Set the current worktree path for tool context resolution. */
  setWorktreePath(worktreePath: string): void {
    this._worktreePath = worktreePath
  }

  /** M2: Configure compression (profiler + compressor + archive). */
  configureCompression(
    profiler: CommandProfiler,
    compressor: CommandCompressor,
    onArchive: (payload: ArchivePayload) => void
  ): void {
    this.toolTruncator.setProfiler(profiler)
    this.toolTruncator.setCompressor(compressor)
    this.toolTruncator.setOnArchive((payload) => {
      // Track compression stats for budget UI
      this.budgetManager.recordCompression(
        Buffer.byteLength(payload.rawOutput, 'utf-8'),
        Buffer.byteLength(payload.compressedOutput, 'utf-8')
      )
      onArchive(payload)
    })
  }

  /** M3: Get budget state for IPC / UI. */
  getBudgetState(): BudgetState {
    return { ...this.budgetManager.state }
  }

  /** M3: Set budget profile from XFP compiler decision. */
  setBudgetProfile(profile: BudgetProfile): void {
    this.budgetManager.setProfile(profile)
  }

  /** M3: Record XFP compiler section decisions for Context Budget UI. */
  recordBudgetSections(included: number, omitted: number): void {
    this.budgetManager.recordSections(included, omitted)
  }

  async prompt(
    input: string | XuanpuPiPromptMessage[],
    modelRef: XuanpuAgentModelRef,
    handlers: XuanpuAgentPromptEventHandlers = {},
    toolMode?: 'build' | 'plan',
    turnId?: string,
    snapshotBudget?: XuanpuTurnBudget,
    snapshotPrefixHash?: string,
    xfpPacketId?: string
  ): Promise<XuanpuAgentPromptResult> {
    if (this.prompting) {
      throw new Error('xuanpu-agent: overlapping prompt() calls are not allowed on the same session')
    }
    this.prompting = true
    const messageId = `xuanpu-agent-${Date.now()}`
    const resolved = await resolvePiModel(modelRef, this.agentConfig)
    assertXuanpuAgentProviderCredential(resolved.modelRef, this.agentConfig)

    const agentConfig = this.agentConfig
    const getApiKey = agentConfig
      ? (provider: string) => resolveConfiguredApiKey(provider, agentConfig)
      : undefined

    // INV-TURN-1: Fresh Agent per turn — no stateful carryover.
    const agent = await this.createAgentForTurn(
      resolved.modelRef, resolved.model, resolved.streamFn, getApiKey, turnId
    )

    // Apply tool mode AFTER agent creation so it's not a no-op on first prompt
    if (toolMode === 'plan') {
      agent.setTools([...READ_ONLY_TOOLS, ...XFP_FIELD_TOOLS])
    }

    // INV-TURN-5: Record provider request snapshot with CORRECT tools.
    let snapshotHash: string | undefined
    if (turnId && snapshotBudget) {
      const contextMessages = Array.isArray(input) ? input.slice(0, -1) : []
      const promptMessage = Array.isArray(input)
        ? input[input.length - 1]
        : { role: 'user' as const, content: [{ type: 'text' as const, text: String(input) }], timestamp: Date.now() }
      const currentTools = toolMode === 'plan'
        ? [...READ_ONLY_TOOLS, ...XFP_FIELD_TOOLS]
        : getXuanpuAgentAllowedTools()
      const snapshot = buildProviderRequest({
        turnId,
        sessionId: this.sessionId,
        modelRef: resolved.modelRef,
        contextMessages,
        promptMessage,
        tools: currentTools.map((t: unknown) => {
          const tool = t as { name: string; description?: string; parameters?: unknown }
          return {
            name: tool.name,
            description: tool.description ?? '',
            parameters: (tool.parameters ?? {}) as Record<string, unknown>
          }
        }),
        providerSessionPolicy: { mode: 'disabled', reason: 'xuanpu owns turn-scoped context' },
        budget: snapshotBudget,
        prefixHash: snapshotPrefixHash
      })
      recordProviderRequestSnapshot(snapshot, xfpPacketId)
      snapshotHash = snapshot.providerRequestHash
    }

    let streamedText = ''
    const stateMessageCountBeforePrompt = agent.state.messages?.length ?? 0
    const pendingAssistantMessages: PiAssistantMessage[] = []
    const toolNames: string[] = []
    const toolStarts = new Map<
      string,
      { toolName: string; args: Record<string, unknown>; startedAt: number }
    >()
    // Phase 5: Per-turn event sequence counter for canonical event ordering.
    let eventSequence = 0

    this.unsubscribe?.()
    this.unsubscribe = agent.subscribe((event) => {
      eventSequence++

      if (event.type === 'message_update' && event.message?.role === 'assistant') {
        const nextText = extractText(event.message)
        if (nextText.length > streamedText.length && nextText.startsWith(streamedText)) {
          const delta = nextText.slice(streamedText.length)
          streamedText = nextText
          handlers.onTextDelta?.(delta, { turnId, eventSequence })
        }
      }

      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        pendingAssistantMessages.push(event.message)
        const nextText = extractText(event.message)
        if (nextText.length > streamedText.length && nextText.startsWith(streamedText)) {
          const delta = nextText.slice(streamedText.length)
          streamedText = nextText
          handlers.onTextDelta?.(delta, { turnId, eventSequence })
        }
      }

      if (event.type === 'agent_end') {
        const turnMessages = getNewTurnMessages(event.messages, stateMessageCountBeforePrompt)
        pendingAssistantMessages.push(
          ...turnMessages.filter((message) => message?.role === 'assistant')
        )
      }

      if (event.type === 'tool_execution_start' && event.toolCallId && event.toolName) {
        const args = event.args && typeof event.args === 'object' ? event.args : {}
        const startedAt = Date.now()
        toolNames.push(event.toolName)
        toolStarts.set(event.toolCallId, { toolName: event.toolName, args, startedAt })
        handlers.onToolStart?.(
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args,
            startedAt
          },
          { turnId, eventSequence }
        )
      }

      if (event.type === 'tool_execution_end' && event.toolCallId && event.toolName) {
        const previous = toolStarts.get(event.toolCallId)
        const args = previous?.args ?? {}
        const startedAt = previous?.startedAt ?? Date.now()
        const endedAt = Date.now()
        handlers.onToolEnd?.(
          {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args,
            result: event.result,
            isError: event.isError === true,
            startedAt,
            endedAt
          },
          { turnId, eventSequence }
        )
        toolStarts.delete(event.toolCallId)
      }
    })

    try {
    // INV-TURN-3 fix: split context messages from the current prompt.
    // Context messages are pre-loaded via replaceMessages() so they appear
    // in agent.state.messages but do NOT get prompt-echoed by agentLoop.
    // Only the final message (the user's actual prompt) is passed to
    // agent.prompt(), so only it produces message_start/message_end echo.
    if (Array.isArray(input) && input.length > 1) {
      const contextMessages = input.slice(0, -1)
      const promptMessage = input[input.length - 1]
      agent.replaceMessages(contextMessages)
      await agent.prompt(promptMessage)
    } else {
      await agent.prompt(input)
    }

    // INV-TURN-5: If emergency shrink fired, annotate the snapshot so audit
    // knows the provider saw fewer/pruned messages than the original snapshot.
    if (turnId && this.budgetManager.state.emergencyShrunk) {
      try {
        const existing = getAgentTurnContextSnapshot(turnId)
        if (existing) {
          const prevDecisions: Record<string, unknown> =
            typeof existing.decisionsJson === 'string'
              ? JSON.parse(existing.decisionsJson)
              : {}
          const updatedDecisions = {
            ...prevDecisions,
            emergencyShrunk: true,
            emergencyShrinkFillRatio: this.budgetManager.state.fillRatio,
            emergencyShrinkEstimatedTokens: this.budgetManager.state.estimatedTokens,
            emergencyShrinkPrunedMessages: this.budgetManager.state.prunedMessageCount
          }
          updateAgentTurnContextSnapshot(turnId, JSON.stringify(updatedDecisions))
        }
      } catch {
        // Best-effort: don't fail the prompt over snapshot annotation.
      }
    }

    const turnStateMessages = getNewTurnMessages(
      agent.state.messages,
      stateMessageCountBeforePrompt
    )
    const message =
      findLastAssistantMessage(pendingAssistantMessages) ??
      findLastAssistantMessage(turnStateMessages)
    const errorMessage = message?.errorMessage ?? agent.state.error
    if (errorMessage) {
      throw new Error(errorMessage)
    }

    const finalText = extractText(message) || streamedText
    const harnessMetrics = buildXuanpuAgentHarnessMetrics({
      usage: message?.usage,
      toolNames,
      isParallelSafeTool: isXuanpuAgentParallelSafeTool,
      budgetState: this.getBudgetState()
    })
    return {
      messageId,
      text: finalText,
      modelRef: resolved.modelRef,
      usage: message?.usage,
      rawMessage: message ?? undefined,
      harnessMetrics,
      snapshotHash,
      turnId
    }
    } finally {
      // Restore full tool set after plan mode prompt
      if (toolMode === 'plan') {
        agent.setTools(getXuanpuAgentAllowedTools())
      }
      this.prompting = false
    }
  }

  /** Switch agent to plan mode: read-only tools only (no writes, no subtasks). */
  setPlanModeTools(): void {
    this.agent?.setTools([...READ_ONLY_TOOLS, ...XFP_FIELD_TOOLS])
  }

  /** Restore full tool set (call after plan mode completes). */
  setBuildModeTools(): void {
    this.agent?.setTools(getXuanpuAgentAllowedTools())
  }

  abort(): void {
    this.agent?.abort()
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.agent?.abort()
    this.agent = null
    this.lastModelKey = null
  }

  /**
   * INV-TURN-1: Always create a fresh Agent per turn.
   * No stateful reuse — provider sees only this turn's snapshot.
   */
  private async createAgentForTurn(
    modelRef: XuanpuAgentModelRef,
    model: unknown,
    streamFn?: unknown,
    getApiKey?: (provider: string) => string | undefined,
    turnId?: string
  ): Promise<PiAgentLike> {
    // Dispose previous agent if any (should not happen in normal flow).
    this.unsubscribe?.()
    this.unsubscribe = null
    this.agent?.abort()
    this.agent = null

    const piAgentCore = await loadPiAgentCoreModule()
    const Agent = piAgentCore.Agent as PiAgentConstructor | undefined
    if (!Agent) {
      throw new Error('@oh-my-pi/pi-agent-core Agent export is not available')
    }

    this.agent = new Agent({
      // Turn-scoped sessionId — not the long-lived hive session.
      sessionId: turnId ?? this.sessionId,
      providerSessionState: undefined, // INV-TURN-1: disabled
      ...(getApiKey ? { getApiKey } : {}),
      beforeToolCall: this.stormDetector.hook,
      afterToolCall: this.toolTruncator.hook,
      transformContext: this.budgetManager.transformContext,
      getToolContext: () => ({
        worktreePath: this._worktreePath ?? undefined,
        sessionId: this.sessionId
      }),
      ...(typeof streamFn === 'function' ? { streamFn } : {})
    })
    const tools = getXuanpuAgentAllowedTools()
    assertXuanpuAgentAllowedTools(tools)
    this.agent.setSystemPrompt(getXuanpuAgentSystemPromptLines())
    this.agent.setTools(tools)
    this.agent.setModel(model)
    return this.agent
  }
}

function extractText(message: PiAssistantMessage | null | undefined): string {
  if (!message?.content) return ''

  return message.content
    .map((part) => {
      if (part.type === 'text') return part.text
      return ''
    })
    .join('')
}

function getNewTurnMessages(
  messages: PiAssistantMessage[] | undefined,
  stateMessageCountBeforePrompt: number
): PiAssistantMessage[] {
  if (!messages) return []
  if (stateMessageCountBeforePrompt === 0) return messages
  if (messages.length > stateMessageCountBeforePrompt)
    return messages.slice(stateMessageCountBeforePrompt)

  return []
}

function findLastAssistantMessage(messages?: PiAssistantMessage[]): PiAssistantMessage | null {
  if (!messages) return null

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant') return message
  }

  return null
}
