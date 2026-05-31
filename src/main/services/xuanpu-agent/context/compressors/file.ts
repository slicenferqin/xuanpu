/**
 * File operation compression strategies.
 *
 * cat / head / tail / ls →
 *   cat: head/tail truncation (already handled by ToolOutputTruncator, this is a
 *        second line of defense for tool output that slips through)
 *   ls:  cap at reasonable line count
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

export function compressFile(
  output: string,
  profile: CommandProfile,
  metadata: CompressionMetadata
): CompressionResult {
  const lines = output.split('\n')

  // Cap at 1000 lines for ls or cat output
  if (lines.length <= 1000) {
    return makeResult(output, output, profile, metadata, ['file:passthrough'])
  }

  // Head/tail truncation: keep first 500 + last 500
  const head = lines.slice(0, 500)
  const tail = lines.slice(-500)
  const omitted = lines.length - 1000
  const text = [...head, '', `... [${omitted} lines truncated] ...`, '', ...tail].join('\n')

  return makeResult(output, text, profile, metadata, ['file:head-tail'])
}
