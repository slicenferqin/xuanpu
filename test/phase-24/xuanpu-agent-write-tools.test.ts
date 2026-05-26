import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyPatchTool,
  editFileTool,
  formatFileTool,
  runTestTool,
  writeFileTool
} from '../../src/main/services/xuanpu-agent/tools/write-tools'

interface ToolDetails {
  applied?: boolean
  requiresConfirmation?: boolean
  previewToken?: string
  diff?: string
  reverseDiff?: string
  filesAffected?: string[]
  sourceContextRefs?: string[]
  longRunning?: boolean
  supervision?: {
    longRunningThresholdMs: number
    notifiedAtMs: number | null
  }
}

const tempDirs: string[] = []

function makeWorktree(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xuanpu-agent-m4-'))
  tempDirs.push(dir)
  return dir
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
    .join('\n')
}

function detailsOf(result: { details?: unknown }): ToolDetails {
  return (result.details ?? {}) as ToolDetails
}

describe('xuanpu-agent M4 controlled write tools', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('previews write_file without touching disk, then applies with the preview token', async () => {
    const worktreePath = makeWorktree()
    const ctx = { worktreePath, sessionId: 'session-write' }

    const preview = await writeFileTool.execute(
      'tool-1',
      {
        path: 'src/example.ts',
        content: 'export const value = 1\n',
        createParentDirs: true,
        sourceContextRefs: ['message:read-1']
      },
      undefined,
      undefined,
      ctx
    )

    expect(preview.isError).toBeUndefined()
    expect(textOf(preview)).toContain('Diff preview for write_file')
    expect(fs.existsSync(path.join(worktreePath, 'src/example.ts'))).toBe(false)
    expect(detailsOf(preview)).toMatchObject({
      applied: false,
      requiresConfirmation: true,
      filesAffected: ['src/example.ts']
    })
    expect(detailsOf(preview).previewToken).toMatch(/^m4-/)
    expect(detailsOf(preview).sourceContextRefs).toContain('message:read-1')

    const applied = await writeFileTool.execute(
      'tool-2',
      {
        path: 'src/example.ts',
        content: 'export const value = 1\n',
        createParentDirs: true,
        confirm: true,
        previewToken: detailsOf(preview).previewToken
      },
      undefined,
      undefined,
      ctx
    )

    expect(applied.isError).toBeUndefined()
    expect(detailsOf(applied)).toMatchObject({ applied: true, requiresConfirmation: false })
    expect(fs.readFileSync(path.join(worktreePath, 'src/example.ts'), 'utf-8')).toBe(
      'export const value = 1\n'
    )
    expect(detailsOf(applied).reverseDiff).toContain('-export const value = 1')
  })

  it('blocks path escapes and dangerous write targets', async () => {
    const worktreePath = makeWorktree()
    const ctx = { worktreePath, sessionId: 'session-paths' }

    const escape = await writeFileTool.execute(
      'tool-escape',
      { path: '../outside.ts', content: 'bad\n' },
      undefined,
      undefined,
      ctx
    )
    expect(escape.isError).toBe(true)
    expect(textOf(escape)).toContain('Path escapes worktree')

    const gitPath = await writeFileTool.execute(
      'tool-git',
      { path: '.git/config', content: 'bad\n' },
      undefined,
      undefined,
      ctx
    )
    expect(gitPath.isError).toBe(true)
    expect(textOf(gitPath)).toContain('Dangerous path segment blocked: .git')
  })

  it('makes edit_file tokens stale when the source content changes', async () => {
    const worktreePath = makeWorktree()
    fs.mkdirSync(path.join(worktreePath, 'src'))
    fs.writeFileSync(path.join(worktreePath, 'src/example.ts'), 'export const value = 1\n')
    const ctx = { worktreePath, sessionId: 'session-edit' }

    const preview = await editFileTool.execute(
      'tool-1',
      {
        path: 'src/example.ts',
        oldString: 'value = 1',
        newString: 'value = 2'
      },
      undefined,
      undefined,
      ctx
    )
    expect(preview.isError).toBeUndefined()
    expect(detailsOf(preview).previewToken).toMatch(/^m4-/)
    expect(fs.readFileSync(path.join(worktreePath, 'src/example.ts'), 'utf-8')).toContain(
      'value = 1'
    )

    fs.writeFileSync(path.join(worktreePath, 'src/example.ts'), 'export const value = 3\n')

    const stale = await editFileTool.execute(
      'tool-2',
      {
        path: 'src/example.ts',
        oldString: 'value = 1',
        newString: 'value = 2',
        confirm: true,
        previewToken: detailsOf(preview).previewToken
      },
      undefined,
      undefined,
      ctx
    )
    expect(stale.isError).toBe(true)
    expect(textOf(stale)).toContain('oldString not found')
    expect(fs.readFileSync(path.join(worktreePath, 'src/example.ts'), 'utf-8')).toContain(
      'value = 3'
    )
  })

  it('checks apply_patch before previewing and applies only with the matching token', async () => {
    const worktreePath = makeWorktree()
    fs.writeFileSync(path.join(worktreePath, 'a.txt'), 'one\n')
    const ctx = { worktreePath, sessionId: 'session-patch' }
    const patchText = ['--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-one', '+two', ''].join('\n')

    const preview = await applyPatchTool.execute(
      'tool-1',
      { patch: patchText, sourceContextRefs: ['command-trace:diff-1'] },
      undefined,
      undefined,
      ctx
    )
    expect(preview.isError).toBeUndefined()
    expect(textOf(preview)).toContain('Patch preview for a.txt')
    expect(fs.readFileSync(path.join(worktreePath, 'a.txt'), 'utf-8')).toBe('one\n')
    expect(detailsOf(preview)).toMatchObject({
      applied: false,
      requiresConfirmation: true,
      filesAffected: ['a.txt']
    })

    const applied = await applyPatchTool.execute(
      'tool-2',
      {
        patch: patchText,
        confirm: true,
        previewToken: detailsOf(preview).previewToken
      },
      undefined,
      undefined,
      ctx
    )
    expect(applied.isError).toBeUndefined()
    expect(detailsOf(applied)).toMatchObject({ applied: true, filesAffected: ['a.txt'] })
    expect(fs.readFileSync(path.join(worktreePath, 'a.txt'), 'utf-8')).toBe('two\n')
  })

  it('keeps run_test on an allowlist and blocks arbitrary shell', async () => {
    const worktreePath = makeWorktree()
    const blocked = await runTestTool.execute(
      'tool-1',
      { command: 'rm -rf .' },
      undefined,
      undefined,
      { worktreePath, sessionId: 'session-test' }
    )

    expect(blocked.isError).toBe(true)
    expect(textOf(blocked)).toContain('only allows focused test commands')

    const updates = vi.fn()
    const allowed = await runTestTool.execute(
      'tool-2',
      {
        args: ['pnpm', 'vitest', 'run', 'test/phase-24/xuanpu-agent-tool-policy.test.ts'],
        longRunningMs: 100
      },
      undefined,
      updates,
      { worktreePath: process.cwd(), sessionId: 'session-test' }
    )
    expect(allowed.details).toMatchObject({
      command: 'pnpm vitest run test/phase-24/xuanpu-agent-tool-policy.test.ts',
      supervision: expect.objectContaining({ longRunningThresholdMs: 100 })
    })
    expect(updates).toHaveBeenCalledWith(
      expect.objectContaining({
        content: [
          expect.objectContaining({
            text: expect.stringContaining('Command still running after')
          })
        ],
        details: expect.objectContaining({
          command: 'pnpm vitest run test/phase-24/xuanpu-agent-tool-policy.test.ts',
          longRunning: true
        })
      })
    )
  })

  it('registers format_file as a preview-gated write tool', () => {
    expect(formatFileTool.name).toBe('format_file')
    expect(formatFileTool.concurrency).toBe('exclusive')
    expect(formatFileTool.description).toContain('diff-preview')
  })
})
