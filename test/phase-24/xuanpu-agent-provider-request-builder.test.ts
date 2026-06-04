import { describe, expect, it } from 'vitest'

import {
  buildProviderRequest,
  computeProviderRequestHash
} from '../../src/main/services/xuanpu-agent/turn/provider-request-builder'
import type { XuanpuPiPromptMessage } from '../../src/main/services/xuanpu-agent/context-transform'

function makeMsg(role: 'user' | 'assistant', text: string): XuanpuPiPromptMessage {
  return { role, content: [{ type: 'text', text }], timestamp: Date.now() }
}

function makeImageMsg(imageData: string, timestamp = Date.now()): XuanpuPiPromptMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: '<attached_files content="metadata-only">screen.png</attached_files>' },
      { type: 'image', data: imageData, mimeType: 'image/png' }
    ],
    timestamp
  }
}

describe('ProviderRequestBuilder', () => {
  const BASE_INPUT = {
    turnId: 'turn-1',
    sessionId: 'session-1',
    modelRef: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
    systemPrompt: ['You are a helpful assistant.'],
    contextMessages: [makeMsg('user', 'context anchor')],
    promptMessage: makeMsg('user', 'current request'),
    tools: [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: {} }
      }
    ],
    providerSessionPolicy: { mode: 'disabled' as const, reason: 'xuanpu owns turn-scoped context' },
    budget: {
      profile: 'balanced' as const,
      managedApproxTokens: 2500,
      providerEstimatedInputTokens: 3000,
      maxContextTokens: 150000,
      fillRatio: 0.02
    }
  }

  it('computes stable providerRequestHash for identical inputs', () => {
    const hash1 = computeProviderRequestHash(BASE_INPUT)
    const hash2 = computeProviderRequestHash(BASE_INPUT)

    expect(hash1).toBe(hash2) // deterministic
    expect(hash1).toMatch(/^[0-9a-f]{64}$/) // sha256 hex
  })

  it('produces different hashes for different system prompts', () => {
    const hash1 = computeProviderRequestHash(BASE_INPUT)
    const hash2 = computeProviderRequestHash({
      ...BASE_INPUT,
      systemPrompt: ['Different prompt.']
    })

    expect(hash1).not.toBe(hash2)
  })

  it('produces different hashes for different context messages', () => {
    const hash1 = computeProviderRequestHash(BASE_INPUT)
    const hash2 = computeProviderRequestHash({
      ...BASE_INPUT,
      contextMessages: [makeMsg('user', 'different context')]
    })

    expect(hash1).not.toBe(hash2)
  })

  it('hash is stable across volatile timestamp changes', () => {
    const hash1 = computeProviderRequestHash({
      ...BASE_INPUT,
      contextMessages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 1 }]
    })
    const hash2 = computeProviderRequestHash({
      ...BASE_INPUT,
      contextMessages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: 999999 }
      ]
    })

    expect(hash1).toBe(hash2) // timestamp is volatile, excluded from hash
  })

  it('buildProviderRequest returns a complete snapshot', () => {
    const snapshot = buildProviderRequest(BASE_INPUT)

    expect(snapshot.turnId).toBe('turn-1')
    expect(snapshot.sessionId).toBe('session-1')
    expect(snapshot.providerRequestHash).toMatch(/^[0-9a-f]{64}$/)
    expect(snapshot.systemPrompt).toEqual(['You are a helpful assistant.'])
    expect(snapshot.contextMessages).toHaveLength(1)
    expect(snapshot.promptMessage.content[0]).toEqual({ type: 'text', text: 'current request' })
    expect(snapshot.toolsJson).toContain('read_file')
    expect(snapshot.providerSessionPolicy.mode).toBe('disabled')
    expect(snapshot.budget.profile).toBe('balanced')
  })

  it('hash differs when modelRef changes', () => {
    const hash1 = computeProviderRequestHash(BASE_INPUT)
    const hash2 = computeProviderRequestHash({
      ...BASE_INPUT,
      modelRef: { providerID: 'openai', modelID: 'gpt-5.5' }
    })

    expect(hash1).not.toBe(hash2)
  })

  it('hash differs when providerSessionPolicy mode changes', () => {
    const hash1 = computeProviderRequestHash(BASE_INPUT)
    const hash2 = computeProviderRequestHash({
      ...BASE_INPUT,
      providerSessionPolicy: { mode: 'explicit-prefix-cache', reason: 'testing' }
    })

    expect(hash1).not.toBe(hash2)
  })

  it('hash includes current-turn image bytes by digest', () => {
    const hash1 = computeProviderRequestHash({
      ...BASE_INPUT,
      promptMessage: makeImageMsg('abc')
    })
    const hash2 = computeProviderRequestHash({
      ...BASE_INPUT,
      promptMessage: makeImageMsg('def')
    })

    expect(hash1).not.toBe(hash2)
  })

  it('image hash is stable across volatile timestamp changes', () => {
    const hash1 = computeProviderRequestHash({
      ...BASE_INPUT,
      promptMessage: makeImageMsg('abc', 1)
    })
    const hash2 = computeProviderRequestHash({
      ...BASE_INPUT,
      promptMessage: makeImageMsg('abc', 999999)
    })

    expect(hash1).toBe(hash2)
  })
})
