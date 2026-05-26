export interface TraceMaterializationTrace {
  id: string
  sessionId?: string | null
  worktreeId?: string | null
  command: string
  exitCode?: number | null
  category?: string | null
  createdAt?: string | number | null
}

export interface TraceMaterializationCandidate {
  signature: string
  normalizedCommand: string
  occurrenceCount: number
  traceIds: string[]
  sessionIds: string[]
  worktreeIds: string[]
  categories: string[]
  successCount: number
  failureCount: number
}

export interface TraceMaterializationOptions {
  minOccurrences?: number
  maxCandidates?: number
}

export function detectFrequentTraceCandidates(
  traces: TraceMaterializationTrace[],
  options: TraceMaterializationOptions = {}
): TraceMaterializationCandidate[] {
  const minOccurrences = options.minOccurrences ?? 3
  const maxCandidates = options.maxCandidates ?? 10
  const groups = new Map<string, TraceMaterializationTrace[]>()

  for (const trace of traces) {
    const normalizedCommand = normalizeCommand(trace.command)
    if (!normalizedCommand) continue
    const signature = commandSignature(normalizedCommand)
    groups.set(signature, [...(groups.get(signature) ?? []), trace])
  }

  return Array.from(groups.entries())
    .map(([signature, group]) => buildCandidate(signature, group))
    .filter((candidate) => candidate.occurrenceCount >= minOccurrences)
    .sort((left, right) => {
      if (right.occurrenceCount !== left.occurrenceCount) {
        return right.occurrenceCount - left.occurrenceCount
      }
      return right.traceIds.length - left.traceIds.length
    })
    .slice(0, maxCandidates)
}

export function normalizeCommand(command: string): string {
  return command
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/(["'])[^"']+\1/g, '$1{value}$1')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '{sha}')
    .replace(/\b\d+\b/g, '{number}')
    .replace(
      /(?:^|\s)([\w@./-]+\.(?:ts|tsx|js|jsx|json|md|css|sql|yaml|yml|toml|rs|go|py|java|kt|swift|mjs|cjs|html|scss))/g,
      ' {path}'
    )
    .replace(/\s+/g, ' ')
    .trim()
}

function commandSignature(normalizedCommand: string): string {
  return normalizedCommand
    .split(' ')
    .map((part, index) => {
      if (index <= 1) return part
      if (part.startsWith('-')) return part.replace(/=.*/, '={value}')
      if (part === '{path}' || part === '{number}' || part === '{sha}') return part
      return part.includes('/') ? '{path}' : part
    })
    .join(' ')
}

function buildCandidate(
  signature: string,
  group: TraceMaterializationTrace[]
): TraceMaterializationCandidate {
  return {
    signature,
    normalizedCommand: normalizeCommand(group[0]?.command ?? ''),
    occurrenceCount: group.length,
    traceIds: unique(group.map((trace) => trace.id)),
    sessionIds: unique(group.map((trace) => trace.sessionId ?? null)),
    worktreeIds: unique(group.map((trace) => trace.worktreeId ?? null)),
    categories: unique(group.map((trace) => trace.category ?? null)),
    successCount: group.filter((trace) => trace.exitCode === 0).length,
    failureCount: group.filter(
      (trace) => typeof trace.exitCode === 'number' && trace.exitCode !== 0
    ).length
  }
}

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))))
}
