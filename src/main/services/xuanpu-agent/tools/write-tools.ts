/**
 * Controlled write tools for xuanpu-agent M4.
 *
 * Writes are two-phase by default:
 *   1. preview call returns a unified diff and previewToken
 *   2. confirm call with the same operation + previewToken applies it
 *
 * The only bypass is explicit trusted mode (`XUANPU_AGENT_TRUSTED_WRITES=1` or
 * `trustedWrites` in the tool context). All paths are contained to the
 * worktree and generated-output / VCS paths are blocked.
 */
import * as fs from 'fs'
import * as path from 'path'
import { createHash, randomUUID } from 'crypto'
import { spawn } from 'child_process'
import type { AgentTool, AgentToolContext, AgentToolResult } from '@oh-my-pi/pi-agent-core'

type JsonSchema<T> = Record<string, unknown> & { static: T }

interface ToolDetails {
  command: string
  cwd: string
  path?: string
  paths?: string[]
  operation?: 'preview' | 'write' | 'edit' | 'patch' | 'test' | 'format'
  applied?: boolean
  requiresConfirmation?: boolean
  previewToken?: string
  sourceContextRefs?: string[]
  rollbackHint?: string
  diff?: string
  reverseDiff?: string
  filesAffected?: string[]
  exitCode?: number
  durationMs?: number
  timedOut?: boolean
  aborted?: boolean
  longRunning?: boolean
  supervision?: {
    longRunningThresholdMs: number
    notifiedAtMs: number | null
  }
}

interface XuanpuToolContext extends AgentToolContext {
  worktreePath?: string
  sessionId?: string
  trustedWrites?: boolean
}

interface ConfirmableParams {
  confirm?: boolean
  previewToken?: string
  sourceContextRefs?: string[]
}

interface PreviewRecord {
  sessionId: string
  token: string
  digest: string
  expiresAt: number
}

interface ResolvedWorktreePath {
  absPath: string
  relPath: string
}

interface ProcessResult {
  stdout: string
  stderr: string
  output: string
  exitCode: number
  durationMs: number
  timedOut: boolean
  aborted: boolean
}

const PREVIEW_TTL_MS = 15 * 60 * 1000
const MAX_FILE_BYTES = 1024 * 1024
const MAX_PATCH_BYTES = 256 * 1024
const MAX_COMMAND_OUTPUT_BYTES = 20 * 1024 * 1024
const previewRecords = new Map<string, PreviewRecord>()

