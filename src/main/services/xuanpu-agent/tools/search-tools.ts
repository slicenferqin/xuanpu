/**
 * Read-only search tool for xuanpu-agent M2.
 *
 * rg_search  — ripgrep content search (falls back to Node.js grep if rg not found)
 */
import * as fs from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { AgentTool, AgentToolResult, AgentToolContext } from '@oh-my-pi/pi-agent-core'

const execFileAsync = promisify(execFile)

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

/**
 * Resolve a user-supplied path safely within the worktree.
 * Defends against symlink escapes by resolving symlinks on the existing
 * parent directory (and the target itself if it exists).
 * Returns the resolved absolute path, or null if it escapes the worktree.
 */
function safeResolve(worktreePath: string, userPath: string): string | null {
  const resolved = path.resolve(worktreePath, userPath)
  const resolvedRoot = path.resolve(worktreePath)

  // If the root doesn't exist on disk, fall back to prefix check
  let root: string
  try {
    root = fs.realpathSync(resolvedRoot)
  } catch {
    const normalizedRoot = resolvedRoot + path.sep
    if (!resolved.startsWith(normalizedRoot) && resolved !== resolvedRoot) {
      return null
    }
    return resolved
  }

  const relPath = path.relative(root, resolved)
  if (relPath === '' || relPath === '.') return root
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) return null

  // Walk up to find the deepest existing ancestor
  let existingParent = path.dirname(resolved)
  while (!fs.existsSync(existingParent)) {
    const next = path.dirname(existingParent)
    if (next === existingParent) break
    existingParent = next
  }

  // Symlink check on the existing parent directory
  try {
    const realParent = fs.realpathSync(existingParent)
    if (realParent !== root && !realParent.startsWith(root + path.sep)) {
      return null
    }
  } catch {
    // Parent doesn't exist yet — no symlink to check
  }

  // If the target itself exists, verify it too
  if (fs.existsSync(resolved)) {
    try {
      const realTarget = fs.realpathSync(resolved)
      if (realTarget !== root && !realTarget.startsWith(root + path.sep)) {
        return null
      }
    } catch {
      // Can't resolve — let the caller handle ENOENT
    }
  }

  return resolved
}

// ───────────────────────────────────────────────────────────────────────────
// rg_search
// ───────────────────────────────────────────────────────────────────────────

interface RgSearchParams {
  pattern: string
  path?: string
  glob?: string
  caseSensitive?: boolean
  maxResults?: number
}

const rgSearchParams = {
  type: 'object',
  additionalProperties: false,
  required: ['pattern'],
  properties: {
    pattern: {
      type: 'string',
      description: 'Search pattern (ripgrep regex syntax)'
    },
    path: {
      type: 'string',
      description: 'Limit search to a specific directory or file path (relative to worktree)'
    },
    glob: {
      type: 'string',
      description: 'File glob filter, e.g. "*.ts" or "*.{ts,tsx}"'
    },
    caseSensitive: {
      type: 'boolean',
      default: false,
      description: 'Enable case-sensitive search'
    },
    maxResults: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      default: 50,
      description: 'Maximum number of results to return'
    }
  }
} as unknown as JsonSchema<RgSearchParams>

export const rgSearchTool: AgentTool<typeof rgSearchParams> = {
  name: 'rg_search',
  label: 'Search (ripgrep)',
  description:
    'Fast content search across files in the worktree using ripgrep. ' +
    'Use this to find where a function, class, string, or pattern appears in the codebase. ' +
    'Supports full regex syntax. Respects .gitignore by default.',
  parameters: rgSearchParams,
  concurrency: 'shared',
  loadMode: 'essential',
  summary: 'Search file contents with ripgrep (regex, .gitignore-aware)',
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const worktreePath = resolveWorktreePath(ctx)
      const target = params.path ?? '.'
      const resolved = safeResolve(worktreePath, target)
      if (!resolved) {
        const command =
          `rg ${params.glob ? `--glob ${params.glob} ` : ''}${params.pattern} ${target}`.trim()
        return errorResult(`Path escapes worktree: ${target}`, { command, cwd: worktreePath })
      }

      // If target resolves to a file, search that file (pass as arg, cwd = worktree).
      // If target resolves to a directory, use it as cwd.
      const isFile = fs.statSync(resolved).isFile()
      const cwd = isFile ? worktreePath : resolved
      const fileArg = isFile ? resolved : null
      const command = [
        'rg',
        params.glob ? `--glob ${params.glob}` : '',
        params.pattern,
        fileArg ?? target
      ]
        .filter(Boolean)
        .join(' ')
      const details = { command, cwd }
      const args: string[] = [
        '--no-heading',
        '--line-number',
        '--color',
        'never',
        '--max-count',
        String(params.maxResults ?? 50)
      ]

      if (!(params.caseSensitive ?? false)) args.push('--ignore-case')
      if (params.glob) args.push('--glob', params.glob)

      args.push('--', params.pattern)
      if (fileArg) args.push(fileArg)

      try {
        const { stdout } = await execFileAsync('rg', args, {
          cwd,
          maxBuffer: 10 * 1024 * 1024, // 10 MiB
          timeout: 30_000
        })
        const output = stdout.trim()
        if (!output) {
          return textResult(`No matches found for pattern: ${params.pattern}`, details)
        }
        // Prefix with match count
        const matchCount = output.split('\n').length
        return textResult(
          `Found ${matchCount} match(es) for "${params.pattern}":\n\n${output}`,
          details
        )
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          return errorResult(
            'ripgrep (rg) is not installed. Install it: https://github.com/BurntSushi/ripgrep',
            details
          )
        }
        // rg returns exit code 1 for "no matches" — not an error
        if ((err as { code?: number }).code === 1) {
          return textResult(`No matches found for pattern: ${params.pattern}`, details)
        }
        throw err
      }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }
}
