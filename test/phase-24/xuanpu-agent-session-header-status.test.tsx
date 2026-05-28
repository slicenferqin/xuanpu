import { render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { SessionHeader } from '../../src/renderer/src/components/session-hq/SessionHeader'

function runtimeStatus(
  overrides: Partial<XuanpuAgentRuntimeStatus> = {}
): XuanpuAgentRuntimeStatus {
  return {
    enabled: true,
    status: 'missing-credentials',
    runtimeGateEnv: 'XUANPU_AGENT_RUNTIME',
    mockMode: false,
    providerReady: false,
    providerID: 'openai',
    modelID: 'gpt-4.1',
    credential: {
      providerID: 'openai',
      required: true,
      present: false,
      envKeys: ['OPENAI_API_KEY']
    },
    toolSurface: {
      status: 'blocked',
      toolsEnabled: false,
      nativeProcessControlEnabled: false,
      unmetGateIds: ['permission-policy']
    },
    ...overrides
  }
}

function renderHeader(
  session: Partial<ComponentProps<typeof SessionHeader>['session']> = {}
): void {
  render(
    <TooltipProvider>
      <SessionHeader
        sessionId="hive-session-1"
        lifecycle="idle"
        session={{
          agent_sdk: 'xuanpu-agent',
          model_provider_id: 'openai',
          model_id: 'gpt-4.1',
          first_message_at: null,
          ...session
        }}
      />
    </TooltipProvider>
  )
}

describe('SessionHeader xuanpu-agent runtime status', () => {
  beforeEach(() => {
    window.systemOps.getXuanpuAgentRuntimeStatus = vi.fn().mockResolvedValue(runtimeStatus())
    Object.defineProperty(window, 'agentOps', {
      configurable: true,
      writable: true,
      value: {
        listModels: vi.fn().mockResolvedValue({
          success: true,
          providers: [
            {
              id: 'openai',
              name: 'OpenAI',
              models: {
                'gpt-4.1': { id: 'gpt-4.1', name: 'GPT 4.1' }
              }
            }
          ]
        })
      }
    })
  })

  it('passes the current xuanpu-agent session model to the runtime status IPC', async () => {
    renderHeader()

    await waitFor(() => {
      expect(window.systemOps.getXuanpuAgentRuntimeStatus).toHaveBeenCalledWith({
        providerID: 'openai',
        modelID: 'gpt-4.1'
      })
    })
    expect(await screen.findByTestId('xuanpu-agent-runtime-status')).toHaveTextContent('Env')
  })

  it('shows mock mode while keeping the provider/model visible to the status path', async () => {
    window.systemOps.getXuanpuAgentRuntimeStatus = vi.fn().mockResolvedValue(
      runtimeStatus({
        status: 'mock-ready',
        mockMode: true,
        providerReady: true,
        credential: {
          providerID: 'openai',
          required: true,
          present: true,
          envKeys: ['OPENAI_API_KEY']
        }
      })
    )

    renderHeader()

    expect(await screen.findByTestId('xuanpu-agent-runtime-status')).toHaveTextContent('Mock')
    expect(window.systemOps.getXuanpuAgentRuntimeStatus).toHaveBeenCalledWith({
      providerID: 'openai',
      modelID: 'gpt-4.1'
    })
  })

  it('shows experimental badge when the selected provider is ready', async () => {
    window.systemOps.getXuanpuAgentRuntimeStatus = vi.fn().mockResolvedValue(
      runtimeStatus({
        status: 'ready',
        providerReady: true,
        credential: {
          providerID: 'openai',
          required: true,
          present: true,
          envKeys: ['OPENAI_API_KEY']
        }
      })
    )

    renderHeader()

    await waitFor(() => {
      expect(window.systemOps.getXuanpuAgentRuntimeStatus).toHaveBeenCalled()
    })
    // M7.0: xuanpu-agent always shows Experimental badge even when ready
    expect(screen.getByTestId('xuanpu-agent-runtime-status')).toHaveTextContent('Experimental')
  })
})
