/**
 * CommandCompressor implementation — M3 (expanded from M2 MVP).
 *
 * Dispatches to per-category compression strategies covering 35+ commands.
 * Each strategy follows: parse → filter → format → return CompressionResult.
 *
 * If a strategy crashes, the caller falls back to head/tail truncation
 * (see compressionFailed() in compressor.ts).
 */
import type {
  CommandCompressor,
  CommandProfile,
  CompressionMetadata,
  CompressionResult
} from './compressor'
import { compressGit } from './compressors/git'
import { compressTest } from './compressors/test'
import { compressLint } from './compressors/lint'
import { compressFile } from './compressors/file'
import { compressSearch } from './compressors/search'
import { compressContainer } from './compressors/container'
import { compressHttp } from './compressors/http'
import { compressPackage } from './compressors/package'
import { compressDb } from './compressors/db'

// ───────────────────────────────────────────────────────────────────────────
// Factory
// ───────────────────────────────────────────────────────────────────────────

export function createCommandCompressor(): CommandCompressor {
  return {
    compress(
      output: string,
      profile: CommandProfile,
      metadata: CompressionMetadata
    ): CompressionResult {
      switch (profile.category) {
        case 'git':
          return compressGit(output, profile, metadata)
        case 'test':
          return compressTest(output, profile, metadata)
        case 'lint':
          return compressLint(output, profile, metadata)
        case 'build':
          return compressLint(output, profile, metadata) // reuse lint logic
        case 'file':
          return compressFile(output, profile, metadata)
        case 'search':
          return compressSearch(output, profile, metadata)
        case 'container':
          return compressContainer(output, profile, metadata)
        case 'curl':
          return compressHttp(output, profile, metadata)
        case 'package':
          return compressPackage(output, profile, metadata)
        case 'db':
          return compressDb(output, profile, metadata)
        default:
          return passThrough(output, profile, metadata)
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Fallback: pass-through (for proxy / unimplemented categories)
// ───────────────────────────────────────────────────────────────────────────

function passThrough(
  output: string,
  _profile: CommandProfile,
  metadata: CompressionMetadata
): CompressionResult {
  const beforeBytes = Buffer.byteLength(output, 'utf-8')
  return {
    text: output,
    beforeBytes,
    afterBytes: beforeBytes,
    compressionRatio: 0,
    ruleHits: ['proxy'],
    rawRef: metadata.traceId
      ? `command-trace:${metadata.traceId}`
      : `command_traces:${metadata.command}:${Date.now()}`,
    exitCode: metadata.exitCode,
    durationMs: metadata.durationMs,
    timedOut: metadata.timedOut,
    aborted: metadata.aborted
  }
}
