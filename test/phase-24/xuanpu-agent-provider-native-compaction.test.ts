import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  OPENAI_REMOTE_COMPACTION_PRESERVE_KEY,
  ProviderNativeCompactionArchiveStore,
  extractProviderNativeReplayRefs,
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
})
