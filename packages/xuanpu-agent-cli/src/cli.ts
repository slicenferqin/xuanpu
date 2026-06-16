#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { stdin as defaultStdin, stdout as defaultStdout } from 'node:process'
import { randomUUID } from 'node:crypto'

import { collectCliFieldContext } from './field-provider.js'
import {
  XuanpuAgentCliEventFactory,
  stringifyNdjsonEvent,
  type XuanpuAgentCliEvent
} from './events.js'
import {
  createDryRunRunner,
  createOhMyPiRuntimeRunner,
  type XuanpuAgentCliRunner
} from './runner.js'

export interface XuanpuAgentCliParsedArgs {
  command: 'run' | 'interactive' | 'help'
  cwd?: string
  prompt?: string
  sessionId?: string
  dryRun: boolean
  json: boolean
  allowWrites?: boolean
  noTools?: boolean
  model?: {
    provider: string
    id: string
  }
}

export interface XuanpuAgentCliMainDeps {
  runner?: XuanpuAgentCliRunner
  write?: (chunk: string) => void
  prompts?: AsyncIterable<string>
}

export function parseArgv(argv: string[]): XuanpuAgentCliParsedArgs {
  const args = [...argv]
  const parsed: XuanpuAgentCliParsedArgs = {
    command: 'run',
    dryRun: false,
    json: true
  }
  const promptParts: string[] = []

  while (args.length > 0) {
    const arg = args.shift()!
    if (arg === 'run') {
      parsed.command = 'run'
      continue
    }
    if (arg === 'interactive' || arg === 'repl') {
      parsed.command = 'interactive'
      continue
    }
    if (arg === '--help' || arg === '-h') {
      parsed.command = 'help'
      continue
    }
    if (arg === '--cwd') {
      parsed.cwd = requireValue(arg, args.shift())
      continue
    }
    if (arg === '--session-id') {
      parsed.sessionId = requireValue(arg, args.shift())
      continue
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true
      continue
    }
    if (arg === '--allow-writes') {
      parsed.allowWrites = true
      continue
    }
    if (arg === '--no-tools') {
      parsed.noTools = true
      continue
    }
    if (arg === '--text') {
      parsed.json = false
      continue
    }
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg === '--model') {
      parsed.model = parseModelRef(requireValue(arg, args.shift()))
      continue
    }
    promptParts.push(arg)
  }

  if (promptParts.length > 0) parsed.prompt = promptParts.join(' ')
  return parsed
}

export async function* runOneShot(
  options: XuanpuAgentCliParsedArgs,
  deps: XuanpuAgentCliMainDeps = {}
): AsyncIterable<XuanpuAgentCliEvent> {
  const sessionId = options.sessionId ?? `cli-${randomUUID()}`
  const turnId = randomUUID()
  const factory = new XuanpuAgentCliEventFactory({ sessionId })
  const fieldContext = await collectCliFieldContext({ cwd: options.cwd })
  const runner = deps.runner ?? resolveDefaultRunner(options)
  const prompt = options.prompt?.trim()

  if (!prompt) {
    yield factory.next({
      type: 'session.error',
      origin: 'system',
      turnId,
      data: { message: 'Missing prompt for xuanpu-agent run.' }
    })
    return
  }

  yield factory.next({
    type: 'session.materialized',
    origin: 'system',
    turnId,
    data: { newSessionId: sessionId, wasFork: false }
  })
  yield factory.next({
    type: 'session.updated',
    origin: 'context',
    turnId,
    data: {
      title: prompt.slice(0, 80),
      info: {
        projectRoot: fieldContext.projectRoot,
        ruleFiles: fieldContext.rules.map((rule) => rule.relativePath),
        sqlitePath: fieldContext.store.sqlitePath
      }
    }
  })
  yield factory.next({
    type: 'session.status',
    origin: 'system',
    turnId,
    data: { status: { type: 'busy', message: 'running' } }
  })

  for await (const event of runner.run({
    prompt,
    mode: 'one-shot',
    sessionId,
    turnId,
    fieldContext
  })) {
    yield factory.next(event)
  }

  yield factory.next({
    type: 'session.status',
    origin: 'system',
    turnId,
    data: { status: { type: 'idle' } }
  })
  yield factory.next({
    type: 'session.idle',
    origin: 'system',
    turnId,
    data: { reason: 'one-shot-complete' }
  })
}

export async function* runInteractive(
  options: XuanpuAgentCliParsedArgs,
  deps: XuanpuAgentCliMainDeps = {}
): AsyncIterable<XuanpuAgentCliEvent> {
  const prompts = deps.prompts ?? createReadlinePrompts()
  const sessionId = options.sessionId ?? `cli-${randomUUID()}`
  const runner = deps.runner ?? resolveDefaultRunner(options)

  for await (const prompt of prompts) {
    const trimmed = prompt.trim()
    if (!trimmed || trimmed === '/exit') continue
    yield* runOneShot(
      {
        ...options,
        command: 'run',
        prompt: trimmed,
        sessionId
      },
      { ...deps, runner }
    )
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
  deps: XuanpuAgentCliMainDeps = {}
): Promise<number> {
  const parsed = parseArgv(argv)
  const write = deps.write ?? ((chunk: string) => defaultStdout.write(chunk))

  if (parsed.command === 'help') {
    write(helpText())
    return 0
  }

  const events =
    parsed.command === 'interactive' ? runInteractive(parsed, deps) : runOneShot(parsed, deps)

  for await (const event of events) {
    write(parsed.json ? stringifyNdjsonEvent(event) : formatTextEvent(event))
  }

  return 0
}

function resolveDefaultRunner(options: XuanpuAgentCliParsedArgs): XuanpuAgentCliRunner {
  if (options.model && !options.dryRun) {
    return createOhMyPiRuntimeRunner({
      model: options.model,
      tools: options.noTools ? 'none' : 'coding',
      allowWrites: options.allowWrites
    })
  }
  return createDryRunRunner()
}

function parseModelRef(value: string): { provider: string; id: string } {
  const [provider, ...rest] = value.split('/')
  const id = rest.join('/')
  if (!provider || !id) {
    throw new Error(`Invalid --model value "${value}". Use provider/model.`)
  }
  return { provider, id }
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

async function* createReadlinePrompts(): AsyncIterable<string> {
  const rl = createInterface({ input: defaultStdin, output: defaultStdout })
  try {
    while (true) {
      const answer = await rl.question('xuanpu-agent> ')
      yield answer
      if (answer.trim() === '/exit') return
    }
  } finally {
    rl.close()
  }
}

function formatTextEvent(event: XuanpuAgentCliEvent): string {
  if (event.type === 'message.updated') {
    const content = event.data.content ?? event.data.message ?? ''
    return `${String(content)}\n`
  }
  if (event.type === 'session.error') {
    return `error: ${String(event.data.message ?? 'unknown error')}\n`
  }
  return ''
}

function helpText(): string {
  const lines = [
    'Usage:',
    '  xuanpu-agent run [--cwd PATH] [--model provider/model] [--allow-writes] [--dry-run] "prompt"',
    '  xuanpu-agent interactive [--cwd PATH] [--model provider/model] [--allow-writes]',
    '',
    'Events are emitted as CanonicalAgentEvent-compatible NDJSON by default.',
    'Real-provider mode exposes read_file, rg_search, run_test, and write_file only with --allow-writes.'
  ]
  return `${lines.join('\n')}\n`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    defaultStdout.write(
      JSON.stringify({
        type: 'session.error',
        data: { message: error instanceof Error ? error.message : String(error) }
      }) + '\n'
    )
    process.exitCode = 1
  })
}