const DANGEROUS_PATH_SEGMENTS = new Set([
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

function resolveWorktreePath(ctx?: AgentToolContext): string {
  const record = ctx as XuanpuToolContext | undefined
  if (record && typeof record.worktreePath === 'string') return record.worktreePath
  return process.cwd()
}

function resolveSessionId(ctx?: AgentToolContext): string {
  const record = ctx as XuanpuToolContext | undefined
  return typeof record?.sessionId === 'string' ? record.sessionId : 'default'
}

function isTrustedWrites(ctx?: AgentToolContext): boolean {
  const record = ctx as XuanpuToolContext | undefined
  return record?.trustedWrites === true || process.env.XUANPU_AGENT_TRUSTED_WRITES === '1'
}

function textResult(text: string, details?: ToolDetails): AgentToolResult<ToolDetails> {
  return { content: [{ type: 'text', text }], details }
}

function errorResult(message: string, details?: ToolDetails): AgentToolResult<ToolDetails> {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details, isError: true }
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function digestOperation(payload: unknown): string {
  return hashText(JSON.stringify(payload))
}

function cleanupPreviewRecords(now = Date.now()): void {
  for (const [key, record] of previewRecords) {
    if (record.expiresAt <= now) previewRecords.delete(key)
  }
}

function createPreviewToken(ctx: AgentToolContext | undefined, digest: string): string {
  cleanupPreviewRecords()
  const sessionId = resolveSessionId(ctx)
  const token = `m4-${randomUUID()}`
  previewRecords.set(`${sessionId}:${token}`, {
    sessionId,
    token,
    digest,
    expiresAt: Date.now() + PREVIEW_TTL_MS
  })
  return token
}

function validatePreviewToken(
  ctx: AgentToolContext | undefined,
  params: ConfirmableParams,
  digest: string
): string | null {
  if (isTrustedWrites(ctx)) return null
  const token = params.previewToken
  if (!params.confirm && !token) return 'preview-required'
  if (!token) return 'A previewToken is required to apply this write.'

  cleanupPreviewRecords()
  const key = `${resolveSessionId(ctx)}:${token}`
  const record = previewRecords.get(key)
  if (!record || record.digest !== digest) {
    return 'Preview token is stale or does not match the current source content.'
  }
  previewRecords.delete(key)
  return null
}

function sourceRefsForPath(relPath: string, oldText: string, params: ConfirmableParams): string[] {
  return [
    ...(params.sourceContextRefs ?? []),
    `file:${relPath}@sha256:${hashText(oldText).slice(0, 16)}`
  ]
}

function resolveWritablePath(worktreePath: string, userPath: string): ResolvedWorktreePath {
  if (typeof userPath !== 'string' || userPath.trim().length === 0) {
    throw new Error('path is required')
  }
  if (userPath.includes('\0')) {
    throw new Error('path contains a NUL byte')
  }

  const root = fs.realpathSync(path.resolve(worktreePath))
  const requested = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(root, userPath)
  const relPath = path.relative(root, requested)
  if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) {
    throw new Error(`Path escapes worktree: ${userPath}`)
  }

  const segments = relPath.split(path.sep)
  const dangerousSegment = segments.find((segment) => DANGEROUS_PATH_SEGMENTS.has(segment))
  if (dangerousSegment) {
    throw new Error(`Dangerous path segment blocked: ${dangerousSegment}`)
  }

  const basename = path.basename(relPath)
  if (basename === '.env' || /^\.env\.(?!example$)/.test(basename)) {
    throw new Error(`Dangerous secrets path blocked: ${relPath}`)
  }

  let existingParent = path.dirname(requested)
  while (!fs.existsSync(existingParent)) {
    const next = path.dirname(existingParent)
    if (next === existingParent) break
    existingParent = next
  }
  const realParent = fs.realpathSync(existingParent)
  if (realParent !== root && !realParent.startsWith(root + path.sep)) {
    throw new Error(`Path resolves outside worktree through a symlink: ${userPath}`)
  }

  if (fs.existsSync(requested)) {
    const realTarget = fs.realpathSync(requested)
    if (realTarget !== root && !realTarget.startsWith(root + path.sep)) {
      throw new Error(`Path resolves outside worktree through a symlink: ${userPath}`)
    }
    const stat = fs.statSync(realTarget)
    if (stat.isDirectory()) throw new Error(`Path is a directory: ${userPath}`)
  }

  return { absPath: requested, relPath }
}

function ensureReadableTextFile(absPath: string, relPath: string): string {
  const stat = fs.statSync(absPath)
  if (!stat.isFile()) throw new Error(`Not a file: ${relPath}`)
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `File too large: ${relPath} (${(stat.size / 1024).toFixed(0)} KiB, max 1024 KiB)`
    )
  }
  return fs.readFileSync(absPath, 'utf-8')
}

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  return text.split('\n')
}

function hunkRange(start: number, count: number): string {
  if (count === 0) return `${Math.max(0, start - 1)},0`
  return `${start},${count}`
}

function createUnifiedDiff(relPath: string, oldText: string, newText: string): string {
  if (oldText === newText) return ''

  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const contextBefore = Math.min(3, prefix)
  const oldChangedEnd = oldLines.length - suffix
  const newChangedEnd = newLines.length - suffix
  const contextAfter = Math.min(3, suffix)
  const oldHunkStartIndex = prefix - contextBefore
  const newHunkStartIndex = prefix - contextBefore
  const oldHunkEndIndex = oldChangedEnd + contextAfter
  const newHunkEndIndex = newChangedEnd + contextAfter

  const oldStartLine = oldHunkStartIndex + 1
  const newStartLine = newHunkStartIndex + 1
  const oldCount = oldHunkEndIndex - oldHunkStartIndex
  const newCount = newHunkEndIndex - newHunkStartIndex
  const lines = [`--- a/${relPath}`, `+++ b/${relPath}`]
  lines.push(`@@ -${hunkRange(oldStartLine, oldCount)} +${hunkRange(newStartLine, newCount)} @@`)

  for (let i = oldHunkStartIndex; i < prefix; i += 1) lines.push(` ${oldLines[i] ?? ''}`)
  for (let i = prefix; i < oldChangedEnd; i += 1) lines.push(`-${oldLines[i] ?? ''}`)
  for (let i = prefix; i < newChangedEnd; i += 1) lines.push(`+${newLines[i] ?? ''}`)
  for (let i = oldChangedEnd; i < oldHunkEndIndex; i += 1) lines.push(` ${oldLines[i] ?? ''}`)

  return `${lines.join('\n')}\n`
}

