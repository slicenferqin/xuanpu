/**
 * Test runner compression strategies.
 *
 * vitest / jest / pnpm test / pytest / cargo test  →
 *   extract pass/fail/skip counts, keep failure details only.
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

export function compressTest(
  output: string,
  profile: CommandProfile,
  metadata: CompressionMetadata
): CompressionResult {
  const lines = output.split('\n')
  const failures: string[] = []
  const summaryLines: string[] = []
  let passed = 0
  let failed = 0
  let skipped = 0
  let inFailure = false
  let failureBuffer: string[] = []

  for (const line of lines) {
    // vitest-style: " ✓ src/file.test.ts > test name"
    if (/^\s*✓\s/.test(line)) {
      passed++
      continue
    }
    // vitest-style: " ↓ src/file.test.ts > test name" or jest-style: "  ○ skipped test"
    if (/^\s*[↓○]\s/.test(line)) {
      skipped++
      continue
    }
    // vitest-style: " × src/file.test.ts > test name"
    // jest-style: "  ● test name"
    if (/^\s*[×✕✖]\s/.test(line) || /^\s*●\s/.test(line)) {
      if (inFailure && failureBuffer.length > 0) {
        failures.push(failureBuffer.join('\n'))
        failureBuffer = []
      }
      inFailure = true
      failed++
      failureBuffer.push(line)
      continue
    }
    // vitest-style: " ❯ src/file.ts:42:15"
    if (/^\s*[❯>]\s/.test(line) && inFailure) {
      failureBuffer.push(line)
      continue
    }
    // Blank line ends a failure block
    if (line.trim() === '' && inFailure && failureBuffer.length > 0) {
      failures.push(failureBuffer.join('\n'))
      failureBuffer = []
      inFailure = false
      continue
    }
    if (inFailure) {
      failureBuffer.push(line)
      continue
    }

    // Summary lines
    if (/Tests\s+\d+\s+(passed|failed)/i.test(line)) summaryLines.push(line)
    if (/Test Suites/i.test(line) && /\d+\s+(passed|failed)/i.test(line)) summaryLines.push(line)
    if (/Snapshots/i.test(line)) summaryLines.push(line)
    if (/Time:/i.test(line)) summaryLines.push(line)
    // Generic pass/fail counts
    if (/(\d+)\s+passed/.test(line)) summaryLines.push(line)
    if (/(\d+)\s+failed/.test(line)) summaryLines.push(line)
    if (/skipped/i.test(line) && /\d+/.test(line)) summaryLines.push(line)
    if (/^Tests:/i.test(line)) summaryLines.push(line)

    // Extract skip count from summary lines like "Tests: 10 passed, 2 failed, 1 skipped"
    const skipMatch = line.match(/(\d+)\s+skipped/i)
    if (skipMatch) {
      const parsed = parseInt(skipMatch[1], 10)
      if (!isNaN(parsed)) skipped = parsed
    }
  }

  // Drain remaining failure buffer
  if (inFailure && failureBuffer.length > 0) {
    failures.push(failureBuffer.join('\n'))
  }

  // Fallback: if no structured summary found, use exit code + basic stats
  if (passed === 0 && failed === 0 && summaryLines.length === 0) {
    // Couldn't parse — keep the last N lines (summary is usually at the end)
    const tailLines = lines.slice(-15)
    const text =
      metadata.exitCode !== 0
        ? `Tests FAILED (exit ${metadata.exitCode})\n\n${tailLines.join('\n')}`
        : `Tests passed\n\n${tailLines.join('\n')}`
    return makeResult(output, text, profile, metadata, ['test:tail'])
  }

  const parts: string[] = []

  // Counts
  if (passed > 0 || failed > 0 || skipped > 0) {
    const counts = [`Passed: ${passed}`, `Failed: ${failed}`]
    if (skipped > 0) counts.push(`Skipped: ${skipped}`)
    parts.push(counts.join(' | '))
  }

  // Summary lines
  if (summaryLines.length > 0) {
    parts.push(summaryLines.join('\n'))
  }

  // Failures
  if (failures.length > 0) {
    parts.push(`\nFailures (${failures.length}):`)
    for (const f of failures) {
      parts.push(f)
    }
  }

  const text = parts.join('\n')
  return makeResult(output, text, profile, metadata, ['test:structured'])
}
