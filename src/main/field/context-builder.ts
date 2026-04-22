/**
 * Field Context Builder — Phase 22A §2.
 *
 * Constructs a FieldContextSnapshot from the Phase 21 event stream.
 *
 * Pipeline:
 *   1. Privacy gate: `isFieldCollectionEnabled() === false` -> return null
 *   2. Resolve worktree metadata from DB
 *   3. `await sink.flushNow()` to guarantee read-after-write on recently emitted events
 *   4. Single SQL query: `getRecentFieldEvents({ worktreeId, since, limit: 1000, order: 'asc' })`
 *   5. Derive focus.file and focus.selection from the last matching events
 *   6. Derive lastTerminal from the last `terminal.command` + correlated `terminal.output`
 *   7. Build recentActivity by filtering out events already promoted into structured sections
 *
 * See docs/prd/phase-22a-working-memory.md
 */
import { basename } from 'path'
import { getDatabase } from '../db'
import { isFieldCollectionEnabled } from './privacy'
import { getFieldEventSink } from './sink'
import { getRecentFieldEvents, type StoredFieldEvent } from './repository'
import { getSemanticMemory } from './semantic-memory-loader'
import { verifyCheckpoint } from './checkpoint-verifier'
import { createLogger } from '../services/logger'
import type {
  FieldContextSnapshot,
  FieldContextActivityEntry,
  ResumedCheckpointBlock
} from '../../shared/types'

const log = createLogger({ component: 'FieldContextBuilder' })

const DEFAULT_WINDOW_MS = 5 * 60_000
const DEFAULT_MAX_ACTIVITY = 30
const QUERY_LIMIT = 1000

export interface BuildOptions {
  worktreeId: string
  /** Window size (ms). Default 5 minutes. */
  windowMs?: number
  /** Max entries in `recentActivity`. Default 30. */
  maxActivity?: number
}

export async function buildFieldContextSnapshot(
  opts: BuildOptions
): Promise<FieldContextSnapshot | null> {
  // Step 1: privacy gate (early-out before any DB work).
  if (!isFieldCollectionEnabled()) {
    return null
  }

  // Step 2: worktree metadata.
  const db = getDatabase()
  const worktreeRow = db.getWorktree(opts.worktreeId)

  // Step 3: parallel I/O — flush sink + load semantic memory + verify checkpoint.
  // All three are independent reads; running concurrently saves a few ms per prompt.
  let semanticMemory: Awaited<ReturnType<typeof getSemanticMemory>> = null
  let checkpoint: ResumedCheckpointBlock | null = null
  try {
    const [, sem, ck] = await Promise.all([
      getFieldEventSink().flushNow(),
      worktreeRow
        ? getSemanticMemory(opts.worktreeId, worktreeRow.path)
        : Promise.resolve(null),
      worktreeRow
        ? verifyCheckpoint({
            worktreeId: opts.worktreeId,
            worktreePath: worktreeRow.path
          }).catch((err) => {
            log.warn('verifyCheckpoint failed; continuing without resume block', {
              error: err instanceof Error ? err.message : String(err)
            })
            return null
          })
        : Promise.resolve(null)
    ])
    semanticMemory = sem
    checkpoint = ck
  } catch (err) {
    log.warn('flushNow / semantic-memory / checkpoint load failed; continuing', {
      error: err instanceof Error ? err.message : String(err)
    })
  }

  // Step 4: single query for the whole window, ascending order.
  const asOf = Date.now()
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
  const since = asOf - windowMs
  const events = getRecentFieldEvents({
    worktreeId: opts.worktreeId,
    since,
    limit: QUERY_LIMIT,
    order: 'asc'
  })

  // Step 5: focus derivation.
  // file.open or file.focus -> focus.file (last one wins).
  // file.selection -> focus.selection (last one wins).
  // If selection.path differs from focus.file.path, selection is stronger.
  const { focusFile, focusSelection, focusFileSourceId, focusSelectionSourceId } =
    deriveFocus(events)

  // Step 6: terminal pairing.
  // Find the most recent terminal.command; then match terminal.output whose
  // relatedEventId == command.id. No related output -> output: null.
  const { lastTerminal, commandId, outputId } = deriveLastTerminal(events)

  // Step 7: recentActivity, deduped against the ids promoted into structured sections.
  const promotedIds = new Set(
    [focusFileSourceId, focusSelectionSourceId, commandId, outputId].filter(
      (id): id is string => !!id
    )
  )
  const maxActivity = opts.maxActivity ?? DEFAULT_MAX_ACTIVITY
  const recentActivity = events
    .filter((e) => !promotedIds.has(e.id))
    .slice(-maxActivity) // asc order -> slice last N keeps most recent
    .map(summarizeEvent)

  return {
    asOf,
    windowMs,
    worktree: worktreeRow
      ? {
          id: worktreeRow.id,
          name: worktreeRow.name,
          branchName: worktreeRow.branch_name ?? null
        }
      : null,
    worktreeNotes: worktreeRow?.context ?? null,
    checkpoint,
    episodicSummary: readEpisodicSummary(opts.worktreeId),
    semanticMemory: semanticMemory
      ? {
          project: {
            path: semanticMemory.project.path,
            markdown: semanticMemory.project.markdown
          },
          user: {
            path: semanticMemory.user.path,
            markdown: semanticMemory.user.markdown
          }
        }
      : null,
    focus: { file: focusFile, selection: focusSelection },
    lastTerminal,
    recentActivity
  }
}

function readEpisodicSummary(
  worktreeId: string
): FieldContextSnapshot['episodicSummary'] {
  const entry = getDatabase().getEpisodicMemory(worktreeId)
  if (!entry) return null
  return {
    markdown: entry.summaryMarkdown,
    compactorId: entry.compactorId,
    compactedAt: entry.compactedAt,
    sourceEventCount: entry.sourceEventCount
  }
}

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------

