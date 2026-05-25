import type { Session, Worktree } from '../../../db/types'
import { XfpFieldPacketSchema } from '../xfp/schema'
import type {
  XfpAnchorSection,
  XfpBudgetProfile,
  XfpCommandTraceSection,
  XfpFieldPacket,
  XfpFocusSection,
  XfpGitState,
  XfpTerminalSummary,
  XfpTestSummary
} from '../xfp/types'
import { ContextBudgetRecorder } from './budget'

export interface CompileOptions {
  now?: number
  turnId?: string
  packetId?: string
  budgetProfile?: XfpBudgetProfile
  budgetTokens?: number
  estimatedTokens?: number
  compressionRatio?: number | null
  rawPacketRef?: string
  gitState: XfpGitState
  focus?: XfpFocusSection
  terminal?: XfpTerminalSummary | null
  tests?: XfpTestSummary | null
  commandTrace?: XfpCommandTraceSection | null
  anchor?: XfpAnchorSection | null
  includedSections?: readonly string[]
  omittedSections?: readonly CompilerOmission[]
  successCriteria?: string | null
}

export interface CompilerOmission {
  readonly name: string
  readonly reason: string
}

export interface CompilerDecision {
  readonly includedSections: readonly string[]
  readonly omittedSections: readonly CompilerOmission[]
  readonly estimatedTokens: number
  readonly budgetProfile: XfpBudgetProfile
}

export interface CompileResult {
  readonly packet: XfpFieldPacket
  readonly decisions: CompilerDecision
}

export class XfpPacketCompiler {
  constructor(private readonly budgetRecorder = new ContextBudgetRecorder()) {}

  compile(
    worktree: Worktree,
    session: Session,
    userMessage: string,
    options: CompileOptions
  ): CompileResult {
    const now = options.now ?? Date.now()
    const packetId = options.packetId ?? createPacketId(now)
    const budgetProfile = options.budgetProfile ?? 'balanced'
    const anchor = options.anchor ?? buildAnchor(worktree, now)
    const omittedSections = options.omittedSections ?? defaultOmittedSections(options, anchor)
    const includedSections = options.includedSections ?? defaultIncludedSections(options, anchor)
    const estimatedTokens = options.estimatedTokens ?? estimateTokens(userMessage, options)
    const rawPacketRef = options.rawPacketRef ?? `xfp-packet:${packetId}`

    const packet = deepFreeze(
      XfpFieldPacketSchema.parse({
        version: 1,
        identity: {
          packetId,
          capturedAt: now,
          projectId: session.project_id,
          worktreeId: worktree.id,
          sessionId: session.id
        },
        anchor,
        gitState: options.gitState,
        focus: options.focus ?? { file: null, selection: null, rawRefs: [] },
        terminal: options.terminal ?? null,
        tests: options.tests ?? null,
        commandTrace: options.commandTrace ?? null,
        currentGoal: {
          objective: userMessage.trim(),
          source: 'user-message',
          successCriteria: options.successCriteria ?? null,
          rawRefs: [{ kind: 'message', id: `session:${session.id}:current-user-message` }]
        },
        budget: {
          profile: budgetProfile,
          budgetTokens: options.budgetTokens ?? defaultBudgetTokens(budgetProfile),
          estimatedTokens,
          omittedSectionNames: omittedSections.map((section) => section.name),
          compressionRatio: options.compressionRatio ?? null
        }
      })
    )

    const decisions: CompilerDecision = deepFreeze({
      includedSections,
      omittedSections,
      estimatedTokens,
      budgetProfile
    })

    this.budgetRecorder.recordTurn({
      turnId: options.turnId ?? packetId,
      capturedAt: now,
      sessionId: session.id,
      runtime: 'xuanpu-agent',
      packetId,
      budgetProfile,
      includedSections,
      omittedSections: omittedSections.map((section) => section.name),
      estimatedTokens,
      compressionRatio: packet.budget.compressionRatio,
      rawPacketRef
    })

    return { packet, decisions }
  }

  getBudgetRecorder(): ContextBudgetRecorder {
    return this.budgetRecorder
  }
}

function buildAnchor(worktree: Worktree, now: number): XfpAnchorSection | null {
  const worktreeNotesMarkdown = worktree.context?.trim() || null
  if (!worktreeNotesMarkdown) return null

  return {
    pinnedFactsMarkdown: null,
    worktreeNotesMarkdown,
    updatedAt: now,
    rawRefs: [{ kind: 'memory-page', id: `worktree:${worktree.id}:context` }]
  }
}

function defaultIncludedSections(
  options: CompileOptions,
  anchor: XfpAnchorSection | null
): readonly string[] {
  return [
    'identity',
    anchor ? 'anchor' : null,
    'gitState',
    'focus',
    options.terminal ? 'terminal' : null,
    options.tests ? 'tests' : null,
    options.commandTrace ? 'commandTrace' : null,
    'currentGoal',
    'budget'
  ].filter((section): section is string => Boolean(section))
}

function defaultOmittedSections(
  options: CompileOptions,
  anchor: XfpAnchorSection | null
): readonly CompilerOmission[] {
  const omitted: CompilerOmission[] = []
  if (!anchor) omitted.push({ name: 'anchor', reason: 'not provided' })
  if (!options.terminal) omitted.push({ name: 'terminal', reason: 'not provided' })
  if (!options.tests) omitted.push({ name: 'tests', reason: 'not provided' })
  if (!options.commandTrace) omitted.push({ name: 'commandTrace', reason: 'not provided' })
  return omitted
}

function defaultBudgetTokens(profile: XfpBudgetProfile): number {
  switch (profile) {
    case 'focused':
      return 20000
    case 'balanced':
      return 80000
    case 'extended':
      return 160000
    case 'max':
      return 300000
  }
}

function estimateTokens(userMessage: string, options: CompileOptions): number {
  return Math.ceil(
    [
      userMessage,
      JSON.stringify(options.gitState),
      JSON.stringify(options.focus ?? {}),
      JSON.stringify(options.anchor ?? {}),
      JSON.stringify(options.terminal ?? {}),
      JSON.stringify(options.tests ?? {}),
      JSON.stringify(options.commandTrace ?? {})
    ].join('\n').length / 4
  )
}

function createPacketId(now: number): string {
  return `xfp-${now}-${Math.random().toString(36).slice(2, 10)}`
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value

  for (const child of Object.values(value)) {
    deepFreeze(child)
  }

  return Object.freeze(value)
}
