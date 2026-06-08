/**
 * Config loader for xuanpu-agent.
 *
 * Reads ~/.xuanpu/xuanpu-agent.json, expands ~, validates fields,
 * returns a normalized XuanpuAgentConfig object.
 *
 * Does NOT read ~/.codex/* or any other agent's config files.
 * Does NOT determine whether a provider credential is present —
 * that responsibility belongs to model-config.ts.
 */
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { createLogger } from '../logger'

let _log: ReturnType<typeof createLogger> | null = null
function log() {
  if (!_log) _log = createLogger({ component: 'XuanpuAgentConfigLoader' })
  return _log
}

const CONFIG_DIR = '.xuanpu'
const CONFIG_FILE = 'xuanpu-agent.json'

export interface XuanpuAgentProviderConfig {
  baseUrl?: string
  apiKeyEnv?: string
  authFile?: string
  authKey?: string
}

type ConfigModelRef = {
  providerID: string
  modelID: string
  variant?: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  verbosity?: 'low' | 'medium' | 'high'
  providerOptions?: Record<string, unknown>
}

export interface XuanpuAgentConfig {
  enabled: boolean
  mainModel: ConfigModelRef
  compactionModel?: ConfigModelRef | null
  providers?: Record<string, XuanpuAgentProviderConfig>
  context?: {
    contextWindow?: number
    autoCompactTokenLimit?: number
  }
}

export type XuanpuAgentConfigSource = 'xuanpu-agent-json' | 'env-only' | 'config-error'

export interface XuanpuAgentConfigLoadResult {
  config: XuanpuAgentConfig
  configSource: XuanpuAgentConfigSource
  configPath: string
  configLoaded: boolean
}

const DEFAULT_MAIN_MODEL: XuanpuAgentConfig['mainModel'] = {
  providerID: 'anthropic',
  modelID: 'claude-haiku-4-5'
}

const DEFAULT_PROVIDER_ENV_KEYS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY'
}

const VALID_PROVIDER_IDS = new Set(['openai', 'anthropic', 'google'])
const VALID_REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high'])
const VALID_VERBOSITY = new Set(['low', 'medium', 'high'])

function getConfigPath(): string {
  return join(homedir(), CONFIG_DIR, CONFIG_FILE)
}

export function expandTilde(filePath: string): string {
  if (filePath.startsWith('~')) {
    return resolve(homedir(), filePath.slice(1).replace(/^\//, ''))
  }
  return resolve(filePath)
}

function makeDefaultConfig(): XuanpuAgentConfig {
  return {
    enabled: false,
    mainModel: { ...DEFAULT_MAIN_MODEL }
  }
}

function validateProviderID(providerID: unknown, field: string): string {
  if (typeof providerID !== 'string' || !providerID.trim()) {
    throw new Error(`Invalid ${field}: providerID must be a non-empty string.`)
  }
  return providerID.trim()
}

function validateModelID(modelID: unknown, field: string): string {
  if (typeof modelID !== 'string' || !modelID.trim()) {
    throw new Error(`Invalid ${field}: modelID must be a non-empty string.`)
  }
  return modelID.trim()
}

function validateModelRef(
  raw: unknown,
  field: string
): ConfigModelRef {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid ${field}: expected an object with providerID and modelID.`)
  }
  const obj = raw as Record<string, unknown>
  const providerID = validateProviderID(obj.providerID, field)
  const modelID = validateModelID(obj.modelID, field)
  const result: ConfigModelRef = {
    providerID,
    modelID
  }
  if (obj.variant !== undefined) {
    if (typeof obj.variant !== 'string') {
      throw new Error(`Invalid ${field}.variant: expected a string.`)
    }
    result.variant = obj.variant
  }
  if (obj.reasoningEffort !== undefined) {
    if (
      typeof obj.reasoningEffort !== 'string' ||
      !VALID_REASONING_EFFORTS.has(obj.reasoningEffort)
    ) {
      throw new Error(
        `Invalid ${field}.reasoningEffort: expected one of minimal, low, medium, high.`
      )
    }
    result.reasoningEffort = obj.reasoningEffort as ConfigModelRef['reasoningEffort']
  }
  if (obj.verbosity !== undefined) {
    if (typeof obj.verbosity !== 'string' || !VALID_VERBOSITY.has(obj.verbosity)) {
      throw new Error(`Invalid ${field}.verbosity: expected one of low, medium, high.`)
    }
    result.verbosity = obj.verbosity as ConfigModelRef['verbosity']
  }
  if (obj.providerOptions !== undefined) {
    if (!obj.providerOptions || typeof obj.providerOptions !== 'object' || Array.isArray(obj.providerOptions)) {
      throw new Error(`Invalid ${field}.providerOptions: expected an object.`)
    }
    result.providerOptions = obj.providerOptions as Record<string, unknown>
  }
  return result
}

function validateProviderConfig(
  raw: unknown,
  providerID: string
): XuanpuAgentProviderConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid providers.${providerID}: expected an object.`)
  }
  const obj = raw as Record<string, unknown>
  const result: XuanpuAgentProviderConfig = {}

  if (obj.baseUrl !== undefined) {
    if (typeof obj.baseUrl !== 'string' || !obj.baseUrl.trim()) {
      throw new Error(`Invalid providers.${providerID}.baseUrl: expected a non-empty string URL.`)
    }
    try {
      const parsed = new URL(obj.baseUrl)
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`Invalid providers.${providerID}.baseUrl: expected an http(s) URL.`)
      }
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`Invalid providers.${providerID}.baseUrl: expected an absolute http(s) URL.`)
      }
      throw error
    }
    result.baseUrl = obj.baseUrl.trim().replace(/\/+$/, '')
  }

  if (obj.apiKeyEnv !== undefined) {
    if (typeof obj.apiKeyEnv !== 'string' || !obj.apiKeyEnv.trim()) {
      throw new Error(`Invalid providers.${providerID}.apiKeyEnv: expected a non-empty string.`)
    }
    result.apiKeyEnv = obj.apiKeyEnv.trim()
  }

  if (obj.authFile !== undefined) {
    if (typeof obj.authFile !== 'string' || !obj.authFile.trim()) {
      throw new Error(`Invalid providers.${providerID}.authFile: expected a non-empty string path.`)
    }
    result.authFile = obj.authFile.trim()
  }

  if (obj.authKey !== undefined) {
    if (typeof obj.authKey !== 'string' || !obj.authKey.trim()) {
      throw new Error(`Invalid providers.${providerID}.authKey: expected a non-empty string.`)
    }
    result.authKey = obj.authKey.trim()
  }

  return result
}

