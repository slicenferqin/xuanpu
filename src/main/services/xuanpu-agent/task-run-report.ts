import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { getDatabase } from '../../db'
import type { CommandTraceSummary, DatabaseService } from '../../db/database'
import {
  getTaskRun,
  listContextSegmentsForTaskRun,
  listUserRoundsForTaskRun
} from '../../db/task-run-repository'
import {
  getProviderRequestReplay,
  listProviderRequestSummariesForTaskRun
} from '../../db/turn-repository'
import type {
  AgentProviderRequestSummary,
  AgentProviderNativeReplayLedger,
  AgentProviderNativeReplayRef,
  AgentProviderRequestReplay,
  AgentTaskRunReport,
  AgentTaskRunReportCommandTrace,
  AgentTaskRunReportExportResult,
  AgentTaskRunReportProviderRequest
} from '@shared/types/agent-task-run'

export interface BuildTaskRunReportOptions {
  commandTraceLimit?: number
  generatedAt?: string
  database?: DatabaseService | null
}

export interface ExportTaskRunReportOptions extends BuildTaskRunReportOptions {
  format?: 'markdown' | 'json'
  reportDir: string
}

function resolveDatabase(database?: DatabaseService | null): DatabaseService {
  return database ?? getDatabase()
}

export function buildTaskRunReport(
  taskRunId: string,
  options: BuildTaskRunReportOptions = {}
): AgentTaskRunReport | null {
  const database = resolveDatabase(options.database)
  const taskRun = getTaskRun(taskRunId, database)
  if (!taskRun) return null

  const userRounds = listUserRoundsForTaskRun(taskRun.id, database)
  const contextSegments = listContextSegmentsForTaskRun(taskRun.id, database)
  const providerRequests = listProviderRequestSummariesForTaskRun(
    taskRun.id,
    { limit: 200 },
    database
  ).map((summary) => {
    const replay = getProviderRequestReplay(summary.id, database)
    return buildProviderRequestReport(replay ?? summary)
  })
  const relatedCommandTraces = database
    .listRecentCommandTraces({
      sessionId: taskRun.sessionId,
      worktreeId: taskRun.worktreeId ?? undefined,
      limit: options.commandTraceLimit ?? 50
    })
    .entries.map(mapCommandTrace)

  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    taskRun,
    totals: {
      userRoundCount: userRounds.length,
      contextSegmentCount: contextSegments.length,
      providerRequestCount: providerRequests.length,
      providerCallCount: contextSegments.reduce(
        (total, segment) => total + segment.providerCallCount,
        0
      ),
      totalInputTokens: taskRun.totalInputTokens,
      totalOutputTokens: taskRun.totalOutputTokens,
      totalTokens: taskRun.totalInputTokens + taskRun.totalOutputTokens,
      totalCost: taskRun.totalCost,
      relatedCommandTraceCount: relatedCommandTraces.length
    },
    userRounds,
    contextSegments,
    providerRequests,
    relatedCommandTraces
  }
}

