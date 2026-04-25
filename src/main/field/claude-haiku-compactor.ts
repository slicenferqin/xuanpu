/**
 * Claude Haiku Episodic Compactor — Phase 22B.2
 *
 * Real LLM implementation of the EpisodicCompactor interface. Reuses the
 * Claude Agent SDK codepath from `claude-session-title.ts` (model: 'haiku',
 * effort: low, thinking: disabled, no tools, no session persistence) to keep
 * cost and latency minimal.
 *
 * Strict prompt contract:
 *   - Restate observed facts + a short abstract summary
 *   - NEVER invent events, file paths, commands, outcomes, or intent
 *   - If the event stream is too thin to justify an abstract, say so
 *
 * On failure (timeout, quota, network, malformed output) the compactor
 * throws. The updater treats that as "try the fallback compactor" and logs
 * a counter; the user's main flow is never blocked.
 *
 * Retry policy:
 *   - Per-attempt 30s timeout
 *   - 1 retry (2 attempts total)
 *   - Exponential backoff for 429 / 502 (1s, then 2s)
 */
import { basename } from 'path'
import { homedir } from 'node:os'
import { loadClaudeSDK } from '../services/claude-sdk-loader'
import { createLogger } from '../services/logger'
import {
  InsufficientEventsError,
  type CompactionInput,
  type CompactionOutput,
  type EpisodicCompactor
} from './episodic-compactor'
import type { StoredFieldEvent } from './repository'

const log = createLogger({ component: 'ClaudeHaikuCompactor' })

const MIN_EVENTS = 5
const REQUEST_TIMEOUT_MS = 30_000
const MAX_ATTEMPTS = 2
const BACKOFF_BASE_MS = 1_000
const MAX_EVENTS_IN_PROMPT = 200
const MAX_OUTPUT_CHARS = 4_000
const MIN_OUTPUT_CHARS = 40
const MAX_TEXT_SNIPPET = 160

const SYSTEM_PROMPT = `You summarize a developer's recent activity in a git worktree.

Rules (strict):
- Restate only events that appear in the input. Do NOT invent anything.
- No guessing about intent unless the event text makes it obvious (e.g. commit messages).
- Do NOT enumerate counts like "the user sent 12 prompts". Synthesize what the user was actually working on (files, commands, errors, topics).
- Output must be clean markdown, no preamble ("Here is..."), no code fences around the whole reply.
- Structure: a first one-line abstract sentence, then a short "Observed" bullet list (3-8 bullets) of concrete observations (files touched, commands run, failures, topics from prompts). End with a "Signals" line if there are notable failures or unresolved issues; skip it otherwise.
- Keep under 400 words.
- If the events are too sparse to summarize honestly, write exactly one line: "Not enough activity to summarize." and stop.`

// ---------------------------------------------------------------------------
// Types for testability
// ---------------------------------------------------------------------------

/** Minimal shape of the SDK we depend on, injectable for tests. */
export interface HaikuSDK {
  query(args: {
    prompt: string
    options: Record<string, unknown>
  }): AsyncIterable<{ type: string; result?: string }>
}

export type HaikuSDKLoader = () => Promise<HaikuSDK>

export interface ClaudeHaikuCompactorOptions {
  /** Inject an alternative loader (tests / ASAR path). */
  loadSDK?: HaikuSDKLoader
  /** Path to the Claude CLI binary (passed through to SDK for packaged apps). */
  claudeBinaryPath?: string | null
  /** Override the per-attempt timeout (tests). */
  timeoutMs?: number
  /** Override the retry count (tests). */
  maxAttempts?: number
}

// ---------------------------------------------------------------------------
// Compactor
// ---------------------------------------------------------------------------

export class ClaudeHaikuCompactor implements EpisodicCompactor {
  readonly id = 'claude-haiku'
  readonly version = 1

  private readonly loadSDK: HaikuSDKLoader
  private readonly claudeBinaryPath: string | null
  private readonly timeoutMs: number
  private readonly maxAttempts: number

  constructor(options: ClaudeHaikuCompactorOptions = {}) {
    this.loadSDK = options.loadSDK ?? (loadClaudeSDK as unknown as HaikuSDKLoader)
    this.claudeBinaryPath = options.claudeBinaryPath ?? null
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS
  }

  async compact(input: CompactionInput): Promise<CompactionOutput> {
    if (input.events.length < MIN_EVENTS) {
      throw new InsufficientEventsError(input.events.length)
    }

    const userPrompt = buildUserPrompt(input)
    const sdk = await this.loadSDK()

    let lastErr: unknown = null
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt - 1)
        await sleep(delay)
      }
      try {
        const raw = await this.runOnce(sdk, userPrompt)
        const markdown = postProcess(raw)
        if (!markdown) {
          throw new Error('empty or too-short Haiku response')
        }
        return { markdown, compactorId: this.id, version: this.version }
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        const retryable = isRetryable(err)
        log.warn('Haiku compaction attempt failed', {
          attempt,
          retryable,
          error: msg
        })
        if (!retryable) break
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`Haiku compaction failed: ${String(lastErr)}`)
  }

  private async runOnce(sdk: HaikuSDK, userPrompt: string): Promise<string> {
    const abortController = new AbortController()
    const timer = setTimeout(() => abortController.abort(), this.timeoutMs)
    try {
      const query = sdk.query({
        prompt: userPrompt,
        options: {
          cwd: homedir(),
          model: 'haiku',
          maxTurns: 1,
          abortController,
          systemPrompt: SYSTEM_PROMPT,
          effort: 'low',
          thinking: { type: 'disabled' },
          tools: [],
          persistSession: false,
          ...(this.claudeBinaryPath ? { pathToClaudeCodeExecutable: this.claudeBinaryPath } : {})
        }
      })

      let result = ''
      for await (const msg of query) {
        if (msg.type === 'result') {
          result = msg.result ?? ''
          break
        }
      }
      return result
    } finally {
      clearTimeout(timer)
    }
  }
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildUserPrompt(input: CompactionInput): string {
  const header =
    `Worktree: ${input.worktreeName}` +
    (input.branchName ? ` (branch: ${input.branchName})` : '') +
    `\nTime window: ${new Date(input.since).toISOString()} → ${new Date(input.until).toISOString()}` +
    `\nTotal events: ${input.events.length}`

  // Keep the tail (most recent) when clipping — that's what the user cares about.
  const slice =
    input.events.length > MAX_EVENTS_IN_PROMPT
      ? input.events.slice(-MAX_EVENTS_IN_PROMPT)
      : input.events

  const lines = slice.map(serializeEvent).filter((x) => x.length > 0)

  return (
    `${header}\n\nEvent stream (chronological, redacted):\n${lines.join('\n')}\n\n` +
    `Write the summary now, following the rules.`
  )
}

