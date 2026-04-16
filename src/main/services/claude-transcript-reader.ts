import { createReadStream } from 'fs'
import { readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'
import { calculateUsageCost } from '@shared/usage/pricing'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeTranscriptReader' })

/**
 * Encode a worktree path the same way Claude CLI does:
 * replace every `/` and `.` with `-`.
 */
export function encodePath(worktreePath: string): string {
  return worktreePath.replace(/[/.]/g, '-')
}

export function getClaudeTranscriptPath(worktreePath: string, claudeSessionId: string): string {
  return join(homedir(), '.claude', 'projects', encodePath(worktreePath), `${claudeSessionId}.jsonl`)
}

interface ClaudeContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  is_error?: boolean
  content?: string | { type: string; text?: string }[]
  _resolvedOutput?: string
  _resolvedError?: string
  [key: string]: unknown
}

interface ClaudeJsonlEntry {
  type: string
  uuid?: string
  requestId?: string
  timestamp?: string
  message?: {
    id?: string
    role?: string
    content?: ClaudeContentBlock[] | string
    usage?: Record<string, unknown>
    model?: unknown
  }
  isSidechain?: boolean
  isCompactSummary?: boolean
  parent_tool_use_id?: string
}

export interface ClaudeTranscriptUsageEntry {
  sourceMessageId: string
  occurredAt: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  totalTokens: number
  cost: number
}

const CONTINUATION_PREFIX = 'This session is being continued from a previous conversation'
const PARSE_CHUNK_SIZE = 200
const MAX_TAIL_LINES = 1200
const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024

function isContextContinuationSummary(text: string): boolean {
  const trimmed = text.trimStart().replace(/^(?:<[^>]+>\s*)+/, '')
  return trimmed.startsWith(CONTINUATION_PREFIX)
}

