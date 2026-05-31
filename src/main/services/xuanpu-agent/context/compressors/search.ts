/**
 * Search tool compression strategies.
 *
 * rg / grep / find / fd →
 *   dedup by file, group results by file, cap at N results.
 */
import type { CommandProfile, CompressionMetadata, CompressionResult } from '../compressor'

function makeResult(
  rawOutput: string,
  text: string,
  _profile: CommandProfile,
  metadata: CompressionMetadata,
  ruleHits: string[]
): CompressionResult {
  const beforeBytes = Buffer.byteLength(rawOutput, 'utf-8')
  const afterBytes = Buffer.byteLength(text, 'utf-8')
  return {
    text,
    beforeBytes,
    afterBytes,
    compressionRatio: beforeBytes > 0 ? 1 - afterBytes / beforeBytes : 0,
    ruleHits,
    rawRef: metadata.traceId
      ? `command-trace:${metadata.traceId}`
      : `command_traces:${metadata.command}:${Date.now()}`,
    exitCode: metadata.exitCode,
    durationMs: metadata.durationMs,
    timedOut: metadata.timedOut,
    aborted: metadata.aborted
  }
}

export function compressSearch(
  output: string,
  profile: CommandProfile,
  metadata: CompressionMetadata
): CompressionResult {
  const lines = output.split('\n').filter((l) => l.trim())

  if (lines.length === 0) {
    return makeResult(output, 'No matches found.', profile, metadata, ['search:empty'])
  }

  // Group results by file. Format: "file:line:text" (rg default)
  const byFile = new Map<string, string[]>()
  for (const line of lines) {
    const colonIdx = line.indexOf(':')
    if (colonIdx < 0) {
      // Can't parse — keep as-is
      const existing = byFile.get('(unknown)') ?? []
      existing.push(line)
      byFile.set('(unknown)', existing)
      continue
    }
    const file = line.slice(0, colonIdx)
    const existing = byFile.get(file) ?? []
    existing.push(line.slice(colonIdx + 1))
    byFile.set(file, existing)
  }

  // Per-file: cap at 20 matches per file
  const parts: string[] = []
  let totalShown = 0
  const MAX_RESULTS = 100
  const MAX_PER_FILE = 20

  for (const [file, fileLines] of byFile) {
    if (totalShown >= MAX_RESULTS) break

    const shown = fileLines.slice(0, MAX_PER_FILE)
    const omitted = fileLines.length - shown.length

    for (const matchLine of shown) {
      parts.push(`${file}:${matchLine}`)
      totalShown++
      if (totalShown >= MAX_RESULTS) break
    }

    if (omitted > 0) {
      parts.push(`  ... (${omitted} more matches in ${file})`)
    }
  }

  const totalMatches = lines.length
  const header =
    totalShown < totalMatches
      ? `Showing ${totalShown} of ${totalMatches} matches, grouped by file:\n`
      : `${totalMatches} match(es):\n`

  const text = header + parts.join('\n')
  return makeResult(output, text, profile, metadata, ['search:grouped'])
}
