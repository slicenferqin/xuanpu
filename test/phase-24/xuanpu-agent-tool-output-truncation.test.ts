import { describe, expect, it } from 'vitest'
import { ToolOutputTruncator } from '../../src/main/services/xuanpu-agent/harness/tool-call-repair'
import type { ArchivePayload } from '../../src/main/services/xuanpu-agent/harness/tool-call-repair/truncation'
import { rgSearchTool } from '../../src/main/services/xuanpu-agent/tools/search-tools'

describe('xuanpu-agent tool output compression', () => {
  it('compresses and archives long error outputs before they reach the model', async () => {
    const truncator = new ToolOutputTruncator({
      charThreshold: 20,
      headLines: 1,
      tailLines: 1
    })
    const archived: ArchivePayload[] = []
    truncator.setOnArchive((payload) => archived.push(payload))

    const rawOutput = ['first failure line', 'middle raw details', 'last failure line'].join('\n')
    const result = await truncator.hook({
      isError: true,
      toolCall: { name: 'rg_search' },
      args: { pattern: 'failure' },
      result: { content: [{ type: 'text', text: rawOutput }], isError: true }
    } as Parameters<typeof truncator.hook>[0])

    const text = result?.content?.[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('first failure line')
    expect(text).toContain('last failure line')
    expect(text).not.toContain('middle raw details')
    expect(text).toContain('Raw output archived at command-trace:')
    expect(archived).toHaveLength(1)
    expect(archived[0]?.rawOutput).toBe(rawOutput)
    expect(archived[0]?.compressedOutput).not.toBe(rawOutput)
    expect(archived[0]?.exitCode).toBe(1)
  })

  it('archives small tool outputs without rewriting the model-visible result', async () => {
    const truncator = new ToolOutputTruncator({ charThreshold: 200 })
    const archived: ArchivePayload[] = []
    truncator.setOnArchive((payload) => archived.push(payload))

    const result = await truncator.hook({
      isError: false,
      toolCall: { name: 'git_status' },
      args: {},
      result: { content: [{ type: 'text', text: 'Working tree clean.' }] }
    } as Parameters<typeof truncator.hook>[0])

    expect(result).toBeUndefined()
    expect(archived).toMatchObject([
      {
        toolName: 'git_status',
        command: 'git status',
        rawOutput: 'Working tree clean.',
        compressedOutput: 'Working tree clean.',
        compressionRatio: 0
      }
    ])
  })

  it('blocks rg_search paths that escape the worktree', async () => {
    const result = await rgSearchTool.execute(
      'tool-1',
      {
        pattern: 'needle',
        path: '../outside',
        caseSensitive: false,
        maxResults: 10
      },
      undefined,
      undefined,
      { worktreePath: '/tmp/xuanpu-worktree' }
    )

    expect(result.isError).toBe(true)
    expect(result.content[0]?.type).toBe('text')
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain(
      'Path escapes worktree'
    )
  })
})