function buildWriteText(
  toolName: string,
  relPath: string,
  diff: string,
  token: string | null,
  sourceContextRefs: string[]
): string {
  if (!diff) return `No changes for ${relPath}.`
  if (!token) {
    return [
      `Applied ${toolName} to ${relPath}.`,
      `Rollback: apply the reverse diff shown in tool details or run git checkout -- ${relPath}.`,
      '',
      'Diff:',
      diff
    ].join('\n')
  }
  return [
    `Diff preview for ${toolName} on ${relPath}.`,
    `Preview token: ${token}`,
    'Call the same tool with confirm=true and this previewToken to apply.',
    `Source refs: ${sourceContextRefs.join(', ')}`,
    '',
    'Diff:',
    diff
  ].join('\n')
}

function writeFileAtomically(absPath: string, content: string): void {
  const dir = path.dirname(absPath)
  const temp = path.join(dir, `.xuanpu-agent-${process.pid}-${randomUUID()}.tmp`)
  fs.writeFileSync(temp, content, 'utf-8')
  fs.renameSync(temp, absPath)
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string
    timeoutMs: number
    longRunningMs?: number
    input?: string
    signal?: AbortSignal
    onLongRunning?: (elapsedMs: number) => void
  }
): Promise<ProcessResult> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let aborted = false

    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(longRunningTimer)
      options.signal?.removeEventListener('abort', abortHandler)
      const output = [stdout, stderr].filter((part) => part.length > 0).join('\n')
      resolve({
        stdout,
        stderr,
        output,
        exitCode,
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (!settled) child.kill('SIGKILL')
      }, 2_000).unref()
    }, options.timeoutMs)
    const longRunningTimer = setTimeout(() => {
      if (!settled) options.onLongRunning?.(Date.now() - startedAt)
    }, options.longRunningMs ?? 5_000)
    longRunningTimer.unref()

    const abortHandler = (): void => {
      aborted = true
      child.kill('SIGTERM')
    }
    options.signal?.addEventListener('abort', abortHandler, { once: true })

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
      if (Buffer.byteLength(stdout, 'utf-8') > MAX_COMMAND_OUTPUT_BYTES) {
        stdout = stdout.slice(0, MAX_COMMAND_OUTPUT_BYTES)
        child.kill('SIGTERM')
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
      if (Buffer.byteLength(stderr, 'utf-8') > MAX_COMMAND_OUTPUT_BYTES) {
        stderr = stderr.slice(0, MAX_COMMAND_OUTPUT_BYTES)
        child.kill('SIGTERM')
      }
    })
    child.on('error', (error) => {
      stderr += error instanceof Error ? error.message : String(error)
      finish(127)
    })
    child.on('close', (code, signal) => {
      finish(code ?? (signal ? 128 : 1))
    })

    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

function parseCommandString(command: string): string[] {
  if (/[;&|<>`$()]/.test(command)) {
    throw new Error('Shell metacharacters are not allowed. Pass argv tokens instead.')
  }
  const parts = command.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) throw new Error('command is required')
  return parts
}

function assertSafeArg(arg: string): void {
  if (arg.length === 0 || arg.length > 300) throw new Error(`Unsafe command arg: ${arg}`)
  if (/[;&|<>`$()]/.test(arg) || arg.includes('\0')) {
    throw new Error(`Shell metacharacters are not allowed in command arg: ${arg}`)
  }
  if (arg === '..' || arg.startsWith('../') || arg.includes('/../')) {
    throw new Error(`Path escape is not allowed in command arg: ${arg}`)
  }
}

