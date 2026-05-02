/**
 * FileWriteCard — Renders a file write/edit action with line change counts.
 *
 * v1.4.3: now ships an inline diff preview. Edit cards show a unified
 * diff snippet (old vs new), Write cards show the first N lines of new
 * content. Defaults to a short preview; clicking "展开全部" reveals the rest.
 * Keeps the timeline scannable while letting users read the actual change
 * without jumping to the right-hand diff panel.
 */

import React, { useMemo, useState } from 'react'
import { ActionCard } from './ActionCard'
import { Check, X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolUseInfo } from '@shared/lib/timeline-types'

interface FileWriteCardProps {
  toolUse: ToolUseInfo
}

const PREVIEW_LINE_LIMIT = 10

type DiffLine =
  | { kind: 'context'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'remove'; text: string }

function isEditTool(name: string | undefined): boolean {
  const n = name?.toLowerCase() ?? ''
  return n === 'edit' || n === 'editfile' || n === 'edit_file' || n === 'multiedit'
}

function isWriteTool(name: string | undefined): boolean {
  const n = name?.toLowerCase() ?? ''
  return n === 'write' || n === 'writefile' || n === 'write_file'
}

/** Extract old/new string pairs, accepting both snake_case and camelCase. */
function readEditStrings(input: Record<string, unknown>): { oldStr: string; newStr: string } {
  const oldStr =
    (typeof input.old_string === 'string' && input.old_string) ||
    (typeof input.oldString === 'string' && input.oldString) ||
    ''
  const newStr =
    (typeof input.new_string === 'string' && input.new_string) ||
    (typeof input.newString === 'string' && input.newString) ||
    ''
  return { oldStr, newStr }
}

function readWriteContent(input: Record<string, unknown>): string {
  if (typeof input.content === 'string') return input.content
  if (typeof input.text === 'string') return input.text
  return ''
}

function resolveWriteFilePath(toolUse: ToolUseInfo, fallback?: string): string {
  const input = (toolUse.input ?? {}) as Record<string, unknown>
  const direct =
    (input.filePath ||
      input.file_path ||
      input.path ||
      input.displayName ||
      input.filename ||
      '') as string
  if (direct) return direct
  const paths = input.paths
  if (Array.isArray(paths) && typeof paths[0] === 'string') return paths[0]
  return fallback ?? ''
}

interface CodexChange {
  path: string
  kind?: { type?: string }
  diff?: string
}

/**
 * Codex emits fileChange items as `input.changes[]` with a unified diff
 * string per change. claude-code emits `input.old_string` / `new_string`
 * for Edit. This helper detects which shape we have.
 */
function getCodexChanges(toolUse: ToolUseInfo): CodexChange[] | null {
  const changes = toolUse.input?.changes
  if (!Array.isArray(changes) || changes.length === 0) return null
  const out: CodexChange[] = []
  for (const c of changes) {
    if (c && typeof c === 'object') {
      const obj = c as Record<string, unknown>
      const path = typeof obj.path === 'string' ? obj.path : ''
      if (!path) continue
      out.push({
        path,
        kind: typeof obj.kind === 'object' ? (obj.kind as { type?: string }) : undefined,
        diff: typeof obj.diff === 'string' ? obj.diff : undefined
      })
    }
  }
  return out.length > 0 ? out : null
}

/** Parse a unified-diff hunk body into DiffLine[]. Strips the @@ header. */
function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = []
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) continue
    if (raw.startsWith('---') || raw.startsWith('+++')) continue
    if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1) })
    else if (raw.startsWith('-')) lines.push({ kind: 'remove', text: raw.slice(1) })
    else lines.push({ kind: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw })
  }
  // Trim trailing empty line that often appears after a final newline.
  while (lines.length > 0 && lines[lines.length - 1].text === '') lines.pop()
  return lines
}

function countDiffChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === 'add') added++
    else if (l.kind === 'remove') removed++
  }
  return { added, removed }
}

function computeLineDiff(toolUse: ToolUseInfo): { added: number; removed: number } | null {
  // Codex shape (preferred — has the real unified diff)
  const codexChanges = getCodexChanges(toolUse)
  if (codexChanges && codexChanges[0]?.diff) {
    return countDiffChanges(parseUnifiedDiff(codexChanges[0].diff))
  }
  const inlineDiff = toolUse.input?.diff
  if (typeof inlineDiff === 'string' && inlineDiff.length > 0) {
    return countDiffChanges(parseUnifiedDiff(inlineDiff))
  }

  const input = toolUse.input ?? {}

  if (isEditTool(toolUse.name)) {
    const { oldStr, newStr } = readEditStrings(input)
    if (!oldStr && !newStr) return null
    const oldLines = oldStr ? oldStr.split('\n').length : 0
    const newLines = newStr ? newStr.split('\n').length : 0
    return {
      added: Math.max(0, newLines - oldLines + (oldLines === 0 ? 0 : 0)),
      removed: Math.max(0, oldLines - newLines + (newLines === 0 ? 0 : 0))
    }
  }

  if (isWriteTool(toolUse.name)) {
    const content = readWriteContent(input)
    if (!content) return null
    const lines = content.split('\n').length
    return { added: lines, removed: 0 }
  }

  // Prefer filediff-provided totals when available (OpenCode Edit tool ships
  // `input.additions` / `input.deletions` via enrichToolPart).
  const additions = typeof input.additions === 'number' ? input.additions : null
  const deletions = typeof input.deletions === 'number' ? input.deletions : null
  if (additions !== null || deletions !== null) {
    return { added: additions ?? 0, removed: deletions ?? 0 }
  }

  return null
}

