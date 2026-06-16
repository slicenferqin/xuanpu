import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ToolCallGovernor } from '../../src/main/services/xuanpu-agent/harness/tool-call-repair'

describe('ToolCallGovernor', () => {
  it('rewrites rg_search arguments to bounded output', async () => {
    const governor = new ToolCallGovernor()
    const args: Record<string, unknown> = {
      pattern: 'needle',
      path: '   ',
      glob: '  *.ts  ',
      maxResults: 999
    }

    const result = await governor.hook(createBeforeContext('rg_search', args), undefined)

    expect(result).toBeUndefined()
    expect(args).toMatchObject({
      path: '.',
      glob: '*.ts',
      maxResults: 200
    })
    expect(governor.listDecisions()).toMatchObject([
      {
        action: 'rewrite',
        ruleId: 'rg-search-argument-cap',
        toolName: 'rg_search'
      }
    ])
  })

  it('caps list_files depth before execution', async () => {
    const governor = new ToolCallGovernor({ listFilesMaxDepth: 3 })
    const args: Record<string, unknown> = { path: '.', depth: 5 }

    const result = await governor.hook(createBeforeContext('list_files', args), undefined)

    expect(result).toBeUndefined()
    expect(args.depth).toBe(3)
    expect(governor.listDecisions()[0]).toMatchObject({
      action: 'rewrite',
      ruleId: 'list-files-depth-cap'
    })
  })

  it('denies whole-file reads of large files before read_file executes', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'xuanpu-governor-'))
    try {
      const logPath = join(worktreePath, 'huge.log')
      writeFileSync(logPath, `${'line\n'.repeat(300_000)}`)

      const governor = new ToolCallGovernor({ readFileWholeFileByteLimit: 1024 })
      governor.setWorktreePath(worktreePath)
      const result = await governor.hook(
        createBeforeContext('read_file', { path: 'huge.log' }),
        undefined
      )

      expect(result).toMatchObject({ block: true })
      expect(result?.reason).toContain('read-file-large-whole-file')
      expect(result?.reason).toContain('startLine/endLine')
      expect(governor.listDecisions()[0]).toMatchObject({
        action: 'deny',
        ruleId: 'read-file-large-whole-file',
        toolName: 'read_file'
      })
    } finally {
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })

  it('allows ranged reads even when the target file is large', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'xuanpu-governor-'))
    try {
      mkdirSync(join(worktreePath, 'logs'), { recursive: true })
      writeFileSync(join(worktreePath, 'logs', 'huge.log'), `${'line\n'.repeat(300_000)}`)

      const governor = new ToolCallGovernor({ readFileWholeFileByteLimit: 1024 })
      governor.setWorktreePath(worktreePath)
      const result = await governor.hook(
        createBeforeContext('read_file', {
          path: 'logs/huge.log',
          startLine: 1,
          endLine: 100
        }),
        undefined
      )

      expect(result).toBeUndefined()
      expect(governor.listDecisions()).toEqual([])
    } finally {
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })

  it('denies broad run_test commands and allows focused test paths', async () => {
    const governor = new ToolCallGovernor()

    const broad = await governor.hook(
      createBeforeContext('run_test', { command: 'pnpm test' }),
      undefined
    )
    const focused = await governor.hook(
      createBeforeContext('run_test', {
        command: 'pnpm vitest run test/phase-24/xuanpu-agent-tool-call-governor.test.ts'
      }),
      undefined
    )

    expect(broad).toMatchObject({ block: true })
    expect(broad?.reason).toContain('run-test-broad-command')
    expect(focused).toBeUndefined()
    expect(governor.listDecisions()).toEqual([
      expect.objectContaining({
        action: 'deny',
        ruleId: 'run-test-broad-command',
        toolName: 'run_test'
      })
    ])
  })
})

function createBeforeContext(toolName: string, args: Record<string, unknown>) {
  return {
    assistantMessage: { role: 'assistant', content: [] },
    toolCall: { type: 'toolCall', id: 'tool-1', name: toolName, arguments: args },
    args,
    context: { systemPrompt: [], messages: [] }
  } as Parameters<ToolCallGovernor['hook']>[0]
}