interface FocusResult {
  focusFile: { path: string; name: string } | null
  focusSelection: {
    path: string
    fromLine: number
    toLine: number
    length: number
  } | null
  focusFileSourceId: string | null
  focusSelectionSourceId: string | null
}

function deriveFocus(events: StoredFieldEvent[]): FocusResult {
  let focusFile: FocusResult['focusFile'] = null
  let focusSelection: FocusResult['focusSelection'] = null
  let focusFileSourceId: string | null = null
  let focusSelectionSourceId: string | null = null

  // Events are ASC order. Walking forward and overwriting gives us "last wins".
  for (const e of events) {
    if (e.type === 'file.open' || e.type === 'file.focus') {
      const p = e.payload as { path?: string; name?: string }
      if (typeof p?.path === 'string') {
        focusFile = {
          path: p.path,
          name: typeof p.name === 'string' ? p.name : basename(p.path)
        }
        focusFileSourceId = e.id
      }
    } else if (e.type === 'file.selection') {
      const p = e.payload as {
        path?: string
        fromLine?: number
        toLine?: number
        length?: number
      }
      if (
        typeof p?.path === 'string' &&
        typeof p?.fromLine === 'number' &&
        typeof p?.toLine === 'number' &&
        typeof p?.length === 'number'
      ) {
        focusSelection = {
          path: p.path,
          fromLine: p.fromLine,
          toLine: p.toLine,
          length: p.length
        }
        focusSelectionSourceId = e.id
      }
    }
  }

  // Selection is a stronger signal than focused-file. If the user last selected
  // text in a *different* file than the last focused one, trust the selection.
  if (focusSelection && focusFile && focusSelection.path !== focusFile.path) {
    focusFile = { path: focusSelection.path, name: basename(focusSelection.path) }
    // Don't overwrite focusFileSourceId — the original file.focus/open event
    // is still the source of the "file" facet; the selection event is its own
    // source. Both end up in promotedIds.
  }

  return { focusFile, focusSelection, focusFileSourceId, focusSelectionSourceId }
}

interface TerminalResult {
  lastTerminal: FieldContextSnapshot['lastTerminal']
  commandId: string | null
  outputId: string | null
}

function deriveLastTerminal(events: StoredFieldEvent[]): TerminalResult {
  // Walk backward from end to find the most recent terminal.command.
  let lastCommand: StoredFieldEvent | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'terminal.command') {
      lastCommand = events[i]
      break
    }
  }
  if (!lastCommand) return { lastTerminal: null, commandId: null, outputId: null }

  // Find a terminal.output that relates to this command.
  let relatedOutput: StoredFieldEvent | null = null
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'terminal.output' && e.relatedEventId === lastCommand.id) {
      relatedOutput = e
      break
    }
  }

  const cmdPayload = lastCommand.payload as { command?: string }
  if (typeof cmdPayload?.command !== 'string') {
    return { lastTerminal: null, commandId: null, outputId: null }
  }

  const lastTerminal: FieldContextSnapshot['lastTerminal'] = {
    command: cmdPayload.command,
    commandAt: lastCommand.timestamp,
    output: null
  }

  if (relatedOutput) {
    const op = relatedOutput.payload as {
      head?: string
      tail?: string
      truncated?: boolean
      exitCode?: number | null
    }
    lastTerminal.output = {
      head: typeof op?.head === 'string' ? op.head : '',
      tail: typeof op?.tail === 'string' ? op.tail : '',
      truncated: !!op?.truncated,
      exitCode: typeof op?.exitCode === 'number' ? op.exitCode : null
    }
  }

  return {
    lastTerminal,
    commandId: lastCommand.id,
    outputId: relatedOutput?.id ?? null
  }
}

function summarizeEvent(e: StoredFieldEvent): FieldContextActivityEntry {
  const type: string = e.type
  const base = { timestamp: e.timestamp, type }
  switch (e.type) {
    case 'worktree.switch': {
      const p = e.payload as { fromWorktreeId?: string | null }
      const from = p?.fromWorktreeId ? p.fromWorktreeId.slice(0, 8) : 'none'
      return { ...base, summary: `switched from \`${from}\`` }
    }
    case 'file.open': {
      const p = e.payload as { path?: string; name?: string }
      return { ...base, summary: `opened \`${p?.name ?? p?.path ?? ''}\`` }
    }
    case 'file.focus': {
      const p = e.payload as { path?: string; name?: string }
      return { ...base, summary: `focused \`${p?.name ?? p?.path ?? ''}\`` }
    }
    case 'file.selection': {
      const p = e.payload as { path?: string; fromLine?: number; toLine?: number }
      const name = p?.path ? basename(p.path) : ''
      return {
        ...base,
        summary: `selected lines ${p?.fromLine}-${p?.toLine} in \`${name}\``
      }
    }
    case 'terminal.command': {
      const p = e.payload as { command?: string }
      const cmd = p?.command ?? ''
      return { ...base, summary: `ran \`${cmd.slice(0, 80)}\`` }
    }
    case 'terminal.output': {
      const p = e.payload as { exitCode?: number | null; totalBytes?: number }
      const exit = p?.exitCode != null ? `exit ${p.exitCode}` : 'still running'
      return { ...base, summary: `terminal output (${p?.totalBytes ?? 0}B, ${exit})` }
    }
    case 'session.message': {
      const p = e.payload as { agentSdk?: string; text?: string }
      const sdk = p?.agentSdk ? `(${p.agentSdk}) ` : ''
      const text = p?.text ? truncate(p.text, 80) : ''
      return { ...base, summary: `${sdk}message: "${text}"` }
    }
    default:
      return { ...base, summary: type }
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}
