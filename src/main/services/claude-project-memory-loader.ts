import { existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeProjectMemoryLoader' })

const ENV_KEY = 'XUANPU_CLAUDE_PROJECT_MEMORY_ADAPTER'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Options = Record<string, any>
type WithProjectMemoryFn = (options: Options, config?: Record<string, unknown>) => Options

let cachedWrapper: WithProjectMemoryFn | null = null
let cachedSpecifier: string | null = null

/**
 * Resolve the adapter entry file from either a direct file path or a package directory.
 * - If `input` ends with `.js` or `.mjs` and exists → use directly
 * - Otherwise treat as a directory and resolve `<dir>/dist/index.js`
 */
function resolveAdapterEntry(input: string): string {
  if ((input.endsWith('.js') || input.endsWith('.mjs')) && existsSync(input)) {
    return input
  }
  return join(input, 'dist', 'index.js')
}

/**
 * Attempt to load the PMR adapter wrapper from the filesystem.
 * Returns null if the env var is missing, the file doesn't exist,
 * or the module doesn't expose `withProjectMemory`.
 */
async function loadWrapper(): Promise<WithProjectMemoryFn | null> {
  const adapterPath = process.env[ENV_KEY]
  if (!adapterPath) {
    log.info('PMR: env var not set, skipping')
    return null
  }

  const entry = resolveAdapterEntry(adapterPath)

  // Return cached wrapper if same specifier
  if (cachedWrapper && cachedSpecifier === entry) {
    return cachedWrapper
  }

  if (!existsSync(entry)) {
    log.warn('PMR: adapter entry not found, skipping', { entry })
    return null
  }

  try {
    const specifier = pathToFileURL(entry).href
    const mod = await import(specifier)
    const fn: unknown = mod.withProjectMemory ?? mod.default?.withProjectMemory

    if (typeof fn !== 'function') {
      log.warn('PMR: module loaded but withProjectMemory is not a function', {
        entry,
        exports: Object.keys(mod)
      })
      return null
    }

    cachedWrapper = fn as WithProjectMemoryFn
    cachedSpecifier = entry
    log.info('PMR: adapter loaded successfully', { entry })
    return cachedWrapper
  } catch (err) {
    log.warn('PMR: failed to import adapter module', {
      entry,
      error: err instanceof Error ? err.message : String(err)
    })
    return null
  }
}

/**
 * Optionally wrap Claude SDK options with PMR's project memory context.
 *
 * - Returns the original options unchanged when PMR is not configured or unavailable
 * - Never throws — all failures are logged and silently fall back
 */
export async function maybeWithClaudeProjectMemory(options: Options): Promise<Options> {
  const wrapper = await loadWrapper()
  if (!wrapper) return options

  try {
    const enhanced = wrapper(options, {
      cwd: options.cwd,
      agent_id: 'xuanpu'
    })
    log.info('PMR: options wrapped successfully')
    return enhanced
  } catch (err) {
    log.warn('PMR: withProjectMemory() threw, falling back to raw options', {
      error: err instanceof Error ? err.message : String(err)
    })
    return options
  }
}

/** @internal Testing-only exports */
export const __testing__ = {
  resolveAdapterEntry,
  resetCache(): void {
    cachedWrapper = null
    cachedSpecifier = null
  }
}
