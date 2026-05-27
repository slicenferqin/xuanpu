import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock pi-ai module
const mockGetBundledModel = vi.fn()

vi.mock('../../src/main/services/xuanpu-agent/pi-agent-core-loader', () => ({
  loadPiAiModule: async () => ({
    getBundledModel: mockGetBundledModel
  })
}))

import { resolveCompactionModel } from '../../src/main/services/xuanpu-agent/context/compaction-model'

describe('resolveCompactionModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetBundledModel.mockReturnValue(null)
  })

  it('returns explicit model when configured and available', async () => {
    const mockModel = { id: 'test-model' }
    mockGetBundledModel.mockImplementation((provider: string, modelId: string) => {
      if (provider === 'anthropic' && modelId === 'claude-haiku-4-5') return mockModel
      return null
    })

    const result = await resolveCompactionModel(
      { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
      { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }
    )

    expect(result.kind).toBe('model')
    expect(result.source).toBe('explicit')
    expect(result.modelRef).toEqual({ providerID: 'anthropic', modelID: 'claude-haiku-4-5' })
    expect(result.model).toBe(mockModel)
  })

  it('falls through to provider-default when explicit model unavailable', async () => {
    const mockModel = { id: 'haiku-model' }
    mockGetBundledModel.mockImplementation((provider: string, modelId: string) => {
      if (provider === 'anthropic' && modelId === 'claude-haiku-4-5') return mockModel
      return null
    })

    const result = await resolveCompactionModel(
      { providerID: 'anthropic', modelID: 'nonexistent-model' },
      { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }
    )

    expect(result.kind).toBe('model')
    expect(result.source).toBe('provider-default')
    expect(result.modelRef?.modelID).toBe('claude-haiku-4-5')
  })

  it('auto-selects from provider candidates based on main model', async () => {
    const mockModel = { id: 'gpt-mini' }
    mockGetBundledModel.mockImplementation((provider: string, modelId: string) => {
      if (provider === 'openai' && modelId === 'gpt-5.4-mini') return mockModel
      return null
    })

    const result = await resolveCompactionModel(
      null,
      { providerID: 'openai', modelID: 'gpt-5' }
    )

    expect(result.kind).toBe('model')
    expect(result.source).toBe('provider-default')
    expect(result.modelRef).toEqual({ providerID: 'openai', modelID: 'gpt-5.4-mini' })
  })

  it('skips main model when selecting candidates and falls back to rule-based if no alternative', async () => {
    const mockModel = { id: 'haiku' }
    mockGetBundledModel.mockImplementation((provider: string, modelId: string) => {
      // Only haiku available — which IS the main model
      if (provider === 'anthropic' && modelId === 'claude-haiku-4-5') return mockModel
      return null
    })

    const result = await resolveCompactionModel(
      null,
      { providerID: 'anthropic', modelID: 'claude-haiku-4-5' }
    )

    // claude-haiku-4-5 is the main model, so provider-auto skips it
    // Cross-provider fallback also skips (main is already anthropic)
    // → rule-based fallback
    expect(result.kind).toBe('rule-based')
    expect(result.source).toBe('fallback')
  })

  it('falls back to rule-based when no model available', async () => {
    mockGetBundledModel.mockReturnValue(null)

    const result = await resolveCompactionModel(null, undefined)

    expect(result.kind).toBe('rule-based')
    expect(result.source).toBe('fallback')
    expect(result.modelRef).toBeUndefined()
  })

  it('canonicalizes provider aliases', async () => {
    const mockModel = { id: 'haiku' }
    mockGetBundledModel.mockImplementation((provider: string, modelId: string) => {
      if (provider === 'anthropic' && modelId === 'claude-haiku-4-5') return mockModel
      return null
    })

    const result = await resolveCompactionModel(
      { providerID: 'claude-code', modelID: 'claude-haiku-4-5' }
    )

    expect(result.kind).toBe('model')
    expect(result.modelRef?.providerID).toBe('anthropic')
  })

  it('tries cross-provider fallback when main provider has no candidates', async () => {
    const mockModel = { id: 'haiku' }
    mockGetBundledModel.mockImplementation((provider: string, modelId: string) => {
      if (provider === 'anthropic' && modelId === 'claude-haiku-4-5') return mockModel
      return null
    })

    const result = await resolveCompactionModel(
      null,
      { providerID: 'google', modelID: 'gemini-2.5-pro' }
    )

    expect(result.kind).toBe('model')
    expect(result.modelRef?.providerID).toBe('anthropic')
  })
})