function extractTextFromContent(content: ClaudeContentBlock[] | string | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function parseTimestamp(timestamp: string | undefined): number {
  if (!timestamp) return 0
  const ms = new Date(timestamp).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

function toFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function extractUsageNumbers(entry: ClaudeJsonlEntry): ClaudeTranscriptUsageEntry | null {
  const usage = entry.message?.usage
  const model = typeof entry.message?.model === 'string' ? entry.message.model : null

  if (!usage || !model) return null

  const inputTokens = toFiniteNumber(usage.input_tokens)
  const outputTokens = toFiniteNumber(usage.output_tokens)
  const cacheWriteTokens = toFiniteNumber(usage.cache_creation_input_tokens)
  const cacheReadTokens = toFiniteNumber(usage.cache_read_input_tokens)
  const totalTokens = inputTokens + outputTokens + cacheWriteTokens + cacheReadTokens

  if (totalTokens === 0) return null

  return {
    sourceMessageId: entry.message?.id ?? entry.uuid ?? `assistant-${entry.timestamp ?? '0'}`,
    occurredAt: entry.timestamp ?? new Date(0).toISOString(),
    model,
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    totalTokens,
    cost: calculateUsageCost(
      model,
      {
        input: inputTokens,
        output: outputTokens,
        cacheWrite: cacheWriteTokens,
        cacheRead: cacheReadTokens
      },
      'claude-code'
    )
  }
}

function translateContentBlock(
  block: ClaudeContentBlock,
  index: number,
  timestamp: string | undefined
): Record<string, unknown> | null {
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? { type: 'text', text: block.text } : null

    case 'tool_use': {
      const toolUse: Record<string, unknown> = {
        id: block.id ?? `tool-${index}`,
        name: block.name ?? 'Unknown',
        input: block.input ?? {},
        status: 'success',
        startTime: parseTimestamp(timestamp)
      }

      if (block._resolvedOutput !== undefined) {
        toolUse.output = block._resolvedOutput
      }
      if (block._resolvedError !== undefined) {
        toolUse.error = block._resolvedError
        toolUse.status = 'error'
      }

      return { type: 'tool_use', toolUse }
    }

    case 'thinking':
      return typeof block.thinking === 'string' ? { type: 'reasoning', text: block.thinking } : null

    case 'tool_result':
      return null

    default:
      return null
  }
}

function translateEntry(
  entry: ClaudeJsonlEntry,
  index: number,
  finalCostByUuid: Map<string, number> = new Map()
): Record<string, unknown> | null {
  if (entry.type !== 'user' && entry.type !== 'assistant') return null
  if (entry.isSidechain === true) return null

  const content = Array.isArray(entry.message?.content) ? entry.message.content : []
  const parts = content
    .map((block, blockIndex) => translateContentBlock(block, blockIndex, entry.timestamp))
    .filter((part): part is Record<string, unknown> => part !== null)

  const translated: Record<string, unknown> = {
    id: entry.uuid ?? entry.message?.id ?? `entry-${index}`,
    role: entry.message?.role ?? entry.type,
    timestamp: entry.timestamp ?? new Date(0).toISOString(),
    content: extractTextFromContent(entry.message?.content),
    parts
  }

  if (typeof entry.requestId === 'string' && entry.requestId.length > 0) {
    translated.requestId = entry.requestId
  }

  if (entry.type === 'assistant') {
    if (entry.message?.usage && typeof entry.message.usage === 'object') {
      translated.usage = entry.message.usage
    }

    if (entry.message?.model !== undefined) {
      translated.model = entry.message.model
    }

    if (entry.uuid && finalCostByUuid.has(entry.uuid)) {
      translated.cost = finalCostByUuid.get(entry.uuid)
    }
  }

  return translated
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function readTranscriptLines(
  filePath: string,
  maxTailLines: number | null
): Promise<{ lines: string[]; totalLines: number }> {
  let allLines: string[]
  const fileStat = await stat(filePath)

  if (fileStat.size > LARGE_FILE_THRESHOLD && maxTailLines !== null) {
    const tailBytes = Math.min(fileStat.size, 4 * 1024 * 1024)
    const startOffset = Math.max(0, fileStat.size - tailBytes)
    allLines = await new Promise<string[]>((resolve, reject) => {
      const collected: string[] = []
      const stream = createReadStream(filePath, {
        encoding: 'utf-8',
        start: startOffset
      })
      const rl = createInterface({ input: stream, crlfDelay: Infinity })
      rl.on('line', (line) => collected.push(line))
      rl.on('close', () => resolve(collected))
      rl.on('error', reject)
    })

    if (startOffset > 0 && allLines.length > 0) {
      allLines.shift()
    }
  } else {
    const raw = await readFile(filePath, 'utf-8')
    allLines = raw.split('\n')
  }

  return {
    totalLines: allLines.length,
    lines:
      maxTailLines !== null && allLines.length > maxTailLines
        ? allLines.slice(-maxTailLines)
        : allLines
  }
}

async function parseEntries(lines: string[]): Promise<ClaudeJsonlEntry[]> {
  const entries: ClaudeJsonlEntry[] = []

  for (let offset = 0; offset < lines.length; offset += PARSE_CHUNK_SIZE) {
    const end = Math.min(offset + PARSE_CHUNK_SIZE, lines.length)
    for (let index = offset; index < end; index++) {
      const trimmed = lines[index].trim()
      if (!trimmed) continue

      try {
        entries.push(JSON.parse(trimmed) as ClaudeJsonlEntry)
      } catch {
        log.debug('Skipping malformed JSONL line', { line: trimmed.slice(0, 100) })
      }
    }

    if (end < lines.length) {
      await yieldToEventLoop()
    }
  }

  return entries
}

async function mergeToolResults(entries: ClaudeJsonlEntry[]): Promise<void> {
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex]
    if (entry.type !== 'user') continue

    const content = Array.isArray(entry.message?.content) ? entry.message.content : []
    const toolResults = content.filter((block) => block.type === 'tool_result')
    if (toolResults.length === 0) continue

    for (let assistantIndex = entryIndex - 1; assistantIndex >= 0; assistantIndex--) {
      if (entries[assistantIndex].type !== 'assistant') continue

      const assistantContent = Array.isArray(entries[assistantIndex].message?.content)
        ? entries[assistantIndex].message!.content!
        : []
      if (!Array.isArray(assistantContent)) break

      for (const toolResult of toolResults) {
        const toolUseBlock = (assistantContent as ClaudeContentBlock[]).find(
          (block) => block.type === 'tool_use' && block.id === toolResult.tool_use_id
        )
        if (!toolUseBlock) continue

        let output: string | undefined
        if (typeof toolResult.content === 'string') {
          output = toolResult.content
        } else if (Array.isArray(toolResult.content)) {
          output = (toolResult.content as { type: string; text?: string }[])
            .filter((item) => item.type === 'text')
            .map((item) => item.text ?? '')
            .join('\n')
        }

        if (toolResult.is_error) {
          toolUseBlock._resolvedError = output
        } else {
          toolUseBlock._resolvedOutput = output
        }
      }

      break
    }

    if (entryIndex > 0 && entryIndex % PARSE_CHUNK_SIZE === 0) {
      await yieldToEventLoop()
    }
  }
}

