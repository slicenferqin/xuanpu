/**
 * Git compression strategies.
 *
 * git status  → branch + file counts by category + file list
 * git log     → keep as-is (--oneline is already compact)
 * git diff    → --stat summary + changed file list + hunk counts
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

export function compressGit(
  output: string,
  profile: CommandProfile,
  metadata: CompressionMetadata
): CompressionResult {
  const cmd = metadata.command.trim().toLowerCase()

  // git status
  if (/\bgit\s+status\b/.test(cmd)) {
    return compressGitStatus(output, profile, metadata)
  }

  // git log
  if (/\bgit\s+log\b/.test(cmd)) {
    return compressGitLog(output, profile, metadata)
  }

  // git diff
  if (/\bgit\s+diff\b/.test(cmd)) {
    return compressGitDiff(output, profile, metadata)
  }

  // Default git: keep as-is (branch/show/etc. are already compact)
  return makeResult(output, output, profile, metadata, ['git:passthrough'])
}

// ───────────────────────────────────────────────────────────────────────────
// git status
// ───────────────────────────────────────────────────────────────────────────

function compressGitStatus(
  output: string,
  profile: CommandProfile,
  metadata: CompressionMetadata
): CompressionResult {
  const lines = output.split('\n')
  const header: string[] = []
  const staged: string[] = []
  const modified: string[] = []
  const untracked: string[] = []
  const deleted: string[] = []

  let section: 'staged' | 'modified' | 'untracked' | 'deleted' | 'header' = 'header'

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Detect section transitions
    if (
      trimmed.startsWith('On branch') ||
      trimmed.startsWith('Your branch') ||
      trimmed.startsWith('nothing to commit')
    ) {
      header.push(trimmed)
      continue
    }

    if (trimmed.startsWith('Changes to be committed:') || trimmed.includes('staged')) {
      section = 'staged'
      continue
    }
    if (trimmed.startsWith('Changes not staged') || trimmed.includes('not staged')) {
      section = 'modified'
      continue
    }
    if (trimmed.startsWith('Untracked files:')) {
      section = 'untracked'
      continue
    }
    if (trimmed.startsWith('deleted:')) {
      section = 'deleted'
      continue
    }

    // Skip section headers like "(use "git add <file>..." ...)"
    if (trimmed.startsWith('(')) continue
    // Skip "no changes added to commit" hints
    if (trimmed.startsWith('no changes')) continue

    // File entries: extract just the filename
    const file = extractFilename(trimmed)
    if (!file) continue

    switch (section) {
      case 'staged':
        staged.push(file)
        break
      case 'modified':
        modified.push(file)
        break
      case 'untracked':
        untracked.push(file)
        break
      case 'deleted':
        deleted.push(file)
        break
    }
  }

  const parts: string[] = [...header]

  if (staged.length)
    parts.push(`\nStaged (${staged.length}):\n${staged.map((f) => `  ${f}`).join('\n')}`)
  if (modified.length)
    parts.push(`\nModified (${modified.length}):\n${modified.map((f) => `  ${f}`).join('\n')}`)
  if (deleted.length)
    parts.push(`\nDeleted (${deleted.length}):\n${deleted.map((f) => `  ${f}`).join('\n')}`)
  if (untracked.length)
    parts.push(`\nUntracked (${untracked.length}):\n${untracked.map((f) => `  ${f}`).join('\n')}`)

  if (!staged.length && !modified.length && !deleted.length && !untracked.length) {
    parts.push('\nWorking tree clean.')
  }

  const text = parts.join('\n')
  return makeResult(output, text, profile, metadata, ['git:status:structured'])
}

function extractFilename(line: string): string | null {
  // Strip common prefixes: "modified:   ", "new file:   ", "deleted:    ", etc.
  const cleaned = line
    .replace(/^(modified|new file|deleted|renamed|typechange):\s+/i, '')
    .replace(/^\s+/, '')
    .trim()

  if (!cleaned) return null
  // Skip lines that look like hints
  if (cleaned.startsWith('(use') || cleaned.startsWith('no changes')) return null

  return cleaned
}

// ───────────────────────────────────────────────────────────────────────────
// git log
// ───────────────────────────────────────────────────────────────────────────

function compressGitLog(
  output: string,
  profile: CommandProfile,
  metadata: CompressionMetadata
): CompressionResult {
  // git log --oneline is already compact, just cap at reasonable size
  const lines = output.split('\n').filter((l) => l.trim())
  if (lines.length <= 50) {
    return makeResult(output, output.trim(), profile, metadata, ['git:log:passthrough'])
  }

  // Cap at 50 commits, note the rest
  const shown = lines.slice(0, 50)
  const text = `${shown.join('\n')}\n\n... (${lines.length - 50} more commits omitted)`
  return makeResult(output, text, profile, metadata, ['git:log:capped'])
}

// ───────────────────────────────────────────────────────────────────────────
// git diff
// ───────────────────────────────────────────────────────────────────────────

function compressGitDiff(
  output: string,
  profile: CommandProfile,
  metadata: CompressionMetadata
): CompressionResult {
  const lines = output.split('\n')

  // Extract --stat-style summary if available
  const files: string[] = []
  let additions = 0
  let deletions = 0
  const hunks: string[] = []

  let currentFile = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Detect --stat section: "file | N +++++----"
    if (/^\s*[\w./-]+\s+\|\s+\d+\s+[+-]+$/.test(line)) {
      const parts = line.split('|')
      const file = parts[0]?.trim()
      if (file) files.push(file)
      continue
    }

    // Detect file headers in diff output: "diff --git a/... b/..."
    if (line.startsWith('diff --git ')) {
      const match = line.match(/b\/(.+)$/)
      currentFile = match?.[1] ?? ''
      if (!files.includes(currentFile)) files.push(currentFile)
      continue
    }

    // Count additions/deletions
    if (line.startsWith('+') && !line.startsWith('+++')) additions++
    if (line.startsWith('-') && !line.startsWith('---')) deletions++

    // Collect hunk headers: "@@ -N,M +N,M @@ ..."
    if (/^@@\s+-\d+.*\+\d+.*@@/.test(line)) {
      hunks.push(`  ${currentFile}: ${line.trim()}`)
    }
  }

  const parts: string[] = []
  parts.push(`Files changed: ${files.length}`)
  if (additions > 0 || deletions > 0) {
    parts.push(`+${additions} -${deletions}`)
  }
  if (files.length > 0 && files.length <= 20) {
    parts.push(`\nFiles:\n${files.map((f) => `  ${f}`).join('\n')}`)
  }
  if (hunks.length > 0 && hunks.length <= 30) {
    parts.push(`\nHunks (${hunks.length}):\n${hunks.join('\n')}`)
  }

  const text = parts.join('\n')
  return makeResult(output, text, profile, metadata, ['git:diff:summary'])
}
