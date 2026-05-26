/**
 * Database tool compression strategies.
 *
 * prisma / drizzle-kit / sqlite3 / psql / pg →
 *   keep migration/generation summaries, errors, and key output; drop verbose SQL.
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

export function compressDb(
  output: string,
  profile: CommandProfile,
  metadata: CompressionMetadata
): CompressionResult {
  const lines = output.split('\n')
  const kept: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Keep errors/warnings
    if (/error|fail|fatal|panic|denied/i.test(trimmed)) {
      kept.push(`[ERR] ${trimmed}`)
      continue
    }
    if (/warn/i.test(trimmed)) {
      kept.push(`[WARN] ${trimmed}`)
      continue
    }

    // Migration/generation summary
    if (/migration|applied|generated|created.*table/i.test(trimmed)) {
      kept.push(trimmed)
      continue
    }

    // Prisma-specific
    if (/✔|✓|×/.test(trimmed) && trimmed.length < 200) {
      kept.push(trimmed)
      continue
    }

    // SQL result summaries
    if (/^\s*\d+\s+rows?\b/i.test(trimmed)) {
      kept.push(trimmed)
      continue
    }
    if (/^\(\d+\s+rows?\)/i.test(trimmed)) {
      kept.push(trimmed)
      continue
    }

    // Keep table-like output headers
    if (/^\s*[\w]+(\s+\|)/.test(trimmed) || /^[\s-+|]+$/.test(trimmed)) {
      kept.push(trimmed)
      continue
    }
  }

  if (kept.length === 0) {
    const tail = lines.slice(-20).filter(Boolean)
    return makeResult(output, tail.join('\n'), profile, metadata, ['db:tail'])
  }

  const text = kept.join('\n')
  return makeResult(output, text, profile, metadata, ['db:structured'])
}
