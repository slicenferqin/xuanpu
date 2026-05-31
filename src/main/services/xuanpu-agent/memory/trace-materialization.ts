import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

import type { XfpWorkflowParameter } from '../xfp/types'

export interface TraceMaterializationTrace {
  id: string
  sessionId?: string | null
  worktreeId?: string | null
  command: string
  exitCode?: number | null
  category?: string | null
  createdAt?: string | number | null
}

export interface TraceMaterializationCandidate {
  signature: string
  normalizedCommand: string
  occurrenceCount: number
  traceIds: string[]
  sessionIds: string[]
  worktreeIds: string[]
  categories: string[]
  successCount: number
  failureCount: number
}

export interface TraceMaterializationOptions {
  minOccurrences?: number
  maxCandidates?: number
}

export interface TraceWorkflowTemplateStep {
  id: string
  kind: 'command'
  signature: string
  commandTemplate: string
  parameters: XfpWorkflowParameter[]
  categories: string[]
  expectedExitCode: number | null
}

export interface TraceWorkflowTemplate {
  schemaVersion: 1
  id: string
  slug: string
  title: string
  materializedAt: string
  projectId: string | null
  worktreeId: string | null
  signature: string
  occurrenceCount: number
  successCount: number
  failureCount: number
  successRate: number | null
  sourceTraceIds: string[]
  retrievalHints: string[]
  steps: TraceWorkflowTemplateStep[]
}

export interface MaterializedTraceWorkflow {
  candidate: TraceMaterializationCandidate
  template: TraceWorkflowTemplate
  filePath: string
  relativePath: string
  status: 'created' | 'updated' | 'unchanged'
}

export interface RetrievedTraceWorkflow {
  template: TraceWorkflowTemplate
  filePath: string
  relativePath: string
  retrievalReason: string
  score: number
}

export function detectFrequentTraceCandidates(
  traces: TraceMaterializationTrace[],
  options: TraceMaterializationOptions = {}
): TraceMaterializationCandidate[] {
  const minOccurrences = options.minOccurrences ?? 3
  const maxCandidates = options.maxCandidates ?? 10
  const groups = new Map<string, TraceMaterializationTrace[]>()

  for (const trace of traces) {
    const normalizedCommand = normalizeCommand(trace.command)
    if (!normalizedCommand) continue
    const signature = commandSignature(normalizedCommand)
    groups.set(signature, [...(groups.get(signature) ?? []), trace])
  }

  return Array.from(groups.entries())
    .map(([signature, group]) => buildCandidate(signature, group))
    .filter((candidate) => candidate.occurrenceCount >= minOccurrences)
    .sort((left, right) => {
      if (right.occurrenceCount !== left.occurrenceCount) {
        return right.occurrenceCount - left.occurrenceCount
      }
      return right.traceIds.length - left.traceIds.length
    })
    .slice(0, maxCandidates)
}

export function materializeTraceWorkflowTemplates(input: {
  worktreePath: string
  projectId?: string | null
  worktreeId?: string | null
  candidates: TraceMaterializationCandidate[]
  now?: Date
}): MaterializedTraceWorkflow[] {
  if (input.candidates.length === 0) return []

  const workflowDir = resolveWorkflowDir(input.worktreePath, true)

  return input.candidates.map((candidate) =>
    materializeTraceWorkflowTemplate({
      ...input,
      workflowDir,
      candidate
    })
  )
}

export function materializeTraceWorkflowTemplate(input: {
  worktreePath: string
  workflowDir?: string
  projectId?: string | null
  worktreeId?: string | null
  candidate: TraceMaterializationCandidate
  now?: Date
}): MaterializedTraceWorkflow {
  const workflowDir = input.workflowDir ?? resolveWorkflowDir(input.worktreePath, true)

  const template = buildTraceWorkflowTemplate({
    candidate: input.candidate,
    projectId: input.projectId ?? null,
    worktreeId: input.worktreeId ?? null,
    now: input.now
  })
  const relativePath = path.posix.join('.agent', 'workflows', `${template.slug}.json`)
  const filePath = path.join(workflowDir, `${template.slug}.json`)

  const existing = readWorkflowTemplate(filePath)
  if (existing && sameWorkflowTemplateIdentity(existing, template)) {
    return {
      candidate: input.candidate,
      template: existing,
      filePath,
      relativePath,
      status: 'unchanged'
    }
  }

  writeWorkflowTemplate(filePath, template)
  return {
    candidate: input.candidate,
    template,
    filePath,
    relativePath,
    status: existing ? 'updated' : 'created'
  }
}

