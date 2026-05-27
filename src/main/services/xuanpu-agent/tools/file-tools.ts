/**
 * Read-only file tools for xuanpu-agent M2.
 *
 * read_file   — read a file (or a range of lines) from the worktree
 * list_files  — list directory contents (with optional recursion)
 *
 * Both tools enforce path containment: all paths must resolve within the
 * worktree root to prevent directory-traversal escapes.
 */
import * as fs from 'fs'
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
// read_file
// ───────────────────────────────────────────────────────────────────────────

interface ReadFileParams {
  path: string
  startLine?: number
  endLine?: number
}

const readFileParams = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: {
      type: 'string',
      description: 'File path relative to the worktree root'
    },
    startLine: {
      type: 'integer',
      minimum: 1,
      description: 'Starting line number (1-based, inclusive)'
    },
    endLine: {
      type: 'integer',
      minimum: 1,
      description: 'Ending line number (1-based, inclusive)'
    }
  }
} as unknown as JsonSchema<ReadFileParams>

export const readFileTool: AgentTool<typeof readFileParams> = {
  name: 'read_file',
  label: 'Read File',
  description:
    'Read the contents of a file within the worktree. ' +
    'Optionally specify a line range to read only part of the file. ' +
    'Use this after git_status or rg_search to inspect specific files.',
  parameters: readFileParams,
  concurrency: 'shared',
  loadMode: 'essential',
  summary: 'Read a file (or line range) from the worktree',
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const worktreePath = resolveWorktreePath(ctx)
      const details = { command: `cat ${params.path}`, cwd: worktreePath }
      const resolved = safeResolve(worktreePath, params.path)
      if (!resolved) {
        return errorResult(`Path escapes worktree: ${params.path}`, details)
      }

      const stat = fs.statSync(resolved)
      if (!stat.isFile()) {
        return errorResult(`Not a file: ${params.path}`, details)
      }

      const hasRange = params.startLine !== undefined || params.endLine !== undefined

      // For whole-file reads, refuse files larger than 256 KiB.
      // For range reads, allow large files — we only read the requested slice.
      if (!hasRange && stat.size > 256 * 1024) {
        return errorResult(
          `File too large: ${params.path} (${(stat.size / 1024).toFixed(0)} KiB, max 256 KiB). ` +
            `Use startLine/endLine to read a specific range.`,
          details
        )
      }

      const content = fs.readFileSync(resolved, 'utf-8')
      const lines = content.split('\n')

      if (hasRange) {
        const start = (params.startLine ?? 1) - 1
        const end = params.endLine ?? lines.length
        if (start < 0 || start >= lines.length) {
          return errorResult(
            `startLine ${params.startLine} out of range (file has ${lines.length} lines)`,
            details
          )
        }
        if (end < start) {
          return errorResult(
            `endLine ${params.endLine} must be >= startLine ${params.startLine}`,
            details
          )
        }
        const sliced = lines.slice(start, end)
        const result = sliced
          .map((line, i) => `${String(start + i + 1).padStart(4, ' ')}| ${line}`)
          .join('\n')
        const header = `[${params.path}:${start + 1}-${Math.min(end, lines.length)} / ${lines.length} lines]`
        return textResult(`${header}\n${result}`, details)
      }

      // Whole file with line numbers
      const numbered = lines
        .map((line, i) => `${String(i + 1).padStart(4, ' ')}| ${line}`)
        .join('\n')
      const header = `[${params.path}:1-${lines.length} / ${lines.length} lines]`
      return textResult(`${header}\n${numbered}`, details)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return errorResult(`File not found: ${params.path}`)
      }
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// list_files
// ───────────────────────────────────────────────────────────────────────────

interface ListFilesParams {
  path?: string
  depth?: number
}

const listFilesParams = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: {
      type: 'string',
      description: 'Directory path relative to worktree root (default: root)'
    },
    depth: {
      type: 'integer',
      minimum: 1,
      maximum: 5,
      default: 2,
      description: 'Maximum recursion depth (1-5, default 2)'
    }
  }
} as unknown as JsonSchema<ListFilesParams>

// Directories and files to skip
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  'build',
  '.next',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  'coverage',
  '.turbo',
  '.cache'
])

const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db'])

export const listFilesTool: AgentTool<typeof listFilesParams> = {
  name: 'list_files',
  label: 'List Files',
  description:
    'List files and directories in the worktree. ' +
    'Use this to understand the project structure before reading or searching.',
  parameters: listFilesParams,
  concurrency: 'shared',
  loadMode: 'essential',
  summary: 'List directory contents (recursive, depth 1-5, default 2)',
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    try {
      const worktreePath = resolveWorktreePath(ctx)
      const dirPath = params.path ?? '.'
      const details = { command: `ls ${dirPath}`, cwd: worktreePath }
      const resolved = safeResolve(worktreePath, dirPath)
      if (!resolved) {
        return errorResult(`Path escapes worktree: ${dirPath}`, details)
      }

      if (!fs.existsSync(resolved)) {
        return errorResult(`Path not found: ${dirPath}`, details)
      }

      const stat = fs.statSync(resolved)
      if (!stat.isDirectory()) {
        return errorResult(`Not a directory: ${dirPath}`, details)
      }

      const lines: string[] = []
      walkDir(resolved, params.depth ?? 2, 0, lines)
      return textResult(lines.join('\n'), details)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }
  }
}

function walkDir(dirPath: string, maxDepth: number, currentDepth: number, lines: string[]): void {
  if (currentDepth >= maxDepth) return

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return // permission error, skip
  }

  // Sort: directories first, then files, alphabetically
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue // skip hidden
    if (SKIP_DIRS.has(entry.name)) continue
    if (!entry.isDirectory() && SKIP_FILES.has(entry.name)) continue

    const indent = '  '.repeat(currentDepth)
    if (entry.isDirectory()) {
      lines.push(`${indent}${entry.name}/`)
      walkDir(path.join(dirPath, entry.name), maxDepth, currentDepth + 1, lines)
    } else {
      lines.push(`${indent}${entry.name}`)
    }
  }
}
