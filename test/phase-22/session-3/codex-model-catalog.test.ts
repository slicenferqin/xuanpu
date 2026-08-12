import { describe, it, expect } from 'vitest'

import {
  CODEX_MODELS,
  CODEX_DEFAULT_MODEL,
  CODEX_REASONING_EFFORTS,
  getAvailableCodexModels,
  getCodexModelInfo,
  parseCodexRuntimeModelCatalog
} from '../../../src/main/services/codex-models'

describe('codex-models', () => {
  // ── CODEX_MODELS constant ──────────────────────────────────────

  describe('CODEX_MODELS', () => {
    it('contains exactly 8 models', () => {
      expect(CODEX_MODELS).toHaveLength(8)
    })

    it('includes the GPT-5.6 family', () => {
      expect(CODEX_MODELS.find((model) => model.id === 'gpt-5.6-sol')?.name).toBe('GPT-5.6-Sol')
      expect(CODEX_MODELS.find((model) => model.id === 'gpt-5.6-terra')?.name).toBe('GPT-5.6-Terra')
      expect(CODEX_MODELS.find((model) => model.id === 'gpt-5.6-luna')?.name).toBe('GPT-5.6-Luna')
    })

    it('includes gpt-5.5', () => {
      const model = CODEX_MODELS.find((m) => m.id === 'gpt-5.5')
      expect(model).toBeDefined()
      expect(model!.name).toBe('GPT-5.5')
    })

    it('includes gpt-5.4', () => {
      const model = CODEX_MODELS.find((m) => m.id === 'gpt-5.4')
      expect(model).toBeDefined()
      expect(model!.name).toBe('GPT-5.4')
    })

    it('includes gpt-5.3-codex', () => {
      const model = CODEX_MODELS.find((m) => m.id === 'gpt-5.3-codex')
      expect(model).toBeDefined()
      expect(model!.name).toBe('GPT-5.3 Codex')
    })

    it('includes gpt-5.3-codex-spark', () => {
      const model = CODEX_MODELS.find((m) => m.id === 'gpt-5.3-codex-spark')
      expect(model).toBeDefined()
      expect(model!.name).toBe('GPT-5.3 Codex Spark')
    })

    it('includes gpt-5.2-codex', () => {
      const model = CODEX_MODELS.find((m) => m.id === 'gpt-5.2-codex')
      expect(model).toBeDefined()
      expect(model!.name).toBe('GPT-5.2 Codex')
    })

    it('all models have context limits', () => {
      for (const model of CODEX_MODELS) {
        expect(model.limit.context).toBeGreaterThan(0)
        expect(model.limit.output).toBeGreaterThan(0)
      }
    })

    it('all models have variant objects with reasoning efforts', () => {
      for (const model of CODEX_MODELS) {
        expect(model.variants).toHaveProperty('xhigh')
        expect(model.variants).toHaveProperty('high')
        expect(model.variants).toHaveProperty('medium')
        expect(model.variants).toHaveProperty('low')
      }
    })

    it('all models have a default variant', () => {
      for (const model of CODEX_MODELS) {
        expect(model.defaultVariant).toBeDefined()
        expect(Object.keys(model.variants)).toContain(model.defaultVariant)
      }
    })
  })

  // ── CODEX_DEFAULT_MODEL ────────────────────────────────────────

  describe('CODEX_DEFAULT_MODEL', () => {
    it('is gpt-5.6-sol', () => {
      expect(CODEX_DEFAULT_MODEL).toBe('gpt-5.6-sol')
    })

    it('exists in the model catalog', () => {
      const model = CODEX_MODELS.find((m) => m.id === CODEX_DEFAULT_MODEL)
      expect(model).toBeDefined()
    })
  })

  // ── CODEX_REASONING_EFFORTS ────────────────────────────────────

  describe('CODEX_REASONING_EFFORTS', () => {
    it('contains all current reasoning levels', () => {
      expect(CODEX_REASONING_EFFORTS).toEqual(['ultra', 'max', 'xhigh', 'high', 'medium', 'low'])
    })
  })

  // ── getAvailableCodexModels ────────────────────────────────────

  describe('getAvailableCodexModels', () => {
    it('returns an array with a single provider entry', () => {
      const result = getAvailableCodexModels()
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('codex')
      expect(result[0].name).toBe('Codex')
    })

    it('provider entry contains all 8 models keyed by id', () => {
      const result = getAvailableCodexModels()
      const models = result[0].models
      expect(Object.keys(models)).toHaveLength(8)
      expect(models['gpt-5.6-sol']).toBeDefined()
      expect(models['gpt-5.6-terra']).toBeDefined()
      expect(models['gpt-5.6-luna']).toBeDefined()
      expect(models['gpt-5.5']).toBeDefined()
      expect(models['gpt-5.4']).toBeDefined()
      expect(models['gpt-5.3-codex']).toBeDefined()
      expect(models['gpt-5.3-codex-spark']).toBeDefined()
      expect(models['gpt-5.2-codex']).toBeDefined()
    })

    it('each model in the result has id, name, limit, and variants', () => {
      const result = getAvailableCodexModels()
      for (const model of Object.values(result[0].models)) {
        expect(model).toHaveProperty('id')
        expect(model).toHaveProperty('name')
        expect(model).toHaveProperty('limit')
        expect(model.limit).toHaveProperty('context')
        expect(model.limit).toHaveProperty('output')
        expect(model).toHaveProperty('variants')
      }
    })

    it('matches the shape returned by ClaudeCodeImplementer.getAvailableModels', () => {
      const result = getAvailableCodexModels()
      // Should be an array of providers, each with id, name, models
      expect(Array.isArray(result)).toBe(true)
      const provider = result[0]
      expect(typeof provider.id).toBe('string')
      expect(typeof provider.name).toBe('string')
      expect(typeof provider.models).toBe('object')
    })
  })

  describe('parseCodexRuntimeModelCatalog', () => {
    it('parses model/list metadata and filters hidden models', () => {
      const catalog = parseCodexRuntimeModelCatalog({
        data: [
          {
            id: 'sol-id',
            model: 'gpt-5.6-sol',
            displayName: 'GPT-5.6-Sol',
            description: 'Latest frontier model',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast' },
              { reasoningEffort: 'ultra', description: 'Delegated' }
            ]
          },
          {
            id: 'hidden-id',
            model: 'hidden-model',
            displayName: 'Hidden',
            hidden: true,
            isDefault: false,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: []
          }
        ],
        nextCursor: 'page-2'
      })

      expect(catalog?.defaultModelId).toBe('gpt-5.6-sol')
      expect(catalog?.nextCursor).toBe('page-2')
      expect(catalog?.models).toHaveLength(1)
      expect(Object.keys(catalog!.models[0].variants)).toEqual(['ultra', 'low'])
      expect(catalog!.models[0].limit.context).toBe(272000)
    })
  })

  // ── getCodexModelInfo ──────────────────────────────────────────

  describe('getCodexModelInfo', () => {
    it('returns model info for gpt-5.4', () => {
      const info = getCodexModelInfo('gpt-5.4')
      expect(info).not.toBeNull()
      expect(info!.id).toBe('gpt-5.4')
      expect(info!.name).toBe('GPT-5.4')
      expect(info!.limit.context).toBe(258400)
    })

    it('returns model info for gpt-5.3-codex', () => {
      const info = getCodexModelInfo('gpt-5.3-codex')
      expect(info).not.toBeNull()
      expect(info!.id).toBe('gpt-5.3-codex')
      expect(info!.name).toBe('GPT-5.3 Codex')
    })

    it('returns model info for gpt-5.2 (resolves alias to gpt-5.2-codex)', () => {
      const info = getCodexModelInfo('gpt-5.2')
      expect(info).not.toBeNull()
      // gpt-5.2 is an alias for gpt-5.2-codex via CODEX_MODEL_ALIASES
      expect(info!.id).toBe('gpt-5.2-codex')
      expect(info!.name).toBe('GPT-5.2 Codex')
    })

    it('returns null for unknown model', () => {
      const info = getCodexModelInfo('nonexistent-model')
      expect(info).toBeNull()
    })

    it('returns null for empty string', () => {
      const info = getCodexModelInfo('')
      expect(info).toBeNull()
    })

    it('returned info has id, name, and limit', () => {
      const info = getCodexModelInfo('gpt-5.2-codex')
      expect(info).not.toBeNull()
      expect(info).toHaveProperty('id')
      expect(info).toHaveProperty('name')
      expect(info).toHaveProperty('limit')
      expect(info!.limit).toHaveProperty('context')
      expect(info!.limit).toHaveProperty('output')
    })
  })
})
