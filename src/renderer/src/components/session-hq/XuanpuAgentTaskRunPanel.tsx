import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleDot, FileDown, Pause, Play, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useSessionRuntimeStore, type SessionLifecycle } from '@/stores/useSessionRuntimeStore'
import type {
  AgentContextSegment,
  AgentProviderRequestSummary,
  AgentTaskRun,
  AgentUserRound
} from '@shared/types/agent-task-run'

interface XuanpuAgentTaskRunPanelProps {
  sessionId: string
  lifecycle: SessionLifecycle
  pendingCount: number
  onResumeQueued: () => Promise<boolean>
}

export function XuanpuAgentTaskRunPanel({
  sessionId,
  lifecycle,
  pendingCount,
  onResumeQueued
}: XuanpuAgentTaskRunPanelProps): React.JSX.Element | null {
  const [taskRuns, setTaskRuns] = useState<AgentTaskRun[]>([])
  const [userRounds, setUserRounds] = useState<AgentUserRound[]>([])
  const [contextSegments, setContextSegments] = useState<AgentContextSegment[]>([])
  const [providerRequests, setProviderRequests] = useState<AgentProviderRequestSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)

  const latestRun = useMemo(
    () =>
      taskRuns.find((run) => run.status === 'running' || run.status === 'paused') ??
      taskRuns[0] ??
      null,
    [taskRuns]
  )

  const load = useCallback(async () => {
    if (!window.xuanpuAgentOps) return
    setLoading(true)
    try {
      const runs = await window.xuanpuAgentOps.listTaskRuns(sessionId)
      setTaskRuns(runs)
      const active =
        runs.find((run) => run.status === 'running' || run.status === 'paused') ?? runs[0]
      if (active) {
        const [rounds, segments, requests] = await Promise.all([
          window.xuanpuAgentOps.listUserRounds(active.id),
          window.xuanpuAgentOps.listContextSegments(active.id),
          window.xuanpuAgentOps.listProviderRequests(active.id)
        ])
        setUserRounds(rounds)
        setContextSegments(segments)
        setProviderRequests(requests)
      } else {
        setUserRounds([])
        setContextSegments([])
        setProviderRequests([])
      }
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [lifecycle, load, pendingCount])

  if (!latestRun) return null

  const providerCallCount = contextSegments.reduce(
    (total, segment) => total + segment.providerCallCount,
    0
  )
  const tokenTotal = latestRun.totalInputTokens + latestRun.totalOutputTokens
  const lastRound = userRounds[userRounds.length - 1] ?? null
  const lastSegment = contextSegments[contextSegments.length - 1] ?? null
  const lastProviderRequest = providerRequests[providerRequests.length - 1] ?? null
  const canPause = latestRun.status === 'running' && lifecycle === 'idle'
  const canResume = latestRun.status === 'paused' && lifecycle === 'idle'

  const handlePause = async (): Promise<void> => {
    if (!canPause || actionBusy) return
    setActionBusy(true)
    try {
      await window.xuanpuAgentOps.pauseTaskRun(latestRun.id)
      await load()
    } finally {
      setActionBusy(false)
    }
  }

  const handleResume = async (): Promise<void> => {
    if (!canResume || actionBusy) return
    setActionBusy(true)
    try {
      const result = await window.xuanpuAgentOps.resumeTaskRun(latestRun.id)
      if (result.success) {
        await useSessionRuntimeStore.getState().hydratePendingMessages(sessionId)
        await onResumeQueued()
      }
      await load()
    } finally {
      setActionBusy(false)
    }
  }

  const handleExportReport = async (): Promise<void> => {
    if (exportBusy) return
    setExportBusy(true)
    try {
      const result = await window.xuanpuAgentOps.exportTaskRunReport({
        taskRunId: latestRun.id,
        format: 'markdown'
      })
      if (!result.success || !result.filePath) {
        toast.error(result.error ?? 'Failed to export task run report')
        return
      }
      const openError = await window.projectOps.openPath(result.filePath)
      if (openError) {
        toast.success(`Task run report exported: ${result.filePath}`)
      } else {
        toast.success('Task run report exported')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setExportBusy(false)
    }
  }

  return (
    <div
      className="mx-4 mb-2 flex min-h-12 items-center gap-3 rounded-lg border border-border/60 bg-background/92 px-3 py-2 text-xs shadow-lg backdrop-blur"
      data-testid="xuanpu-agent-task-run-panel"
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <StatusPill status={latestRun.status} autonomy={latestRun.autonomy} />
        <Metric label="rounds" value={String(userRounds.length || 1)} />
        <Metric label="segments" value={String(latestRun.epochCount || contextSegments.length)} />
        <Metric
          label="requests"
          value={String(
            providerRequests.length ||
              userRounds.reduce((total, round) => total + round.providerRequestCount, 0)
          )}
        />
        <Metric label="calls" value={String(providerCallCount)} />
        {lastRound && (
          <Metric
            label="round"
            value={`${lastRound.ordinal + 1}:${formatOrigin(lastRound.origin)}`}
          />
        )}
        {lastSegment && (
          <Metric label="segment" value={`${lastSegment.ordinal + 1}:${lastSegment.status}`} />
        )}
        {lastProviderRequest && (
          <Metric label="request" value={shortHash(lastProviderRequest.providerRequestHash)} />
        )}
        <Metric label="tokens" value={formatTokens(tokenTotal)} />
        <Metric label="cost" value={formatCost(latestRun.totalCost)} />
        {lastSegment && (
          <Metric
            label="fill"
            value={formatFillRatio(lastSegment.endFillRatio ?? lastSegment.startFillRatio)}
          />
        )}
        {latestRun.errorMessage && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {latestRun.errorMessage}
          </span>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void load()}
              disabled={loading || actionBusy}
              aria-label="Refresh task run"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Refresh task run</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void handleExportReport()}
              disabled={exportBusy}
              aria-label="Export task run report"
            >
              <FileDown className={cn('h-3.5 w-3.5', exportBusy && 'animate-pulse')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Export task run report</TooltipContent>
        </Tooltip>
        {latestRun.status === 'paused' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void handleResume()}
                disabled={!canResume || actionBusy}
                aria-label="Resume task run"
              >
                <Play className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Resume task run</TooltipContent>
          </Tooltip>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void handlePause()}
                disabled={!canPause || actionBusy}
                aria-label="Pause task run"
              >
                <Pause className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Pause task run</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

function StatusPill({
  status,
  autonomy
}: {
  status: AgentTaskRun['status']
  autonomy: AgentTaskRun['autonomy']
}): React.JSX.Element {
  const settled = status === 'completed' || status === 'failed' || status === 'aborted'
  const Icon = settled ? CheckCircle2 : CircleDot
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/60 px-2 font-medium text-foreground">
      <Icon
        className={cn(
          'h-3.5 w-3.5',
          status === 'running' && 'text-emerald-500',
          status === 'paused' && 'text-amber-500',
          settled && 'text-muted-foreground'
        )}
      />
      <span className="capitalize">{status}</span>
      <span className="text-muted-foreground">/{autonomy}</span>
    </span>
  )
}

function Metric({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-muted/45 px-2 tabular-nums">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </span>
  )
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

function formatCost(cost: number): string {
  if (cost <= 0) return '$0'
  if (cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

function formatFillRatio(fillRatio: number | null): string {
  if (typeof fillRatio !== 'number' || !Number.isFinite(fillRatio)) return '-'
  return `${Math.round(fillRatio * 100)}%`
}

function formatOrigin(origin: AgentUserRound['origin']): string {
  switch (origin) {
    case 'agent-continuation':
      return 'continue'
    case 'recovery-continuation':
      return 'recover'
    case 'user-originated':
      return 'user'
    default:
      return 'user'
  }
}

function shortHash(hash: string): string {
  return hash.length > 8 ? hash.slice(0, 8) : hash
}