function serializeEvent(ev: StoredFieldEvent): string {
  const ts = formatClock(ev.timestamp)
  switch (ev.type) {
    case 'worktree.switch': {
      const p = ev.payload as { fromWorktreeId?: string | null; toWorktreeId?: string | null }
      return `${ts} worktree.switch ${p.fromWorktreeId ?? '∅'} → ${p.toWorktreeId ?? '∅'}`
    }
    case 'file.open':
    case 'file.focus': {
      const p = ev.payload as { path?: string }
      if (!p?.path) return ''
      return `${ts} ${ev.type} ${basename(p.path)} (${p.path})`
    }
    case 'file.selection': {
      // Selection is a drag-storm event; don't bloat the prompt with it.
      return ''
    }
    case 'terminal.command': {
      const p = ev.payload as { command?: string }
      return `${ts} $ ${truncate(p?.command ?? '(unknown)', MAX_TEXT_SNIPPET)}`
    }
    case 'terminal.output': {
      const p = ev.payload as { exitCode?: number | null; excerpt?: string }
      const code = typeof p?.exitCode === 'number' ? `exit=${p.exitCode}` : 'exit=?'
      const excerpt = p?.excerpt ? ` :: ${truncate(p.excerpt, MAX_TEXT_SNIPPET)}` : ''
      return `${ts} ← ${code}${excerpt}`
    }
    case 'session.message': {
      const p = ev.payload as { text?: string; agentSdk?: string }
      const text = truncate(redactSecrets(p?.text ?? ''), MAX_TEXT_SNIPPET)
      const agent = p?.agentSdk ? ` [${p.agentSdk}]` : ''
      return `${ts} prompt${agent}: ${text}`
    }
    case 'agent.file_read':
    case 'agent.file_write': {
      const p = ev.payload as { path?: string }
      if (!p?.path) return ''
      return `${ts} ${ev.type} ${basename(p.path)}`
    }
    case 'agent.file_search': {
      const p = ev.payload as { query?: string }
      return `${ts} agent.file_search "${truncate(p?.query ?? '', 80)}"`
    }
    case 'agent.bash_exec': {
      const p = ev.payload as { command?: string }
      return `${ts} agent.bash_exec $ ${truncate(p?.command ?? '', MAX_TEXT_SNIPPET)}`
    }
    default:
      return ''
  }
}

// ---------------------------------------------------------------------------
// Response post-processing & validation
// ---------------------------------------------------------------------------

function postProcess(raw: string): string | null {
  if (!raw) return null
  // Strip <think>...</think> reasoning artifacts if any.
  let s = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  // Strip surrounding ``` code fences if the model wrapped the whole reply.
  if (s.startsWith('```')) {
    s = s
      .replace(/^```[a-zA-Z]*\n?/, '')
      .replace(/```$/, '')
      .trim()
  }
  if (s.length < MIN_OUTPUT_CHARS) return null
  if (s.length > MAX_OUTPUT_CHARS) {
    const cut = s.slice(0, MAX_OUTPUT_CHARS)
    const lastBreak = cut.lastIndexOf('\n\n')
    s = lastBreak > 0 ? cut.slice(0, lastBreak) + '\n\n…(truncated)' : cut + '…'
  }
  return s
}

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

function isRetryable(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  if (msg.includes('abort')) return true // timeout abort
  if (msg.includes('timeout')) return true
  if (msg.includes('429')) return true
  if (msg.includes('502')) return true
  if (msg.includes('rate limit')) return true
  if (msg.includes('econnreset') || msg.includes('etimedout')) return true
  if (msg.includes('network')) return true
  return false
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatClock(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function truncate(s: string, max: number): string {
  if (!s) return ''
  const single = s.replace(/\s+/g, ' ').trim()
  return single.length <= max ? single : single.slice(0, Math.max(0, max - 1)) + '…'
}

const SECRET_INLINE_REGEX =
  /(api[_-]?key|password|token|secret|authorization|bearer)\s*[:=]?\s*\S+/gi

function redactSecrets(s: string): string {
  return s.replace(SECRET_INLINE_REGEX, (_m, kw: string) => `${kw}=[REDACTED]`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export const __HAIKU_COMPACTOR_TUNABLES_FOR_TEST = {
  MIN_EVENTS,
  REQUEST_TIMEOUT_MS,
  MAX_ATTEMPTS,
  BACKOFF_BASE_MS,
  MAX_EVENTS_IN_PROMPT,
  MAX_OUTPUT_CHARS,
  MIN_OUTPUT_CHARS,
  SYSTEM_PROMPT,
  isRetryable,
  redactSecrets,
  postProcess,
  buildUserPrompt
}
