import type { XuanpuAgentCliFieldContext } from './field-provider.js'
import type { XuanpuAgentCliRawEvent } from './events.js'
import { createCliCodingTools, type XuanpuAgentCliToolOptions } from './tools.js'

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
  tools?: 'coding' | 'none'
  allowWrites?: boolean
  testTimeoutMs?: number
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined
  importRuntime?: () => Promise<OhMyPiRuntimeModule>
}

export interface OhMyPiRuntimeModule {
  runTurn(options: {
    contextMessages: unknown[]
    promptMessage: unknown
    systemPrompt: string[]
    tools: unknown[]
    model: { provider: string; id: string }
    getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined
    agentOptions?: {
      sessionId?: string
      getToolContext?: () => Record<string, unknown>
    }
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
      const runtime = options.importRuntime
        ? await options.importRuntime()
        : await importOhMyPiRuntime()
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
      const tools =
        options.tools === 'none'
          ? []
          : createCliCodingTools({
              projectRoot: input.fieldContext.projectRoot,
              allowWrites: options.allowWrites,
              testTimeoutMs: options.testTimeoutMs
            } satisfies XuanpuAgentCliToolOptions)

      for await (const event of runtime.runTurn({
        contextMessages,
        promptMessage,
        systemPrompt: options.systemPrompt ?? buildDefaultSystemPrompt(options),
        tools,
        model: {
          provider: options.model.provider,
          id: options.model.id
        },
        getApiKey: options.getApiKey,
        agentOptions: {
          sessionId: input.sessionId,
          getToolContext: () => ({
            worktreePath: input.fieldContext.projectRoot,
            projectRoot: input.fieldContext.projectRoot,
            sessionId: input.sessionId,
            turnId: input.turnId,
            trustedWrites: options.allowWrites === true
          })
        }
      })) {
        yield mapOhMyPiEvent(event as Record<string, unknown>, input.turnId)
      }
    }
  }
}

function buildDefaultSystemPrompt(options: OhMyPiRuntimeRunnerOptions): string[] {
  const lines = [
    'You are xuanpu-agent running from the CLI.',
    'Work inside the detected project root. Use project-local rules and Git status from the field context.',
    'Use read_file and rg_search before making code claims. Use run_test for focused verification.'
  ]
  if (options.tools !== 'none' && options.allowWrites) {
    lines.push('You may use write_file to edit bounded UTF-8 project files.')
  } else if (options.tools !== 'none') {
    lines.push('Writes are disabled unless the CLI is started with --allow-writes.')
  }
  return lines
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