function resolveTestCommand(params: RunTestParams): { command: string; args: string[] } {
  const tokens = params.args ?? (params.command ? parseCommandString(params.command) : [])
  if (tokens.length === 0) throw new Error('command or args is required')
  for (const token of tokens) assertSafeArg(token)

  const [bin, ...args] = tokens
  const command = bin ?? ''
  const isVitest = command === 'vitest' && args[0] === 'run'
  const isPnpmVitest =
    command === 'pnpm' &&
    ((args[0] === 'vitest' && args[1] === 'run') ||
      (args[0] === 'exec' && args[1] === 'vitest' && args[2] === 'run'))
  const isPnpmTest =
    command === 'pnpm' &&
    (args[0] === 'test' || (args[0] === 'run' && (args[1] === 'test' || args[1] === 'test:unit')))

  if (!isVitest && !isPnpmVitest && !isPnpmTest) {
    throw new Error(
      'run_test only allows focused test commands: vitest run, pnpm vitest run, pnpm exec vitest run, pnpm test, or pnpm run test.'
    )
  }

  return { command, args }
}

function extractPatchPaths(patchText: string): string[] {
  const paths = new Set<string>()
  for (const line of patchText.split('\n')) {
    const match =
      line.match(/^diff --git a\/(.+?) b\/(.+)$/) ?? line.match(/^(?:---|\+\+\+) (?:a|b)\/(.+)$/)
    if (!match) continue

    const candidates = match.length >= 3 ? [match[1], match[2]] : [match[1]]
    for (const candidate of candidates) {
      if (!candidate || candidate === '/dev/null') continue
      paths.add(candidate)
    }
  }
  return [...paths]
}

async function checkPatch(
  worktreePath: string,
  patchText: string,
  reverse: boolean
): Promise<ProcessResult> {
  return runProcess(
    'git',
    ['apply', '--check', '--whitespace=nowarn', ...(reverse ? ['--reverse'] : [])],
    {
      cwd: worktreePath,
      timeoutMs: 30_000,
      input: patchText
    }
  )
}

async function applyPatch(
  worktreePath: string,
  patchText: string,
  reverse: boolean
): Promise<ProcessResult> {
  return runProcess('git', ['apply', '--whitespace=nowarn', ...(reverse ? ['--reverse'] : [])], {
    cwd: worktreePath,
    timeoutMs: 30_000,
    input: patchText
  })
}

// ───────────────────────────────────────────────────────────────────────────
// write_file
// ───────────────────────────────────────────────────────────────────────────

interface WriteFileParams extends ConfirmableParams {
  path: string
  content: string
  createParentDirs?: boolean
}

const writeFileParams = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'content'],
  properties: {
    path: { type: 'string', description: 'File path relative to the worktree root' },
    content: { type: 'string', description: 'Complete new file content' },
    createParentDirs: {
      type: 'boolean',
      default: false,
      description: 'Create missing parent directories inside the worktree'
    },
    confirm: { type: 'boolean', default: false },
    previewToken: { type: 'string' },
    sourceContextRefs: { type: 'array', items: { type: 'string' } }
  }
} as unknown as JsonSchema<WriteFileParams>

