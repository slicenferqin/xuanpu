import type {
  FieldMemoryEntity,
  FieldMemoryProposalCreate,
  FieldMemoryRawRef,
  FieldMemoryScope
} from '../../../../shared/types/field-memory'

export interface MemoryExtractionTurn {
  messageId: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: string | number | null
}

export interface MemoryExtractionInput {
  scope: FieldMemoryScope
  scopeId: string
  projectId?: string | null
  worktreeId?: string | null
  sessionId?: string | null
  episodeId?: string | null
  commandTraceId?: string | null
  turns: MemoryExtractionTurn[]
  source?: string
  proposedBy?: string
}

type ExtractedKind = FieldMemoryProposalCreate['kind']

const FACT_PATTERN = /\b(remember|for future|from now on|project rule)\b|记住|以后|长期|项目规则/iu
const CONSTRAINT_PATTERN =
  /\b(must|never|do not|don't|should|require|requires|required|constraint|avoid|keep|always)\b|必须|不要|不能|需要|保持|避免|约束|永远/iu
const DECISION_PATTERN =
  /\b(decided|decision|we will|we chose|chosen|adopt|use .+ instead|switch to)\b|决定|结论|采用|改用|选用|方案/iu
const ASSUMPTION_PATTERN = /\b(assume|assuming|assumption|default to|presume)\b|假设|默认|先认为/iu

export function extractMemoryProposalDrafts(
  input: MemoryExtractionInput
): FieldMemoryProposalCreate[] {
  const drafts: FieldMemoryProposalCreate[] = []

  for (const turn of input.turns) {
    const lines = turn.content
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[-*]\s+/, ''))
      .filter(Boolean)

    lines.forEach((line, index) => {
      const kind = classifyLine(line)
      if (!kind) return
      const bodyMarkdown = trimSnippet(stripDirectivePrefix(line))
      if (bodyMarkdown.length < 8) return

      const rawRef: FieldMemoryRawRef = {
        type: 'session_message',
        id: turn.messageId,
        role: turn.role,
        at: turn.createdAt ?? null,
        excerpt: bodyMarkdown.slice(0, 200),
        metadata: { line: index + 1 }
      }
      const entities = extractEntities(bodyMarkdown)

      drafts.push({
        scope: input.scope,
        scopeId: input.scopeId,
        projectId: input.projectId ?? null,
        worktreeId: input.worktreeId ?? null,
        sessionId: input.sessionId ?? null,
        episodeId: input.episodeId ?? null,
        commandTraceId: input.commandTraceId ?? null,
        kind,
        title: `${kind}: ${bodyMarkdown}`,
        bodyMarkdown,
        entities,
        rawRefs: [rawRef],
        retrievalHints: buildRetrievalHints(kind, bodyMarkdown, entities),
        source: input.source ?? 'turn-extractor',
        proposedBy: input.proposedBy ?? 'xuanpu-agent',
        proposalReason: `Detected explicit ${kind} signal in ${turn.role} turn`
      })
    })
  }

  return dedupeDrafts(drafts)
}

export function extractEntities(text: string): FieldMemoryEntity[] {
  const entities: FieldMemoryEntity[] = []
  for (const file of extractFiles(text)) {
    entities.push({ type: 'file', value: file })
  }
  for (const command of extractCommands(text)) {
    entities.push({ type: 'command', value: command })
  }
  for (const signature of extractErrorSignatures(text)) {
    entities.push({ type: 'error_signature', value: signature })
  }
  for (const keyword of extractKeywords(text)) {
    entities.push({ type: 'keyword', value: keyword })
  }
  return uniqueEntities(entities)
}

function classifyLine(line: string): ExtractedKind | null {
  if (CONSTRAINT_PATTERN.test(line)) return 'constraint'
  if (DECISION_PATTERN.test(line)) return 'decision'
  if (ASSUMPTION_PATTERN.test(line)) return 'assumption'
  if (FACT_PATTERN.test(line)) return 'fact'
  return null
}

function stripDirectivePrefix(line: string): string {
  return line
    .replace(/^\/remember\s+/i, '')
    .replace(/^remember\s*[:：]\s*/i, '')
    .replace(/^记住\s*[:：]?\s*/u, '')
    .trim()
}

function buildRetrievalHints(
  kind: ExtractedKind,
  text: string,
  entities: FieldMemoryEntity[]
): string[] {
  return uniqueStrings([
    kind,
    ...entities.map((entity) => entity.value),
    ...text
      .split(/[^\p{L}\p{N}_@./-]+/u)
      .map((word) => word.trim())
      .filter((word) => word.length >= 4)
      .slice(0, 12)
  ])
}

function extractFiles(text: string): string[] {
  const matches = text.matchAll(
    /(?:^|[\s`'"])([\w@./-]+\.(?:ts|tsx|js|jsx|json|md|css|sql|yaml|yml|toml|rs|go|py|java|kt|swift|mjs|cjs|html|scss))(?:$|[\s`'",:;，。！？])/g
  )
  return uniqueStrings(Array.from(matches, (match) => match[1])).slice(0, 20)
}

function extractCommands(text: string): string[] {
  const commandPattern =
    /(?:^|\n)\s*(?:\$ )?((?:pnpm|npm|yarn|bun|node|git|python|python3|tsc|vitest|eslint|cargo|go|make|bash|sh)\b[^\n]*)/g
  const inlinePattern =
    /`((?:pnpm|npm|yarn|bun|node|git|python|python3|tsc|vitest|eslint|cargo|go|make|bash|sh)\b[^`]*)`/g
  return uniqueStrings([
    ...Array.from(text.matchAll(commandPattern), (match) => trimSnippet(match[1])),
    ...Array.from(text.matchAll(inlinePattern), (match) => trimSnippet(match[1]))
  ]).slice(0, 20)
}

function extractErrorSignatures(text: string): string[] {
  const matches = text.matchAll(
    /\b([A-Z][A-Za-z]+Error|ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|SQLITE_[A-Z_]+)\b/g
  )
  return uniqueStrings(Array.from(matches, (match) => match[1])).slice(0, 10)
}

function extractKeywords(text: string): string[] {
  return uniqueStrings(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((word) => word.length >= 5)
      .filter((word) => !/^(should|would|could|about|because|there|their|which)$/.test(word))
  ).slice(0, 12)
}

function dedupeDrafts(drafts: FieldMemoryProposalCreate[]): FieldMemoryProposalCreate[] {
  const seen = new Set<string>()
  const output: FieldMemoryProposalCreate[] = []
  for (const draft of drafts) {
    const key = `${draft.kind}:${normalizeText(draft.bodyMarkdown)}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(draft)
  }
  return output.slice(0, 8)
}

function uniqueEntities(entities: FieldMemoryEntity[]): FieldMemoryEntity[] {
  const seen = new Set<string>()
  const output: FieldMemoryEntity[] = []
  for (const entity of entities) {
    const key = `${entity.type}:${normalizeText(entity.value)}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(entity)
  }
  return output
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function trimSnippet(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 320 ? `${trimmed.slice(0, 317)}...` : trimmed
}
