import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, CircleDot, Pause, Play, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useSessionRuntimeStore, type SessionLifecycle } from '@/stores/useSessionRuntimeStore'
import type { AgentEpoch, AgentTaskRun } from '@shared/types/agent-task-run'

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
  const [epochs, setEpochs] = useState<AgentEpoch[]>([])
  const [loading, setLoading] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)

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
        setEpochs(await window.xuanpuAgentOps.listEpochs(active.id))
      } else {
        setEpochs([])
      }
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [lifecycle, load, pendingCount])

  if (!latestRun) return null

  const providerCallCount = epochs.reduce((total, epoch) => total + epoch.providerCallCount, 0)
  const tokenTotal = latestRun.totalInputTokens + latestRun.totalOutputTokens
  const lastEpoch = epochs[epochs.length - 1] ?? null
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

  return (
    <div
      className="mx-4 mb-2 flex min-h-12 items-center gap-3 rounded-lg border border-border/60 bg-background/92 px-3 py-2 text-xs shadow-lg backdrop-blur"
      data-testid="xuanpu-agent-task-run-panel"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <StatusPill status={latestRun.status} autonomy={latestRun.autonomy} />
        <Metric label="epochs" value={String(latestRun.epochCount || epochs.length)} />
        <Metric label="calls" value={String(providerCallCount)} />
        <Metric label="tokens" value={formatTokens(tokenTotal)} />
        <Metric label="cost" value={formatCost(latestRun.totalCost)} />
        {lastEpoch && (
          <Metric
            label="fill"
            value={formatFillRatio(lastEpoch.endFillRatio ?? lastEpoch.startFillRatio)}
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