export function buildTraceWorkflowTemplate(input: {
  candidate: TraceMaterializationCandidate
  projectId?: string | null
  worktreeId?: string | null
  now?: Date
}): TraceWorkflowTemplate {
  const parameterized = parameterizeCommand(input.candidate.signature)
  const slug = slugForSignature(input.candidate.signature)
  const successRate =
    input.candidate.successCount + input.candidate.failureCount > 0
      ? input.candidate.successCount /
        (input.candidate.successCount + input.candidate.failureCount)
      : null

  return {
    schemaVersion: 1,
    id: `trace-workflow:${hashStable(input.candidate.signature).slice(0, 12)}`,
    slug,
    title: titleForSignature(input.candidate.signature),
    materializedAt: (input.now ?? new Date()).toISOString(),
    projectId: input.projectId ?? null,
    worktreeId: input.worktreeId ?? null,
    signature: input.candidate.signature,
    occurrenceCount: input.candidate.occurrenceCount,
    successCount: input.candidate.successCount,
    failureCount: input.candidate.failureCount,
    successRate,
    sourceTraceIds: input.candidate.traceIds,
    retrievalHints: buildRetrievalHints(input.candidate),
    steps: [
      {
        id: 'command-1',
        kind: 'command',
        signature: input.candidate.signature,
        commandTemplate: parameterized.commandTemplate,
        parameters: parameterized.parameters,
        categories: input.candidate.categories,
        expectedExitCode: input.candidate.failureCount === 0 ? 0 : null
      }
    ]
  }
}

export function loadTraceWorkflowTemplates(worktreePath: string): RetrievedTraceWorkflow[] {
  const workflowDir = resolveWorkflowDir(worktreePath, false)
  if (!workflowDir) return []
  if (!fs.existsSync(workflowDir)) return []

  return fs
    .readdirSync(workflowDir)
    .filter((name) => name.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right))
    .flatMap((name) => {
      const filePath = path.join(workflowDir, name)
      const template = readWorkflowTemplate(filePath)
      if (!template) return []
      return [
        {
          template,
          filePath,
          relativePath: path.posix.join('.agent', 'workflows', name),
          retrievalReason: 'available materialized workflow',
          score: 0
        }
      ]
    })
}

export function retrieveTraceWorkflowsForContext(input: {
  userText: string
  workflows: RetrievedTraceWorkflow[]
  maxEntries?: number
}): RetrievedTraceWorkflow[] {
  const terms = tokenize(input.userText)
  if (terms.size === 0) return []
  const maxEntries = Math.max(1, Math.min(input.maxEntries ?? 3, 5))

  return input.workflows
    .map((workflow) => scoreWorkflow(workflow, terms))
    .filter((workflow) => workflow.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return right.template.occurrenceCount - left.template.occurrenceCount
    })
    .slice(0, maxEntries)
}

export function normalizeCommand(command: string): string {
  return command
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/(["'])[^"']+\1/g, '$1{value}$1')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '{sha}')
    .replace(/\b\d+\b/g, '{number}')
    .replace(
      /(?:^|\s)([\w@./-]+\.(?:ts|tsx|js|jsx|json|md|css|sql|yaml|yml|toml|rs|go|py|java|kt|swift|mjs|cjs|html|scss))/g,
      ' {path}'
    )
    .replace(/\s+/g, ' ')
    .trim()
}

function commandSignature(normalizedCommand: string): string {
  return normalizedCommand
    .split(' ')
    .map((part, index) => {
      if (index <= 1) return part
      if (part.startsWith('-')) return part.replace(/=.*/, '={value}')
      if (part === '{path}' || part === '{number}' || part === '{sha}') return part
      return part.includes('/') ? '{path}' : part
    })
    .join(' ')
}

function buildCandidate(
  signature: string,
  group: TraceMaterializationTrace[]
): TraceMaterializationCandidate {
  return {
    signature,
    normalizedCommand: normalizeCommand(group[0]?.command ?? ''),
    occurrenceCount: group.length,
    traceIds: unique(group.map((trace) => trace.id)),
    sessionIds: unique(group.map((trace) => trace.sessionId ?? null)),
    worktreeIds: unique(group.map((trace) => trace.worktreeId ?? null)),
    categories: unique(group.map((trace) => trace.category ?? null)),
    successCount: group.filter((trace) => trace.exitCode === 0).length,
    failureCount: group.filter(
      (trace) => typeof trace.exitCode === 'number' && trace.exitCode !== 0
    ).length
  }
}

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))))
}

