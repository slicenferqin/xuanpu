import { readFile, stat } from 'fs/promises'
import { createReadStream } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createInterface } from 'readline'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeTranscriptReader' })

/**
 * Encode a worktree path the same way Claude CLI does:
 * replace every `/` and `.` with `-`.
 */
export function encodePath(worktreePath: string): string {
  return worktreePath.replace(/[/.]/g, '-')
}

interface ClaudeContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  // tool_result fields
  tool_use_id?: string
  is_error?: boolean
  content?: string | { type: string; text?: string }[]
  // Resolved output/error attached during two-pass correlation
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
    role?: string
    content?: ClaudeContentBlock[] | string
    usage?: Record<string, unknown>
    model?: unknown
  }
  isSidechain?: boolean
  /** Synthetic user message containing the conversation summary after context compaction */
  isCompactSummary?: boolean
}

/**
 * Detect context-continuation summary messages injected by Claude CLI when
 * resuming from a context-exhausted session. These are synthetic user messages
 * that do NOT carry the `isCompactSummary` flag.
 */
const CONTINUATION_PREFIX = 'This session is being continued from a previous conversation'

function isContextContinuationSummary(text: string): boolean {
  return text.trimStart().startsWith(CONTINUATION_PREFIX)
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
      // output/error may be attached by mergeToolResults() after initial translation
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

function translateEntry(entry: ClaudeJsonlEntry, index: number): Record<string, unknown> | null {
  if (entry.type !== 'user' && entry.type !== 'assistant') return null
  if (entry.isSidechain === true) return null

  const content = Array.isArray(entry.message?.content) ? entry.message.content : []
  const parts = content
    .map((block, i) => translateContentBlock(block, i, entry.timestamp))
    .filter((p): p is Record<string, unknown> => p !== null)

  const translated: Record<string, unknown> = {
    id: entry.uuid ?? `entry-${index}`,
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
  }

  return translated
}

/**
 * Yield to the event loop so IPC and other callbacks can be processed.
 * Uses setImmediate (macrotask) to let pending I/O and IPC handlers run.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** Number of JSONL lines to process before yielding to the event loop. */
const PARSE_CHUNK_SIZE = 200

/**
 * Maximum number of JSONL lines to read from the end of large transcripts.
 * Older entries beyond this limit are not visible in the UI and would only
 * waste CPU parsing multi-megabyte JSON blobs.
 */
const MAX_TAIL_LINES = 1200

/**
 * Read a Claude CLI transcript JSONL file and translate it into the format
 * expected by `mapOpencodeMessagesToSessionViewMessages()`.
 *
 * Parsing is chunked to avoid blocking the main thread for large transcripts.
 * Returns `[]` if the file doesn't exist or can't be parsed.
 */
export async function readClaudeTranscript(
  worktreePath: string,
  claudeSessionId: string
): Promise<unknown[]> {
  const encoded = encodePath(worktreePath)
  const filePath = join(homedir(), '.claude', 'projects', encoded, `${claudeSessionId}.jsonl`)

  /** Size threshold (bytes) above which we stream-read only the tail of the file. */
  const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024 // 2 MB

  let allLines: string[]
  try {
    const fileStat = await stat(filePath)
    if (fileStat.size > LARGE_FILE_THRESHOLD) {
      // Large file — stream only the last portion to avoid loading 36MB into memory.
      // We read lines from the end using a reverse scan of the last ~4MB.
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
      // First line may be partial (we started mid-file), drop it
      if (startOffset > 0 && allLines.length > 0) {
        allLines.shift()
      }
    } else {
      const raw = await readFile(filePath, 'utf-8')
      allLines = raw.split('\n')
    }
  } catch (err) {
    log.debug('Transcript file not found or unreadable', {
      filePath,
      error: err instanceof Error ? err.message : String(err)
    })
    return []
  }

  // For very large transcripts, only parse the last MAX_TAIL_LINES lines.
  // Older entries at the top of the file are not visible in the UI and
  // would take seconds to parse (e.g. 36MB → 4600 lines of 8KB each).
  const lines =
    allLines.length > MAX_TAIL_LINES ? allLines.slice(-MAX_TAIL_LINES) : allLines

  // Pass 1: Parse all JSONL entries (chunked to avoid blocking main thread)
  const entries: ClaudeJsonlEntry[] = []
  for (let offset = 0; offset < lines.length; offset += PARSE_CHUNK_SIZE) {
    const end = Math.min(offset + PARSE_CHUNK_SIZE, lines.length)
    for (let k = offset; k < end; k++) {
      const trimmed = lines[k].trim()
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

  // Pass 2: For each user entry with tool_result blocks, merge output into
  // the preceding assistant entry's tool_use blocks so they survive translation.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.type !== 'user') continue
    const content = Array.isArray(entry.message?.content) ? entry.message!.content : []
    const toolResults = content.filter((b) => b.type === 'tool_result')
    if (toolResults.length === 0) continue

    // Find the preceding assistant entry
    for (let j = i - 1; j >= 0; j--) {
      if (entries[j].type !== 'assistant') continue
      const assistantContent = Array.isArray(entries[j].message?.content)
        ? entries[j].message!.content!
        : []
      if (!Array.isArray(assistantContent)) break
      for (const tr of toolResults) {
        const toolUseBlock = (assistantContent as ClaudeContentBlock[]).find(
          (b) => b.type === 'tool_use' && b.id === tr.tool_use_id
        )
        if (!toolUseBlock) continue
        // Extract text output from tool_result content
        let output: string | undefined
        if (typeof tr.content === 'string') {
          output = tr.content
        } else if (Array.isArray(tr.content)) {
          output = (tr.content as { type: string; text?: string }[])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n')
        }
        if (tr.is_error) {
          toolUseBlock._resolvedError = output
        } else {
          toolUseBlock._resolvedOutput = output
        }
      }
      break
    }

    // Yield periodically during pass 2 as well
    if (i > 0 && i % PARSE_CHUNK_SIZE === 0) {
      await yieldToEventLoop()
    }
  }

  // Pass 3: Translate entries, skipping tool_result-only and subagent messages
  const messages: unknown[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]

    // Skip subagent messages — they have parent_tool_use_id set and belong
    // to child session transcripts, not the main conversation.
    const rawEntry = entry as unknown as Record<string, unknown>
    if (rawEntry.parent_tool_use_id) {
      continue
    }

    // Skip compaction summary — a synthetic user message containing the
    // conversation summary after context compaction.
    if (entry.isCompactSummary === true) {
      continue
    }

    // Skip context-continuation summary — content-based fallback.
    // Claude CLI injects a synthetic user message when resuming from a
    // context-exhausted session; it has no isCompactSummary flag.
    if (entry.type === 'user') {
      const text = extractTextFromContent(entry.message?.content)
      if (isContextContinuationSummary(text)) {
        continue
      }
    }

    // Skip user messages that only contain tool_result blocks
    if (entry.type === 'user') {
      const content = Array.isArray(entry.message?.content) ? entry.message!.content : []
      if (content.length > 0 && content.every((b) => b.type === 'tool_result')) {
        continue
      }
    }

    const translated = translateEntry(entry, messages.length)
    if (translated) {
      messages.push(translated)
    }

    // Yield periodically during pass 3
    if (i > 0 && i % PARSE_CHUNK_SIZE === 0) {
      await yieldToEventLoop()
    }
  }

  log.info('Read Claude transcript', {
    filePath,
    totalLines: allLines.length,
    parsedLines: lines.length,
    truncated: allLines.length > MAX_TAIL_LINES,
    parsedEntries: entries.length,
    messageCount: messages.length
  })

  return messages
}

// Export helpers for testing
export { translateEntry, translateContentBlock, extractTextFromContent }
export type { ClaudeJsonlEntry, ClaudeContentBlock }
