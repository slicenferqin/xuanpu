import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AgentLoopConfig } from '@oh-my-pi/pi-agent-core'
import { normalizeRgSearchMaxResults, RG_SEARCH_MAX_RESULTS } from './arguments'

type BeforeToolCallFn = NonNullable<AgentLoopConfig['beforeToolCall']>

export type ToolCallGovernorAction = 'rewrite' | 'deny'

export interface ToolCallGovernorDecision {
  action: ToolCallGovernorAction
  ruleId: string
  toolName: string
  reason: string
  originalArgs: Record<string, unknown>
  nextArgs?: Record<string, unknown>
  occurredAt: number
}

interface ToolCallGovernorOptions {
  readFileWholeFileByteLimit?: number
  listFilesMaxDepth?: number
}

const DEFAULT_READ_FILE_LIMIT_BYTES = 256 * 1024
const DEFAULT_LIST_FILES_MAX_DEPTH = 3

export class ToolCallGovernor {
  private worktreePath: string | null = null
  private readonly readFileWholeFileByteLimit: number
  private readonly listFilesMaxDepth: number
  private readonly decisions: ToolCallGovernorDecision[] = []

  constructor(options: ToolCallGovernorOptions = {}) {
    this.readFileWholeFileByteLimit =
      options.readFileWholeFileByteLimit ?? DEFAULT_READ_FILE_LIMIT_BYTES
    this.listFilesMaxDepth = options.listFilesMaxDepth ?? DEFAULT_LIST_FILES_MAX_DEPTH
  }

  setWorktreePath(worktreePath: string): void {
    this.worktreePath = worktreePath
  }

  listDecisions(): ToolCallGovernorDecision[] {
    return this.decisions.map((decision) => ({
      ...decision,
      originalArgs: { ...decision.originalArgs },
      nextArgs: decision.nextArgs ? { ...decision.nextArgs } : undefined
    }))
  }

  clearDecisions(): void {
    this.decisions.length = 0
  }

  get hook(): BeforeToolCallFn {
    return async (ctx) => {
      const toolName = ctx.toolCall.name ?? ''
      const originalArgs = { ...ctx.args }
      const rewriteReason = this.applyCheapRewrites(toolName, ctx.args)
      if (rewriteReason) {
        this.record({
          action: 'rewrite',
          ruleId: rewriteReason.ruleId,
          toolName,
          reason: rewriteReason.reason,
          originalArgs,
          nextArgs: { ...ctx.args }
        })
      }

      const denial = this.evaluateDenial(toolName, ctx.args)
      if (!denial) return undefined

      this.record({
        action: 'deny',
        ruleId: denial.ruleId,
        toolName,
        reason: denial.reason,
        originalArgs,
        nextArgs: { ...ctx.args }
      })
      return {
        block: true,
        reason: [
          `[ToolCallGovernor:${denial.ruleId}] ${denial.reason}`,
          denial.suggestion ? `Suggested alternative: ${denial.suggestion}` : null
        ]
          .filter((part): part is string => Boolean(part))
          .join(' ')
      }
    }
  }

  private applyCheapRewrites(
    toolName: string,
    args: Record<string, unknown>
  ): { ruleId: string; reason: string } | null {
    if (toolName === 'rg_search') {
      let changed = false
      const normalizedMaxResults = normalizeRgSearchMaxResults(args.maxResults)
      if (args.maxResults !== normalizedMaxResults) {
        args.maxResults = normalizedMaxResults
        changed = true
      }

      if (typeof args.glob === 'string') {
        const trimmedGlob = args.glob.trim()
        if (trimmedGlob !== args.glob) {
          args.glob = trimmedGlob
          changed = true
        }
        if (!trimmedGlob) {
          delete args.glob
          changed = true
        }
      }

      if (typeof args.path === 'string' && !args.path.trim()) {
        args.path = '.'
        changed = true
      }

      if (changed) {
        return {
          ruleId: 'rg-search-argument-cap',
          reason: `constrained rg_search arguments; maxResults is capped at ${RG_SEARCH_MAX_RESULTS}`
        }
      }
    }

    if (toolName === 'list_files') {
      const requestedDepth =
        typeof args.depth === 'number'
          ? args.depth
          : typeof args.depth === 'string'
            ? Number(args.depth)
            : null
      if (requestedDepth !== null && Number.isFinite(requestedDepth)) {
        const cappedDepth = Math.max(
          1,
          Math.min(Math.trunc(requestedDepth), this.listFilesMaxDepth)
        )
        if (cappedDepth !== requestedDepth) {
          args.depth = cappedDepth
          return {
            ruleId: 'list-files-depth-cap',
            reason: `capped list_files depth to ${this.listFilesMaxDepth} to avoid huge directory output`
          }
        }
      }
    }

    return null
  }

