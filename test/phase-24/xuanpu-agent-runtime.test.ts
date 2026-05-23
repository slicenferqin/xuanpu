import { afterEach, describe, expect, it, vi } from 'vitest'

interface FakeTextPart {
  type: 'text'
  text: string
}

interface FakeAssistantMessage {
  role: 'assistant'
  content: FakeTextPart[]
  provider: string
  model: string
  usage: Record<string, unknown>
}

interface FakeAgentEvent {
  type: 'message_update' | 'message_end' | 'agent_end'
  message?: FakeAssistantMessage
  messages?: FakeAssistantMessage[]
}

type FakeAgentListener = (event: FakeAgentEvent) => void

const fakeRuntime = vi.hoisted(() => {
  const setToolsCalls: unknown[][] = []
  const systemPrompts: string[][] = []
  const prompts: string[] = []
  const aborts: string[] = []

  class FakeAgent {
    readonly state: { messages: FakeAssistantMessage[]; error?: string } = { messages: [] }
    private readonly listeners = new Set<FakeAgentListener>()
    private model: Record<string, unknown> | null = null

    constructor(readonly options?: Record<string, unknown>) {}

    setModel(model: unknown): void {
      this.model = model && typeof model === 'object' ? (model as Record<string, unknown>) : null
    }

    setSystemPrompt(prompt: string[]): void {
      systemPrompts.push(prompt)
    }

    setTools(tools: unknown[]): void {
      setToolsCalls.push(tools)
    }

    subscribe(listener: FakeAgentListener): () => void {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }

    async prompt(input: string): Promise<void> {
      prompts.push(input)
      const text =
        typeof this.model?.responseText === 'string' ? this.model.responseText : 'mock ok'
      const firstChunk = text.slice(0, Math.max(1, Math.floor(text.length / 2)))
      const message: FakeAssistantMessage = {
        role: 'assistant',
        content: [{ type: 'text', text }],
        provider: 'xuanpu-agent',
        model: 'xuanpu-agent-mock',
        usage: { input: 1, output: 2 }
      }

      this.emit({
        type: 'message_update',
        message: { ...message, content: [{ type: 'text', text: firstChunk }] }
      })
      this.emit({ type: 'message_update', message })
      this.emit({ type: 'message_end', message })
      this.state.messages.push(message)
      this.emit({ type: 'agent_end', messages: this.state.messages })
    }

    abort(): void {
      aborts.push('abort')
    }

    private emit(event: FakeAgentEvent): void {
      for (const listener of this.listeners) listener(event)
    }
  }

  return {
    aborts,
    prompts,
    setToolsCalls,
    systemPrompts,
    FakeAgent,
    reset: () => {
      aborts.length = 0
      prompts.length = 0
      setToolsCalls.length = 0
      systemPrompts.length = 0
    }
  }
})

vi.mock('../../src/main/services/xuanpu-agent/pi-agent-core-loader', () => ({
  loadPiAgentCoreModule: vi.fn(async () => ({ Agent: fakeRuntime.FakeAgent })),
  loadPiAiModule: vi.fn(async () => ({
    createMockModel: vi.fn(
      (options: { id: string; provider: string; handler?: { content?: string[] } }) => ({
        model: {
          id: options.id,
          provider: options.provider,
          responseText: options.handler?.content?.join('') ?? 'mock ok'
        },
        stream: vi.fn()
      })
    )
  }))
}))

describe('XuanpuPiAgentSession', () => {
  const previousMockResponse = process.env.XUANPU_AGENT_MOCK_RESPONSE

  afterEach(() => {
    fakeRuntime.reset()
    if (previousMockResponse === undefined) {
      delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    } else {
      process.env.XUANPU_AGENT_MOCK_RESPONSE = previousMockResponse
    }
    vi.resetModules()
  })

  it('runs a no-tools prompt through the wrapped pi Agent', async () => {
    process.env.XUANPU_AGENT_MOCK_RESPONSE = 'mock ok'

    const { XuanpuPiAgentSession } = await import('../../src/main/services/xuanpu-agent/runtime')
    const session = new XuanpuPiAgentSession('test-session')
    const deltas: string[] = []

    const result = await session.prompt(
      'hello',
      { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
      { onTextDelta: (delta) => deltas.push(delta) }
    )

    expect(result.text).toBe('mock ok')
    expect(result.modelRef).toEqual({
      providerID: 'xuanpu-agent',
      modelID: 'xuanpu-agent-mock'
    })
    expect(result.usage).toEqual({ input: 1, output: 2 })
    expect(deltas.join('')).toBe('mock ok')
    expect(fakeRuntime.prompts).toEqual(['hello'])
    expect(fakeRuntime.setToolsCalls).toEqual([[], []])
    expect(fakeRuntime.systemPrompts.at(-1)?.join('\n')).toContain('no-tools')

    session.dispose()
    expect(fakeRuntime.aborts).toEqual(['abort'])
  })
})
