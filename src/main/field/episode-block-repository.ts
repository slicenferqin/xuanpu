import { randomUUID } from 'node:crypto'

import { getDatabase } from '../db'

export type FieldEpisodeBlockKind = 'turns' | 'events' | 'checkpoint' | 'manual'
export type FieldEpisodeBlockConfidence = 'low' | 'medium' | 'high'

export interface FieldEpisodeRawRef {
  type: 'session_message' | 'field_event' | 'file' | 'command' | 'manual'
  id: string
  seq?: number
  role?: string
  at?: string | number | null
  metadata?: Record<string, unknown>
}

export interface FieldEpisodeBlockCreate {
  worktreeId: string
  sessionId?: string | null
  sourceEventSeqStart?: number | null
  sourceEventSeqEnd?: number | null
  sourceMessageIdStart?: string | null
  sourceMessageIdEnd?: string | null
  kind: FieldEpisodeBlockKind
  title?: string | null
  summaryMarkdown: string
  keyFacts: string[]
  constraints: string[]
  files: string[]
  commands: string[]
  failures: string[]
  rawRefs: FieldEpisodeRawRef[]
  tokenEstimate?: number
  confidence: FieldEpisodeBlockConfidence
}

export interface FieldEpisodeBlockRecord extends FieldEpisodeBlockCreate {
  id: string
  createdAt: number
  tokenEstimate: number
}

interface FieldEpisodeBlockRow {
  id: string
  worktree_id: string
  session_id: string | null
  created_at: number
  source_event_seq_start: number | null
  source_event_seq_end: number | null
  source_message_id_start: string | null
  source_message_id_end: string | null
  kind: FieldEpisodeBlockKind
  title: string | null
  summary_markdown: string
  key_facts_json: string
  constraints_json: string
  files_json: string
  commands_json: string
  failures_json: string
  raw_refs_json: string
  token_estimate: number
  confidence: FieldEpisodeBlockConfidence
}

export interface FieldEpisodeBlockQuery {
  worktreeId?: string
  sessionId?: string
  kind?: FieldEpisodeBlockKind
  limit?: number
  order?: 'asc' | 'desc'
}

export interface FieldEpisodeTurnInput {
  messageId: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: string | number | null
}

export interface RuleBasedEpisodeInput {
  worktreeId: string
  sessionId?: string | null
  title?: string | null
  turns: FieldEpisodeTurnInput[]
  confidence?: FieldEpisodeBlockConfidence
}

