import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Options } from '@anthropic-ai/claude-agent-sdk'

import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeProjectMemoryLoader' })

const PMR_ADAPTER_ENV_VAR = 'XUANPU_CLAUDE_PROJECT_MEMORY_ADAPTER'

type WithProjectMemory = (
  options: Options,
  config?: {
    cwd?: string
    agent_id?: string
    agent_version?: string
  }
) => Options | Promise<Options>

let cachedSpecifier: string | null = null
let cachedWrapper: WithProjectMemory | null = null
let warnedNoEnv = false

function resolveAdapterEntry(rawPath: string): string {
  const resolvedPath = resolve(rawPath)

  if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
    return join(resolvedPath, 'dist', 'index.js')
  }

  return resolvedPath
}

async function loadProjectMemoryWrapper(): Promise<WithProjectMemory | null> {
  const configuredPath = process.env[PMR_ADAPTER_ENV_VAR]?.trim()
  if (!configuredPath) {
    if (!warnedNoEnv) {
      log.info('Claude PMR adapter not configured; continuing without Project Memory', {
        envVar: PMR_ADAPTER_ENV_VAR
      })
      warnedNoEnv = true
    }
    return null
  }

  const entryPath = resolveAdapterEntry(configuredPath)
  const specifier = pathToFileURL(entryPath).href

  if (cachedSpecifier === specifier) {
    return cachedWrapper
  }

  try {
    const mod = (await import(specifier)) as { withProjectMemory?: WithProjectMemory }
    if (typeof mod.withProjectMemory !== 'function') {
      log.warn('Claude PMR adapter loaded but missing withProjectMemory export', {
        configuredPath,
        entryPath
      })
      cachedSpecifier = specifier
      cachedWrapper = null
      return null
    }

    cachedSpecifier = specifier
    cachedWrapper = mod.withProjectMemory
    log.info('Claude PMR adapter loaded', { configuredPath, entryPath })
    return cachedWrapper
  } catch (error) {
    cachedSpecifier = specifier
    cachedWrapper = null
    log.warn('Failed to load Claude PMR adapter; continuing without Project Memory', {
      configuredPath,
      entryPath,
      error: error instanceof Error ? error.message : String(error)
    })
    return null
  }
}

export async function maybeWithClaudeProjectMemory(options: Options): Promise<Options> {
  const withProjectMemory = await loadProjectMemoryWrapper()
  if (!withProjectMemory) return options

  try {
    return await withProjectMemory(options, {
      cwd: options.cwd,
      agent_id: 'xuanpu'
    })
  } catch (error) {
    log.warn('Claude PMR adapter threw during options wrapping; continuing without Project Memory', {
      error: error instanceof Error ? error.message : String(error),
      cwd: options.cwd
    })
    return options
  }
}

export const __testing__ = {
  resolveAdapterEntry,
  resetCache() {
    cachedSpecifier = null
    cachedWrapper = null
    warnedNoEnv = false
  }
}
