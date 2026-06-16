import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

type JsonSchema<T> = Record<string, unknown> & { static: T }

export interface XuanpuAgentCliToolResult<TDetails = ToolDetails> {
  content: Array<{ type: 'text'; text: string }>
  details?: TDetails
  isError?: boolean
}

export interface XuanpuAgentCliTool {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  concurrency?: 'shared' | 'exclusive'
  loadMode?: 'essential' | 'discoverable'
  summary?: string
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (partialResult: XuanpuAgentCliToolResult) => void,
    context?: Record<string, unknown>
  ): Promise<XuanpuAgentCliToolResult>
}

export interface XuanpuAgentCliToolOptions {
  projectRoot: string
  allowWrites?: boolean
  testTimeoutMs?: number
}

interface ToolDetails {
  command?: string
  cwd: string
  path?: string
  paths?: string[]
  exitCode?: number
  durationMs?: number
  timedOut?: boolean
}

interface ResolvedPath {
  absolutePath: string
  relativePath: string
}

const DEFAULT_TEST_TIMEOUT_MS = 120_000
const MAX_READ_FILE_BYTES = 256 * 1024
const MAX_WRITE_FILE_BYTES = 1024 * 1024
const MAX_SEARCH_OUTPUT_BYTES = 512 * 1024
const MAX_TEST_OUTPUT_BYTES = 1024 * 1024
const BLOCKED_WRITE_SEGMENTS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage'
])

export function createCliCodingTools(options: XuanpuAgentCliToolOptions): XuanpuAgentCliTool[] {
  return [
    createReadFileTool(options),
    createRgSearchTool(options),
    ...(options.allowWrites ? [createWriteFileTool(options)] : []),
    createRunTestTool(options)
  ]
}

function createReadFileTool(options: XuanpuAgentCliToolOptions): XuanpuAgentCliTool {
  return {
    name: 'read_file',
    label: 'Read File',
    description: 'Read a file from the current project. Use startLine/endLine for large files.',
    parameters: readFileParams as Record<string, unknown>,
    concurrency: 'shared',
    loadMode: 'essential',
    summary: 'Read a project file with optional line range',
    async execute(_toolCallId, rawParams) {
      const params = rawParams as unknown as ReadFileParams
      const details = { cwd: options.projectRoot, command: `read_file ${params.path}` }
      try {
        const target = await resolveInsideProject(options.projectRoot, params.path)
        const info = await stat(target.absolutePath)
        if (!info.isFile()) return errorResult(`Not a file: ${params.path}`, details)

        const hasRange = params.startLine !== undefined || params.endLine !== undefined
        if (!hasRange && info.size > MAX_READ_FILE_BYTES) {
          return errorResult(
            `File too large: ${target.relativePath} (${info.size} bytes). Use startLine/endLine.`,
            details
          )
        }

        const text = await readFile(target.absolutePath, 'utf8')
        const lines = text.split('\n')
        const start = Math.max(1, params.startLine ?? 1)
        const end = Math.min(lines.length, params.endLine ?? lines.length)
        if (end < start) return errorResult('endLine must be >= startLine', details)

        const numbered = lines
          .slice(start - 1, end)
          .map((line, index) => `${String(start + index).padStart(4, ' ')}| ${line}`)
          .join('\n')
        return textResult(
          `[${target.relativePath}:${start}-${end} / ${lines.length} lines]\n${numbered}`,
          { ...details, path: target.relativePath }
        )
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error), details)
      }
    }
  }
}