function parseConfig(rawJson: unknown): XuanpuAgentConfig {
  if (!rawJson || typeof rawJson !== 'object') {
    throw new Error('Config must be a JSON object.')
  }
  const obj = rawJson as Record<string, unknown>

  const config: XuanpuAgentConfig = {
    enabled: false,
    mainModel: { ...DEFAULT_MAIN_MODEL }
  }

  // enabled
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== 'boolean') {
      throw new Error('Invalid enabled: expected a boolean.')
    }
    config.enabled = obj.enabled
  }

  // mainModel
  if (obj.mainModel !== undefined) {
    config.mainModel = validateModelRef(obj.mainModel, 'mainModel')
  }

  // compactionModel (optional, nullable)
  if (obj.compactionModel !== undefined) {
    if (obj.compactionModel === null) {
      config.compactionModel = null
    } else {
      config.compactionModel = validateModelRef(obj.compactionModel, 'compactionModel')
    }
  }

  // providers (optional)
  if (obj.providers !== undefined) {
    if (!obj.providers || typeof obj.providers !== 'object') {
      throw new Error('Invalid providers: expected an object keyed by provider ID.')
    }
    const providersObj = obj.providers as Record<string, unknown>
    const providers: Record<string, XuanpuAgentProviderConfig> = {}
    for (const [pid, raw] of Object.entries(providersObj)) {
      if (!VALID_PROVIDER_IDS.has(pid)) {
        log().warn(`Unknown provider ID "${pid}" in config — skipping`)
        continue
      }
      providers[pid] = validateProviderConfig(raw, pid)
      // Apply defaults for apiKeyEnv if not specified
      if (!providers[pid].apiKeyEnv && DEFAULT_PROVIDER_ENV_KEYS[pid]) {
        providers[pid].apiKeyEnv = DEFAULT_PROVIDER_ENV_KEYS[pid]
      }
      // Apply default authKey = apiKeyEnv if not specified
      if (!providers[pid].authKey && providers[pid].apiKeyEnv) {
        providers[pid].authKey = providers[pid].apiKeyEnv
      }
    }
    config.providers = providers
  }

  // context (optional)
  if (obj.context !== undefined) {
    if (!obj.context || typeof obj.context !== 'object') {
      throw new Error('Invalid context: expected an object.')
    }
    const ctxObj = obj.context as Record<string, unknown>
    const ctx: XuanpuAgentConfig['context'] = {}

    if (ctxObj.contextWindow !== undefined) {
      if (typeof ctxObj.contextWindow !== 'number' || ctxObj.contextWindow <= 0) {
        throw new Error('Invalid context.contextWindow: expected a positive number.')
      }
      ctx.contextWindow = ctxObj.contextWindow
    }

    if (ctxObj.autoCompactTokenLimit !== undefined) {
      if (typeof ctxObj.autoCompactTokenLimit !== 'number' || ctxObj.autoCompactTokenLimit <= 0) {
        throw new Error('Invalid context.autoCompactTokenLimit: expected a positive number.')
      }
      ctx.autoCompactTokenLimit = ctxObj.autoCompactTokenLimit
    }

    if (Object.keys(ctx).length > 0) {
      config.context = ctx
    }
  }

  return config
}

/**
 * Load xuanpu-agent config from ~/.xuanpu/xuanpu-agent.json.
 *
 * - If the file does not exist, returns env-only defaults (no error).
 * - If the file exists but is malformed, throws a config error.
 * - If the file exists with missing fields, fills in defaults.
 */
export function loadXuanpuAgentConfig(): XuanpuAgentConfigLoadResult {
  const configPath = getConfigPath()

  if (!existsSync(configPath)) {
    log().info('No xuanpu-agent config file found, using env-only defaults', { configPath })
    return {
      config: makeDefaultConfig(),
      configSource: 'env-only',
      configPath,
      configLoaded: false
    }
  }

  let rawContent: string
  try {
    rawContent = readFileSync(configPath, 'utf-8')
  } catch (error) {
    throw new Error(
      `Failed to read xuanpu-agent config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch {
    throw new Error(
      `Failed to parse xuanpu-agent config at ${configPath}: invalid JSON.`
    )
  }

  try {
    const config = parseConfig(parsed)
    log().info('Loaded xuanpu-agent config', {
      configPath,
      enabled: config.enabled,
      mainModel: `${config.mainModel.providerID}/${config.mainModel.modelID}`
    })
    return {
      config,
      configSource: 'xuanpu-agent-json',
      configPath,
      configLoaded: true
    }
  } catch (error) {
    throw new Error(
      `Invalid xuanpu-agent config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
