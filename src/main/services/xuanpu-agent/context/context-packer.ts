/**
 * Context Packer for xuanpu-agent M7.
 *
 * Replaces full-log-append (buildMessages) with zone-based context assembly.
 * Zones are packed in priority order with per-zone token budgets.
 *
 * Zone layout:
 *   1. Anchor        — cache-friendly rules (~1K tokens, fixed)
 *   2. CurrentField  — XFP field packet (~2-5K tokens)
 *   3. FrozenEpisodes — model-summarized history (~2-6K tokens)
 *   4. WorkingSet    — recent N turns, deduped against episodes (~5-15K tokens)
 *   5. CurrentRequest — user's message (never compressed)
 *   6. Buffer        — implicit (remaining budget)
 */
import type { XuanpuPiPromptMessage } from '../context-transform'
import type { FieldTurn } from '../field/provider'
import type { FieldEpisodeBlockRecord } from '../../../field/episode-block-repository'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface RetrievedEpisodeEntry {
  episode: FieldEpisodeBlockRecord
  retrievalReason: string
}

export interface ContextPackerInput {
  anchor: string
  fieldContextMarkdown: string | null
  frozenEpisodes: FieldEpisodeBlockRecord[]
  /** Episodes retrieved by gated retrieval (user referenced history). */
  retrievedEpisodes?: RetrievedEpisodeEntry[]
  workingSet: FieldTurn[]
  currentRequest: string
  /** Override per-zone budgets (tokens). */
  budgetOverrides?: Partial<ContextZoneBudgets>
  /** Total budget profile tokens. Default: 150_000 (balanced). */
  totalBudgetTokens?: number
  /** Stable string for prefixHash computation. Falls back to anchor if omitted. */
  prefixSeed?: string
  now?: number
}

export interface ContextPackerOutput {
  messages: XuanpuPiPromptMessage[]
  decisions: ContextPackerDecisions
  /** Full retrieved episode entries that were included by the packer. */
  includedRetrievedEpisodes: RetrievedEpisodeEntry[]
}

export interface ContextPackerDecisions {
  zones: {
    anchor: { tokens: number }
    currentField: { tokens: number; included: boolean }
    frozenEpisodes: { tokens: number; count: number; dropped: number }
    retrievedEpisodes: { tokens: number; count: number; dropped: number; reasons: string[]; includedIds: string[] }
    workingSet: { tokens: number; count: number; dedupedCount: number }
    currentRequest: { tokens: number }
  }
  totalTokens: number
  fillRatio: number
  /** Hash of stable prefix (anchor + frozen episodes). Same across turns if content unchanged. */
  prefixHash: string
}

interface ContextZoneBudgets {
  anchor: number
  currentField: number
  frozenEpisodes: number
  workingSet: number
  currentRequest: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ZONE_BUDGETS: ContextZoneBudgets = {
  anchor: 2_000,
  currentField: 8_000,
  frozenEpisodes: 10_000,
  workingSet: 25_000,
  currentRequest: 50_000
}

const DEFAULT_TOTAL_BUDGET = 150_000

// ─────────────────────────────────────────────────────────────────────────────
// Token estimation
// ─────────────────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf-8') / 4))
}

/** Simple djb2 hash for prefix stability check. Returns hex string. */
function djb2Hash(text: string): string {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16)
}

// ─────────────────────────────────────────────────────────────────────────────
// Deduplication
// ─────────────────────────────────────────────────────────────────────────────

function collectEpisodeMessageIds(episodes: FieldEpisodeBlockRecord[]): Set<string> {
  const ids = new Set<string>()
  for (const ep of episodes) {
    for (const ref of ep.rawRefs) {
      if (ref.type === 'session_message') ids.add(ref.id)
    }
  }
  return ids
}

// ─────────────────────────────────────────────────────────────────────────────
// Packing
// ─────────────────────────────────────────────────────────────────────────────