export const writeFileTool: AgentTool<typeof writeFileParams> = {
  name: 'write_file',
  label: 'Write File',
  description:
    'Create or replace a file in the worktree through a diff-preview confirmation flow. ' +
    'First call returns a previewToken; call again with confirm=true and previewToken to apply.',
  parameters: writeFileParams,
  concurrency: 'exclusive',
  loadMode: 'essential',
  summary: 'Create or replace a worktree file with preview-token confirmation',
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const worktreePath = resolveWorktreePath(ctx)
    const details: ToolDetails = {
      command: `write_file ${params.path}`,
      cwd: worktreePath,
      path: params.path,
      operation: 'write'
    }
    try {
      const target = resolveWritablePath(worktreePath, params.path)
      if (!fs.existsSync(path.dirname(target.absPath))) {
        if (!params.createParentDirs) {
          return errorResult(
            `Parent directory does not exist: ${path.dirname(target.relPath)}`,
            details
          )
        }
        fs.mkdirSync(path.dirname(target.absPath), { recursive: true })
      }
      const oldText = fs.existsSync(target.absPath)
        ? ensureReadableTextFile(target.absPath, target.relPath)
        : ''
      const newText = params.content
      const diff = createUnifiedDiff(target.relPath, oldText, newText)
      const reverseDiff = createUnifiedDiff(target.relPath, newText, oldText)
      const sourceContextRefs = sourceRefsForPath(target.relPath, oldText, params)
      const digest = digestOperation({
        tool: 'write_file',
        path: target.relPath,
        oldHash: hashText(oldText),
        newHash: hashText(newText)
      })
      const validation = validatePreviewToken(ctx, params, digest)

      Object.assign(details, {
        path: target.relPath,
        sourceContextRefs,
        rollbackHint: `git checkout -- ${target.relPath}`,
        diff,
        reverseDiff,
        filesAffected: [target.relPath]
      })

      if (validation === 'preview-required') {
        const previewToken = createPreviewToken(ctx, digest)
        details.applied = false
        details.requiresConfirmation = true
        details.previewToken = previewToken
        return textResult(
          buildWriteText('write_file', target.relPath, diff, previewToken, sourceContextRefs),
          details
        )
      }
      if (validation) return errorResult(validation, details)
      if (!diff) {
        details.applied = false
        return textResult(`No changes for ${target.relPath}.`, details)
      }

      writeFileAtomically(target.absPath, newText)
      details.applied = true
      details.requiresConfirmation = false
      return textResult(
        buildWriteText('write_file', target.relPath, diff, null, sourceContextRefs),
        details
      )
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err), details)
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// edit_file
// ───────────────────────────────────────────────────────────────────────────

interface EditFileParams extends ConfirmableParams {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

const editFileParams = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'oldString', 'newString'],
  properties: {
    path: { type: 'string', description: 'File path relative to the worktree root' },
    oldString: { type: 'string', description: 'Exact text to replace' },
    newString: { type: 'string', description: 'Replacement text' },
    replaceAll: {
      type: 'boolean',
      default: false,
      description: 'Replace every exact match. Default requires exactly one match.'
    },
    confirm: { type: 'boolean', default: false },
    previewToken: { type: 'string' },
    sourceContextRefs: { type: 'array', items: { type: 'string' } }
  }
} as unknown as JsonSchema<EditFileParams>

export const editFileTool: AgentTool<typeof editFileParams> = {
  name: 'edit_file',
  label: 'Edit File',
  description:
    'Replace exact text in a worktree file through a diff-preview confirmation flow. ' +
    'The oldString must match exactly; repeated matches require replaceAll=true.',
  parameters: editFileParams,
  concurrency: 'exclusive',
  loadMode: 'essential',
  summary: 'Replace exact text in a file with preview-token confirmation',
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const worktreePath = resolveWorktreePath(ctx)
    const details: ToolDetails = {
      command: `edit_file ${params.path}`,
      cwd: worktreePath,
      path: params.path,
      operation: 'edit'
    }
    try {
      if (params.oldString.length === 0) return errorResult('oldString cannot be empty', details)
      const target = resolveWritablePath(worktreePath, params.path)
      const oldText = ensureReadableTextFile(target.absPath, target.relPath)
      const matches = oldText.split(params.oldString).length - 1
      if (matches === 0) return errorResult(`oldString not found in ${target.relPath}`, details)
      if (matches > 1 && !params.replaceAll) {
        return errorResult(
          `oldString matched ${matches} times in ${target.relPath}; set replaceAll=true to replace all matches.`,
          details
        )
      }

      const newText = params.replaceAll
        ? oldText.split(params.oldString).join(params.newString)
        : oldText.replace(params.oldString, params.newString)
      const diff = createUnifiedDiff(target.relPath, oldText, newText)
      const reverseDiff = createUnifiedDiff(target.relPath, newText, oldText)
      const sourceContextRefs = sourceRefsForPath(target.relPath, oldText, params)
      const digest = digestOperation({
        tool: 'edit_file',
        path: target.relPath,
        oldHash: hashText(oldText),
        newHash: hashText(newText),
        oldStringHash: hashText(params.oldString),
        newStringHash: hashText(params.newString),
        replaceAll: params.replaceAll === true
      })
      const validation = validatePreviewToken(ctx, params, digest)

      Object.assign(details, {
        path: target.relPath,
        sourceContextRefs,
        rollbackHint: `git checkout -- ${target.relPath}`,
        diff,
        reverseDiff,
        filesAffected: [target.relPath]
      })

      if (validation === 'preview-required') {
        const previewToken = createPreviewToken(ctx, digest)
        details.applied = false
        details.requiresConfirmation = true
        details.previewToken = previewToken
        return textResult(
          buildWriteText('edit_file', target.relPath, diff, previewToken, sourceContextRefs),
          details
        )
      }
      if (validation) return errorResult(validation, details)

      writeFileAtomically(target.absPath, newText)
      details.applied = true
      details.requiresConfirmation = false
      return textResult(
        buildWriteText('edit_file', target.relPath, diff, null, sourceContextRefs),
        details
      )
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err), details)
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// apply_patch
// ───────────────────────────────────────────────────────────────────────────

