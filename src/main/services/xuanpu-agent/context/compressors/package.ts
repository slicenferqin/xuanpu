/**
 * Package manager compression strategies.
 *
 * pnpm / npm / yarn / pip / cargo / bun →
 *   drop progress bars + install trees; keep errors, summary, and version changes.
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

export function compressPackage(
  output: string,
  profile: CommandProfile,
  metadata: CompressionMetadata
): CompressionResult {
  const lines = output.split('\n')
  const kept: string[] = []
  let progressStripped = 0
  let treeSkipped = false
  let inTree = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (inTree) treeSkipped = true
      inTree = false
      continue
    }

    // Drop progress bars and spinners
    if (/[█▓▒░▏▎▍▌▋▊▉]/.test(trimmed)) {
      progressStripped++
      continue
    }
    if (/^\s*(⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏)\s/.test(trimmed)) {
      progressStripped++
      continue
    }
    if (/^\s*\d+[%]/.test(trimmed)) {
      progressStripped++
      continue
    }

    // Detect dependency tree output
    if (/^[├└│─][─\s]/.test(trimmed)) {
      inTree = true
      if (!treeSkipped) kept.push('[dependency tree omitted]')
      treeSkipped = true
      continue
    }

    // Keep key lines
    if (/error|fail|denied|not found|ERR!/i.test(trimmed)) {
      kept.push(trimmed)
      continue
    }
    if (/warn|deprecated|notice/i.test(trimmed)) {
      kept.push(trimmed)
      continue
    }
    // Summary lines
    if (/added|removed|updated|changed|up to date|audited|found \d+/i.test(trimmed)) {
      kept.push(trimmed)
      continue
    }
    // Package version lines: "package@1.2.3" or "+ package@1.2.3"
    if (/^[\s+]*(package|@)?[\w./@-]+@[\d.]+/.test(trimmed) && trimmed.length < 120) {
      kept.push(trimmed)
      continue
    }
    // Done / success
    if (/done|success|complete|finished|ready/i.test(trimmed) && trimmed.length < 100) {
      kept.push(trimmed)
      continue
    }
    // Script execution lines
    if (/^[>≥]\s/.test(trimmed)) {
      kept.push(trimmed)
      continue
    }
    // Timing
    if (/done in|finished in|\d+\.?\d*s$/.test(trimmed)) {
      kept.push(trimmed)
      continue
    }
  }

  if (kept.length === 0) {
    const tail = lines.slice(-15).filter(Boolean)
    return makeResult(output, tail.join('\n'), profile, metadata, ['package:tail'])
  }

  let text = kept.join('\n')
  const notes: string[] = []
  if (progressStripped > 0) notes.push(`${progressStripped} progress lines stripped`)
  if (treeSkipped) notes.push('dependency tree omitted')
  if (notes.length > 0) text += `\n\n[${notes.join(', ')}]`

  return makeResult(output, text, profile, metadata, ['package:structured'])
}