export function createFieldEpisodeBlock(data: FieldEpisodeBlockCreate): FieldEpisodeBlockRecord {
  validateEpisodeBlock(data)

  const record: FieldEpisodeBlockRecord = {
    ...data,
    id: randomUUID(),
    createdAt: Date.now(),
    tokenEstimate: data.tokenEstimate ?? estimateTokens(data.summaryMarkdown)
  }

  getDatabase()
    .getDb()
    .prepare(
      `INSERT INTO field_episode_blocks (
        id,
        worktree_id,
        session_id,
        created_at,
        source_event_seq_start,
        source_event_seq_end,
        source_message_id_start,
        source_message_id_end,
        kind,
        title,
        summary_markdown,
        key_facts_json,
        constraints_json,
        files_json,
        commands_json,
        failures_json,
        raw_refs_json,
        token_estimate,
        confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.id,
      record.worktreeId,
      record.sessionId ?? null,
      record.createdAt,
      record.sourceEventSeqStart ?? null,
      record.sourceEventSeqEnd ?? null,
      record.sourceMessageIdStart ?? null,
      record.sourceMessageIdEnd ?? null,
      record.kind,
      record.title ?? null,
      record.summaryMarkdown,
      JSON.stringify(record.keyFacts),
      JSON.stringify(record.constraints),
      JSON.stringify(record.files),
      JSON.stringify(record.commands),
      JSON.stringify(record.failures),
      JSON.stringify(record.rawRefs),
      record.tokenEstimate,
      record.confidence
    )

  return record
}

export function createRuleBasedEpisodeFromTurns(
  input: RuleBasedEpisodeInput
): FieldEpisodeBlockRecord {
  const turns = input.turns.filter((turn) => turn.content.trim().length > 0)
  if (turns.length === 0) {
    throw new Error('Cannot create a field episode block without raw turns')
  }

  const joined = turns.map((turn) => turn.content).join('\n')
  const rawRefs: FieldEpisodeRawRef[] = turns.map((turn) => ({
    type: 'session_message',
    id: turn.messageId,
    role: turn.role,
    at: turn.createdAt ?? null
  }))
  const keyFacts = extractKeyFacts(turns)
  const constraints = extractConstraints(joined)
  const files = extractFiles(joined)
  const commands = extractCommands(joined)
  const failures = extractFailures(joined)
  const summaryMarkdown = [
    `## ${input.title || 'Conversation Episode'}`,
    '',
    ...turns.slice(-6).map((turn) => `- **${turn.role}:** ${firstLine(turn.content)}`),
    constraints.length ? ['', '### Constraints', ...constraints.map((item) => `- ${item}`)] : '',
    failures.length ? ['', '### Failures', ...failures.map((item) => `- ${item}`)] : ''
  ]
    .flat()
    .filter((line) => line !== '')
    .join('\n')

  return createFieldEpisodeBlock({
    worktreeId: input.worktreeId,
    sessionId: input.sessionId ?? null,
    sourceMessageIdStart: turns.at(0)?.messageId ?? null,
    sourceMessageIdEnd: turns.at(-1)?.messageId ?? null,
    kind: 'turns',
    title: input.title ?? 'Conversation Episode',
    summaryMarkdown,
    keyFacts,
    constraints,
    files,
    commands,
    failures,
    rawRefs,
    confidence: input.confidence ?? 'medium'
  })
}

export function getFieldEpisodeBlock(id: string): FieldEpisodeBlockRecord | null {
  const row = getDatabase()
    .getDb()
    .prepare(
      `SELECT
        id,
        worktree_id,
        session_id,
        created_at,
        source_event_seq_start,
        source_event_seq_end,
        source_message_id_start,
        source_message_id_end,
        kind,
        title,
        summary_markdown,
        key_facts_json,
        constraints_json,
        files_json,
        commands_json,
        failures_json,
        raw_refs_json,
        token_estimate,
        confidence
      FROM field_episode_blocks
      WHERE id = ?`
    )
    .get(id) as FieldEpisodeBlockRow | undefined

  return row ? hydrateRow(row) : null
}

