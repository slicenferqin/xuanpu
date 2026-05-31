/**
 * Container tool compression strategies.
 *
 * docker / kubectl / podman / helm →
 *   keep status lines, errors, and key metadata; drop progress bars and verbose pull output.
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

export function compressContainer(
  output: string,
  profile: CommandProfile,
  metadata: CompressionMetadata
): CompressionResult {
  const lines = output.split('\n')
  const kept: string[] = []
  let progressStripped = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Drop progress/loading lines
    if (isProgressLine(trimmed)) {
      progressStripped++
      continue
    }

    // Keep errors, warnings, status
    if (/error|fail|denied|not found|unauthorized|forbidden/i.test(trimmed)) {
      kept.push(`[ERR] ${trimmed}`)
      continue
    }
    if (/warn/i.test(trimmed) && !/warn.*\d+%/i.test(trimmed)) {
      kept.push(`[WARN] ${trimmed}`)
      continue
    }
    if (/running|up|healthy|ready|started|created|applied|configured/i.test(trimmed)) {
      kept.push(trimmed)
      continue
    }
    // Keep ID/hash lines
    if (/^[a-f0-9]{12,64}$/i.test(trimmed)) {
      kept.push(trimmed)
      continue
    }
    // Keep table-like output (docker ps, kubectl get)
    if (/^\s*[\w.-]+\s{2,}/.test(trimmed) && trimmed.length > 20) {
      kept.push(trimmed)
      continue
    }
  }

  // If we stripped everything, keep the tail
  if (kept.length === 0) {
    const tail = lines.slice(-20)
    return makeResult(output, tail.join('\n'), profile, metadata, ['container:tail'])
  }

  let text = kept.join('\n')
  if (progressStripped > 0) {
    text += `\n\n[${progressStripped} progress/loading lines stripped]`
  }
  return makeResult(output, text, profile, metadata, ['container:structured'])
}

function isProgressLine(line: string): boolean {
  if (/[█▓▒░▏▎▍▌▋▊▉]/.test(line)) return true
  if (/^\s*\[=*>.\s-]*\]\s*\d+%/.test(line)) return true // [====>    ] 45%
  if (/^\s*\d+(\.\d+)?[%]/.test(line)) return true // 45.2%
  if (/downloading|pulling|extracting|pushing|uploading/i.test(line) && /\d+[%]/.test(line))
    return true
  if (/^\s*[.]+$/.test(line)) return true // Docker build dots
  if (/^\s*#\d+\s/.test(line) && /^#\d+\s+(DONE|RUN|COPY|FROM)/.test(line)) return false // keep BuildKit lines
  if (/^\s*#\d+/.test(line) && /\[.*\]/.test(line)) return false // keep BuildKit status
  return false
}