  private evaluateDenial(
    toolName: string,
    args: Record<string, unknown>
  ): { ruleId: string; reason: string; suggestion?: string } | null {
    if (toolName === 'read_file') return this.evaluateReadFile(args)
    if (toolName === 'run_test') return evaluateRunTest(args)
    return null
  }

  private evaluateReadFile(
    args: Record<string, unknown>
  ): { ruleId: string; reason: string; suggestion?: string } | null {
    const userPath = typeof args.path === 'string' ? args.path : ''
    if (!userPath || args.startLine !== undefined || args.endLine !== undefined) return null
    if (!this.worktreePath) return null

    const resolved = safeResolve(this.worktreePath, userPath)
    if (!resolved) return null

    let stat: fs.Stats
    try {
      stat = fs.statSync(resolved)
    } catch {
      return null
    }
    if (!stat.isFile() || stat.size <= this.readFileWholeFileByteLimit) return null

    return {
      ruleId: 'read-file-large-whole-file',
      reason: `blocked whole-file read of ${userPath} (${formatBytes(stat.size)}; limit ${formatBytes(this.readFileWholeFileByteLimit)})`,
      suggestion:
        'call read_file with startLine/endLine for the relevant range, or use rg_search to locate the target lines first'
    }
  }

  private record(input: Omit<ToolCallGovernorDecision, 'occurredAt'>): void {
    this.decisions.push({
      ...input,
      occurredAt: Date.now()
    })
  }
}

function evaluateRunTest(
  args: Record<string, unknown>
): { ruleId: string; reason: string; suggestion?: string } | null {
  const tokens = getRunTestTokens(args)
  if (tokens.length === 0) return null

  if (!isBroadTestCommand(tokens)) return null

  return {
    ruleId: 'run-test-broad-command',
    reason: `blocked broad test command: ${tokens.join(' ')}`,
    suggestion:
      'run a focused command such as "pnpm vitest run test/path/to/file.test.ts" or include a specific test file/path'
  }
}

function getRunTestTokens(args: Record<string, unknown>): string[] {
  if (Array.isArray(args.args)) return args.args.map(String).filter(Boolean)
  if (typeof args.command === 'string') return args.command.trim().split(/\s+/).filter(Boolean)
  return []
}

function isBroadTestCommand(tokens: string[]): boolean {
  if (tokens.length === 0) return false
  const normalized = tokens.map((token) => token.trim()).filter(Boolean)
  if (normalized.length === 0) return false
  if (hasFocusedSelector(normalized)) return false

  const [bin, first, second, third] = normalized
  if (bin === 'vitest' && first === 'run') return true
  if (bin !== 'pnpm') return false
  if (first === 'test') return true
  if (first === 'run' && (second === 'test' || second === 'test:unit')) return true
  if (first === 'vitest' && second === 'run') return true
  if (first === 'exec' && second === 'vitest' && third === 'run') return true
  return false
}

function hasFocusedSelector(tokens: string[]): boolean {
  return tokens.some((token) => {
    if (token.startsWith('-')) return false
    return (
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(token) ||
      token.startsWith('test/') ||
      token.startsWith('tests/') ||
      token.startsWith('src/') ||
      token.includes('.test.') ||
      token.includes('.spec.')
    )
  })
}

function safeResolve(worktreePath: string, userPath: string): string | null {
  const resolvedRoot = path.resolve(worktreePath)
  const requested = path.resolve(resolvedRoot, userPath)
  let realRoot: string
  try {
    realRoot = fs.realpathSync(resolvedRoot)
  } catch {
    return null
  }

  const targetForRelative = fs.existsSync(requested)
    ? fs.realpathSync(requested)
    : path.resolve(realRoot, path.relative(resolvedRoot, requested))
  const relPath = path.relative(realRoot, targetForRelative)
  if (relPath === '' || relPath === '.') return realRoot
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) return null

  try {
    if (!fs.existsSync(requested)) return requested
    const realTarget = fs.realpathSync(requested)
    const realRel = path.relative(realRoot, realTarget)
    if (realRel === '' || realRel === '.') return realTarget
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) return null
    return realTarget
  } catch {
    return null
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kib = bytes / 1024
  if (kib < 1024) return `${Math.round(kib)}KiB`
  return `${(kib / 1024).toFixed(1)}MiB`
}