interface ApplyPatchParams extends ConfirmableParams {
  patch: string
  reverse?: boolean
}

const applyPatchParams = {
  type: 'object',
  additionalProperties: false,
  required: ['patch'],
  properties: {
    patch: { type: 'string', description: 'Unified patch to apply from the worktree root' },
    reverse: { type: 'boolean', default: false, description: 'Apply the patch in reverse' },
    confirm: { type: 'boolean', default: false },
    previewToken: { type: 'string' },
    sourceContextRefs: { type: 'array', items: { type: 'string' } }
  }
} as unknown as JsonSchema<ApplyPatchParams>

export const applyPatchTool: AgentTool<typeof applyPatchParams> = {
  name: 'apply_patch',
  label: 'Apply Patch',
  description:
    'Apply a unified patch to the worktree after git apply --check and preview-token confirmation.',
  parameters: applyPatchParams,
  concurrency: 'exclusive',
  loadMode: 'essential',
  summary: 'Apply a unified patch with git apply --check and preview-token confirmation',
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const worktreePath = resolveWorktreePath(ctx)
    const details: ToolDetails = {
      command: `git apply${params.reverse ? ' --reverse' : ''}`,
      cwd: worktreePath,
      operation: 'patch'
    }
    try {
      if (Buffer.byteLength(params.patch, 'utf-8') > MAX_PATCH_BYTES) {
        return errorResult('Patch too large (max 256 KiB)', details)
      }
      const paths = extractPatchPaths(params.patch)
      if (paths.length === 0) return errorResult('Patch contains no file paths', details)
      const resolved = paths.map((patchPath) => resolveWritablePath(worktreePath, patchPath))
      const relPaths = [...new Set(resolved.map((item) => item.relPath))]
      const sourceContextRefs = [
        ...(params.sourceContextRefs ?? []),
        ...relPaths.map((relPath) => {
          const absPath = path.join(worktreePath, relPath)
          const oldText = fs.existsSync(absPath) ? ensureReadableTextFile(absPath, relPath) : ''
          return `file:${relPath}@sha256:${hashText(oldText).slice(0, 16)}`
        })
      ]
      const sourceHashes = relPaths.map((relPath) => {
        const absPath = path.join(worktreePath, relPath)
        const oldText = fs.existsSync(absPath) ? ensureReadableTextFile(absPath, relPath) : ''
        return { path: relPath, hash: hashText(oldText) }
      })
      const digest = digestOperation({
        tool: 'apply_patch',
        patchHash: hashText(params.patch),
        reverse: params.reverse === true,
        sourceHashes
      })
      Object.assign(details, {
        paths: relPaths,
        sourceContextRefs,
        rollbackHint: `apply_patch with reverse=${params.reverse ? 'false' : 'true'} and the same patch`,
        diff: params.patch,
        filesAffected: relPaths
      })

      const check = await checkPatch(worktreePath, params.patch, params.reverse === true)
      Object.assign(details, {
        exitCode: check.exitCode,
        durationMs: check.durationMs,
        timedOut: check.timedOut,
        aborted: check.aborted
      })
      if (check.exitCode !== 0) {
        return errorResult(`git apply --check failed:\n${check.output || '(no output)'}`, details)
      }

      const validation = validatePreviewToken(ctx, params, digest)
      if (validation === 'preview-required') {
        const previewToken = createPreviewToken(ctx, digest)
        details.applied = false
        details.requiresConfirmation = true
        details.previewToken = previewToken
        return textResult(
          [
            `Patch preview for ${relPaths.join(', ')}.`,
            `Preview token: ${previewToken}`,
            'Call apply_patch with confirm=true and this previewToken to apply.',
            `Source refs: ${sourceContextRefs.join(', ')}`,
            '',
            params.patch
          ].join('\n'),
          details
        )
      }
      if (validation) return errorResult(validation, details)

      const applied = await applyPatch(worktreePath, params.patch, params.reverse === true)
      Object.assign(details, {
        exitCode: applied.exitCode,
        durationMs: applied.durationMs,
        timedOut: applied.timedOut,
        aborted: applied.aborted,
        applied: applied.exitCode === 0,
        requiresConfirmation: false
      })
      if (applied.exitCode !== 0) {
        return errorResult(`git apply failed:\n${applied.output || '(no output)'}`, details)
      }

      return textResult(
        [
          `Applied patch to ${relPaths.join(', ')}.`,
          `Rollback: ${details.rollbackHint}.`,
          '',
          params.patch
        ].join('\n'),
        details
      )
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err), details)
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// run_test
// ───────────────────────────────────────────────────────────────────────────

