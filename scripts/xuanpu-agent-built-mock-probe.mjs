#!/usr/bin/env node

import {
  fail,
  loadBuiltXuanpuAgentImplementer,
  noop,
  printJson
} from './xuanpu-agent-built-probe-utils.mjs'

async function runProbe() {
  const previousMockResponse = process.env.XUANPU_AGENT_MOCK_RESPONSE
  const mockResponse =
    process.env.XUANPU_AGENT_MOCK_RESPONSE || 'xuanpu-agent built mock probe response'
  const prompt =
    process.env.XUANPU_AGENT_BUILT_MOCK_PROMPT || 'Reply through the xuanpu-agent built mock probe.'
  const providerID = process.env.XUANPU_AGENT_PROVIDER_ID || 'anthropic'
  const modelID = process.env.XUANPU_AGENT_MODEL_ID || 'claude-haiku-4-5'
  const capturedMessages = []

  process.env.XUANPU_AGENT_MOCK_RESPONSE = mockResponse

  let implementer
  let sessionId = null
  const worktreePath = process.cwd()
  const hiveSessionId = `xuanpu-agent-built-mock-probe-${Date.now()}`

  try {
    const { XuanpuAgentImplementer, implementerChunk } = loadBuiltXuanpuAgentImplementer()
    implementer = new XuanpuAgentImplementer()
    implementer.setDatabaseService({
      createSessionMessage: (message) => {
        const record = {
          id: `probe-message-${capturedMessages.length + 1}`,
          ...message
        }
        capturedMessages.push(record)
        return record
      },
      getSessionMessages: () => capturedMessages,
      getWorktreeByPath: () => null,
      updateSession: noop
    })

    const connected = await implementer.connect(worktreePath, hiveSessionId)
    sessionId = connected.sessionId
    await implementer.prompt(worktreePath, sessionId, prompt, { providerID, modelID })

    const persisted = capturedMessages.map((message) => [message.role, message.content])
    const assistantMessage = capturedMessages
      .filter((message) => message.role === 'assistant')
      .at(-1)

    if (!assistantMessage?.content?.includes(mockResponse)) {
      fail('Built mock probe did not persist the expected assistant response.', {
        providerID,
        modelID,
        persisted
      })
      return
    }

    printJson({
      ok: true,
      status: 'completed',
      mode: 'mock',
      providerID,
      modelID,
      implementerChunk,
      hiveSessionId,
      runtimeSessionId: sessionId,
      persistedMessageCount: capturedMessages.length,
      persisted
    })
  } catch (error) {
    fail('Built mock probe failed.', {
      providerID,
      modelID,
      errorMessage: error instanceof Error ? error.message : String(error)
    })
  } finally {
    if (implementer && sessionId) {
      await implementer.disconnect(worktreePath, sessionId).catch(() => {})
    }

    if (previousMockResponse === undefined) {
      delete process.env.XUANPU_AGENT_MOCK_RESPONSE
    } else {
      process.env.XUANPU_AGENT_MOCK_RESPONSE = previousMockResponse
    }
  }
}

void runProbe()
