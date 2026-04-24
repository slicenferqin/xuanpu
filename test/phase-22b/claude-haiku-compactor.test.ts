import { describe, it, expect, vi } from 'vitest'
import {
  ClaudeHaikuCompactor,
  __HAIKU_COMPACTOR_TUNABLES_FOR_TEST,
  type HaikuSDK
} from '../../src/main/field/claude-haiku-compactor'
import {
  InsufficientEventsError,
  type CompactionInput
} from '../../src/main/field/episodic-compactor'
import type { StoredFieldEvent } from '../../src/main/field/repository'
import type { FieldEventType } from '../../src/shared/types'

vi.mock('../../src/main/services/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

// ── Helpers ─────────────────────────────────────────────────────────────

function e(overrides: Partial<StoredFieldEvent>): StoredFieldEvent {
  return {
    seq: overrides.seq ?? Math.floor(Math.random() * 1_000_000),
    id: overrides.id ?? crypto.randomUUID(),
    timestamp: overrides.timestamp ?? Date.now(),
    worktreeId: overrides.worktreeId ?? 'w-1',
    projectId: overrides.projectId ?? 'p-1',
    sessionId: overrides.sessionId ?? null,
    relatedEventId: overrides.relatedEventId ?? null,
    type: (overrides.type as FieldEventType) ?? 'file.focus',
    payload: overrides.payload ?? { path: '/a.ts', name: 'a.ts', fromPath: null }
  } as StoredFieldEvent
}

function makeInput(eventCount = 10): CompactionInput {
  const t = 1_700_000_000_000
  const events: StoredFieldEvent[] = []
  for (let i = 0; i < eventCount; i++) {
    events.push(
      e({
        id: `e-${i}`,
        timestamp: t + i * 1000,
        type: 'file.focus',
        payload: { path: `/src/file-${i % 3}.ts`, name: `file-${i % 3}.ts`, fromPath: null }
      })
    )
  }
  return {
    worktreeId: 'w-1',
    worktreeName: 'hub-mobile',
    branchName: 'feat/stream-render',
    events,
    since: t - 60_000,
    until: t + eventCount * 1000
  }
}

function sdkReturning(text: string): HaikuSDK {
  return {
    query: () =>
      (async function* () {
        yield { type: 'result', result: text }
      })()
  }
}

function sdkThrowing(err: Error): HaikuSDK {
  return {
    query: () => ({
      async next(): Promise<IteratorResult<{ type: string; result?: string }>> {
        throw err
      },
      [Symbol.asyncIterator]() {
        return this
      }
    })
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('ClaudeHaikuCompactor — Phase 22B.2', () => {
  describe('identity', () => {
    it('declares id "claude-haiku" and version 1', () => {
      const c = new ClaudeHaikuCompactor({ loadSDK: async () => sdkReturning('') })
      expect(c.id).toBe('claude-haiku')
      expect(c.version).toBe(1)
    })
  })

  describe('minimum events guard', () => {
    it('throws InsufficientEventsError when events.length < 5', async () => {
      const c = new ClaudeHaikuCompactor({ loadSDK: async () => sdkReturning('x') })
      await expect(c.compact(makeInput(3))).rejects.toBeInstanceOf(InsufficientEventsError)
    })
  })

  describe('happy path', () => {
    it('returns a CompactionOutput with LLM markdown', async () => {
      const expected =
        'Worked on streaming renderer in hub-mobile.\n\nObserved:\n- Edited file-0.ts, file-1.ts\n- No failures observed\n'
      const sdk = sdkReturning(expected)
      const querySpy = vi.spyOn(sdk, 'query')
      const c = new ClaudeHaikuCompactor({ loadSDK: async () => sdk })

      const out = await c.compact(makeInput(10))

      expect(out.compactorId).toBe('claude-haiku')
      expect(out.version).toBe(1)
      expect(out.markdown).toContain('streaming renderer')
      expect(querySpy).toHaveBeenCalledTimes(1)

      // Sanity-check the prompt we actually sent the model:
      const args = querySpy.mock.calls[0][0]
      expect(args.options.model).toBe('haiku')
      expect(args.options.thinking).toEqual({ type: 'disabled' })
      expect(args.options.tools).toEqual([])
      expect(args.options.persistSession).toBe(false)
      expect(args.prompt).toContain('hub-mobile')
      expect(args.prompt).toContain('feat/stream-render')
    })

    it('strips <think> tags and code fences', async () => {
      const withThink =
        '<think>internal reasoning</think>\n```markdown\nHere is the summary body line one.\nLine two with enough substance to pass validation.\n```'
      const c = new ClaudeHaikuCompactor({ loadSDK: async () => sdkReturning(withThink) })
      const out = await c.compact(makeInput(10))
      expect(out.markdown).not.toContain('<think>')
      expect(out.markdown).not.toContain('internal reasoning')
      expect(out.markdown).not.toMatch(/^```/)
      expect(out.markdown).toContain('summary body')
    })

    it('rejects too-short responses (treated as failure, not success)', async () => {
      const c = new ClaudeHaikuCompactor({
        loadSDK: async () => sdkReturning('ok'),
        maxAttempts: 1
      })
      await expect(c.compact(makeInput(10))).rejects.toThrow()
    })
  })

  describe('retry + timeout', () => {
    it('retries once on abort/timeout and succeeds on the second attempt', async () => {
      let call = 0
      const sdk: HaikuSDK = {
        query() {
          call++
          if (call === 1) {
            return {
              async next(): Promise<IteratorResult<{ type: string; result?: string }>> {
                throw new Error('request aborted')
              },
              [Symbol.asyncIterator]() {
                return this
              }
            }
          }
          return (async function* () {
            yield {
              type: 'result',
              result:
                'Second-attempt summary of what the developer worked on — plenty of content here.'
            }
          })()
        }
      }
      const c = new ClaudeHaikuCompactor({
        loadSDK: async () => sdk,
        maxAttempts: 2
      })
      const out = await c.compact(makeInput(10))
      expect(out.markdown).toContain('Second-attempt')
      expect(call).toBe(2)
    })

    it('does NOT retry on non-retryable errors (e.g. "invalid api key")', async () => {
      const sdk = sdkThrowing(new Error('invalid api key'))
      const querySpy = vi.spyOn(sdk, 'query')
      const c = new ClaudeHaikuCompactor({
        loadSDK: async () => sdk,
        maxAttempts: 3
      })
      await expect(c.compact(makeInput(10))).rejects.toThrow(/invalid api key/)
      expect(querySpy).toHaveBeenCalledTimes(1)
    })

    it('gives up after maxAttempts on persistent 429', async () => {
      const sdk = sdkThrowing(new Error('HTTP 429 Too Many Requests'))
      const querySpy = vi.spyOn(sdk, 'query')
      const c = new ClaudeHaikuCompactor({
        loadSDK: async () => sdk,
        maxAttempts: 2
      })
      await expect(c.compact(makeInput(10))).rejects.toThrow(/429/)
      expect(querySpy).toHaveBeenCalledTimes(2)
    })

    it('aborts the query when the per-attempt timeout elapses', async () => {
      let capturedOptions: Record<string, unknown> | null = null
      const sdk: HaikuSDK = {
        query(args) {
          capturedOptions = args.options
          const ctrl = args.options.abortController as AbortController
          return {
            async next(): Promise<IteratorResult<{ type: string; result?: string }>> {
              return new Promise((_, reject) => {
                ctrl.signal.addEventListener('abort', () => reject(new Error('aborted')))
              })
            },
            [Symbol.asyncIterator]() {
              return this
            }
          }
        }
      }
      const c = new ClaudeHaikuCompactor({
        loadSDK: async () => sdk,
        maxAttempts: 1,
        timeoutMs: 20
      })
      await expect(c.compact(makeInput(10))).rejects.toThrow()
      expect(capturedOptions).not.toBeNull()
      expect(capturedOptions!.abortController).toBeInstanceOf(AbortController)
    })
  })

  describe('retry classifier', () => {
    it('classifies network/timeout/429/502 as retryable', () => {
      const { isRetryable } = __HAIKU_COMPACTOR_TUNABLES_FOR_TEST
      expect(isRetryable(new Error('request aborted'))).toBe(true)
      expect(isRetryable(new Error('ETIMEDOUT'))).toBe(true)
      expect(isRetryable(new Error('ECONNRESET on upstream'))).toBe(true)
      expect(isRetryable(new Error('HTTP 429'))).toBe(true)
      expect(isRetryable(new Error('HTTP 502 Bad Gateway'))).toBe(true)
      expect(isRetryable(new Error('rate limit exceeded'))).toBe(true)
      expect(isRetryable(new Error('network unreachable'))).toBe(true)
    })
    it('classifies auth/validation errors as non-retryable', () => {
      const { isRetryable } = __HAIKU_COMPACTOR_TUNABLES_FOR_TEST
      expect(isRetryable(new Error('invalid api key'))).toBe(false)
      expect(isRetryable(new Error('model not found'))).toBe(false)
      expect(isRetryable(new Error('malformed request'))).toBe(false)
    })
  })

  describe('prompt construction', () => {
    it('redacts inline secrets in session.message payloads', () => {
      const { buildUserPrompt } = __HAIKU_COMPACTOR_TUNABLES_FOR_TEST
      const events: StoredFieldEvent[] = [
        e({
          id: 'p',
          type: 'session.message',
          payload: {
            text: 'deploy with api_key=abc123 and BEARER xyz',
            agentSdk: 'claude-code',
            agentSessionId: 's-1',
            attachmentCount: 0
          }
        })
      ]
      const prompt = buildUserPrompt({
        worktreeId: 'w-1',
        worktreeName: 'wt',
        branchName: null,
        events,
        since: 0,
        until: Date.now()
      })
      expect(prompt).not.toContain('abc123')
      expect(prompt).not.toContain('xyz')
      expect(prompt).toContain('[REDACTED]')
    })

    it('clips event stream to tail when too many events', () => {
      const { buildUserPrompt, MAX_EVENTS_IN_PROMPT } = __HAIKU_COMPACTOR_TUNABLES_FOR_TEST
      const events: StoredFieldEvent[] = Array.from({ length: MAX_EVENTS_IN_PROMPT + 50 }, (_, i) =>
        e({
          id: `e-${i}`,
          timestamp: i * 1000,
          type: 'terminal.command',
          payload: { command: `cmd-${i}` }
        })
      )
      const prompt = buildUserPrompt({
        worktreeId: 'w-1',
        worktreeName: 'wt',
        branchName: null,
        events,
        since: 0,
        until: Date.now()
      })
      // First 50 commands should be clipped
      expect(prompt).not.toContain('cmd-0 ')
      // Last command should survive
      expect(prompt).toContain(`cmd-${MAX_EVENTS_IN_PROMPT + 49}`)
    })
  })
})
