import type {
  FieldMemoryPageRecord,
  FieldMemoryRetrievedPage
} from '../../../../shared/types/field-memory'

export interface XuanpuAgentMemoryRetrievalInput {
  userText: string
  pages: FieldMemoryPageRecord[]
  currentSessionId?: string | null
  maxPages?: number
  maxTokens?: number
}

export interface XuanpuAgentMemoryRetrievalScore {
  id: string
  score: number
  retrievalReason: string
  tokenEstimate: number
}

export interface XuanpuAgentMemoryRetrievalResult {
  included: FieldMemoryRetrievedPage[]
  decisions: {
    policy: 'deterministic-memory-page-retrieval'
    triggered: boolean
    triggers: string[]
    candidateCount: number
    includedIds: string[]
    droppedCount: number
    maxPages: number
    maxTokens: number
    scores: XuanpuAgentMemoryRetrievalScore[]
  }
}

const DEFAULT_MAX_PAGES = 5
const DEFAULT_MAX_TOKENS = 4_000

const HISTORICAL_REFERENCE_PATTERN =
  /\b(before|last time|earlier|previous|previously|that plan|that change|last run|history|continue|resume)\b|之前|上次|刚才|前面|历史|继续|接着|上一次|那个方案|那份计划/iu
const ERROR_SIGNAL_PATTERN =
  /\b(error|failed|failure|exception|timeout|crash|stack|trace|enoent|eacces|typeerror|referenceerror)\b|失败|报错|错误|异常/iu
const CONSTRAINT_SIGNAL_PATTERN =
  /\b(must|never|do not|should|require|requires|required|constraint|avoid|keep|always)\b|必须|不要|不能|需要|保持|避免|约束|注意/iu
const DECISION_SIGNAL_PATTERN =
  /\b(decision|decide|decided|plan|approach|chosen|use instead)\b|决定|结论|方案|采用|改用/iu

export function selectRetrievedMemoryForContext(
  input: XuanpuAgentMemoryRetrievalInput
): XuanpuAgentMemoryRetrievalResult {
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS
  const userText = input.userText.trim()
  const files = extractFiles(userText)
  const commands = extractCommands(userText)
  const hasHistoricalReference = HISTORICAL_REFERENCE_PATTERN.test(userText)
  const hasErrorSignal = ERROR_SIGNAL_PATTERN.test(userText)
  const hasConstraintSignal = CONSTRAINT_SIGNAL_PATTERN.test(userText)
  const hasDecisionSignal = DECISION_SIGNAL_PATTERN.test(userText)
  const triggers = unique([
    files.length > 0 ? 'path_match_query' : null,
    commands.length > 0 ? 'command_match_query' : null,
    hasHistoricalReference ? 'historical_reference' : null,
    hasErrorSignal ? 'error_signal' : null,
    hasConstraintSignal ? 'constraint_signal' : null,
    hasDecisionSignal ? 'decision_signal' : null
  ])

  const scored = input.pages
    .filter((page) => page.status === 'accepted')
    .map((page) =>
      scorePage(page, {
        userText,
        files,
        commands,
        hasHistoricalReference,
        hasErrorSignal,
        hasConstraintSignal,
        hasDecisionSignal,
        currentSessionId: input.currentSessionId ?? null
      })
    )
    .filter((item) => item.score > 0 && item.reasons.length > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.page.updatedAt - a.page.updatedAt
    })

  const included: FieldMemoryRetrievedPage[] = []
  let usedTokens = 0
  for (const item of scored) {
    if (included.length >= maxPages) break
    const tokenEstimate = estimateTokens(item.page)
    if (included.length > 0 && usedTokens + tokenEstimate > maxTokens) continue
    if (included.length === 0 || usedTokens + tokenEstimate <= maxTokens) {
      included.push({
        page: item.page,
        retrievalReason: item.reasons.join('; '),
        score: item.score
      })
      usedTokens += tokenEstimate
    }
  }

  return {
    included,
    decisions: {
      policy: 'deterministic-memory-page-retrieval',
      triggered: triggers.length > 0,
      triggers,
      candidateCount: input.pages.length,
      includedIds: included.map((item) => item.page.id),
      droppedCount: Math.max(0, scored.length - included.length),
      maxPages,
      maxTokens,
      scores: scored.slice(0, 20).map((item) => ({
        id: item.page.id,
        score: item.score,
        retrievalReason: item.reasons.join('; '),
        tokenEstimate: estimateTokens(item.page)
      }))
    }
  }
}

