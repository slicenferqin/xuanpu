import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  OPENAI_REMOTE_COMPACTION_PRESERVE_KEY,
  ProviderNativeCompactionArchiveStore,
  buildOpenAiRemoteCompactionNativeInput,
  extractProviderNativeReplayRefs,
  readOpenAiRemoteCompactionPreserveData,
  requestOpenAiRemoteCompaction,
  resolveOpenAiRemoteCompactionEndpoint,
  shouldUseOpenAiRemoteCompaction,
  summarizeProviderNativePreserveData
} from '../../src/main/services/xuanpu-agent/context/provider-native-compaction'

let tmpDir: string | null = null

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

function makeTempDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'xuanpu-provider-native-compaction-'))
  return tmpDir
}

function makeOpenAiPreserveData() {
  return {
    [OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]: {
      provider: 'openai',
      replacementHistory: [
        { type: 'message', role: 'assistant' },
        { type: 'compaction', encrypted_content: 'secret-provider-state' }
      ],
      compactionItem: { type: 'compaction', encrypted_content: 'secret-provider-state' }
    }
  }
}

describe('ProviderNativeCompactionArchiveStore', () => {
  it('archives provider-native preserveData by stable sha ref', () => {
    const rootDir = makeTempDir()
    const preserveData = makeOpenAiPreserveData()
    const store = new ProviderNativeCompactionArchiveStore({ rootDir })

    const first = store.writePreserveData({ provider: 'openai', preserveData })
    const second = store.writePreserveData({ provider: 'openai', preserveData })

    expect(first.ref).toBe(second.ref)
    expect(first.path).toBe(second.path)
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(first.ref).toBe(`provider-native-compaction:${first.sha256}`)
    expect(first.bytes).toBeGreaterThan(0)
    expect(first).toMatchObject({
      provider: 'openai',
      replacementHistoryCount: 2,
      compactionItemType: 'compaction',
      replayable: true
    })
    expect(existsSync(first.path)).toBe(true)
    expect(readFileSync(first.path, 'utf-8')).toContain('secret-provider-state')
  })

  it('summarizes OpenAI remote compaction preserve data without exposing content', () => {
    expect(summarizeProviderNativePreserveData(makeOpenAiPreserveData())).toEqual({
      provider: 'openai',
      replacementHistoryCount: 2,
      compactionItemType: 'compaction',
      replayable: true
    })
  })

  it('builds native OpenAI compaction input with previous replacement history', () => {
    expect(
      buildOpenAiRemoteCompactionNativeInput(
        [
          { role: 'user', content: '  fix auth  ', messageId: 'u-1' },
          { role: 'assistant', content: 'patched auth.ts', messageId: 'assistant:2' },
          { role: 'assistant', content: '   ', messageId: 'empty' }
        ],
        [{ type: 'compaction', encrypted_content: 'previous-state' }]
      )
    ).toEqual([
      { type: 'compaction', encrypted_content: 'previous-state' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix auth' }] },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'patched auth.ts', annotations: [] }],
        status: 'completed',
        id: 'assistant_2'
      }
    ])
  })

  it('resolves OpenAI and Codex compact endpoints', () => {
    expect(
      resolveOpenAiRemoteCompactionEndpoint({
        providerID: 'openai',
        modelID: 'gpt-test'
      })
    ).toBe('https://api.openai.com/v1/responses/compact')
    expect(
      resolveOpenAiRemoteCompactionEndpoint({
        providerID: 'openai',
        modelID: 'gpt-test',
        baseUrl: 'https://example.test/openai'
      })
    ).toBe('https://example.test/openai/v1/responses/compact')
    expect(
      resolveOpenAiRemoteCompactionEndpoint({
        providerID: 'openai-codex',
        modelID: 'gpt-test',
        baseUrl: 'https://example.test/codex'
      })
    ).toBe('https://example.test/codex/responses/compact')
    expect(shouldUseOpenAiRemoteCompaction('anthropic')).toBe(false)
  })

  it('requests OpenAI remote compaction and wraps returned preserveData', async () => {
    let captured: { url: string; init: RequestInit } | null = null
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} }
      return new Response(
        JSON.stringify({
          output: [
            { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'drop' }] },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'kept' }]
            },
            { type: 'unknown', ignored: true },
            { type: 'compaction', encrypted_content: 'encrypted-state' }
          ]
        }),
        { status: 200, statusText: 'OK' }
      )
    }) as typeof fetch

    const result = await requestOpenAiRemoteCompaction({
      model: {
        providerID: 'openai',
        modelID: 'gpt-test',
        baseUrl: 'https://api.test/v1',
        contextWindow: 100_000
      },
      apiKey: 'test-key',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      instructions: 'compact this',
      fetchImpl
    })

    expect(captured?.url).toBe('https://api.test/v1/responses/compact')
    expect(captured?.init.method).toBe('POST')
    expect(captured?.init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer test-key'
    })
    expect(JSON.parse(String(captured?.init.body))).toEqual({
      model: 'gpt-test',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      instructions: 'compact this'
    })
    expect(result.preserveData[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]).toMatchObject({
      provider: 'openai',
      replacementHistory: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'kept' }]
        },
        { type: 'compaction', encrypted_content: 'encrypted-state' }
      ],
      compactionItem: { type: 'compaction', encrypted_content: 'encrypted-state' }
    })
    expect(summarizeProviderNativePreserveData(result.preserveData)).toMatchObject({
      replayable: true,
      replacementHistoryCount: 2,
      compactionItemType: 'compaction'
    })
  })

  it('trims dangling tool outputs and filters contextual output fragments', async () => {
    let capturedBody: unknown = null
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          output: [
            {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: '# AGENTS.md instructions for /repo\n<INSTRUCTIONS>\nnoise\n</INSTRUCTIONS>'
                }
              ]
            },
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'keep user fact' }]
            },
            { type: 'compaction_summary', summary: 'summary-state' }
          ]
        }),
        { status: 200, statusText: 'OK' }
      )
    }) as typeof fetch

    const result = await requestOpenAiRemoteCompaction({
      model: {
        providerID: 'openai',
        modelID: 'gpt-test',
        contextWindow: 1
      },
      apiKey: 'test-key',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep' }] },
        { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call-1', output: 'large output' },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'drop' }] }
      ],
      instructions: 'compact',
      fetchImpl
    })

    expect((capturedBody as { input: unknown[] }).input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'keep' }] }
    ])
    expect(result.preserveData[OPENAI_REMOTE_COMPACTION_PRESERVE_KEY]).toMatchObject({
      replacementHistory: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'keep user fact' }]
        },
        { type: 'compaction_summary', summary: 'summary-state' }
      ],
      compactionItem: { type: 'compaction_summary', summary: 'summary-state' }
    })
  })

  it('rejects OpenAI remote compaction responses without a compaction item', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          output: [{ type: 'message', role: 'assistant', content: [] }]
        }),
        { status: 200, statusText: 'OK' }
      )
    }) as typeof fetch

    await expect(
      requestOpenAiRemoteCompaction({
        model: { providerID: 'openai', modelID: 'gpt-test' },
        apiKey: 'test-key',
        input: [],
        instructions: 'compact',
        fetchImpl
      })
    ).rejects.toThrow('missing compaction item')
  })

  it('extracts replay refs from segment compaction metadata', () => {
    const refs = extractProviderNativeReplayRefs({
      episodeId: 'episode-1',
      source: 'frozen-episode',
      metadata: {
        segmentCompaction: {
          providerNative: {
            provider: 'openai',
            preserveDataRef: 'provider-native-compaction:abc',
            preserveDataPath: '/tmp/archive/abc.json',
            preserveDataSha256: 'abc',
            preserveDataBytes: 128,
            replacementHistoryCount: 2,
            compactionItemType: 'compaction',
            replayable: true,
            historyReplacementId: 'hr-1',
            firstKeptEntryId: 'entry-9'
          }
        }
      }
    })

    expect(refs).toEqual([
      {
        source: 'frozen-episode',
        episodeId: 'episode-1',
        provider: 'openai',
        ref: 'provider-native-compaction:abc',
        path: '/tmp/archive/abc.json',
        sha256: 'abc',
        bytes: 128,
        replacementHistoryCount: 2,
        compactionItemType: 'compaction',
        replayable: true,
        historyReplacementId: 'hr-1',
        firstKeptEntryId: 'entry-9'
      }
    ])
  })

  it('reads archived OpenAI remote compaction preserveData for replay', () => {
    const rootDir = makeTempDir()
    const store = new ProviderNativeCompactionArchiveStore({ rootDir })
    const archived = store.writePreserveData({
      provider: 'openai',
      preserveData: makeOpenAiPreserveData()
    })

    expect(readOpenAiRemoteCompactionPreserveData(archived.path)).toMatchObject({
      provider: 'openai',
      replacementHistory: [
        { type: 'message', role: 'assistant' },
        { type: 'compaction', encrypted_content: 'secret-provider-state' }
      ],
      compactionItem: { type: 'compaction', encrypted_content: 'secret-provider-state' }
    })
  })
})
