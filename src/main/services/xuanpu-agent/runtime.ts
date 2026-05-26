import { loadPiAgentCoreModule } from './pi-agent-core-loader'
import {
  assertXuanpuAgentProviderCredential,
  resolvePiModel,
  type XuanpuAgentModelRef
} from './model-config'
import type { XuanpuPiPromptMessage } from './context-transform'
import {
  assertXuanpuAgentAllowedTools,
  getXuanpuAgentAllowedTools,
  getXuanpuAgentSystemPromptLines
} from './tool-policy'
import { StormDetector } from './harness/tool-call-repair/storm'
import { ToolOutputTruncator } from './harness/tool-call-repair/truncation'

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
}

export interface XuanpuAgentPromptResult {
  messageId: string
  text: string
  modelRef: XuanpuAgentModelRef
  usage?: Record<string, unknown>
  rawMessage?: PiAssistantMessage
}

export class XuanpuPiAgentSession {
  private agent: PiAgentLike | null = null
  private unsubscribe: (() => void) | null = null
  private lastModelKey: string | null = null

  /** M1.5: 工具调用去重检测。挂载为 beforeToolCall 钩子。 */
  readonly stormDetector = new StormDetector({ windowSize: 5, threshold: 3 })

  /** M1.5: 命令输出截断（head/tail MVP）。挂载为 afterToolCall 钩子。 */
  readonly toolTruncator = new ToolOutputTruncator({ charThreshold: 12_000, headLines: 500, tailLines: 500 })

  constructor(private readonly sessionId: string) {}

  async prompt(
    input: string | XuanpuPiPromptMessage[],
    modelRef: XuanpuAgentModelRef,
    handlers: XuanpuAgentPromptEventHandlers = {}
  ): Promise<XuanpuAgentPromptResult> {
    const messageId = `xuanpu-agent-${Date.now()}`
    const resolved = await resolvePiModel(modelRef)
    assertXuanpuAgentProviderCredential(resolved.modelRef)
    const agent = await this.getOrCreateAgent(resolved.modelRef, resolved.model, resolved.streamFn)

    let streamedText = ''
    const stateMessageCountBeforePrompt = agent.state.messages?.length ?? 0
    const pendingAssistantMessages: PiAssistantMessage[] = []

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
    })

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
    return {
      messageId,
      text: finalText,
      modelRef: resolved.modelRef,
      usage: message?.usage,
      rawMessage: message ?? undefined
    }
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
    streamFn?: unknown
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
        beforeToolCall: this.stormDetector.hook,
        afterToolCall: this.toolTruncator.hook,
        ...(typeof streamFn === 'function' ? { streamFn } : {})
      })
      const tools = getXuanpuAgentAllowedTools()
      assertXuanpuAgentAllowedTools(tools)
      this.agent.setSystemPrompt(getXuanpuAgentSystemPromptLines())
      this.agent.setTools(tools)
      this.lastModelKey = modelKey
    }

    this.agent.setModel(model)
    const tools = getXuanpuAgentAllowedTools()
    assertXuanpuAgentAllowedTools(tools)
    this.agent.setTools(tools)
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