function resolveWorkflowDir(worktreePath: string, create: true): string
function resolveWorkflowDir(worktreePath: string, create: false): string | null
function resolveWorkflowDir(worktreePath: string, create: boolean): string | null {
  const root = fs.realpathSync(path.resolve(worktreePath))
  const agentDir = path.join(root, '.agent')
  const workflowDir = path.join(agentDir, 'workflows')

  if (fs.existsSync(agentDir) && fs.lstatSync(agentDir).isSymbolicLink()) {
    throw new Error('.agent is a symlink; refusing to materialize workflows outside worktree')
  }
  if (fs.existsSync(workflowDir) && fs.lstatSync(workflowDir).isSymbolicLink()) {
    throw new Error('.agent/workflows is a symlink; refusing to materialize workflows outside worktree')
  }
  if (!fs.existsSync(workflowDir)) {
    if (!create) return null
    fs.mkdirSync(workflowDir, { recursive: true })
  }

  const realWorkflowDir = fs.realpathSync(workflowDir)
  if (realWorkflowDir !== root && !realWorkflowDir.startsWith(root + path.sep)) {
    throw new Error('.agent/workflows resolves outside worktree')
  }
  return realWorkflowDir
}

function parameterizeCommand(signature: string): {
  commandTemplate: string
  parameters: XfpWorkflowParameter[]
} {
  let pathCount = 0
  let numberCount = 0
  let shaCount = 0
  let valueCount = 0
  const parameters: XfpWorkflowParameter[] = []
  const commandTemplate = signature.replace(/\{(path|number|sha|value)\}/g, (_match, kind) => {
    const name =
      kind === 'path'
        ? `path${++pathCount}`
        : kind === 'number'
          ? `number${++numberCount}`
          : kind === 'sha'
            ? `sha${++shaCount}`
            : `value${++valueCount}`
    parameters.push({ name, kind, example: exampleForKind(kind) })
    return `{{${name}}}`
  })

  return { commandTemplate, parameters }
}

function exampleForKind(kind: XfpWorkflowParameter['kind']): string | null {
  switch (kind) {
    case 'path':
      return 'test/example.test.ts'
    case 'number':
      return '1'
    case 'sha':
      return 'abcdef1'
    case 'value':
      return null
  }
}

function titleForSignature(signature: string): string {
  const withoutPlaceholders = signature.replace(/\{(?:path|number|sha|value)\}/g, '').trim()
  const words = withoutPlaceholders.split(/\s+/).filter(Boolean).slice(0, 5)
  return words.length > 0 ? `Workflow: ${words.join(' ')}` : 'Workflow: command trace'
}

function slugForSignature(signature: string): string {
  const base =
    signature
      .toLowerCase()
      .replace(/\{(?:path|number|sha|value)\}/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'workflow'
  return `${base}-${hashStable(signature).slice(0, 8)}`
}

function buildRetrievalHints(candidate: TraceMaterializationCandidate): string[] {
  return unique([
    ...tokenize(candidate.signature),
    ...candidate.categories,
    candidate.successCount > 0 ? 'successful-command-path' : null
  ]).slice(0, 16)
}

function scoreWorkflow(
  workflow: RetrievedTraceWorkflow,
  userTerms: Set<string>
): RetrievedTraceWorkflow {
  const haystackTerms = new Set([
    ...tokenize(workflow.template.signature),
    ...tokenize(workflow.template.title),
    ...workflow.template.retrievalHints.flatMap((hint) => [...tokenize(hint)])
  ])

  const matches = [...userTerms].filter((term) => haystackTerms.has(term))
  const categoryBoost =
    userTerms.has('test') && haystackTerms.has('vitest')
      ? 2
      : userTerms.has('lint') && haystackTerms.has('lint')
        ? 2
        : 0
  const score = matches.length + categoryBoost
  return {
    ...workflow,
    score,
    retrievalReason:
      score > 0
        ? `matched workflow hints: ${matches.slice(0, 5).join(', ') || 'category'}`
        : workflow.retrievalReason
  }
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_.-]+/)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2)
      .flatMap((token) => {
        const parts = token.split(/[_.-]+/).filter((part) => part.length >= 2)
        return [token, ...parts]
      })
  )
}

function readWorkflowTemplate(filePath: string): TraceWorkflowTemplate | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<TraceWorkflowTemplate>
    if (parsed.schemaVersion !== 1) return null
    if (!parsed.id || !parsed.slug || !parsed.signature || !Array.isArray(parsed.steps)) return null
    return parsed as TraceWorkflowTemplate
  } catch {
    return null
  }
}

function sameWorkflowTemplateIdentity(
  left: TraceWorkflowTemplate,
  right: TraceWorkflowTemplate
): boolean {
  return (
    left.signature === right.signature &&
    left.occurrenceCount === right.occurrenceCount &&
    left.successCount === right.successCount &&
    left.failureCount === right.failureCount &&
    JSON.stringify(left.sourceTraceIds) === JSON.stringify(right.sourceTraceIds) &&
    JSON.stringify(left.steps) === JSON.stringify(right.steps)
  )
}

function writeWorkflowTemplate(filePath: string, template: TraceWorkflowTemplate): void {
  fs.writeFileSync(filePath, `${JSON.stringify(template, null, 2)}\n`, 'utf-8')
}

function hashStable(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