function createRgSearchTool(options: XuanpuAgentCliToolOptions): XuanpuAgentCliTool {
  return {
    name: 'rg_search',
    label: 'Search',
    description:
      'Search project files with ripgrep. Use maxResults and path to keep output focused.',
    parameters: rgSearchParams as Record<string, unknown>,
    concurrency: 'shared',
    loadMode: 'essential',
    summary: 'Search project files with ripgrep',
    async execute(_toolCallId, rawParams) {
      const params = rawParams as unknown as RgSearchParams
      const maxResults = Math.max(1, Math.min(params.maxResults ?? 50, 200))
      const targetPath = params.path ?? '.'
      const details = {
        cwd: options.projectRoot,
        command: `rg ${params.pattern} ${targetPath}`
      }
      try {
        await resolveInsideProject(options.projectRoot, targetPath)
        const args = [
          '--no-heading',
          '--line-number',
          '--color',
          'never',
          '--max-count',
          String(maxResults)
        ]
        if (!(params.caseSensitive ?? false)) args.push('--ignore-case')
        if (params.glob) args.push('--glob', params.glob)
        args.push('--', params.pattern, targetPath)

        const startedAt = Date.now()
        try {
          const { stdout } = await execFileAsync('rg', args, {
            cwd: options.projectRoot,
            encoding: 'utf8',
            maxBuffer: MAX_SEARCH_OUTPUT_BYTES,
            timeout: 30_000
          })
          const output = stdout.trim()
          return textResult(output || `No matches found for pattern: ${params.pattern}`, {
            ...details,
            durationMs: Date.now() - startedAt
          })
        } catch (error) {
          const execError = error as NodeJS.ErrnoException & {
            code?: string | number
            stdout?: string
            stderr?: string
            killed?: boolean
          }
          const errorCode = (execError as { code?: unknown }).code
          if (errorCode === 1) {
            return textResult(`No matches found for pattern: ${params.pattern}`, details)
          }
          return errorResult(
            errorCode === 'ENOENT'
              ? 'ripgrep is not installed or not on PATH.'
              : (execError.stderr ?? execError.message ?? String(error)),
            {
              ...details,
              exitCode: typeof errorCode === 'number' ? errorCode : undefined,
              timedOut: execError.killed === true
            }
          )
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error), details)
      }
    }
  }
}

function createWriteFileTool(options: XuanpuAgentCliToolOptions): XuanpuAgentCliTool {
  return {
    name: 'write_file',
    label: 'Write File',
    description:
      'Write a UTF-8 file inside the current project. Only available when CLI is started with --allow-writes.',
    parameters: writeFileParams as Record<string, unknown>,
    concurrency: 'exclusive',
    loadMode: 'essential',
    summary: 'Write a bounded UTF-8 project file',
    async execute(_toolCallId, rawParams) {
      const params = rawParams as unknown as WriteFileParams
      const details = { cwd: options.projectRoot, command: `write_file ${params.path}` }
      try {
        if (!options.allowWrites) return errorResult('Writes are disabled.', details)
        if (Buffer.byteLength(params.content, 'utf8') > MAX_WRITE_FILE_BYTES) {
          return errorResult(`content exceeds ${MAX_WRITE_FILE_BYTES} bytes`, details)
        }
        const target = await resolveWritableProjectPath(options.projectRoot, params.path)
        await mkdir(dirname(target.absolutePath), { recursive: true })
        await writeFile(target.absolutePath, params.content, 'utf8')
        return textResult(`Wrote ${target.relativePath}`, {
          ...details,
          path: target.relativePath
        })
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error), details)
      }
    }
  }
}

function createRunTestTool(options: XuanpuAgentCliToolOptions): XuanpuAgentCliTool {
  return {
    name: 'run_test',
    label: 'Run Test',
    description:
      'Run a focused pnpm test/typecheck/build command without a shell. Pass args such as ["vitest","run","test/file.test.ts"] or ["exec","tsc","-p","tsconfig.json","--noEmit"].',
    parameters: runTestParams as Record<string, unknown>,
    concurrency: 'exclusive',
    loadMode: 'essential',
    summary: 'Run focused pnpm verification commands',
    async execute(_toolCallId, rawParams) {
      const params = rawParams as unknown as RunTestParams
      const args = params.args ?? ['test']
      const timeoutMs = Math.max(
        1_000,
        Math.min(params.timeoutMs ?? options.testTimeoutMs ?? DEFAULT_TEST_TIMEOUT_MS, 300_000)
      )
      const details = {
        cwd: options.projectRoot,
        command: ['pnpm', ...args].join(' ')
      }
      try {
        assertSafeCommandArgs(args)
        const startedAt = Date.now()
        try {
          const { stdout, stderr } = await execFileAsync('pnpm', args, {
            cwd: options.projectRoot,
            encoding: 'utf8',
            timeout: timeoutMs,
            maxBuffer: MAX_TEST_OUTPUT_BYTES
          })
          const output = [stdout, stderr].filter(Boolean).join('\n').trim()
          return textResult(output || 'Command completed with no output.', {
            ...details,
            exitCode: 0,
            durationMs: Date.now() - startedAt
          })
        } catch (error) {
          const execError = error as NodeJS.ErrnoException & {
            code?: string | number
            stdout?: string
            stderr?: string
            killed?: boolean
          }
          const output = [execError.stdout, execError.stderr, execError.message]
            .filter(Boolean)
            .join('\n')
            .trim()
          const errorCode = (execError as { code?: unknown }).code
          return errorResult(output || 'pnpm command failed.', {
            ...details,
            exitCode: typeof errorCode === 'number' ? errorCode : undefined,
            durationMs: Date.now() - startedAt,
            timedOut: execError.killed === true
          })
        }
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error), details)
      }
    }
  }
}