interface RunTestParams {
  command?: string
  args?: string[]
  timeoutMs?: number
  longRunningMs?: number
}

const runTestParams = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: {
      type: 'string',
      description: 'Focused test command, e.g. "pnpm vitest run test/foo.test.ts"'
    },
    args: {
      type: 'array',
      items: { type: 'string' },
      description: 'Command argv tokens. Prefer this when paths contain spaces.'
    },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, default: 60000 },
    longRunningMs: {
      type: 'integer',
      minimum: 100,
      maximum: 60000,
      default: 5000,
      description: 'Emit a supervision update when the command runs longer than this threshold.'
    }
  }
} as unknown as JsonSchema<RunTestParams>

export const runTestTool: AgentTool<typeof runTestParams> = {
  name: 'run_test',
  label: 'Run Test',
  description:
    'Run a focused test command from a strict allowlist. Output is archived and compressed before it re-enters the model.',
  parameters: runTestParams,
  concurrency: 'exclusive',
  loadMode: 'essential',
  summary: 'Run a focused vitest/pnpm test command with compressed output',
  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    const worktreePath = resolveWorktreePath(ctx)
    try {
      const { command, args } = resolveTestCommand(params)
      const displayCommand = formatCommand(command, args)
      const longRunningThresholdMs = Math.max(
        100,
        Math.min(params.longRunningMs ?? 5_000, 60_000)
      )
      const details: ToolDetails = {
        command: displayCommand,
        cwd: worktreePath,
        operation: 'test',
        supervision: {
          longRunningThresholdMs,
          notifiedAtMs: null
        }
      }
      const result = await runProcess(command, args, {
        cwd: worktreePath,
        timeoutMs: Math.max(1000, Math.min(params.timeoutMs ?? 60_000, 120_000)),
        longRunningMs: longRunningThresholdMs,
        signal,
        onLongRunning: (elapsedMs) => {
          details.longRunning = true
          details.supervision = {
            longRunningThresholdMs,
            notifiedAtMs: elapsedMs
          }
          onUpdate?.({
            content: [
              {
                type: 'text',
                text: `Command still running after ${elapsedMs}ms: ${displayCommand}`
              }
            ],
            details: {
              ...details,
              durationMs: elapsedMs
            }
          })
        }
      })
      Object.assign(details, {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        aborted: result.aborted
      })
      const header = [
        `Command: ${displayCommand}`,
        `Exit code: ${result.exitCode}`,
        `Duration: ${result.durationMs}ms`,
        result.timedOut ? 'Timed out: true' : null,
        result.aborted ? 'Aborted: true' : null
      ]
        .filter(Boolean)
        .join('\n')
      const output = result.output.trim() || '(no output)'
      return {
        content: [{ type: 'text', text: `${header}\n\n${output}` }],
        details,
        isError: result.exitCode !== 0 || result.timedOut || result.aborted
      }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err), {
        command: params.command ?? (params.args ? params.args.join(' ') : 'run_test'),
        cwd: worktreePath,
        operation: 'test'
      })
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// format_file
// ───────────────────────────────────────────────────────────────────────────

