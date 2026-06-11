import type { AgentLoopConfig } from '@oh-my-pi/pi-agent-core'

type TransformToolCallArgumentsFn = NonNullable<AgentLoopConfig['transformToolCallArguments']>

export const RG_SEARCH_MIN_RESULTS = 1
export const RG_SEARCH_MAX_RESULTS = 200
export const RG_SEARCH_DEFAULT_MAX_RESULTS = 50

export function normalizeToolCallArguments(
  args: Record<string, unknown>,
  toolName: string
): Record<string, unknown> {
  if (toolName !== 'rg_search') return args

  const normalized: Record<string, unknown> = {
    ...args,
    maxResults: normalizeRgSearchMaxResults(args.maxResults)
  }

  if (typeof args.glob === 'string') {
    const glob = args.glob.trim()
    if (glob) normalized.glob = glob
  }

  return normalized
}

export const normalizeToolCallArgumentsHook: TransformToolCallArgumentsFn =
  normalizeToolCallArguments

export function normalizeRgSearchMaxResults(value: unknown): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value.trim())
        : RG_SEARCH_DEFAULT_MAX_RESULTS

  if (!Number.isFinite(numeric)) return RG_SEARCH_DEFAULT_MAX_RESULTS

  return Math.max(RG_SEARCH_MIN_RESULTS, Math.min(RG_SEARCH_MAX_RESULTS, Math.trunc(numeric)))
}
