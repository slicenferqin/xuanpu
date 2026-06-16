import type { XuanpuAgentCliFieldContext } from './field-provider.js'
import type { XuanpuAgentCliRawEvent } from './events.js'

export interface XuanpuAgentCliRunInput {
  prompt: string
  mode: 'one-shot' | 'interactive'
  sessionId: string
  turnId: string
  fieldContext: XuanpuAgentCliFieldContext
}

export interface XuanpuAgentCliRunner {
  run(input: XuanpuAgentCliRunInput): AsyncIterable<XuanpuAgentCliRawEvent>
}

export interface OhMyPiRuntimeRunnerOptions {
  model: {
    provider: string
    id: string
  }
  systemPrompt?: string[]
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined
}

interface OhMyPiRuntimeModule {
  runTurn(options: {
    contextMessages: unknown[]
    promptMessage: unknown
    systemPrompt: string[]
    tools: unknown[]
    model: { provider: string; id: string }
    getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined
  }): AsyncIterable<Record<string, unknown>>
}

export function createDryRunRunner(): XuanpuAgentCliRunner {
  return {
    async *run(input) {
      yield {
        type: 'message.updated',
        origin: 'model',
        turnId: input.turnId,
        data: {
          role: 'assistant',
          content: [
            'Xuanpu agent CLI dry run.',
            '',
            `Prompt: ${input.prompt}`,
            `Project: ${input.fieldContext.projectRoot}`,
            `Rules loaded: ${input.fieldContext.rules.length}`,
            `Git available: ${input.fieldContext.git.available}`
          ].join('\n'),
          info: {
            dryRun: true,
            mode: input.mode,
            ruleFiles: input.fieldContext.rules.map((rule) => rule.relativePath),
            sqlitePath: input.fieldContext.store.sqlitePath
          }
        }
      }
    }
  }
}

export function createOhMyPiRuntimeRunner(
  options: OhMyPiRuntimeRunnerOptions
): XuanpuAgentCliRunner {
  return {
    async *run(input) {
      const runtime = await importOhMyPiRuntime()
      const timestamp = Date.now()
      const contextMessages = [
        {
          role: 'user',
          content: [{ type: 'text', text: input.fieldContext.markdown }],
          timestamp
        }
      ]
      const promptMessage = {
        role: 'user',
        content: [{ type: 'text', text: input.prompt }],
        timestamp
      }

      for await (const event of runtime.runTurn({
        contextMessages,
        promptMessage,
        systemPrompt: options.systemPrompt ?? ['You are xuanpu-agent running from the CLI.'],
        tools: [],
        model: {
          provider: options.model.provider,
          id: options.model.id
        },
        getApiKey: options.getApiKey
      })) {
        yield mapOhMyPiEvent(event as Record<string, unknown>, input.turnId)
      }
    }
  }
}

async function importOhMyPiRuntime(): Promise<OhMyPiRuntimeModule> {
  const importer = new Function('specifier', 'return import(specifier)') as (
    specifier: string
  ) => Promise<OhMyPiRuntimeModule>
  return importer('@xuanpu/oh-my-pi-runtime')
}

function mapOhMyPiEvent(event: Record<string, unknown>, turnId: string): XuanpuAgentCliRawEvent {
  if (event.type === 'agent_end') {
    return {
      type: 'session.idle',
      origin: 'system',
      turnId,
      data: { sourceEvent: event.type }
    }
  }

  if (event.type === 'message_end' || event.type === 'message') {
    return {
      type: 'message.updated',
      origin: 'model',
      turnId,
      data: {
        message: event.message ?? event,
        sourceEvent: event.type
      }
    }
  }

  return {
    type: 'message.part.updated',
    origin: 'model',
    turnId,
    data: {
      part: event,
      sourceEvent: event.type
    }
  }
}
