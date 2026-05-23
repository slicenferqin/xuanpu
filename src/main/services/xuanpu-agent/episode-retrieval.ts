import type { FieldEpisodeBlockRecord } from '../../field/episode-block-repository'
import type { XuanpuAgentContextTurn } from './context-transform'

export interface XuanpuAgentEpisodeRetrievalInput {
  userText: string
  episodes: FieldEpisodeBlockRecord[]
  priorMessages?: XuanpuAgentContextTurn[]
  currentSessionId?: string | null
  maxEpisodes?: number
  maxTokens?: number
}

export interface XuanpuAgentEpisodeRetrievalScore {
  id: string
  score: number
  reasons: string[]
  tokenEstimate: number
}

export interface XuanpuAgentEpisodeRetrievalResult {
  included: FieldEpisodeBlockRecord[]
  decisions: {
    policy: 'deterministic-gated-episode-retrieval'
    triggered: boolean
    triggers: string[]
    candidateCount: number
    includedIds: string[]
    droppedCount: number
    maxEpisodes: number
    maxTokens: number
    query: {
      files: string[]
      commands: string[]
      hasErrorSignal: boolean
      hasConstraintSignal: boolean
      hasHistoricalReference: boolean
      hasShortReferentialInput: boolean
    }
    scores: XuanpuAgentEpisodeRetrievalScore[]
  }
}

const DEFAULT_MAX_EPISODES = 3
const DEFAULT_MAX_TOKENS = 6_000

const HISTORICAL_REFERENCE_PATTERN =
  /\b(before|last time|earlier|previous|previously|that plan|that change|last run|history)\b|之前|上次|刚才|前面|历史|之前的|上一次|那个方案|那份计划/iu
const SHORT_REFERENTIAL_PATTERN =
  /\b(it|this|that|same|again|continue|resume)\b|这个|那个|继续|按这个|照旧|上面/iu
const ERROR_SIGNAL_PATTERN =
  /\b(error|failed|failure|exception|timeout|crash|stack|trace|enoent|eacces|typeerror|referenceerror)\b|失败|报错|错误|异常/iu
const CONSTRAINT_SIGNAL_PATTERN =
  /\b(must|never|do not|should|require|requires|required|constraint|avoid|keep)\b|必须|不要|不能|需要|保持|避免|约束|注意/iu

export function selectRetrievedEpisodesForContext(
  input: XuanpuAgentEpisodeRetrievalInput
): XuanpuAgentEpisodeRetrievalResult {
  const maxEpisodes = input.maxEpisodes ?? DEFAULT_MAX_EPISODES
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS
  const userText = input.userText.trim()
  const files = extractFiles(userText)
  const commands = extractCommands(userText)
  const hasErrorSignal = ERROR_SIGNAL_PATTERN.test(userText)
  const hasConstraintSignal = CONSTRAINT_SIGNAL_PATTERN.test(userText)
  const hasHistoricalReference = HISTORICAL_REFERENCE_PATTERN.test(userText)
  const hasShortReferentialInput =
    userText.length > 0 && userText.length <= 80 && SHORT_REFERENTIAL_PATTERN.test(userText)
  const triggers = unique([
    hasHistoricalReference ? 'historical_reference' : null,
    hasShortReferentialInput ? 'short_referential_input' : null,
    files.length > 0 ? 'file_path' : null,
    commands.length > 0 ? 'command' : null,
    hasErrorSignal ? 'error_signal' : null,
    hasConstraintSignal ? 'constraint_signal' : null
  ])

  const scored = input.episodes
    .filter((episode) => episode.summaryMarkdown.trim().length > 0)
    .map((episode, index) =>
      scoreEpisode(episode, {
        index,
        files,
        commands,
        hasErrorSignal,
        hasConstraintSignal,
        hasHistoricalReference,
        hasShortReferentialInput,
        currentSessionId: input.currentSessionId ?? null
      })
    )
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.episode.createdAt - a.episode.createdAt
    })

  const included: FieldEpisodeBlockRecord[] = []
  let usedTokens = 0
  for (const item of scored) {
    if (included.length >= maxEpisodes) break
    const tokenEstimate = Math.max(1, item.episode.tokenEstimate)
    if (included.length > 0 && usedTokens + tokenEstimate > maxTokens) continue
    if (included.length === 0 || usedTokens + tokenEstimate <= maxTokens) {
      included.push(item.episode)
      usedTokens += tokenEstimate
    }
  }

  return {
    included,
    decisions: {
      policy: 'deterministic-gated-episode-retrieval',
      triggered: triggers.length > 0,
      triggers,
      candidateCount: input.episodes.length,
      includedIds: included.map((episode) => episode.id),
      droppedCount: Math.max(0, scored.length - included.length),
      maxEpisodes,
      maxTokens,
      query: {
        files,
        commands,
        hasErrorSignal,
        hasConstraintSignal,
        hasHistoricalReference,
        hasShortReferentialInput
      },
      scores: scored.slice(0, 10).map((item) => ({
        id: item.episode.id,
        score: item.score,
        reasons: item.reasons,
        tokenEstimate: item.episode.tokenEstimate
      }))
    }
  }
}