interface FormatFileParams extends ConfirmableParams {
  path: string
}

const formatFileParams = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string', description: 'File path relative to the worktree root' },
    confirm: { type: 'boolean', default: false },
    previewToken: { type: 'string' },
    sourceContextRefs: { type: 'array', items: { type: 'string' } }
  }
} as unknown as JsonSchema<FormatFileParams>

export const formatFileTool: AgentTool<typeof formatFileParams> = {
  name: 'format_file',
  label: 'Format File',
  description:
    'Format one worktree file with project prettier through a diff-preview confirmation flow.',
  parameters: formatFileParams,
  concurrency: 'exclusive',
  loadMode: 'essential',
  summary: 'Format one file with prettier and preview-token confirmation',
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const worktreePath = resolveWorktreePath(ctx)
    const details: ToolDetails = {
      command: `pnpm exec prettier --stdin-filepath ${params.path}`,
      cwd: worktreePath,
      path: params.path,
      operation: 'format'
    }
    try {
      const target = resolveWritablePath(worktreePath, params.path)
      const oldText = ensureReadableTextFile(target.absPath, target.relPath)
      const formatted = await runProcess(
        'pnpm',
        ['exec', 'prettier', '--stdin-filepath', target.relPath],
        {
          cwd: worktreePath,
          timeoutMs: 30_000,
          input: oldText,
          signal
        }
      )
      Object.assign(details, {
        exitCode: formatted.exitCode,
        durationMs: formatted.durationMs,
        timedOut: formatted.timedOut,
        aborted: formatted.aborted
      })
      if (formatted.exitCode !== 0) {
        return errorResult(`prettier failed:\n${formatted.output || '(no output)'}`, details)
      }

      const newText = formatted.stdout
      const diff = createUnifiedDiff(target.relPath, oldText, newText)
      const reverseDiff = createUnifiedDiff(target.relPath, newText, oldText)
      const sourceContextRefs = sourceRefsForPath(target.relPath, oldText, params)
      const digest = digestOperation({
        tool: 'format_file',
        path: target.relPath,
        oldHash: hashText(oldText),
        newHash: hashText(newText)
      })
      Object.assign(details, {
        path: target.relPath,
        sourceContextRefs,
        rollbackHint: `git checkout -- ${target.relPath}`,
        diff,
        reverseDiff,
        filesAffected: [target.relPath]
      })

      if (!diff) {
        details.applied = false
        return textResult(`No formatting changes for ${target.relPath}.`, details)
      }

      const validation = validatePreviewToken(ctx, params, digest)
      if (validation === 'preview-required') {
        const previewToken = createPreviewToken(ctx, digest)
        details.applied = false
        details.requiresConfirmation = true
        details.previewToken = previewToken
        return textResult(
          buildWriteText('format_file', target.relPath, diff, previewToken, sourceContextRefs),
          details
        )
      }
      if (validation) return errorResult(validation, details)

      writeFileAtomically(target.absPath, newText)
      details.applied = true
      details.requiresConfirmation = false
      return textResult(
        buildWriteText('format_file', target.relPath, diff, null, sourceContextRefs),
        details
      )
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err), details)
    }
  }
}

export const CONTROLLED_WRITE_TOOLS: AgentTool[] = [
  applyPatchTool,
  writeFileTool,
  editFileTool,
  runTestTool,
  formatFileTool
]

export const __TEST_WRITE_TOOL_INTERNALS = {
  createUnifiedDiff,
  extractPatchPaths,
  resolveWritablePath
}
