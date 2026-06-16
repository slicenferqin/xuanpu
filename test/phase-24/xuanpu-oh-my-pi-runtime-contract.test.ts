import { beforeEach, describe, expect, it, vi } from 'vitest'

type AgentEvent = { type: string; [key: string]: unknown }
type Listener = (event: AgentEvent) => void

const fakeRuntime = vi.hoisted(() => {
  const constructors: Array<Record<string, unknown>> = []
  const prompts: unknown[] = []
  const replacements: unknown[][] = []

  class FakeAgent {
    private readonly listeners = new Set<Listener>()

    constructor(readonly options: Record<string, unknown>) {
      constructors.push(options)
    }

    setSystemPrompt(): void {}
    setModel(): void {}
    setTools(): void {}

    replaceMessages(messages: unknown[]): void {
      replacements.push(messages)
    }

    subscribe(listener: Listener): () => void {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }

    async prompt(message: unknown): Promise<void> {
      prompts.push(message)
      this.emit({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'model response' }] }
      })
      this.emit({ type: 'agent_end', messages: [] })
    }

    private emit(event: AgentEvent): void {
      for (const listener of this.listeners) listener(event)
    }
  }

  return {
    constructors,
    prompts,
    replacements,
    FakeAgent,
    reset: () => {
      constructors.length = 0
      prompts.length = 0
      replacements.length = 0
    }
  }
})

vi.mock('@oh-my-pi/pi-agent-core', () => ({
  Agent: fakeRuntime.FakeAgent,
  agentLoop: vi.fn(),
  agentLoopContinue: vi.fn(),
  agentLoopDetailed: vi.fn(),
  agentLoopContinueDetailed: vi.fn(),
  INTENT_FIELD: 'intent'
}))

async function collectEvents(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

describe('@xuanpu/oh-my-pi-runtime runTurn contract', () => {
  beforeEach(() => {
    vi.resetModules()
    fakeRuntime.reset()
  })

  it('loads context with replaceMessages and prompts only the current message', async () => {
    const { runTurn } = await import('@xuanpu/oh-my-pi-runtime')
    const contextMessages = [
      { role: 'user', content: [{ type: 'text', text: 'anchor' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }], timestamp: 2 }
    ]
    const promptMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'current request' }],
      timestamp: 3
    }

    const events = await collectEvents(
      runTurn({
        contextMessages,
        promptMessage,
        systemPrompt: ['system'],
        tools: [],
        model: { id: 'mock', provider: 'mock' }
      })
    )

    expect(fakeRuntime.replacements).toEqual([contextMessages])
    expect(fakeRuntime.prompts).toEqual([promptMessage])
    expect(JSON.stringify(fakeRuntime.prompts)).not.toContain('old answer')
    expect(events.map((event) => event.type)).toContain('agent_end')
  })

  it('creates a fresh Agent per turn and does not forward providerSessionState', async () => {
    const { runTurn } = await import('@xuanpu/oh-my-pi-runtime')
    const makeOptions = () => ({
      contextMessages: [],
      promptMessage: {
        role: 'user',
        content: [{ type: 'text', text: 'request' }],
        timestamp: 1
      },
      systemPrompt: ['system'],
      tools: [],
      model: { id: 'mock', provider: 'mock' },
      agentOptions: {
        sessionId: 'session-1',
        providerSessionState: { opaque: true }
      } as Record<string, unknown>
    })

    await collectEvents(runTurn(makeOptions()))
    await collectEvents(runTurn(makeOptions()))

    expect(fakeRuntime.constructors).toHaveLength(2)
    expect(fakeRuntime.constructors[0]).not.toBe(fakeRuntime.constructors[1])
    expect(fakeRuntime.constructors.every((options) => !('providerSessionState' in options))).toBe(
      true
    )
  })
})
