/**
 * MemoryPanel — v1.4.2.
 *
 * User-facing memory panel surfaced in the Session HQ. Three sections:
 *   1. Pinned Facts (user-authored permanent worktree facts) — reuses
 *      `PinnedFactsCard`. Editing here is the same as editing on the
 *      Worktree Detail page.
 *   2. Observed (Episodic) — the rolling summary compacted by
 *      `episodic-updater`. [Regenerate] forces a fresh compaction;
 *      [Clear] deletes the summary so the next eligible event triggers a
 *      new one from scratch.
 *   3. Semantic — read-only links to `.xuanpu/memory.md` (project) and
 *      `~/.xuanpu/memory.md` (user). Empty files show a [Create] CTA;
 *      existing files show an [Open] CTA that asks the system to open
 *      them in the user's editor.
 *
 * Mounted as a sibling of `FieldContextDebug`. Unlike FieldContextDebug,
 * which we now hide outside dev builds, this panel is the daily-driver
 * view for inspecting and editing memory.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Brain,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Trash2,
  Pin,
  FolderOpen,
  Plus,
  Loader2
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'
import { PinnedFactsCard } from '@/components/worktrees/PinnedFactsCard'

interface EpisodicMemoryEntry {
  worktreeId: string
  summaryMarkdown: string
  compactorId: string
  version: number
  compactedAt: number
  sourceEventCount: number
  sourceSince: number
  sourceUntil: number
}

interface SemanticMemoryFile {
  path: string
  mtimeMs: number
  size: number
  markdown: string | null
}

interface SemanticMemoryEntry {
  project: SemanticMemoryFile
  user: SemanticMemoryFile
  lastReadAt: number
}

interface MemoryPanelProps {
  worktreeId: string | null | undefined
  className?: string
}

type Tab = 'pinned' | 'observed' | 'semantic'

export function MemoryPanel({ worktreeId, className }: MemoryPanelProps): React.JSX.Element | null {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('pinned')
  const [episodic, setEpisodic] = useState<EpisodicMemoryEntry | null>(null)
  const [semantic, setSemantic] = useState<SemanticMemoryEntry | null>(null)
  const [loading, setLoading] = useState(false)
  const [actionPending, setActionPending] = useState(false)

  const refresh = useCallback(async () => {
    if (!worktreeId) return
    setLoading(true)
    try {
      const [ep, sem] = await Promise.all([
        window.fieldOps.getEpisodicMemory(worktreeId),
        window.fieldOps.getSemanticMemory(worktreeId)
      ])
      setEpisodic(ep)
      setSemantic(sem)
    } finally {
      setLoading(false)
    }
  }, [worktreeId])

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  const handleRegenerate = useCallback(async () => {
    if (!worktreeId || actionPending) return
    setActionPending(true)
    try {
      const result = await window.fieldOps.regenerateEpisodic(worktreeId)
      if (result) {
        setEpisodic(result)
        toast.success(t('memory.toasts.regenerateOk'))
      } else {
        toast.warning(t('memory.toasts.regenerateSkipped'))
      }
    } catch {
      toast.error(t('memory.toasts.regenerateError'))
    } finally {
      setActionPending(false)
    }
  }, [worktreeId, actionPending, t])

  const handleClear = useCallback(async () => {
    if (!worktreeId || actionPending) return
    setActionPending(true)
    try {
      await window.fieldOps.clearEpisodic(worktreeId)
      setEpisodic(null)
      toast.success(t('memory.toasts.clearOk'))
    } catch {
      toast.error(t('memory.toasts.clearError'))
    } finally {
      setActionPending(false)
    }
  }, [worktreeId, actionPending, t])

  if (!worktreeId) return null

  const headerLabel =
    tab === 'pinned'
      ? t('memory.pinnedSection')
      : tab === 'observed'
        ? episodic
          ? formatCompactorBadge(episodic, t)
          : t('memory.empty.observed')
        : t('memory.semanticSection')

  return (
    <div
      className={cn('border-t border-border/40 bg-muted/20 text-xs', className)}
      data-testid="memory-panel"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-muted-foreground hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center gap-1.5">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Brain size={12} className="text-amber-400" />
          <span>{t('memory.title')}</span>
          <span className="text-muted-foreground/70 ml-2 truncate max-w-[40ch]">{headerLabel}</span>
        </div>
        {open && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              void refresh()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                void refresh()
              }
            }}
            className={cn(
              'p-1 rounded hover:bg-muted/50',
              loading && 'animate-spin text-muted-foreground/60'
            )}
            title="Refresh"
          >
            <RefreshCw size={12} />
          </span>
        )}
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 max-h-[60vh] overflow-auto">
          {/* Tab bar */}
          <div className="flex items-center gap-1 mb-2 text-[11px]">
            <TabButton
              active={tab === 'pinned'}
              onClick={() => setTab('pinned')}
              icon={<Pin size={11} />}
              label={t('memory.pinnedSection')}
            />
            <TabButton
              active={tab === 'observed'}
              onClick={() => setTab('observed')}
              icon={<Brain size={11} />}
              label={t('memory.observedSection')}
            />
            <TabButton
              active={tab === 'semantic'}
              onClick={() => setTab('semantic')}
              icon={<FolderOpen size={11} />}
              label={t('memory.semanticSection')}
            />
          </div>

          {tab === 'pinned' && (
            <div className="bg-background/30 rounded">
              <PinnedFactsCard worktreeId={worktreeId} />
            </div>
          )}

          {tab === 'observed' && (
            <ObservedSection
              episodic={episodic}
              loading={loading}
              actionPending={actionPending}
              onRegenerate={handleRegenerate}
              onClear={handleClear}
            />
          )}

          {tab === 'semantic' && <SemanticSection semantic={semantic} loading={loading} />}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface TabButtonProps {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}

