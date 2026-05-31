import { describe, expect, it } from 'vitest'
import { getEnabledSessionAgentSdks } from '@/lib/agent-sdk-availability'

describe('xuanpu-agent hidden UI gate', () => {
  it('keeps xuanpu-agent out of new-session choices until runtime detection enables it', () => {
    expect(
      getEnabledSessionAgentSdks({
        opencode: true,
        claude: true,
        codex: true,
        xuanpuAgent: false
      })
    ).toEqual(['opencode', 'claude-code', 'codex', 'terminal'])

    expect(
      getEnabledSessionAgentSdks({
        opencode: true,
        claude: false,
        codex: false,
        xuanpuAgent: true
      })
    ).toEqual(['opencode', 'xuanpu-agent', 'terminal'])
  })
})
