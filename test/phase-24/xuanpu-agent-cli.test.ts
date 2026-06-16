import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  collectCliFieldContext,
  main,
  parseArgv,
  runInteractive,
  runOneShot,
  type XuanpuAgentCliRunner
} from '../../packages/xuanpu-agent-cli/src/index'

async function createProjectFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'xuanpu-agent-cli-'))
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
  await writeFile(join(root, 'AGENTS.md'), 'Use pnpm and keep changes focused.\n')
  await writeFile(join(root, 'CLAUDE.md'), 'Claude-specific rule.\n')
  await mkdir(join(root, '.github'), { recursive: true })
  await writeFile(join(root, '.github', 'copilot-instructions.md'), 'Copilot rule.\n')
  await mkdir(join(root, '.cursor', 'rules'), { recursive: true })
  await writeFile(join(root, '.cursor', 'rules', 'repo.mdc'), 'Cursor rule.\n')
  await writeFile(join(root, 'README.md'), '# fixture\n')
  await mkdir(join(root, 'nested'), { recursive: true })
  return realpath(root)
}

function makeRunner(): XuanpuAgentCliRunner {
  return {
    async *run(input) {
      yield {
        type: 'message.updated',
        origin: 'model',
        turnId: input.turnId,
        data: {
          role: 'assistant',
          content: `handled:${input.prompt}`,
          projectRoot: input.fieldContext.projectRoot
        }
      }
    }
  }
}

describe('@xuanpu/agent-cli', () => {
  it('collects project-local rules, git status, and planned sqlite path', async () => {
    const root = await createProjectFixture()
    const context = await collectCliFieldContext({ cwd: join(root, 'nested') })

    expect(context.projectRoot).toBe(root)
    expect(context.rules.map((rule) => rule.relativePath)).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      '.github/copilot-instructions.md',
      '.cursor/rules/repo.mdc'
    ])
    expect(context.git.available).toBe(true)
    expect(context.git.porcelain).toContain('README.md')
    expect(context.store.sqlitePath).toBe(join(root, '.xuanpu', 'agent.sqlite'))
    expect(context.markdown).toContain('## Project Rules')
  })

  it('parses one-shot and interactive CLI arguments', () => {
    expect(
      parseArgv(['run', '--cwd', '/repo', '--model', 'openai/gpt-5.5', 'fix', 'tests'])
    ).toEqual({
      command: 'run',
      cwd: '/repo',
      prompt: 'fix tests',
      dryRun: false,
      json: true,
      model: { provider: 'openai', id: 'gpt-5.5' }
    })
    expect(parseArgv(['interactive', '--dry-run', '--text']).command).toBe('interactive')
  })

  it('runs one-shot prompts through an injected runner and emits canonical-compatible events', async () => {
    const root = await createProjectFixture()
    const events = []
    for await (const event of runOneShot(
      {
        command: 'run',
        cwd: root,
        prompt: 'summarize repo',
        sessionId: 'cli-session-1',
        dryRun: true,
        json: true
      },
      { runner: makeRunner() }
    )) {
      events.push(event)
    }

    expect(events[0]).toMatchObject({
      type: 'session.materialized',
      sessionId: 'cli-session-1',
      runtimeId: 'xuanpu-agent',
      sourceChannel: 'agent:stream'
    })
    expect(events.map((event) => event.sessionSequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(events.some((event) => event.type === 'message.updated')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'session.idle' })
  })

  it('runs interactive prompts as repeated one-shot turns on the same session', async () => {
    const root = await createProjectFixture()
    async function* prompts(): AsyncIterable<string> {
      yield 'first'
      yield ''
      yield 'second'
      yield '/exit'
    }

    const events = []
    for await (const event of runInteractive(
      {
        command: 'interactive',
        cwd: root,
        sessionId: 'cli-session-2',
        dryRun: true,
        json: true
      },
      { runner: makeRunner(), prompts: prompts() }
    )) {
      events.push(event)
    }

    const materialized = events.filter((event) => event.type === 'session.materialized')
    expect(materialized).toHaveLength(2)
    expect(new Set(events.map((event) => event.sessionId))).toEqual(new Set(['cli-session-2']))
    expect(events.filter((event) => event.type === 'message.updated')).toHaveLength(2)
  })

  it('writes NDJSON from main()', async () => {
    const root = await createProjectFixture()
    const chunks: string[] = []
    const exitCode = await main(['run', '--cwd', root, '--dry-run', 'hello'], {
      runner: makeRunner(),
      write: (chunk) => chunks.push(chunk)
    })

    expect(exitCode).toBe(0)
    const lines = chunks.join('').trim().split('\n')
    expect(lines.length).toBeGreaterThan(1)
    expect(JSON.parse(lines[0])).toMatchObject({
      type: 'session.materialized',
      runtimeId: 'xuanpu-agent'
    })
  })
})
