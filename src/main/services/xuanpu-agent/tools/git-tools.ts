/**
 * Read-only Git tools for xuanpu-agent M2.
 *
 * git_status  — working-tree / index state (status, branch, changed files)
 * git_log     — recent commit history
 * git_diff    — unstaged / staged / branch-comparison diffs
 *
 * All tools resolve the worktree path from AgentToolContext and run via
 * simple-git. Output is plain text so the model sees what a developer sees.
 */
import simpleGit from 'simple-git'
import * as path from 'path'
import type { AgentTool, AgentToolResult, AgentToolContext } from '@oh-my-pi/pi-agent-core'

type JsonSchema<T> = Record<string, unknown> & { static: T }

interface ToolDetails {
  command: string
  cwd: string
}

// ───────────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────────

function resolveWorktreePath(ctx?: AgentToolContext): string {
  const record = ctx as Record<string, unknown> | undefined
  if (record && typeof record.worktreePath === 'string') return record.worktreePath
  return process.cwd()
}

function textResult(text: string, details?: ToolDetails): AgentToolResult<ToolDetails> {
  return { content: [{ type: 'text', text }], details }
}

function errorResult(message: string, details?: ToolDetails): AgentToolResult<ToolDetails> {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details, isError: true }
}

function pathEscapesWorktree(worktreePath: string, userPath: string): boolean {
  const resolved = path.resolve(worktreePath, userPath)
  const root = path.resolve(worktreePath)
  return resolved !== root && !resolved.startsWith(root + path.sep)
}

// ───────────────────────────────────────────────────────────────────────────
// git_status
// ───────────────────────────────────────────────────────────────────────────

interface GitStatusParams {
  path?: string
}

const gitStatusParams = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: {
      type: 'string',
      description: 'Limit status to a specific path within the worktree'
    }
  }
} as unknown as JsonSchema<GitStatusParams>

export const gitStatusTool: AgentTool<typeof gitStatusParams> = {
  name: 'git_status',
  label: 'Git Status',
  description:
    'Show the working tree status — current branch, staged/unstaged/untracked changes. ' +
    'Use this to understand what files have been modified before reading or searching.',
  parameters: gitStatusParams,
  concurrency: 'shared',
  loadMode: 'essential',
  summary: 'Show git working tree status (branch, staged, unstaged, untracked files)',
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const worktreePath = resolveWorktreePath(ctx)
      const details = {
        command: params.path ? `git status -- ${params.path}` : 'git status',
        cwd: worktreePath
      }
      if (params.path && pathEscapesWorktree(worktreePath, params.path)) {
        return errorResult(`Path escapes worktree: ${params.path}`, details)
      }
      const git = simpleGit(worktreePath)
      const status = await git.status(
        params.path ? ['--untracked-files=normal', '--', params.path] : ['--untracked-files=normal']
      )

      const lines: string[] = []
      lines.push(`Branch: ${status.current}`)
      if (status.tracking) lines.push(`Tracking: ${status.tracking}`)

      const staged = status.staged
      const notStaged = status.modified.concat(status.deleted).filter((f) => !staged.includes(f))
      const created = status.created
      const untracked = status.not_added ?? []

      if (staged.length)
        lines.push(`\nStaged (${staged.length}):\n${staged.map((f) => `  M ${f}`).join('\n')}`)
      if (notStaged.length)
        lines.push(
          `\nModified (${notStaged.length}):\n${notStaged.map((f) => `  M ${f}`).join('\n')}`
        )
      if (created.length)
        lines.push(`\nCreated (${created.length}):\n${created.map((f) => `  ?? ${f}`).join('\n')}`)
      if (untracked.length)
        lines.push(
          `\nUntracked (${untracked.length}):\n${untracked.map((f) => `  ?? ${f}`).join('\n')}`
        )

      if (!staged.length && !notStaged.length && !created.length && !untracked.length) {
        lines.push('\nWorking tree clean.')
      }

      return textResult(lines.join('\n'), details)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// git_log
// ───────────────────────────────────────────────────────────────────────────

interface GitLogParams {
  n?: number
  branch?: string
  path?: string
  oneline?: boolean
}

const gitLogParams = {
  type: 'object',
  additionalProperties: false,
  properties: {
    n: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 10,
      description: 'Number of recent commits to show'
    },
    branch: {
      type: 'string',
      description: 'Branch or ref to show log for (default: current branch)'
    },
    path: {
      type: 'string',
      description: 'Limit log to commits affecting this file/directory'
    },
    oneline: {
      type: 'boolean',
      default: true,
      description: 'Show one line per commit (compact format)'
    }
  }
} as unknown as JsonSchema<GitLogParams>

export const gitLogTool: AgentTool<typeof gitLogParams> = {
  name: 'git_log',
  label: 'Git Log',
  description:
    'Show recent commit history. Use this to understand what changed recently, ' +
    'find when a feature was introduced, or trace the evolution of a file.',
  parameters: gitLogParams,
  concurrency: 'shared',
  loadMode: 'essential',
  summary: 'Show recent git commit history (default: last 10 commits, one-line format)',
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const worktreePath = resolveWorktreePath(ctx)
      const limit = params.n ?? 10
      const details = {
        command: `git log -${limit}${params.branch ? ` ${params.branch}` : ''}${params.path ? ` -- ${params.path}` : ''}`,
        cwd: worktreePath
      }
      if (params.path && pathEscapesWorktree(worktreePath, params.path)) {
        return errorResult(`Path escapes worktree: ${params.path}`, details)
      }
      const git = simpleGit(worktreePath)
      const args: string[] = [`-${limit}`]
      if (params.oneline ?? true) args.push('--oneline')
      if (params.branch) args.push(params.branch)
      if (params.path) args.push('--', params.path)

      const result = await git.raw(['log', ...args])
      const output = result.trim()
      return textResult(output || '(no commits)', details)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// git_diff
// ───────────────────────────────────────────────────────────────────────────

interface GitDiffParams {
  staged?: boolean
  path?: string
  branch?: string
}

const gitDiffParams = {
  type: 'object',
  additionalProperties: false,
  properties: {
    staged: {
      type: 'boolean',
      default: false,
      description: 'Show staged changes (git diff --staged)'
    },
    path: {
      type: 'string',
      description: 'Limit diff to a specific file'
    },
    branch: {
      type: 'string',
      description: 'Compare working tree against another branch (e.g. "main")'
    }
  }
} as unknown as JsonSchema<GitDiffParams>

export const gitDiffTool: AgentTool<typeof gitDiffParams> = {
  name: 'git_diff',
  label: 'Git Diff',
  description:
    'Show changes in the working tree. Use this to see what was modified, ' +
    'review staged changes before committing, or compare against another branch.',
  parameters: gitDiffParams,
  concurrency: 'shared',
  loadMode: 'essential',
  summary: 'Show git diff (unstaged by default, --staged flag for staged changes)',
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const worktreePath = resolveWorktreePath(ctx)
      const details = {
        command: `git diff${params.staged ? ' --staged' : ''}${params.branch ? ` ${params.branch}` : ''}${params.path ? ` -- ${params.path}` : ''}`,
        cwd: worktreePath
      }
      if (params.path && pathEscapesWorktree(worktreePath, params.path)) {
        return errorResult(`Path escapes worktree: ${params.path}`, details)
      }
      const git = simpleGit(worktreePath)
      const args: string[] = ['diff']
      if (params.staged) args.push('--staged')
      if (params.branch) args.push(params.branch)
      if (params.path) args.push('--', params.path)

      const result = await git.raw(args)
      const output = result.trim()
      return textResult(output || '(no changes)', details)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }
}
