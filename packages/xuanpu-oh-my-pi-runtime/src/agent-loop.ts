/**
 * Turn-scoped agent-loop wrapper.
 *
 * Unlike the upstream `agentLoop()` which emits message_start/message_end
 * for EVERY prompt message (including historical assistant context), the
 * turn-scoped API separates context from prompt:
 *
 *   - contextMessages -> set via replaceMessages() (no echo)
 *   - promptMessage   -> passed to prompt() (normal echo)
 *
 * This is the INV-TURN-3 fix: context messages never appear as model output.
 */
import type {
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn
} from '@oh-my-pi/pi-agent-core'
import { Agent } from '@oh-my-pi/pi-agent-core'
import type { Model } from '@oh-my-pi/pi-ai'

// Re-export everything from the original agent-loop for backwards compat.
export {
  agentLoop,
  agentLoopContinue,
  agentLoopDetailed,
  agentLoopContinueDetailed,
  INTENT_FIELD
} from '@oh-my-pi/pi-agent-core'

export interface RunTurnOptions {
  /** Context messages (anchor, field, episodes, working set). NOT prompt-echoed. */
  contextMessages: AgentMessage[]
  /** The current user prompt. This is the ONLY message that gets prompt-echo. */
  promptMessage: AgentMessage
  systemPrompt: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: AgentTool<any>[]
  model: Model
  /** API key resolver. */
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined
  /** Custom stream function. */
  streamFn?: StreamFn
  /**
   * Agent-level options forwarded to the Agent constructor.
   * providerSessionState is explicitly NOT forwarded (disabled by default).
   */
  agentOptions?: {
    sessionId?: string
    transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>
    beforeToolCall?: AgentLoopConfig['beforeToolCall']
    afterToolCall?: AgentLoopConfig['afterToolCall']
    getToolContext?: (
      toolCall?: import('@oh-my-pi/pi-agent-core').ToolCallContext
    ) => import('@oh-my-pi/pi-agent-core').AgentToolContext | undefined
  }
}

/**
 * Run a single turn with a fresh Agent.
 *
 * Context messages are loaded into agent state via replaceMessages() and do
 * NOT produce prompt-echo events. Only the promptMessage is passed to
 * agent.prompt(), so only it gets message_start/message_end echo.
 *
 * The returned Agent is freshly created per turn — no stateful carryover.
 */
export async function* runTurn(options: RunTurnOptions): AsyncGenerator<AgentEvent> {
  const agent = new Agent({
    sessionId: options.agentOptions?.sessionId,
    getApiKey: options.getApiKey,
    streamFn: options.streamFn,
    transformContext: options.agentOptions?.transformContext,
    beforeToolCall: options.agentOptions?.beforeToolCall,
    afterToolCall: options.agentOptions?.afterToolCall,
    getToolContext: options.agentOptions?.getToolContext
    // providerSessionState is intentionally NOT set — disabled per INV-TURN-1.
  })

  agent.setSystemPrompt(options.systemPrompt)
  agent.setModel(options.model)
  agent.setTools(options.tools)

  // Pre-load context messages into agent state (no echo).
  if (options.contextMessages.length > 0) {
    agent.replaceMessages(options.contextMessages)
  }

  // Subscribe to events BEFORE prompt to capture everything.
  const eventQueue: AgentEvent[] = []
  let resolveNext: ((value: IteratorResult<AgentEvent>) => void) | null = null
  let done = false

  const unsubscribe = agent.subscribe((event) => {
    if (done) return
    if (resolveNext) {
      resolveNext({ value: event, done: false })
      resolveNext = null
    } else {
      eventQueue.push(event)
    }
  })

  // Send the prompt (single message — no context in the prompt array).
  const promptPromise = agent.prompt(options.promptMessage)

  try {
    while (true) {
      // Check queue first, then wait for next event.
      if (eventQueue.length > 0) {
        const event = eventQueue.shift()!
        if (event.type === 'agent_end') {
          done = true
          yield event
          return
        }
        yield event
        continue
      }

      const next = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
        resolveNext = resolve
      })

      if (next.done) return
      if (next.value.type === 'agent_end') {
        done = true
        yield next.value
        return
      }
      yield next.value
    }
  } finally {
    done = true
    unsubscribe()
    await promptPromise.catch(() => {})
  }
}