function scorePage(
  page: FieldMemoryPageRecord,
  context: {
    userText: string
    files: string[]
    commands: string[]
    hasHistoricalReference: boolean
    hasErrorSignal: boolean
    hasConstraintSignal: boolean
    hasDecisionSignal: boolean
    currentSessionId: string | null
  }
): { page: FieldMemoryPageRecord; score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []
  const pageText = normalizeText(
    [
      page.title,
      page.bodyMarkdown,
      ...page.retrievalHints,
      ...page.entities.map((entity) => entity.value)
    ].join('\n')
  )

  const matchedFiles = overlap(context.files, entityValues(page, 'file'))
  if (matchedFiles.length > 0) {
    score += 100 + matchedFiles.length * 20
    reasons.push(`path match: ${matchedFiles.join(', ')}`)
  }

  const matchedCommands = overlap(context.commands, entityValues(page, 'command'))
  if (matchedCommands.length > 0) {
    score += 70 + matchedCommands.length * 10
    reasons.push(`command match: ${matchedCommands.join(', ')}`)
  }

  const explicit = explicitMention(context.userText, page)
  if (explicit) {
    score += 80
    reasons.push(`explicit user mention: ${explicit}`)
  }

  if (context.hasErrorSignal && hasEntity(page, 'error_signature')) {
    score += 55
    reasons.push('error signature match')
  }

  if (context.hasConstraintSignal && page.kind === 'constraint') {
    score += 45
    reasons.push(`${scopeLabel(page)} constraint hit`)
  }

  if (context.hasDecisionSignal && page.kind === 'decision') {
    score += 40
    reasons.push(`${scopeLabel(page)} decision hit`)
  }

  if (
    context.hasHistoricalReference &&
    (page.kind === 'decision' || page.kind === 'constraint' || page.kind === 'assumption')
  ) {
    score += 25
    reasons.push('historical reference')
  }

  for (const token of importantTokens(context.userText)) {
    if (pageText.includes(token)) {
      score += 5
      reasons.push(`keyword match: ${token}`)
      break
    }
  }

  if (score > 0 && context.currentSessionId && page.sessionId === context.currentSessionId) {
    score += 8
    reasons.push('same session')
  }

  if (
    score > 0 &&
    (page.scope === 'project' || page.scope === 'worktree' || page.scope === 'user')
  ) {
    score += 4
  }

  return { page, score, reasons: unique(reasons) }
}

function explicitMention(userText: string, page: FieldMemoryPageRecord): string | null {
  const text = normalizeText(userText)
  const candidates = [
    page.title,
    ...page.entities.map((entity) => entity.value),
    ...page.retrievalHints
  ]
    .map((value) => normalizeText(value))
    .filter((value) => value.length >= 5)

  return candidates.find((candidate) => text.includes(candidate)) ?? null
}

function entityValues(
  page: FieldMemoryPageRecord,
  type: FieldMemoryPageRecord['entities'][number]['type']
) {
  return page.entities.filter((entity) => entity.type === type).map((entity) => entity.value)
}

function hasEntity(
  page: FieldMemoryPageRecord,
  type: FieldMemoryPageRecord['entities'][number]['type']
) {
  return page.entities.some((entity) => entity.type === type)
}

function scopeLabel(page: FieldMemoryPageRecord): string {
  return `${page.scope}:${page.scopeId}`
}

function extractFiles(text: string): string[] {
  const matches = text.matchAll(
    /(?:^|[\s`'"])([\w@./-]+\.(?:ts|tsx|js|jsx|json|md|css|sql|yaml|yml|toml|rs|go|py|java|kt|swift|mjs|cjs|html|scss))(?:$|[\s`'",:;，。！？])/g
  )
  return unique(Array.from(matches, (match) => match[1]))
}

function extractCommands(text: string): string[] {
  const commandPattern =
    /(?:^|\n)\s*(?:\$ )?((?:pnpm|npm|yarn|bun|node|git|python|python3|tsc|vitest|eslint|cargo|go|make|bash|sh)\b[^\n]*)/g
  const inlinePattern =
    /`((?:pnpm|npm|yarn|bun|node|git|python|python3|tsc|vitest|eslint|cargo|go|make|bash|sh)\b[^`]*)`/g
  return unique([
    ...Array.from(text.matchAll(commandPattern), (match) => normalizeCommand(match[1])),
    ...Array.from(text.matchAll(inlinePattern), (match) => normalizeCommand(match[1]))
  ])
}

function importantTokens(text: string): string[] {
  return unique(
    normalizeText(text)
      .split(/[^\p{L}\p{N}_@./-]+/u)
      .filter((token) => token.length >= 5)
      .filter((token) => !/^(please|continue|should|would|could|about|because)$/.test(token))
  ).slice(0, 12)
}

function overlap(needles: string[], haystack: string[]): string[] {
  if (needles.length === 0 || haystack.length === 0) return []
  const normalizedHaystack = haystack.map(normalizeCommand)
  return needles.filter((needle) => {
    const normalizedNeedle = normalizeCommand(needle)
    return normalizedHaystack.some(
      (item) => item === normalizedNeedle || item.endsWith(`/${normalizedNeedle}`)
    )
  })
}

function estimateTokens(page: FieldMemoryPageRecord): number {
  return Math.max(1, Math.ceil([page.title, page.bodyMarkdown].join('\n').length / 3))
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizeCommand(value: string): string {
  return normalizeText(value).replace(/\s+/g, ' ')
}

function unique<T>(values: Array<T | null | undefined>): T[] {
  return Array.from(
    new Set(values.filter((value): value is T => value !== null && value !== undefined))
  )
}
