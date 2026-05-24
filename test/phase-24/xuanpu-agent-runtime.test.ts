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
type FakePromptMessage = {
  role: 'user' | 'assistant'
  content: FakeTextPart[]
  timestamp: number
}

const fakeRuntime = vi.hoisted(() => {
  const setToolsCalls: unknown[][] = []
  const systemPrompts: string[][] = []
  const prompts: Array<string | FakePromptMessage[]> = []
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

    async prompt(input: string | FakePromptMessage[]): Promise<void> {
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
    ),
    getBundledModel: vi.fn((provider: string, modelID: string) => ({
      id: modelID,
      provider
    })),
    getBundledProviders: vi.fn(() => ['anthropic', 'openai'])
  }))
}))

describe('XuanpuPiAgentSession', () => {
  const previousMockResponse = process.env.XUANPU_AGENT_MOCK_RESPONSE
  const credentialEnvKeys = [
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_FOUNDRY_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY'
  ]
  const previousCredentialEnv = Object.fromEntries(
    credentialEnvKeys.map((key) => [key, process.env[key]])
  )

  afterEach(() => {
    fakeRuntime.reset()
    if (previousMockResponse === undefined) {
      delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    } else {
      process.env.XUANPU_AGENT_MOCK_RESPONSE = previousMockResponse
    }
    for (const key of credentialEnvKeys) {
      const value = previousCredentialEnv[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
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

  it('forwards Xuanpu-managed message arrays to the pi Agent without flattening them', async () => {
    process.env.XUANPU_AGENT_MOCK_RESPONSE = 'array ok'

    const { XuanpuPiAgentSession } = await import('../../src/main/services/xuanpu-agent/runtime')
    const session = new XuanpuPiAgentSession('test-session')
    const promptMessages: FakePromptMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: '<xuanpu-context-anchor>anchor</xuanpu-context-anchor>' }],
        timestamp: 123
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'prior assistant turn' }],
        timestamp: 124
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'current request' }],
        timestamp: 125
      }
    ]

    const result = await session.prompt(promptMessages, {
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5'
    })

    expect(result.text).toBe('array ok')
    expect(fakeRuntime.prompts).toHaveLength(1)
    expect(fakeRuntime.prompts[0]).toBe(promptMessages)
    expect((fakeRuntime.prompts[0] as FakePromptMessage[]).at(-1)?.content[0]?.text).toBe(
      'current request'
    )
    expect(fakeRuntime.setToolsCalls).toEqual([[], []])
  })

  it('uses the latest assistant message from reused pi Agent state', async () => {
    const { XuanpuPiAgentSession } = await import('../../src/main/services/xuanpu-agent/runtime')
    const session = new XuanpuPiAgentSession('test-session')

    process.env.XUANPU_AGENT_MOCK_RESPONSE = 'first response'
    const first = await session.prompt('first turn', {
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5'
    })

    process.env.XUANPU_AGENT_MOCK_RESPONSE = 'second response'
    const second = await session.prompt('second turn', {
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5'
    })

    expect(first.text).toBe('first response')
    expect(second.text).toBe('second response')
    expect(fakeRuntime.prompts).toEqual(['first turn', 'second turn'])

    session.dispose()
  })

  it('fails before creating a pi Agent when real provider credentials are missing', async () => {
    for (const key of credentialEnvKeys) delete process.env[key]

    const { XuanpuPiAgentSession } = await import('../../src/main/services/xuanpu-agent/runtime')
    const session = new XuanpuPiAgentSession('test-session')

    await expect(
      session.prompt('hello', { providerID: 'anthropic', modelID: 'claude-haiku-4-5' })
    ).rejects.toThrow(
      [
        'Missing credentials for xuanpu-agent provider: anthropic.',
        'Set one of: ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_FOUNDRY_API_KEY.',
        'The experimental xuanpu-agent runtime reads provider credentials from environment variables during this spike.'
      ].join('\n')
    )

    expect(fakeRuntime.prompts).toEqual([])
    expect(fakeRuntime.setToolsCalls).toEqual([])
  })
})