async function resolveInsideProject(projectRoot: string, userPath: string): Promise<ResolvedPath> {
  if (!userPath || userPath.includes('\0')) throw new Error('Invalid path.')
  const root = await realpath(projectRoot)
  const requested = isAbsolute(userPath) ? resolve(userPath) : resolve(root, userPath)
  const rel = relative(root, requested)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes project root: ${userPath}`)
  }

  if (await pathExists(requested)) {
    const realTarget = await realpath(requested)
    const realRel = relative(root, realTarget)
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new Error(`Path resolves outside project through symlink: ${userPath}`)
    }
  }

  return { absolutePath: requested, relativePath: rel || '.' }
}

async function resolveWritableProjectPath(
  projectRoot: string,
  userPath: string
): Promise<ResolvedPath> {
  const target = await resolveInsideProject(projectRoot, userPath)
  const dangerousSegment = target.relativePath
    .split(/[\\/]+/)
    .find((segment) => BLOCKED_WRITE_SEGMENTS.has(segment))
  if (dangerousSegment) throw new Error(`Blocked write path segment: ${dangerousSegment}`)
  const basename = target.relativePath.split(/[\\/]+/).at(-1) ?? ''
  if (basename === '.env' || /^\.env\.(?!example$)/.test(basename)) {
    throw new Error(`Blocked secrets path: ${target.relativePath}`)
  }

  const parent = dirname(target.absolutePath)
  try {
    const realParent = await realpath(parent)
    const root = await realpath(projectRoot)
    const relParent = relative(root, realParent)
    if (relParent.startsWith('..') || isAbsolute(relParent)) {
      throw new Error(`Path resolves outside project through symlink: ${userPath}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  return target
}

function assertSafeCommandArgs(args: string[]): void {
  if (!Array.isArray(args) || args.length === 0) throw new Error('args must be non-empty.')
  const unsafe = args.find((arg) => /[;&|`$<>]/.test(arg))
  if (unsafe) throw new Error(`Unsafe shell metacharacter in argument: ${unsafe}`)
  const joined = args.join(' ')
  if (/--watch\b|\bwatch\b/.test(joined)) {
    throw new Error('Long-running watch commands are not allowed.')
  }
}

function textResult(text: string, details: ToolDetails): XuanpuAgentCliToolResult<ToolDetails> {
  return { content: [{ type: 'text', text }], details }
}

function errorResult(message: string, details: ToolDetails): XuanpuAgentCliToolResult<ToolDetails> {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details, isError: true }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

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
    path: { type: 'string', description: 'Path relative to the project root' },
    startLine: { type: 'integer', minimum: 1 },
    endLine: { type: 'integer', minimum: 1 }
  }
} as unknown as JsonSchema<ReadFileParams>

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
    pattern: { type: 'string', description: 'ripgrep regex pattern' },
    path: { type: 'string', description: 'Optional path relative to project root' },
    glob: { type: 'string', description: 'Optional ripgrep glob, e.g. *.ts' },
    caseSensitive: { type: 'boolean', default: false },
    maxResults: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
  }
} as unknown as JsonSchema<RgSearchParams>

interface WriteFileParams {
  path: string
  content: string
}

const writeFileParams = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'content'],
  properties: {
    path: { type: 'string', description: 'Path relative to the project root' },
    content: { type: 'string', description: 'Full UTF-8 file content to write' }
  }
} as unknown as JsonSchema<WriteFileParams>

interface RunTestParams {
  args?: string[]
  timeoutMs?: number
}

const runTestParams = {
  type: 'object',
  additionalProperties: false,
  properties: {
    args: {
      type: 'array',
      items: { type: 'string' },
      description: 'Arguments passed to pnpm without a shell'
    },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000 }
  }
} as unknown as JsonSchema<RunTestParams>

export const __TEST_CLI_TOOL_INTERNALS = {
  pathExists,
  resolveInsideProject,
  resolveWritableProjectPath
}