function buildFinalAssistantMaps(entries: ClaudeJsonlEntry[]): {
  finalCostByUuid: Map<string, number>
  finalUsageByMessageId: Map<string, ClaudeTranscriptUsageEntry>
} {
  const finalUsageByMessageId = new Map<string, ClaudeTranscriptUsageEntry>()
  const finalUuidByMessageId = new Map<string, string>()

  for (const entry of entries) {
    if (entry.type !== 'assistant' || entry.isSidechain === true) continue

    const usage = extractUsageNumbers(entry)
    if (!usage) continue

    finalUsageByMessageId.set(usage.sourceMessageId, usage)
    if (entry.uuid) {
      finalUuidByMessageId.set(usage.sourceMessageId, entry.uuid)
    }
  }

  const finalCostByUuid = new Map<string, number>()
  for (const [messageId, usage] of finalUsageByMessageId.entries()) {
    const uuid = finalUuidByMessageId.get(messageId)
    if (uuid) {
      finalCostByUuid.set(uuid, usage.cost)
    }
  }

  return { finalCostByUuid, finalUsageByMessageId }
}

function shouldSkipEntry(entry: ClaudeJsonlEntry): boolean {
  if (entry.parent_tool_use_id) return true
  if (entry.isCompactSummary === true) return true

  if (entry.type === 'user') {
    const text = extractTextFromContent(entry.message?.content)
    if (isContextContinuationSummary(text)) return true

    const content = Array.isArray(entry.message?.content) ? entry.message.content : []
    if (content.length > 0 && content.every((block) => block.type === 'tool_result')) {
      return true
    }
  }

  return false
}

/**
 * Read a Claude CLI transcript JSONL file and translate it into the format
 * expected by `mapOpencodeMessagesToSessionViewMessages()`.
 */
export async function readClaudeTranscript(
  worktreePath: string,
  claudeSessionId: string
): Promise<unknown[]> {
  const filePath = getClaudeTranscriptPath(worktreePath, claudeSessionId)

  let lines: string[]
  let totalLines = 0
  try {
    const result = await readTranscriptLines(filePath, MAX_TAIL_LINES)
    lines = result.lines
    totalLines = result.totalLines
  } catch (err) {
    log.debug('Transcript file not found or unreadable', {
      filePath,
      error: err instanceof Error ? err.message : String(err)
    })
    return []
  }

  const entries = await parseEntries(lines)
  await mergeToolResults(entries)
  const { finalCostByUuid } = buildFinalAssistantMaps(entries)

  const messages: unknown[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (shouldSkipEntry(entry)) continue

    const translated = translateEntry(entry, messages.length, finalCostByUuid)
    if (translated) {
      messages.push(translated)
    }

    if (index > 0 && index % PARSE_CHUNK_SIZE === 0) {
      await yieldToEventLoop()
    }
  }

  log.info('Read Claude transcript', {
    filePath,
    totalLines,
    parsedLines: lines.length,
    truncated: totalLines > MAX_TAIL_LINES,
    parsedEntries: entries.length,
    messageCount: messages.length
  })

  return messages
}

export async function readClaudeTranscriptUsage(
  worktreePath: string,
  claudeSessionId: string
): Promise<{ entries: ClaudeTranscriptUsageEntry[]; filePath: string; mtimeMs: number | null }> {
  const filePath = getClaudeTranscriptPath(worktreePath, claudeSessionId)

  try {
    const fileStat = await stat(filePath)
    const { lines } = await readTranscriptLines(filePath, null)
    const entries = await parseEntries(lines)
    const { finalUsageByMessageId } = buildFinalAssistantMaps(entries)

    return {
      entries: Array.from(finalUsageByMessageId.values()).sort((a, b) =>
        a.occurredAt.localeCompare(b.occurredAt)
      ),
      filePath,
      mtimeMs: fileStat.mtimeMs
    }
  } catch (error) {
    log.debug('Transcript usage file not found or unreadable', {
      filePath,
      error: error instanceof Error ? error.message : String(error)
    })
    return {
      entries: [],
      filePath,
      mtimeMs: null
    }
  }
}

export { extractTextFromContent, translateContentBlock, translateEntry }
export type { ClaudeContentBlock, ClaudeJsonlEntry }
