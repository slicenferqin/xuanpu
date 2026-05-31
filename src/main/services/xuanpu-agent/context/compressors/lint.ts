/**
 * Lint / build compression strategies.
 *
 * tsc / eslint / ruff / clippy / build tools →
 *   classify output, keep errors only, summarize warnings, drop success noise.
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

export function compressLint(
  output: string,
  profile: CommandProfile,
  metadata: CompressionMetadata
): CompressionResult {
  const lines = output.split('\n')
  const errors: string[] = []
  const warnings: string[] = []
  const summaryLines: string[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // tsc-style: "src/file.ts(42,15): error TS2345: ..."
    // eslint-style: "  42:15  error  message  rule-name"
    // ruff-style: "src/file.py:42:15: E501 message"

    if (/error\b/i.test(trimmed) && !/0 errors/i.test(trimmed)) {
      errors.push(trimmed)
      continue
    }

    if (/warning\b/i.test(trimmed) && !/0 warnings/i.test(trimmed)) {
      warnings.push(trimmed)
      continue
    }

    // Summary: "Found N errors" / "N error(s)"
    if (/found\s+\d+\s+error/i.test(trimmed)) summaryLines.push(trimmed)
    if (/\d+\s+error/i.test(trimmed)) summaryLines.push(trimmed)
    if (/error.*\d+/i.test(trimmed) && !/error\s+TS\d+/i.test(trimmed)) summaryLines.push(trimmed)

    // "error Command failed" from package managers
    if (/error Command failed/i.test(trimmed)) errors.push(trimmed)

    // Build errors: "ERROR in ./src/..."
    if (/^ERROR\b/.test(trimmed)) errors.push(trimmed)
  }

  const parts: string[] = []

  // Summary first
  const errorCount = errors.length
  const warningCount = warnings.length
  parts.push(`Errors: ${errorCount} | Warnings: ${warningCount}`)

  if (summaryLines.length > 0) {
    parts.push(summaryLines.join('\n'))
  }

  // Errors
  if (errors.length > 0) {
    // Cap at 50 errors
    const shown = errors.length <= 50 ? errors : errors.slice(0, 50)
    parts.push(`\nErrors (showing ${Math.min(errors.length, 50)} of ${errors.length}):`)
    for (const e of shown) {
      parts.push(`  ${e}`)
    }
    if (errors.length > 50) {
      parts.push(`  ... (${errors.length - 50} more errors)`)
    }
  }

  // Warnings
  if (warnings.length > 0 && warnings.length <= 20) {
    parts.push(`\nWarnings:`)
    for (const w of warnings) {
      parts.push(`  ${w}`)
    }
  }

  if (errors.length === 0 && warningCount === 0) {
    parts.push('\nClean — no errors or warnings.')
  }

  const text = parts.join('\n')
  return makeResult(output, text, profile, metadata, ['lint:errors-only'])
}
