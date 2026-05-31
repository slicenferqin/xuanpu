import { describe, expect, it } from 'vitest'
import { parseCodexConfigToml } from '../../../src/main/services/codex-config'

describe('codex config parsing', () => {
  it('reads top-level model and configured context window', () => {
    const config = parseCodexConfigToml(`
model = "gpt-5.5"
model_context_window = 500000
profile = "auto-max"

[profiles.auto-max]
model = "gpt-5.5"
model_reasoning_effort = "xhigh"
`)

    expect(config.model).toBe('gpt-5.5')
    expect(config.modelContextWindow).toBe(500000)
    expect(config.activeProfile).toBe('auto-max')
  })

  it('accepts TOML integer separators in context window values', () => {
    const config = parseCodexConfigToml(`
model = "gpt-5.5"
model_context_window = 500_000
model_auto_compact_token_limit = 450_000
`)

    expect(config.model).toBe('gpt-5.5')
    expect(config.modelContextWindow).toBe(500000)
  })

  it('lets the active profile override root model and context window', () => {
    const config = parseCodexConfigToml(`
model = "gpt-5.4"
model_context_window = 258400
profile = "large"

[profiles.large]
model = "gpt-5.5"
model_context_window = 500000
`)

    expect(config.model).toBe('gpt-5.5')
    expect(config.modelContextWindow).toBe(500000)
  })
})
