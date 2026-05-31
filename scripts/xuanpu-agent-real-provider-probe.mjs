#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  fail,
  getBuiltProbeSqliteState,
  loadBuiltXuanpuAgentImplementer,
  noop,
  printJson,
  resetBuiltProbeSqliteState
} from './xuanpu-agent-built-probe-utils.mjs'

const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5.4',
  google: 'gemini-2.5-pro'
}

const PROVIDER_ENV_KEYS = {
  anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_FOUNDRY_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY']
}

function hasCredential(providerID) {
  const envKeys = PROVIDER_ENV_KEYS[providerID] ?? []
  return envKeys.some((key) => typeof process.env[key] === 'string' && process.env[key].trim())
}

function stripTomlQuotes(value) {
  return String(value)
    .trim()
    .replace(/^['"]|['"]$/g, '')
}

function readCodexOpenAICompatBaseUrl() {
  const configPath = join(homedir(), '.codex/config.toml')
  if (!existsSync(configPath)) return null

  const providers = new Map()
  let selectedProvider = null
  let section = ''

  for (const rawLine of readFileSync(configPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const sectionMatch = line.match(/^\[(.+)]$/)
    if (sectionMatch) {
      section = sectionMatch[1]
      continue
    }

    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/)
    if (!kv) continue

    const [, key, rawValue] = kv
    const value = stripTomlQuotes(rawValue)
    if (!section && key === 'model_provider') {
      selectedProvider = value
      continue
    }

    const providerMatch = section.match(/^model_providers\.([A-Za-z0-9_.-]+)$/)
    if (!providerMatch) continue

    const providerID = providerMatch[1]
    const provider = providers.get(providerID) ?? {}
    provider[key] = value
    providers.set(providerID, provider)
  }

  if (!selectedProvider) return null

  const provider = providers.get(selectedProvider)
  if (!provider?.base_url) return null

  return {
    providerID: selectedProvider,
    baseUrl: provider.base_url.replace(/\/+$/, ''),
    wireApi: provider.wire_api ?? null,
    requiresOpenAIAuth: provider.requires_openai_auth === 'true'
  }
}

function installCodexOpenAICompatBaseUrl(providerID) {
  if (providerID !== 'openai') return null
  if (process.env.XUANPU_AGENT_OPENAI_BASE_URL?.trim() || process.env.OPENAI_BASE_URL?.trim()) {
    return null
  }

  const config = readCodexOpenAICompatBaseUrl()
  if (!config?.requiresOpenAIAuth) return null

  process.env.XUANPU_AGENT_OPENAI_BASE_URL = config.baseUrl
  return config
}

async function runProbe() {
  if (process.env.XUANPU_AGENT_REAL_PROVIDER_PROBE !== '1') {
    printJson({
      ok: true,
      status: 'skipped',
      reason: 'Set XUANPU_AGENT_REAL_PROVIDER_PROBE=1 to call a real provider.'
    })
    return
  }

  if (Object.prototype.hasOwnProperty.call(process.env, 'XUANPU_AGENT_MOCK_RESPONSE')) {
    fail('Unset XUANPU_AGENT_MOCK_RESPONSE before running the real provider probe.')
    return
  }

  const providerID =
    process.env.XUANPU_AGENT_PROVIDER_ID || process.env.XUANPU_AGENT_PROVIDER || 'anthropic'
  const modelID =
    process.env.XUANPU_AGENT_MODEL_ID ||
    process.env.XUANPU_AGENT_MODEL ||
    DEFAULT_MODELS[providerID] ||
    ''
  const prompt =
    process.env.XUANPU_AGENT_REAL_PROVIDER_PROMPT ||
    'Reply with one short sentence confirming the xuanpu-agent real provider probe succeeded.'
  const previousXuanpuOpenAIBaseUrl = process.env.XUANPU_AGENT_OPENAI_BASE_URL
  const codexOpenAICompatBaseUrl = installCodexOpenAICompatBaseUrl(providerID)

  if (!modelID) {
    fail('No model selected for real provider probe.', { providerID })
    return
  }

  if (!hasCredential(providerID)) {
    fail('Missing provider credential environment variable for real provider probe.', {
      providerID,
      expectedEnv: PROVIDER_ENV_KEYS[providerID] ?? []
    })
    return
  }

  const previousHome = process.env.HOME
  const previousFakeSqlite = process.env.XUANPU_AGENT_BUILT_PROBE_FAKE_SQLITE
  const probeHome = mkdtempSync(join(tmpdir(), 'xuanpu-agent-real-provider-'))
  const restoreProbeEnv = () => {
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
    if (previousXuanpuOpenAIBaseUrl === undefined) {
      delete process.env.XUANPU_AGENT_OPENAI_BASE_URL
    } else {
      process.env.XUANPU_AGENT_OPENAI_BASE_URL = previousXuanpuOpenAIBaseUrl
    }
  }

  process.env.HOME = probeHome
  process.env.XUANPU_AGENT_BUILT_PROBE_FAKE_SQLITE = '1'
  resetBuiltProbeSqliteState()

  let XuanpuAgentImplementer
  let implementerChunk
  try {
    const builtProbe = loadBuiltXuanpuAgentImplementer()
    XuanpuAgentImplementer = builtProbe.XuanpuAgentImplementer
    implementerChunk = builtProbe.implementerChunk
  } catch (error) {
    restoreProbeEnv()
    fail(error instanceof Error ? error.message : String(error))
    return
  }

  const capturedMessages = []
  const getWorktreeByPathCalls = []
  const implementer = new XuanpuAgentImplementer()
  const worktreePath = process.cwd()
  const hiveSessionId = `xuanpu-agent-real-provider-probe-${Date.now()}`
  const probeWorktree = {
    id: 'xuanpu-agent-real-provider-worktree',
    project_id: 'xuanpu-agent-real-provider-project',
    path: worktreePath
  }
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

  const timeoutMs = Number(process.env.XUANPU_AGENT_REAL_PROVIDER_TIMEOUT_MS || 60000)
  let sessionId = null
  let didTimeOut = false
  let timeout = null

  try {
    const connected = await implementer.connect(worktreePath, hiveSessionId)
    sessionId = connected.sessionId
    timeout = setTimeout(() => {
      didTimeOut = true
      void implementer.abort(worktreePath, sessionId).finally(() => {
        fail('Real provider probe timed out.', { providerID, modelID, timeoutMs })
        process.exit(1)
      })
    }, timeoutMs)

    implementer.setSelectedModel({ providerID, modelID })
    await implementer.prompt(worktreePath, sessionId, prompt, { providerID, modelID })
    if (didTimeOut) return

    const assistantMessage = capturedMessages
      .filter((message) => message.role === 'assistant')
      .at(-1)
    const responseText = assistantMessage?.content ?? ''
    const contextPackage = getBuiltProbeSqliteState().contextPackages.find(
      (record) => record.session_id === hiveSessionId
    )

    if (!contextPackage) {
      fail('Real provider probe did not persist a context package.', {
        providerID,
        modelID,
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
      fail('Real provider context package did not match the selected model or policy.', {
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
      providerID,
      modelID,
      openAICompatibleBaseUrl: codexOpenAICompatBaseUrl
        ? {
            source: 'codex-config',
            providerID: codexOpenAICompatBaseUrl.providerID,
            baseUrl: codexOpenAICompatBaseUrl.baseUrl,
            wireApi: codexOpenAICompatBaseUrl.wireApi
          }
        : process.env.XUANPU_AGENT_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL
          ? {
              source: process.env.XUANPU_AGENT_OPENAI_BASE_URL
                ? 'XUANPU_AGENT_OPENAI_BASE_URL'
                : 'OPENAI_BASE_URL',
              baseUrl: process.env.XUANPU_AGENT_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL
            }
          : null,
      implementerChunk,
      responseChars: responseText.length,
      responsePreview: responseText.slice(0, 200),
      persistedMessageCount: capturedMessages.length,
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
    if (!didTimeOut) {
      fail('Real provider probe failed.', {
        providerID,
        modelID,
        errorMessage: error instanceof Error ? error.message : String(error)
      })
    }
  } finally {
    if (timeout) clearTimeout(timeout)
    if (sessionId) {
      await implementer.disconnect(worktreePath, sessionId).catch(() => {})
    }
    restoreProbeEnv()
  }
}

void runProbe()
