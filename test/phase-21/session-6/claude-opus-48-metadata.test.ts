/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/main/services/claude-sdk-loader', () => ({
  loadClaudeSDK: vi.fn()
}))

vi.mock('../../../src/main/services/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

vi.mock('../../../src/main/services/claude-transcript-reader', () => ({
  readClaudeTranscript: vi.fn().mockResolvedValue([]),
  readClaudeGoalStatus: vi.fn().mockResolvedValue(null),
  translateEntry: vi.fn().mockReturnValue(null)
}))

import { ClaudeCodeImplementer } from '../../../src/main/services/claude-code-implementer'

describe('Claude model metadata for Opus 4.8', () => {
  let impl: ClaudeCodeImplementer

  beforeEach(() => {
    vi.resetAllMocks()
    impl = new ClaudeCodeImplementer()
  })

  it('Opus model name is Opus 4.8', async () => {
    const providers = (await impl.getAvailableModels()) as any[]
    const opus = providers[0].models.opus
    expect(opus).toBeDefined()
    expect(opus.name).toBe('Opus 4.8')
  })

  it('Opus variants include xhigh', async () => {
    const providers = (await impl.getAvailableModels()) as any[]
    const opus = providers[0].models.opus
    expect(opus).toBeDefined()
    const variantKeys = Object.keys(opus.variants)
    expect(variantKeys).toContain('xhigh')
    expect(variantKeys).toContain('low')
    expect(variantKeys).toContain('medium')
    expect(variantKeys).toContain('high')
    expect(variantKeys).toContain('max')
  })

  it('Opus default variant remains high', async () => {
    const providers = (await impl.getAvailableModels()) as any[]
    const opus = providers[0].models.opus
    expect(opus).toBeDefined()
    expect(opus.defaultVariant).toBe('high')
  })

  it('no ultracode variant is emitted', async () => {
    const providers = (await impl.getAvailableModels()) as any[]
    const models = providers[0].models
    for (const key of Object.keys(models)) {
      const variantKeys = Object.keys(models[key].variants ?? {})
      expect(variantKeys).not.toContain('ultracode')
    }
  })

  it('Opus supports fast mode', async () => {
    const providers = (await impl.getAvailableModels()) as any[]
    const opus = providers[0].models.opus
    expect(opus).toBeDefined()
    expect(opus.supportsFastMode).toBe(true)
  })
})
