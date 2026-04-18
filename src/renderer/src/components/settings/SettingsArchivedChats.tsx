import { useCallback, useEffect, useState } from 'react'
import { Archive, ExternalLink, GitBranch, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import { useSessionStore } from '@/stores/useSessionStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { toast } from 'sonner'

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])

  return debouncedValue
}

function formatRelativeDate(value: string): string {
  return new Date(value).toLocaleString()
}

function getRestoreState(session: SessionWithWorktree): {
  canRestore: boolean
  helperText: string | null
} {
  if (!session.worktree_id || !session.worktree_status) {
    return { canRestore: false, helperText: 'missing' }
  }

  if (session.worktree_status !== 'active') {
    return { canRestore: false, helperText: 'archived' }
  }

  return { canRestore: true, helperText: null }
}

export function SettingsArchivedChats(): React.JSX.Element {
  const { t } = useI18n()
  const closeSettings = useSettingsStore((state) => state.closeSettings)
  const { setActiveSession, loadSessions, loadConnectionSessions } = useSessionStore()

  const [keyword, setKeyword] = useState('')
  const [sessions, setSessions] = useState<SessionWithWorktree[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [restoringSessionId, setRestoringSessionId] = useState<string | null>(null)
  const debouncedKeyword = useDebouncedValue(keyword, 200)

  const fetchArchivedSessions = useCallback(async (): Promise<void> => {
    setIsLoading(true)
    try {
      const results = await window.db.session.search({
        ...(debouncedKeyword.trim() ? { keyword: debouncedKeyword.trim() } : {}),
        includeArchived: true,
        statusFilter: 'archived'
      })
      setSessions(results)
    } finally {
      setIsLoading(false)
    }
  }, [debouncedKeyword])

  useEffect(() => {
    void fetchArchivedSessions()
  }, [fetchArchivedSessions])

  const hasKeyword = keyword.trim().length > 0
  const emptyTitle = hasKeyword
    ? t('settings.archivedChats.empty.filtered')
    : t('settings.archivedChats.empty.default')

  const openArchivedSession = (session: SessionWithWorktree): void => {
    toast.info(t('settings.archivedChats.toasts.readOnly'))
    setActiveSession(session.id)
    closeSettings()
  }

  const restoreArchivedSession = async (session: SessionWithWorktree): Promise<void> => {
    const { canRestore } = getRestoreState(session)
    if (!canRestore) return

    setRestoringSessionId(session.id)
    try {
      const restored = await window.db.session.restore(session.id)
      if (!restored) {
        throw new Error(t('settings.archivedChats.toasts.restoreFailed'))
      }

      if (session.worktree_id) {
        await loadSessions(session.worktree_id, session.project_id)
      }
      if (session.connection_id) {
        await loadConnectionSessions(session.connection_id)
      }

      setSessions((current) => current.filter((item) => item.id !== session.id))
      toast.success(t('settings.archivedChats.toasts.restored'))
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t('settings.archivedChats.toasts.restoreFailed')
      )
    } finally {
      setRestoringSessionId(null)
    }
  }

  let content: React.JSX.Element
  if (isLoading) {
    content = (
      <div className="flex h-64 items-center justify-center rounded-2xl border border-border/70">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  } else if (sessions.length === 0) {
    content = (
      <div className="rounded-2xl border border-border/70 px-4 py-12 text-center">
        <Archive className="mx-auto mb-4 h-10 w-10 text-muted-foreground/50" />
        <div className="text-base font-medium">{t('settings.archivedChats.empty.title')}</div>
        <div className="mt-2 text-sm text-muted-foreground">{emptyTitle}</div>
      </div>
    )
  } else {
    content = (
      <div className="rounded-2xl border border-border/70 bg-background">
        <div className="divide-y divide-border/60">
          {sessions.map((session) => {
            const { canRestore, helperText } = getRestoreState(session)
            const isRestoring = restoringSessionId === session.id
            const helperKey =
              helperText === 'archived'
                ? 'settings.archivedChats.labels.archivedWorktree'
                : helperText === 'missing'
                  ? 'settings.archivedChats.labels.missingWorktree'
                  : null

            return (
              <div
                key={session.id}
                className="flex items-start justify-between gap-4 px-4 py-4"
                data-testid={`archived-chat-${session.id}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {session.name || t('sessionHistory.common.untitled')}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {t('settings.archivedChats.labels.project')}: {session.project_name || '-'}
                    </span>
                    <span className="flex items-center gap-1">
                      <GitBranch className="h-3 w-3" />
                      {t('settings.archivedChats.labels.worktree')}:{' '}
                      {session.worktree_name || t('settings.archivedChats.labels.missingWorktree')}
                    </span>
                    <span>{session.agent_sdk}</span>
                    <span>
                      {t('settings.archivedChats.labels.updated', {
                        date: formatRelativeDate(session.updated_at)
                      })}
                    </span>
                  </div>
                  {(helperKey || !canRestore) && (
                    <div className="mt-2 text-xs text-amber-600 dark:text-amber-300">
                      {helperKey ? t(helperKey) : t('settings.archivedChats.labels.restoreDisabled')}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openArchivedSession(session)}
                    data-testid={`archived-chat-open-${session.id}`}
                  >
                    <ExternalLink className="mr-1.5 h-4 w-4" />
                    {t('settings.archivedChats.actions.open')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canRestore || isRestoring}
                    onClick={() => void restoreArchivedSession(session)}
                    className={cn(!canRestore && 'cursor-not-allowed')}
                    title={!canRestore ? t('settings.archivedChats.labels.restoreDisabled') : undefined}
                    data-testid={`archived-chat-restore-${session.id}`}
                  >
                    {isRestoring ? (
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="mr-1.5 h-4 w-4" />
                    )}
                    {isRestoring
                      ? t('settings.archivedChats.actions.restoring')
                      : t('settings.archivedChats.actions.restore')}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6" data-testid="settings-archived-chats">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-base font-medium mb-1">{t('settings.archivedChats.title')}</h3>
          <p className="text-sm text-muted-foreground">{t('settings.archivedChats.description')}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void fetchArchivedSessions()}
          disabled={isLoading}
          data-testid="archived-chats-refresh-button"
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t('settings.archivedChats.actions.refresh')}
        </Button>
      </div>

      <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t('settings.archivedChats.search.placeholder')}
          data-testid="archived-chats-search-input"
        />
      </div>

      {content}
    </div>
  )
}