export function listFieldEpisodeBlocks(
  query: FieldEpisodeBlockQuery = {}
): FieldEpisodeBlockRecord[] {
  const clauses: string[] = []
  const params: unknown[] = []

  if (query.worktreeId) {
    clauses.push('worktree_id = ?')
    params.push(query.worktreeId)
  }
  if (query.sessionId) {
    clauses.push('session_id = ?')
    params.push(query.sessionId)
  }
  if (query.kind) {
    clauses.push('kind = ?')
    params.push(query.kind)
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const order = query.order === 'asc' ? 'ASC' : 'DESC'
  const limit = normalizeLimit(query.limit)

  const rows = getDatabase()
    .getDb()
    .prepare(
      `SELECT
        id,
        worktree_id,
        session_id,
        created_at,
        source_event_seq_start,
        source_event_seq_end,
        source_message_id_start,
        source_message_id_end,
        kind,
        title,
        summary_markdown,
        key_facts_json,
        constraints_json,
        files_json,
        commands_json,
        failures_json,
        raw_refs_json,
        token_estimate,
        confidence
      FROM field_episode_blocks
      ${where}
      ORDER BY created_at ${order}, id ${order}
      LIMIT ?`
    )
    .all(...params, limit) as FieldEpisodeBlockRow[]

  return rows.map(hydrateRow)
}

function validateEpisodeBlock(data: FieldEpisodeBlockCreate): void {
  if (!data.worktreeId.trim()) throw new Error('field episode block requires worktreeId')
  if (!data.summaryMarkdown.trim()) throw new Error('field episode block requires summaryMarkdown')
  if (data.rawRefs.length === 0) throw new Error('field episode block requires rawRefs')
  if (data.tokenEstimate !== undefined && data.tokenEstimate < 0) {
    throw new Error('field episode block tokenEstimate must be non-negative')
  }
}

function hydrateRow(row: FieldEpisodeBlockRow): FieldEpisodeBlockRecord {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    sourceEventSeqStart: row.source_event_seq_start,
    sourceEventSeqEnd: row.source_event_seq_end,
    sourceMessageIdStart: row.source_message_id_start,
    sourceMessageIdEnd: row.source_message_id_end,
    kind: row.kind,
    title: row.title,
    summaryMarkdown: row.summary_markdown,
    keyFacts: parseJson<string[]>(row.key_facts_json, []),
    constraints: parseJson<string[]>(row.constraints_json, []),
    files: parseJson<string[]>(row.files_json, []),
    commands: parseJson<string[]>(row.commands_json, []),
    failures: parseJson<string[]>(row.failures_json, []),
    rawRefs: parseJson<FieldEpisodeRawRef[]>(row.raw_refs_json, []),
    tokenEstimate: row.token_estimate,
    confidence: row.confidence
  }
}

function extractKeyFacts(turns: FieldEpisodeTurnInput[]): string[] {
  return unique(
    turns
      .filter((turn) => turn.role === 'assistant')
      .flatMap((turn) => splitSentences(turn.content))
      .filter((sentence) => sentence.length >= 20)
      .slice(0, 8)
  )
}

function extractConstraints(text: string): string[] {
  return unique(
    text
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[-*]\s+/, ''))
      .filter((line) =>
        /\b(must|never|do not|should|require|requires|required|keep|avoid)\b|必须|不要|不能|需要|保持|避免/.test(
          line
        )
      )
      .map(trimSnippet)
      .slice(0, 12)
  )
}

function extractFiles(text: string): string[] {
  const matches = text.matchAll(
    /(?:^|[\s`'"])([\w@./-]+\.(?:ts|tsx|js|jsx|json|md|css|sql|yaml|yml|toml|rs|go|py|java|kt|swift|mjs|cjs|html|scss))(?:$|[\s`'",:;])/g
  )
  return unique(Array.from(matches, (match) => match[1]).slice(0, 40))
}

function extractCommands(text: string): string[] {
  const commandPattern =
    /(?:^|\n)\s*(?:\$ )?((?:pnpm|npm|yarn|bun|node|git|python|python3|tsc|vitest|eslint|cargo|go|make|bash|sh)\b[^\n]*)/g
  const inlinePattern =
    /`((?:pnpm|npm|yarn|bun|node|git|python|python3|tsc|vitest|eslint|cargo|go|make|bash|sh)\b[^`]*)`/g
  return unique([
    ...Array.from(text.matchAll(commandPattern), (match) => trimSnippet(match[1])),
    ...Array.from(text.matchAll(inlinePattern), (match) => trimSnippet(match[1]))
  ]).slice(0, 30)
}

function extractFailures(text: string): string[] {
  return unique(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) =>
        /\b(error|failed|failure|exception|timeout|crash)\b|失败|报错|错误/.test(line)
      )
      .map(trimSnippet)
      .slice(0, 12)
  )
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?。！？])\s+/)
    .map(trimSnippet)
}

function firstLine(text: string): string {
  return trimSnippet(text.split(/\r?\n/).find((line) => line.trim()) ?? text)
}

function trimSnippet(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function normalizeLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return 50
  return Math.min(Math.max(Math.trunc(limit as number), 1), 200)
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3))
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}
