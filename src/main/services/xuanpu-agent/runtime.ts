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
  subscribe(listener: (event: PiAgentEvent) => void): () => void
  prompt(input: string | XuanpuPiPromptMessage[]): Promise<void>
  abort(): void
}

type PiAgentConstructor = new (options?: Record<string, unknown>) => PiAgentLike

export interface XuanpuAgentPromptEventHandlers {
  onTextDelta?: (delta: string) => void
  onToolStart?: (event: XuanpuAgentToolStartEvent) => void
  onToolEnd?: (event: XuanpuAgentToolEndEvent) => void
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
    toolMode?: 'build' | 'plan'
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

    const agent = await this.getOrCreateAgent(
      resolved.modelRef, resolved.model, resolved.streamFn, getApiKey
    )

    // Apply tool mode AFTER agent creation so it's not a no-op on first prompt
    if (toolMode === 'plan') {
      agent.setTools([...READ_ONLY_TOOLS, ...XFP_FIELD_TOOLS])
    }

    let streamedText = ''
    const stateMessageCountBeforePrompt = agent.state.messages?.length ?? 0
    const pendingAssistantMessages: PiAssistantMessage[] = []
    const toolNames: string[] = []
    const toolStarts = new Map<
      string,
      { toolName: string; args: Record<string, unknown>; startedAt: number }
    >()

    this.unsubscribe?.()
    this.unsubscribe = agent.subscribe((event) => {
      if (event.type === 'message_update' && event.message?.role === 'assistant') {
        const nextText = extractText(event.message)
        if (nextText.length > streamedText.length && nextText.startsWith(streamedText)) {
          const delta = nextText.slice(streamedText.length)
          streamedText = nextText
          handlers.onTextDelta?.(delta)
        }
      }

      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        pendingAssistantMessages.push(event.message)
        const nextText = extractText(event.message)
        if (nextText.length > streamedText.length && nextText.startsWith(streamedText)) {
          const delta = nextText.slice(streamedText.length)
          streamedText = nextText
          handlers.onTextDelta?.(delta)
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
        handlers.onToolStart?.({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args,
          startedAt
        })
      }

      if (event.type === 'tool_execution_end' && event.toolCallId && event.toolName) {
        const previous = toolStarts.get(event.toolCallId)
        const args = previous?.args ?? {}
        const startedAt = previous?.startedAt ?? Date.now()
        const endedAt = Date.now()
        handlers.onToolEnd?.({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args,
          result: event.result,
          isError: event.isError === true,
          startedAt,
          endedAt
        })
        toolStarts.delete(event.toolCallId)
      }
    })

    try {
    await agent.prompt(input)

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
      harnessMetrics
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

  private async getOrCreateAgent(
    modelRef: XuanpuAgentModelRef,
    model: unknown,
    streamFn?: unknown,
    getApiKey?: (provider: string) => string | undefined
  ): Promise<PiAgentLike> {
    const modelKey = `${modelRef.providerID}/${modelRef.modelID}/${modelRef.variant ?? ''}`

    if (!this.agent || this.lastModelKey !== modelKey) {
      this.dispose()
      const piAgentCore = await loadPiAgentCoreModule()
      const Agent = piAgentCore.Agent as PiAgentConstructor | undefined
      if (!Agent) {
        throw new Error('@oh-my-pi/pi-agent-core Agent export is not available')
      }

      this.agent = new Agent({
        sessionId: this.sessionId,
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
      this.lastModelKey = modelKey
    }

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