function scoreEpisode(
  episode: FieldEpisodeBlockRecord,
  context: {
    index: number
    files: string[]
    commands: string[]
    hasErrorSignal: boolean
    hasConstraintSignal: boolean
    hasHistoricalReference: boolean
    hasShortReferentialInput: boolean
    currentSessionId: string | null
  }
): { episode: FieldEpisodeBlockRecord; score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []
  const matchedFiles = overlap(context.files, episode.files)
  if (matchedFiles.length > 0) {
    score += 100 + matchedFiles.length * 20
    reasons.push(`file:${matchedFiles.join(',')}`)
  }

  const matchedCommands = overlap(context.commands, episode.commands)
  if (matchedCommands.length > 0) {
    score += 60 + matchedCommands.length * 10
    reasons.push(`command:${matchedCommands.join(',')}`)
  }

  if (context.hasErrorSignal && episode.failures.length > 0) {
    score += 45
    reasons.push('error-signal')
  }

  if (context.hasConstraintSignal && episode.constraints.length > 0) {
    score += 35
    reasons.push('constraint-signal')
  }

  if (context.hasHistoricalReference) {
    score += 20
    reasons.push('historical-reference')
  }

  if (context.hasShortReferentialInput) {
    score += 15
    reasons.push('short-referential-input')
  }

  if (score > 0 && context.currentSessionId && episode.sessionId === context.currentSessionId) {
    score += 8
    reasons.push('same-session')
  }

  if (score > 0) {
    score += Math.max(0, 5 - context.index)
  }

  return { episode, score, reasons }
}

function extractFiles(text: string): string[] {
  const matches = text.matchAll(
    /(?:^|[\s`'"])([\w@./-]+\.(?:ts|tsx|js|jsx|json|md|css|sql|yaml|yml|toml|rs|go|py|java|kt|swift|mjs|cjs|html|scss))(?:$|[\s`'",:;])/g
  )
  return unique(Array.from(matches, (match) => match[1]))
}

function extractCommands(text: string): string[] {
  const commandPattern =
    /(?:^|\n)\s*(?:\$ )?((?:pnpm|npm|yarn|bun|node|git|python|python3|tsc|vitest|eslint|cargo|go|make|bash|sh)\b[^\n]*)/g
  const inlinePattern =
    /`((?:pnpm|npm|yarn|bun|node|git|python|python3|tsc|vitest|eslint|cargo|go|make|bash|sh)\b[^`]*)`/g
  return unique([
    ...Array.from(text.matchAll(commandPattern), (match) => normalizeText(match[1])),
    ...Array.from(text.matchAll(inlinePattern), (match) => normalizeText(match[1]))
  ])
}

function overlap(needles: string[], haystack: string[]): string[] {
  if (needles.length === 0 || haystack.length === 0) return []
  const normalizedHaystack = haystack.map(normalizeText)
  return needles.filter((needle) => {
    const normalizedNeedle = normalizeText(needle)
    return normalizedHaystack.some(
      (item) => item === normalizedNeedle || item.endsWith(`/${normalizedNeedle}`)
    )
  })
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase()
}

function unique<T>(values: Array<T | null | undefined>): T[] {
  return Array.from(
    new Set(values.filter((value): value is T => value !== null && value !== undefined))
  )
}
