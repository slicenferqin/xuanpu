import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeRgSearchMaxResults,
  ToolOutputTruncator
} from '../../src/main/services/xuanpu-agent/harness/tool-call-repair'
import type { ArchivePayload } from '../../src/main/services/xuanpu-agent/harness/tool-call-repair/truncation'
import { rgSearchTool } from '../../src/main/services/xuanpu-agent/tools/search-tools'
import { createCommandProfiler } from '../../src/main/services/xuanpu-agent/context/profiler'
import { createCommandCompressor } from '../../src/main/services/xuanpu-agent/context/compressor-impl'
import { computeToolOutputSha256 } from '../../src/main/services/xuanpu-agent/harness/tool-call-repair/observation'

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
    expect(text).toContain('<ToolObservation')
    expect(text).toContain('Raw output archived at command-trace:')
    expect(text).toContain(`Raw output sha256: ${computeToolOutputSha256(rawOutput)}.`)
    expect(archived).toHaveLength(1)
    expect(archived[0]?.rawOutput).toBe(rawOutput)
    expect(archived[0]?.rawOutputSha256).toBe(computeToolOutputSha256(rawOutput))
    expect(archived[0]?.rawOutputBytes).toBe(Buffer.byteLength(rawOutput, 'utf-8'))
    expect(archived[0]?.compressedOutputBytes).toBe(
      Buffer.byteLength(archived[0]?.compressedOutput ?? '', 'utf-8')
    )
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
        rawOutputSha256: computeToolOutputSha256('Working tree clean.'),
        compressedOutput: 'Working tree clean.',
        compressionRatio: 0
      }
    ])
  })

  it('compresses run_test output as test output and preserves command exit metadata', async () => {
    const truncator = new ToolOutputTruncator({
      charThreshold: 20,
      headLines: 1,
      tailLines: 1
    })
    const archived: ArchivePayload[] = []
    truncator.setProfiler(createCommandProfiler())
    truncator.setCompressor(createCommandCompressor())
    truncator.setOnArchive((payload) => archived.push(payload))

    const rawOutput = [
      ' × test/phase-24/failing.test.ts > fails',
      '   expected 1 to be 2',
      '',
      ...Array.from({ length: 60 }, (_, index) => ` ✓ passing.test.ts > case ${index}`),
      ' Tests  1 failed | 10 passed'
    ].join('\n')
    const result = await truncator.hook({
      isError: true,
      toolCall: { name: 'run_test' },
      args: { command: 'pnpm vitest run test/phase-24/failing.test.ts' },
      result: {
        content: [{ type: 'text', text: rawOutput }],
        isError: true,
        details: {
          command: 'pnpm vitest run test/phase-24/failing.test.ts',
          cwd: '/repo',
          exitCode: 1,
          durationMs: 1234
        }
      }
    } as Parameters<typeof truncator.hook>[0])

    const text = result?.content?.[0]?.type === 'text' ? result.content[0].text : ''
    expect(text).toContain('<ToolObservation')
    expect(text).toContain('Failures')
    expect(text).toContain('Raw output archived at command-trace:')
    expect(text).toContain(`Raw output sha256: ${computeToolOutputSha256(rawOutput)}.`)
    expect(archived).toMatchObject([
      {
        toolName: 'run_test',
        command: 'pnpm vitest run test/phase-24/failing.test.ts',
        category: 'test',
        exitCode: 1,
        durationMs: 1234,
        rawOutputSha256: computeToolOutputSha256(rawOutput),
        rawOutputBytes: Buffer.byteLength(rawOutput, 'utf-8')
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

  it('normalizes rg_search maxResults before executing ripgrep', async () => {
    expect(normalizeRgSearchMaxResults(300)).toBe(200)
    expect(normalizeRgSearchMaxResults('12')).toBe(12)
    expect(normalizeRgSearchMaxResults(0)).toBe(1)
    expect(normalizeRgSearchMaxResults('not-a-number')).toBe(50)

    const worktreePath = mkdtempSync(join(tmpdir(), 'xuanpu-rg-'))
    try {
      mkdirSync(join(worktreePath, 'src'), { recursive: true })
      writeFileSync(join(worktreePath, 'src', 'sample.ts'), 'needle\n')
      const result = await rgSearchTool.execute(
        'tool-1',
        {
          pattern: 'needle',
          path: 'src',
          glob: '*.ts',
          maxResults: 300
        } as Parameters<typeof rgSearchTool.execute>[1],
        undefined,
        undefined,
        { worktreePath }
      )

      expect((result.details as { command?: string } | undefined)?.command).toContain(
        '--max-count 200'
      )
      expect((result.details as { cwd?: string } | undefined)?.cwd).toBe(worktreePath)
      expect((result.details as { command?: string } | undefined)?.command).toContain(' src')
      expect(result.isError).toBeFalsy()
    } finally {
      rmSync(worktreePath, { recursive: true, force: true })
    }
  })
})