/**
 * Build a minimal unified-style preview: every old_string line as `-`,
 * every new_string line as `+`. Good enough for an inline at-a-glance read;
 * the right-hand Monaco diff panel still owns "true" diffs.
 */
function buildEditPreview(oldStr: string, newStr: string): DiffLine[] {
  const out: DiffLine[] = []
  if (oldStr) {
    for (const line of oldStr.split('\n')) {
      out.push({ kind: 'remove', text: line })
    }
  }
  if (newStr) {
    for (const line of newStr.split('\n')) {
      out.push({ kind: 'add', text: line })
    }
  }
  return out
}

function buildWritePreview(content: string): DiffLine[] {
  return content.split('\n').map((text) => ({ kind: 'add' as const, text }))
}

function buildPreviewLines(toolUse: ToolUseInfo): DiffLine[] | null {
  // Codex shape: changes[].diff (unified)
  const codexChanges = getCodexChanges(toolUse)
  if (codexChanges && codexChanges[0]?.diff) {
    return parseUnifiedDiff(codexChanges[0].diff)
  }
  // Single-file convenience: input.diff (also unified)
  const inlineDiff = toolUse.input?.diff
  if (typeof inlineDiff === 'string' && inlineDiff.length > 0) {
    return parseUnifiedDiff(inlineDiff)
  }

  const input = toolUse.input ?? {}
  if (isEditTool(toolUse.name)) {
    const { oldStr, newStr } = readEditStrings(input)
    if (!oldStr && !newStr) return null
    return buildEditPreview(oldStr, newStr)
  }
  if (isWriteTool(toolUse.name)) {
    const content = readWriteContent(input)
    if (!content) return null
    return buildWritePreview(content)
  }
  return null
}

interface DiffPreviewProps {
  lines: DiffLine[]
}

function DiffPreview({ lines }: DiffPreviewProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const overflow = lines.length > PREVIEW_LINE_LIMIT
  const visible = expanded ? lines : lines.slice(0, PREVIEW_LINE_LIMIT)
  const hiddenCount = lines.length - PREVIEW_LINE_LIMIT

  return (
    <div className="rounded border border-border/40 bg-background/60 overflow-hidden">
      <pre className="text-[11.5px] leading-snug font-mono overflow-x-auto px-2 py-1.5 m-0">
        {visible.map((line, i) => (
          <div
            key={i}
            className={cn(
              'whitespace-pre flex',
              line.kind === 'add' && 'bg-celadon/10 text-celadon',
              line.kind === 'remove' && 'bg-red-500/10 text-red-400'
            )}
          >
            <span className="select-none w-4 text-muted-foreground/70 shrink-0">
              {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
            </span>
            <span className="break-all">{line.text || ' '}</span>
          </div>
        ))}
      </pre>
      {overflow && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
          className="w-full text-[11px] py-1 border-t border-border/40 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
        >
          {expanded ? '收起' : `展开全部（还有 ${hiddenCount} 行）`}
        </button>
      )}
    </div>
  )
}

export function FileWriteCard({ toolUse }: FileWriteCardProps): React.JSX.Element {
  const codexChanges = getCodexChanges(toolUse)
  const filePath =
    resolveWriteFilePath(toolUse, codexChanges?.[0]?.path) ||
    codexChanges?.[0]?.path ||
    ''
  // Codex emits 'Edit' for both pure edits and full rewrites; treat as Edit.
  const isEdit =
    toolUse.name === 'Edit' ||
    toolUse.name === 'edit' ||
    isEditTool(toolUse.name) ||
    codexChanges !== null
  const isRunning = toolUse.status === 'running' || toolUse.status === 'pending'
  const isError = toolUse.status === 'error'
  const isSuccess = toolUse.status === 'success' || toolUse.status === 'completed'
  const diff = computeLineDiff(toolUse)
  const previewLines = useMemo(() => buildPreviewLines(toolUse), [toolUse])
  const hasPreview = previewLines !== null && previewLines.length > 0
  const multiFile = codexChanges && codexChanges.length > 1

  return (
    <ActionCard
      headerLeft={
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-foreground shrink-0">
            {isEdit ? 'Edit' : 'Write File'}
          </span>
          <span className="font-mono text-xs text-blue-500 bg-blue-500/10 px-1.5 py-0.5 rounded truncate">
            {filePath}
            {multiFile ? ` +${codexChanges.length - 1}` : ''}
          </span>
        </div>
      }
      headerRight={
        <div className="flex items-center gap-1.5">
          {isRunning && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {isSuccess && <Check className="h-3.5 w-3.5 text-celadon" />}
          {isError && <X className="h-3.5 w-3.5 text-red-500" />}
          {diff && isSuccess && (
            <div className="flex gap-1.5 font-mono text-xs font-semibold">
              {diff.added > 0 && <span className="text-celadon">+{diff.added}</span>}
              {diff.removed > 0 && <span className="text-red-400">-{diff.removed}</span>}
              {diff.added === 0 && diff.removed === 0 && (
                <span className="text-muted-foreground">~0</span>
              )}
            </div>
          )}
          {isRunning && <span>Writing...</span>}
          {isError && <span>Error</span>}
        </div>
      }
      // Default collapsed — click the header to expand the diff preview
      // (or the error message). Errors still auto-expand so the user
      // immediately sees what went wrong.
      defaultExpanded={isError}
    >
      {toolUse.error && (
        <pre className="whitespace-pre-wrap break-all font-mono text-xs text-red-400 max-h-[200px] overflow-y-auto mb-2">
          {toolUse.error}
        </pre>
      )}
      {hasPreview && previewLines && <DiffPreview lines={previewLines} />}
    </ActionCard>
  )
}