function TabButton({ active, onClick, icon, label }: TabButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded',
        active
          ? 'bg-primary/20 text-foreground'
          : 'text-muted-foreground hover:bg-muted/50'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

interface ObservedSectionProps {
  episodic: EpisodicMemoryEntry | null
  loading: boolean
  actionPending: boolean
  onRegenerate: () => void
  onClear: () => void
}

function ObservedSection({
  episodic,
  loading,
  actionPending,
  onRegenerate,
  onClear
}: ObservedSectionProps): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {episodic && (
          <span className="text-muted-foreground/70 text-[11px]">
            {formatCompactorBadge(episodic, t)} •{' '}
            {t('memory.eventCount', { count: String(episodic.sourceEventCount) })}
          </span>
        )}
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs gap-1.5"
          disabled={actionPending || loading}
          onClick={onRegenerate}
        >
          {actionPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          {t('memory.regenerate')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs gap-1.5 text-destructive"
          disabled={actionPending || loading || !episodic}
          onClick={onClear}
        >
          <Trash2 className="h-3 w-3" />
          {t('memory.clear')}
        </Button>
      </div>
      {loading && !episodic && (
        <div className="text-muted-foreground/60">Loading…</div>
      )}
      {!loading && !episodic && (
        <div className="text-muted-foreground/60 italic">{t('memory.empty.observed')}</div>
      )}
      {episodic && (
        <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed bg-background/50 rounded p-2 max-h-64 overflow-auto">
          {episodic.summaryMarkdown}
        </pre>
      )}
    </div>
  )
}

interface SemanticSectionProps {
  semantic: SemanticMemoryEntry | null
  loading: boolean
}

function SemanticSection({ semantic, loading }: SemanticSectionProps): React.JSX.Element {
  const { t } = useI18n()
  if (loading && !semantic) {
    return <div className="text-muted-foreground/60">Loading…</div>
  }
  if (!semantic) {
    return <div className="text-muted-foreground/60 italic">{t('memory.empty.semantic')}</div>
  }
  return (
    <div className="space-y-3">
      <SemanticFileRow label={t('memory.semanticSection') + ' — Project'} file={semantic.project} />
      <SemanticFileRow label={t('memory.semanticSection') + ' — User'} file={semantic.user} />
    </div>
  )
}

interface SemanticFileRowProps {
  label: string
  file: SemanticMemoryFile
}

function SemanticFileRow({ label, file }: SemanticFileRowProps): React.JSX.Element {
  const { t } = useI18n()
  const exists = file.markdown !== null
  const handleOpen = useCallback(() => {
    void window.gitOps.openInEditor(file.path).catch(() => {
      toast.error(`Failed to open ${file.path}`)
    })
  }, [file.path])
  const handleCreate = useCallback(async () => {
    try {
      // Best-effort create. The semantic-memory loader will pick up the new
      // file on the next refresh; we then nudge the user's editor open.
      const result = await window.fileOps.writeFile(file.path, '# Memory\n\n')
      if (!result.success) {
        toast.error(result.error || 'Failed to create memory.md')
        return
      }
      toast.success('memory.md created')
      await window.gitOps.openInEditor(file.path)
    } catch (error) {
      console.error('Failed to create memory.md:', error)
      toast.error('Failed to create memory.md')
    }
  }, [file.path])

  return (
    <div className="flex flex-col gap-1 bg-background/30 rounded p-2">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-foreground">{label}</span>
        <code className="text-[10px] text-muted-foreground truncate">{file.path}</code>
        <div className="flex-1" />
        {exists ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px] gap-1"
            onClick={handleOpen}
          >
            <FolderOpen className="h-3 w-3" />
            {t('memory.open')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px] gap-1"
            onClick={handleCreate}
          >
            <Plus className="h-3 w-3" />
            {t('memory.create')}
          </Button>
        )}
      </div>
      {!exists && (
        <span className="text-muted-foreground/60 italic">{t('memory.empty.semantic')}</span>
      )}
      {exists && file.markdown && file.markdown.trim().length > 0 && (
        <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed bg-background/50 rounded p-2 max-h-48 overflow-auto">
          {file.markdown}
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCompactorBadge(
  entry: EpisodicMemoryEntry,
  t: (key: string, vars?: Record<string, string>) => string
): string {
  const ago = humanElapsed(Date.now() - entry.compactedAt)
  return `${t('memory.compactor', {
    id: entry.compactorId,
    version: String(entry.version)
  })} • ${t('memory.compactedAt', { ago })}`
}

function humanElapsed(ms: number): string {
  if (ms < 0) return 'just now'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  return `${day}d`
}
