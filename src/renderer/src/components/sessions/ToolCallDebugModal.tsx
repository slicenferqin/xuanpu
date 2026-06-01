import { useState, useMemo, useEffect } from 'react'
import { Copy, Check, Bug, Clock } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import type { ToolUseInfo, ToolStatus } from './ToolCard'
import { useI18n } from '@/i18n/useI18n'

function statusColor(status: ToolStatus): string {
  switch (status) {
    case 'pending':
      return 'bg-muted-foreground/15 text-muted-foreground'
    case 'running':
      return 'bg-blue-500/15 text-blue-500'
    case 'success':
      return 'bg-green-500/15 text-green-500'
    case 'error':
    case 'rejected':
      return 'bg-red-500/15 text-red-500'
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      toast.success(t('toolCallDebugModal.toasts.copied', { label }))
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('toolCallDebugModal.toasts.copyError'))
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={handleCopy} className="h-7 gap-1.5 text-xs">
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
      {copied
        ? t('toolCallDebugModal.actions.copied')
        : t('toolCallDebugModal.actions.copy', { label })}
    </Button>
  )
}

interface ToolCallDebugModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  toolUse: ToolUseInfo
}

export function ToolCallDebugModal({ open, onOpenChange, toolUse }: ToolCallDebugModalProps) {
  const { t } = useI18n()
  const [activeTab, setActiveTab] = useState<'input' | 'output'>('input')

  useEffect(() => {
    setActiveTab('input')
  }, [toolUse.id])

  const inputJson = useMemo(() => {
    try {
      return JSON.stringify(toolUse.input, null, 2)
    } catch {
      return '(unable to serialize input)'
    }
  }, [toolUse.input])

  const outputText = useMemo(
    () => (toolUse.error ? `[ERROR]\n${toolUse.error}` : (toolUse.output ?? '(no output)')),
    [toolUse.error, toolUse.output]
  )

  const duration =
    toolUse.endTime && toolUse.startTime
      ? formatDuration(toolUse.endTime - toolUse.startTime)
      : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="tool-debug-modal"
        className="max-w-2xl max-h-[85vh] flex flex-col gap-3"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Bug className="h-4 w-4 text-muted-foreground" />
            {t('toolCallDebugModal.title')}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="font-medium text-foreground text-sm">{toolUse.name}</span>
              <code className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono text-muted-foreground select-all">
                {toolUse.id}
              </code>
              <span
                className={cn(
                  'text-[10px] rounded px-1.5 py-0.5 font-medium',
                  statusColor(toolUse.status)
                )}
              >
                {t(`toolCallDebugModal.status.${toolUse.status}`)}
              </span>
              {duration && (
                <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {duration}
                </span>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        {/* Tab buttons */}
        <div role="tablist" className="flex items-center gap-1 border-b border-border">
          <button
            role="tab"
            aria-selected={activeTab === 'input'}
            data-testid="tool-debug-tab-input"
            onClick={() => setActiveTab('input')}
            className={cn(
              'px-3 py-1.5 text-xs font-medium border-b-2 transition-colors -mb-px',
              activeTab === 'input'
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t('toolCallDebugModal.tabs.input')}
          </button>
          <button
            role="tab"
            aria-selected={activeTab === 'output'}
            data-testid="tool-debug-tab-output"
            onClick={() => setActiveTab('output')}
            className={cn(
              'px-3 py-1.5 text-xs font-medium border-b-2 transition-colors -mb-px',
              activeTab === 'output'
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t('toolCallDebugModal.tabs.output')}
          </button>
          <div className="flex-1" />
          <CopyButton
            text={activeTab === 'input' ? inputJson : outputText}
            label={
              activeTab === 'input'
                ? t('toolCallDebugModal.tabs.input')
                : t('toolCallDebugModal.tabs.output')
            }
          />
        </div>

        {/* Tab content */}
        <div role="tabpanel" className="flex-1 min-h-0">
          <pre
            data-testid="tool-debug-content"
            className="bg-muted rounded-md p-3 font-mono text-xs leading-relaxed overflow-auto max-h-[60vh] select-text whitespace-pre-wrap break-words"
          >
            {activeTab === 'input' ? inputJson : outputText}
          </pre>
        </div>
      </DialogContent>
    </Dialog>
  )
}
