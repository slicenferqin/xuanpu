/**
 * HTTP client compression strategies.
 *
 * curl / wget / httpie →
 *   keep status code, headers (key ones), truncate response bodies.
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

export function compressHttp(
  output: string,
  profile: CommandProfile,
  metadata: CompressionMetadata
): CompressionResult {
  const lines = output.split('\n')
  const headers: string[] = []
  const body: string[] = []
  let inBody = false

  const KEY_HEADERS = new Set([
    'content-type',
    'content-length',
    'location',
    'set-cookie',
    'authorization',
    'x-request-id',
    'x-trace-id',
    'x-rate-limit',
    'cache-control',
    'etag',
    'last-modified',
    'server',
    'www-authenticate',
    'access-control'
  ])

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (headers.length > 0) inBody = true
      continue
    }

    if (!inBody) {
      // Status line
      if (/^HTTP\/\d/i.test(trimmed) || /^<\s*HTTP\/\d/i.test(trimmed)) {
        headers.push(trimmed)
        continue
      }
      // Header line: "Key: Value" or "< Key: Value"
      const headerMatch = trimmed.match(/^<?\s*([\w-]+)\s*:\s*(.+)/i)
      if (headerMatch) {
        const name = headerMatch[1].toLowerCase()
        if (KEY_HEADERS.has(name)) {
          headers.push(`${headerMatch[1]}: ${headerMatch[2]}`)
        }
        continue
      }
      // Non-header line before body starts — probably still preamble
      if (!inBody && headers.length === 0) {
        headers.push(`[${trimmed.slice(0, 80)}]`)
        continue
      }
      inBody = true
    }

    body.push(trimmed)
  }

  const parts: string[] = []

  if (headers.length > 0) {
    parts.push(`Response:\n${headers.join('\n')}`)
  }

  if (body.length > 0) {
    if (body.length <= 50) {
      parts.push(`\nBody (${body.length} lines):\n${body.join('\n')}`)
    } else {
      const head = body.slice(0, 20)
      const tail = body.slice(-10)
      parts.push(
        `\nBody (${body.length} lines, truncated):\n${head.join('\n')}` +
          `\n... [${body.length - 30} lines omitted] ...\n${tail.join('\n')}`
      )
    }
  }

  const text = parts.join('\n') || '(empty response)'
  return makeResult(output, text, profile, metadata, ['http:headers+truncated'])
}