export function renderTaskRunReportMarkdown(report: AgentTaskRunReport): string {
  const taskRun = report.taskRun
  const lines = [
    '# Xuanpu Agent Task Run Report',
    '',
    `Generated: ${report.generatedAt}`,
    `TaskRun: \`${taskRun.id}\``,
    `Session: \`${taskRun.sessionId}\``,
    `Worktree: ${taskRun.worktreeId ? `\`${taskRun.worktreeId}\`` : '-'}`,
    `Project: \`${taskRun.projectId}\``,
    `Status: ${taskRun.status} / ${taskRun.autonomy}`,
    `Objective: ${taskRun.objective ? escapeInline(taskRun.objective) : '-'}`,
    '',
    '## Totals',
    '',
    `- UserRounds: ${report.totals.userRoundCount}`,
    `- ContextSegments: ${report.totals.contextSegmentCount}`,
    `- ProviderRequests: ${report.totals.providerRequestCount}`,
    `- ProviderCalls: ${report.totals.providerCallCount}`,
    `- Tokens: ${report.totals.totalTokens} (${report.totals.totalInputTokens} input / ${report.totals.totalOutputTokens} output)`,
    `- Cost: ${formatCost(report.totals.totalCost)}`,
    `- Related command traces: ${report.totals.relatedCommandTraceCount}`,
    '',
    '## UserRounds',
    '',
    '| # | id | origin | status | provider requests | context segments | prompt |',
    '| - | - | - | - | - | - | - |',
    ...report.userRounds.map(
      (round) =>
        `| ${round.ordinal + 1} | \`${round.id}\` | ${round.origin} | ${round.status} | ${round.providerRequestCount} | ${round.contextSegmentCount} | ${escapeCell(shorten(round.promptText ?? '-', 80))} |`
    ),
    '',
    '## ContextSegments',
    '',
    '| # | id | user round | status | calls | fill | close | checkpoint |',
    '| - | - | - | - | - | - | - | - |',
    ...report.contextSegments.map(
      (segment) =>
        `| ${segment.ordinal + 1} | \`${segment.id}\` | ${segment.userRoundId ? `\`${segment.userRoundId}\`` : '-'} | ${segment.status} | ${segment.providerCallCount} | ${formatFill(segment.startFillRatio)} -> ${formatFill(segment.endFillRatio)} | ${segment.closeReason ?? '-'} | ${segment.checkpointId ? `\`${segment.checkpointId}\`` : '-'} |`
    ),
    '',
    '## ProviderRequests',
    '',
    '| # | snapshot | turn | round | segment | input/max | gateway | hash | prefix | config |',
    '| - | - | - | - | - | - | - | - | - | - |',
    ...report.providerRequests.map(
      (request, index) =>
        `| ${index + 1} | \`${request.id}\` | \`${request.turnId}\` | ${request.userRoundId ? `\`${request.userRoundId}\`` : '-'} | ${request.contextSegmentId ? `\`${request.contextSegmentId}\`` : '-'} | ${request.providerEstimatedInputTokens}/${request.maxContextTokens} | ${escapeCell(formatGatewayDecision(request.decisions))} | \`${shortHash(request.providerRequestHash)}\` | ${request.prefixHash ? `\`${shortHash(request.prefixHash)}\`` : '-'} | ${escapeCell(formatProviderConfig(request.providerConfig))} |`
    ),
    '',
    '## Replay Payload Refs',
    '',
    ...report.providerRequests.flatMap((request) => [
      `- \`${request.id}\`: xfp=${request.xfpPacketId ? `\`${request.xfpPacketId}\`` : '-'}, managed=${request.replayPayloadBytes.managedContextJson}B, messages=${request.replayPayloadBytes.providerMessagesJson}B, tools=${request.replayPayloadBytes.providerToolsJson}B, config=${request.replayPayloadBytes.providerConfigJson}B, decisions=${request.replayPayloadBytes.decisionsJson}B`
    ]),
    '',
    '## Provider Native Replay Refs',
    '',
    ...renderProviderNativeReplayRefs(report.providerRequests),
    '',
    '## Related Command Trace Raw Refs',
    '',
    ...renderCommandTraceRefs(report.relatedCommandTraces)
  ]

  return `${lines.join('\n')}\n`
}

export function exportTaskRunReport(
  taskRunId: string,
  options: ExportTaskRunReportOptions
): AgentTaskRunReportExportResult {
  const format = options.format ?? 'markdown'
  const report = buildTaskRunReport(taskRunId, options)
  if (!report) {
    return {
      success: false,
      taskRunId,
      format,
      error: `Task run not found: ${taskRunId}`
    }
  }

  const content =
    format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderTaskRunReportMarkdown(report)
  mkdirSync(options.reportDir, { recursive: true })
  const filePath = join(
    options.reportDir,
    `xuanpu-agent-task-run-${sanitizeFilePart(taskRunId)}-${sanitizeFilePart(report.generatedAt)}.${format === 'json' ? 'json' : 'md'}`
  )
  writeFileSync(filePath, content, 'utf-8')

  return {
    success: true,
    taskRunId,
    format,
    filePath,
    content,
    report
  }
}

function buildProviderRequestReport(
  replayOrSummary: AgentProviderRequestReplay | AgentProviderRequestReportSource
): AgentTaskRunReportProviderRequest {
  const replay = isReplay(replayOrSummary) ? replayOrSummary : null
  const providerConfig = replay ? safeJsonParse(replay.providerConfigJson) : null
  const decisions = replay ? safeJsonParse(replay.decisionsJson) : null
  const managedContext = replay ? safeJsonParse(replay.managedContextJson) : null
  return {
    id: replayOrSummary.id,
    turnId: replayOrSummary.turnId,
    sessionId: replayOrSummary.sessionId,
    taskRunId: replayOrSummary.taskRunId,
    userRoundId: replayOrSummary.userRoundId,
    contextSegmentId: replayOrSummary.contextSegmentId,
    contextSegmentOrdinal: replayOrSummary.contextSegmentOrdinal,
    providerCallSeq: replayOrSummary.providerCallSeq,
    providerRequestHash: replayOrSummary.providerRequestHash,
    prefixHash: replayOrSummary.prefixHash,
    managedApproxTokens: replayOrSummary.managedApproxTokens,
    providerEstimatedInputTokens: replayOrSummary.providerEstimatedInputTokens,
    maxContextTokens: replayOrSummary.maxContextTokens,
    createdAt: replayOrSummary.createdAt,
    xfpPacketId: replay?.xfpPacketId ?? null,
    providerConfig,
    decisions,
    managedContext,
    providerNativeReplay: extractProviderNativeReplay(decisions, managedContext),
    replayPayloadBytes: {
      managedContextJson: byteLength(replay?.managedContextJson),
      providerMessagesJson: byteLength(replay?.providerMessagesJson),
      providerToolsJson: byteLength(replay?.providerToolsJson),
      providerConfigJson: byteLength(replay?.providerConfigJson),
      decisionsJson: byteLength(replay?.decisionsJson)
    }
  }
}

type AgentProviderRequestReportSource = AgentProviderRequestSummary

function isReplay(
  value: AgentProviderRequestReplay | AgentProviderRequestReportSource
): value is AgentProviderRequestReplay {
  return 'providerMessagesJson' in value
}

function mapCommandTrace(trace: CommandTraceSummary): AgentTaskRunReportCommandTrace {
  return {
    id: trace.id,
    sessionId: trace.sessionId,
    worktreeId: trace.worktreeId,
    command: trace.command,
    cwd: trace.cwd,
    exitCode: trace.exitCode,
    durationMs: trace.durationMs,
    timedOut: trace.timedOut,
    aborted: trace.aborted,
    rawOutputRef: trace.rawOutputRef,
    rawOutputBytes: trace.rawOutputBytes,
    rawOutputSha256: trace.rawOutputSha256,
    compressionRatio: trace.compressionRatio,
    category: trace.category,
    ruleHits: trace.ruleHits,
    createdAt: trace.createdAt
  }
}

function extractProviderNativeReplay(
  ...sources: unknown[]
): AgentProviderNativeReplayLedger | null {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    const candidate = (source as { providerNativeReplay?: unknown }).providerNativeReplay
    const normalized = normalizeProviderNativeReplay(candidate)
    if (normalized) return normalized
  }
  return null
}

function normalizeProviderNativeReplay(input: unknown): AgentProviderNativeReplayLedger | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  if (!Array.isArray(record.refs)) return null

  const refs = record.refs
    .map(normalizeProviderNativeReplayRef)
    .filter((ref): ref is AgentProviderNativeReplayRef => Boolean(ref))
  const replayableCount =
    typeof record.replayableCount === 'number'
      ? record.replayableCount
      : refs.filter((ref) => ref.replayable).length
  if (refs.length === 0 && replayableCount === 0) return null
  return { replayableCount, refs }
}

function normalizeProviderNativeReplayRef(input: unknown): AgentProviderNativeReplayRef | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  if (typeof record.episodeId !== 'string') return null
  if (typeof record.ref !== 'string') return null
  if (typeof record.sha256 !== 'string') return null

  return {
    source: typeof record.source === 'string' ? record.source : 'unknown',
    episodeId: record.episodeId,
    provider: typeof record.provider === 'string' ? record.provider : null,
    ref: record.ref,
    path: typeof record.path === 'string' ? record.path : null,
    sha256: record.sha256,
    bytes: typeof record.bytes === 'number' ? record.bytes : 0,
    replacementHistoryCount:
      typeof record.replacementHistoryCount === 'number' ? record.replacementHistoryCount : 0,
    compactionItemType:
      typeof record.compactionItemType === 'string' ? record.compactionItemType : null,
    replayable: record.replayable === true,
    historyReplacementId:
      typeof record.historyReplacementId === 'string' ? record.historyReplacementId : null,
    firstKeptEntryId: typeof record.firstKeptEntryId === 'string' ? record.firstKeptEntryId : null
  }
}

function renderProviderNativeReplayRefs(requests: AgentTaskRunReportProviderRequest[]): string[] {
  const lines = requests.flatMap((request) =>
    (request.providerNativeReplay?.refs ?? []).map(
      (ref) =>
        `- \`${request.id}\`: provider=${ref.provider ?? '-'}, source=${ref.source}, episode=\`${ref.episodeId}\`, ref=\`${ref.ref}\`, bytes=${ref.bytes}, sha256=\`${shortHash(ref.sha256)}\`, replacementHistory=${ref.replacementHistoryCount}, item=${ref.compactionItemType ?? '-'}, replayable=${ref.replayable ? 'yes' : 'no'}`
    )
  )
  return lines.length > 0 ? lines : ['- none']
}