export function packContext(input: ContextPackerInput): ContextPackerOutput {
  const now = input.now ?? Date.now()
  const budgets = { ...DEFAULT_ZONE_BUDGETS, ...input.budgetOverrides }
  const totalBudget = input.totalBudgetTokens ?? DEFAULT_TOTAL_BUDGET

  const messages: XuanpuPiPromptMessage[] = []
  let usedTokens = 0

  // ── Zone 1: Anchor ──
  const anchorTokens = estimateTokens(input.anchor)
  messages.push(createUserMessage(input.anchor, now))
  usedTokens += anchorTokens

  // ── Zone 2: CurrentField ──
  let fieldTokens = 0
  let fieldIncluded = false
  if (input.fieldContextMarkdown?.trim()) {
    const fieldText = [
      '<xuanpu-current-field-context>',
      input.fieldContextMarkdown.trim(),
      '</xuanpu-current-field-context>'
    ].join('\n')
    fieldTokens = estimateTokens(fieldText)
    if (usedTokens + fieldTokens <= totalBudget) {
      messages.push(createUserMessage(fieldText, now))
      usedTokens += fieldTokens
      fieldIncluded = true
    }
  }

  // ── Zone 3: FrozenEpisodes ──
  const { included: includedEpisodes, dropped: droppedEpisodes, tokens: episodeTokens } =
    packEpisodes(input.frozenEpisodes, budgets.frozenEpisodes, totalBudget - usedTokens, now)
  let frozenEpisodeText = ''
  if (includedEpisodes.length > 0) {
    frozenEpisodeText = [
      '<xuanpu-frozen-episodes>',
      ...includedEpisodes.map(formatEpisode),
      '</xuanpu-frozen-episodes>'
    ].join('\n\n')
    messages.push(createUserMessage(frozenEpisodeText, now))
    usedTokens += episodeTokens
  }

  // Prefix hash: stable across turns when anchor + frozen episodes unchanged
  const prefixHash = djb2Hash((input.prefixSeed ?? input.anchor) + frozenEpisodeText)

  // ── Zone 3b: RetrievedEpisodes ──
  const retrievedEntries = input.retrievedEpisodes ?? []
  const {
    included: includedRetrieved,
    dropped: droppedRetrieved,
    tokens: retrievedTokens,
    reasons: retrievedReasons
  } = packRetrievedEpisodes(retrievedEntries, totalBudget - usedTokens, now)
  if (includedRetrieved.length > 0) {
    const retrievedText = [
      '<xuanpu-retrieved-episodes>',
      ...includedRetrieved.map((entry) => [
        `<episode id="${entry.episode.id}" reason="${entry.retrievalReason}">`,
        entry.episode.title ? `### ${entry.episode.title}` : null,
        entry.episode.summaryMarkdown.trim(),
        '</episode>'
      ].filter(Boolean).join('\n')),
      '</xuanpu-retrieved-episodes>'
    ].join('\n\n')
    messages.push(createUserMessage(retrievedText, now))
    usedTokens += retrievedTokens
  }

  // ── Zone 4: WorkingSet (deduped against frozen + retrieved episodes) ──
  const episodeMsgIds = collectEpisodeMessageIds([
    ...input.frozenEpisodes,
    ...includedRetrieved.map((e) => e.episode)
  ])
  const dedupedWorkingSet = input.workingSet.filter(
    (turn) => !turn.messageId || !episodeMsgIds.has(turn.messageId)
  )
  const dedupedCount = input.workingSet.length - dedupedWorkingSet.length

  const {
    included: includedTurns,
    tokens: workingSetTokens
  } = packWorkingSet(dedupedWorkingSet, budgets.workingSet, totalBudget - usedTokens, now)

  for (const turn of includedTurns) {
    messages.push(createConversationMessage(turn, now))
    usedTokens += estimateTokens(turn.content)
  }

  // ── Zone 5: CurrentRequest ──
  const requestTokens = estimateTokens(input.currentRequest)
  messages.push(createUserMessage(input.currentRequest, now))
  usedTokens += requestTokens

  return {
    messages,
    includedRetrievedEpisodes: includedRetrieved,
    decisions: {
      zones: {
        anchor: { tokens: anchorTokens },
        currentField: { tokens: fieldTokens, included: fieldIncluded },
        frozenEpisodes: {
          tokens: episodeTokens,
          count: includedEpisodes.length,
          dropped: droppedEpisodes
        },
        retrievedEpisodes: {
          tokens: retrievedTokens,
          count: includedRetrieved.length,
          dropped: droppedRetrieved,
          reasons: retrievedReasons,
          includedIds: includedRetrieved.map((e) => e.episode.id)
        },
        workingSet: {
          tokens: workingSetTokens,
          count: includedTurns.length,
          dedupedCount
        },
        currentRequest: { tokens: requestTokens }
      },
      totalTokens: usedTokens,
      fillRatio: usedTokens / totalBudget,
      prefixHash
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Zone packers
// ─────────────────────────────────────────────────────────────────────────────

function packEpisodes(
  episodes: FieldEpisodeBlockRecord[],
  budget: number,
  remaining: number,
  _now: number
): { included: FieldEpisodeBlockRecord[]; dropped: number; tokens: number } {
  const effectiveBudget = Math.min(budget, remaining)
  const included: FieldEpisodeBlockRecord[] = []
  let tokens = 0

  // Most recent first
  const sorted = [...episodes].sort((a, b) => b.createdAt - a.createdAt)

  for (const ep of sorted) {
    const epTokens = estimateTokens(ep.summaryMarkdown)
    if (tokens + epTokens > effectiveBudget && included.length > 0) break
    if (tokens + epTokens > effectiveBudget * 1.5) break // hard cap
    included.push(ep)
    tokens += epTokens
  }

  return { included, dropped: episodes.length - included.length, tokens }
}

function packRetrievedEpisodes(
  entries: RetrievedEpisodeEntry[],
  remaining: number,
  _now: number
): { included: RetrievedEpisodeEntry[]; dropped: number; tokens: number; reasons: string[] } {
  if (entries.length === 0) return { included: [], dropped: 0, tokens: 0, reasons: [] }

  const included: RetrievedEpisodeEntry[] = []
  let tokens = 0

  for (const entry of entries) {
    const epTokens = estimateTokens(entry.episode.summaryMarkdown)
    if (tokens + epTokens > remaining && included.length > 0) break
    included.push(entry)
    tokens += epTokens
  }

  return {
    included,
    dropped: entries.length - included.length,
    tokens,
    reasons: included.map((e) => e.retrievalReason)
  }
}

function packWorkingSet(
  turns: FieldTurn[],
  budget: number,
  remaining: number,
  _now: number
): { included: FieldTurn[]; tokens: number } {
  const effectiveBudget = Math.min(budget, remaining)
  // Keep most recent turns
  const recent = turns.slice(-20)
  const included: FieldTurn[] = []
  let tokens = 0

  // Pack from the end (most recent first)
  for (let i = recent.length - 1; i >= 0; i--) {
    const turnTokens = estimateTokens(recent[i].content)
    if (tokens + turnTokens > effectiveBudget && included.length > 0) break
    included.unshift(recent[i])
    tokens += turnTokens
  }

  return { included, tokens }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message factories
// ─────────────────────────────────────────────────────────────────────────────

function createUserMessage(text: string, timestamp: number): XuanpuPiPromptMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp
  }
}

function createConversationMessage(turn: FieldTurn, fallbackTimestamp: number): XuanpuPiPromptMessage {
  return {
    role: turn.role,
    content: [{ type: 'text', text: turn.content }],
    timestamp: typeof turn.createdAt === 'number' ? turn.createdAt : fallbackTimestamp
  }
}

function formatEpisode(ep: FieldEpisodeBlockRecord): string {
  return [
    `<episode id="${ep.id}" confidence="${ep.confidence}">`,
    ep.title ? `### ${ep.title}` : null,
    ep.summaryMarkdown.trim(),
    '</episode>'
  ]
    .filter(Boolean)
    .join('\n')
}
