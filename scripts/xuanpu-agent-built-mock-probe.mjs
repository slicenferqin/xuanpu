#!/usr/bin/env node

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  fail,
  getBuiltProbeSqliteState,
  loadBuiltXuanpuAgentImplementer,
  noop,
  printJson,
  resetBuiltProbeSqliteState
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
  const getWorktreeByPathCalls = []
  const previousHome = process.env.HOME
  const previousFakeSqlite = process.env.XUANPU_AGENT_BUILT_PROBE_FAKE_SQLITE
  const probeHome = mkdtempSync(join(tmpdir(), 'xuanpu-agent-built-mock-'))
  const probeWorktree = {
    id: 'xuanpu-agent-built-mock-worktree',
    project_id: 'xuanpu-agent-built-mock-project',
    path: process.cwd()
  }

  process.env.XUANPU_AGENT_MOCK_RESPONSE = mockResponse
  process.env.HOME = probeHome
  process.env.XUANPU_AGENT_BUILT_PROBE_FAKE_SQLITE = '1'
  resetBuiltProbeSqliteState()

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
      getWorktreeByPath: (path) => {
        getWorktreeByPathCalls.push(path)
        return path === worktreePath ? probeWorktree : null
      },
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

    const contextPackage = getBuiltProbeSqliteState().contextPackages.find(
      (record) => record.session_id === hiveSessionId
    )

    if (!contextPackage) {
      fail('Built mock probe did not persist a context package.', {
        hiveSessionId,
        worktreePath,
        getWorktreeByPathCalls
      })
      return
    }

    const contextDecisions = JSON.parse(contextPackage.decisions_json)
    const contextSections = JSON.parse(contextPackage.sections_json)
    if (
      contextPackage.runtime_id !== 'xuanpu-agent' ||
      contextPackage.model_provider_id !== providerID ||
      contextPackage.model_id !== modelID ||
      contextDecisions.visibleTranscriptPolicy !== 'persist-user-authored-message-only'
    ) {
      fail('Built mock probe context package did not match the selected model or policy.', {
        providerID,
        modelID,
        contextPackage,
        contextDecisions
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
      persisted,
      contextPackage: {
        sessionId: contextPackage.session_id,
        worktreeId: contextPackage.worktree_id,
        runtimeId: contextPackage.runtime_id,
        modelProviderId: contextPackage.model_provider_id,
        modelId: contextPackage.model_id,
        renderedMarkdownStored: Boolean(contextPackage.rendered_markdown),
        visibleTranscriptPolicy: contextDecisions.visibleTranscriptPolicy,
        sectionIds: contextSections.map((section) => section.id)
      }
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
    if (previousHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = previousHome
    }
    if (previousFakeSqlite === undefined) {
      delete process.env.XUANPU_AGENT_BUILT_PROBE_FAKE_SQLITE
    } else {
      process.env.XUANPU_AGENT_BUILT_PROBE_FAKE_SQLITE = previousFakeSqlite
    }
  }
}

void runProbe()