function renderCommandTraceRefs(traces: AgentTaskRunReportCommandTrace[]): string[] {
  if (traces.length === 0) return ['- none']
  return traces.map(
    (trace) =>
      `- \`${trace.id}\`: command=${escapeInline(shorten(trace.command, 80))}, raw=${trace.rawOutputRef ? `\`${trace.rawOutputRef}\`` : '-'}, bytes=${trace.rawOutputBytes ?? 0}, sha256=${trace.rawOutputSha256 ? `\`${shortHash(trace.rawOutputSha256)}\`` : '-'}`
  )
}

function formatGatewayDecision(decisions: unknown): string {
  if (!decisions || typeof decisions !== 'object') return '-'
  const gateway = (decisions as { gateway?: unknown }).gateway
  if (!gateway || typeof gateway !== 'object') return '-'
  const record = gateway as Record<string, unknown>
  const action = typeof record.action === 'string' ? record.action : 'unknown'
  const effectiveProfile =
    typeof record.effectiveProfile === 'string' ? record.effectiveProfile : 'unknown'
  const input =
    typeof record.providerEstimatedInputTokens === 'number'
      ? record.providerEstimatedInputTokens
      : null
  const hard = typeof record.hardTokenLimit === 'number' ? record.hardTokenLimit : null
  const ratio =
    typeof record.fillRatio === 'number' && Number.isFinite(record.fillRatio)
      ? `${Math.round(record.fillRatio * 100)}%`
      : '-'
  const limit = input !== null && hard !== null ? ` ${input}/${hard}` : ''
  return `${action} ${effectiveProfile} ${ratio}${limit}`.trim()
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return { parseError: true, rawPreview: shorten(value, 200) }
  }
}

function byteLength(value: string | undefined): number {
  return value ? Buffer.byteLength(value, 'utf-8') : 0
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
}

function shortHash(hash: string): string {
  return hash.length > 12 ? hash.slice(0, 12) : hash
}

function shorten(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value
}

function escapeCell(value: string): string {
  return escapeInline(value).replace(/\|/g, '\\|')
}

function escapeInline(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function formatFill(value: number | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  return `${Math.round(value * 100)}%`
}

function formatCost(value: number): string {
  if (value <= 0) return '$0'
  if (value < 0.01) return '<$0.01'
  return `$${value.toFixed(2)}`
}

function formatProviderConfig(config: unknown): string {
  if (!config || typeof config !== 'object') return '-'
  const modelRef = (config as { modelRef?: { providerID?: string; modelID?: string } }).modelRef
  if (!modelRef) return '-'
  return [modelRef.providerID, modelRef.modelID].filter(Boolean).join('/') || '-'
}
