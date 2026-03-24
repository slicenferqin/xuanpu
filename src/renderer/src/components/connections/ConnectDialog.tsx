import { useState, useEffect, useMemo, useCallback } from 'react'
import { Loader2, Search, Link, GitBranch, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useProjectStore, useWorktreeStore, useConnectionStore } from '@/stores'
import { useI18n } from '@/i18n/useI18n'

interface ConnectDialogProps {
  sourceWorktreeId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface WorktreeOption {
  id: string
  name: string
  branchName: string
  projectId: string
  projectName: string
}

interface ProjectGroup {
  projectId: string
  projectName: string
  worktrees: WorktreeOption[]
}

export function ConnectDialog({
  sourceWorktreeId,
  open,
  onOpenChange
}: ConnectDialogProps): React.JSX.Element {
  const projects = useProjectStore((s) => s.projects)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const connections = useConnectionStore((s) => s.connections)
  const createConnection = useConnectionStore((s) => s.createConnection)
  const addMember = useConnectionStore((s) => s.addMember)

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const { t } = useI18n()

  // Find the source worktree's project ID
  const sourceProjectId = useMemo(() => {
    for (const [projectId, worktrees] of worktreesByProject.entries()) {
      if (worktrees.some((w) => w.id === sourceWorktreeId)) {
        return projectId
      }
    }
    return null
  }, [worktreesByProject, sourceWorktreeId])

  // Find existing connections that contain the source worktree
  const existingConnections = useMemo(() => {
    return connections.filter((c) => c.members?.some((m) => m.worktree_id === sourceWorktreeId))
  }, [connections, sourceWorktreeId])

  // Build worktree options grouped by project, excluding source project
  const projectGroups = useMemo(() => {
    const groups: ProjectGroup[] = []

    for (const project of projects) {
      // Skip the source worktree's project
      if (project.id === sourceProjectId) continue

      const worktrees = worktreesByProject.get(project.id) || []
      const activeWorktrees = worktrees.filter((w) => w.status === 'active')

      if (activeWorktrees.length === 0) continue

      groups.push({
        projectId: project.id,
        projectName: project.name,
        worktrees: activeWorktrees.map((w) => ({
          id: w.id,
          name: w.name,
          branchName: w.branch_name,
          projectId: project.id,
          projectName: project.name
        }))
      })
    }

    return groups
  }, [projects, worktreesByProject, sourceProjectId])

  // Filter groups by search query
  const filteredGroups = useMemo(() => {
    if (!filter) return projectGroups
    const lowerFilter = filter.toLowerCase()

    return projectGroups
      .map((group) => ({
        ...group,
        worktrees: group.worktrees.filter(
          (w) =>
            w.name.toLowerCase().includes(lowerFilter) ||
            w.branchName.toLowerCase().includes(lowerFilter) ||
            w.projectName.toLowerCase().includes(lowerFilter)
        )
      }))
      .filter((group) => group.worktrees.length > 0)
  }, [projectGroups, filter])

  // Total available worktrees count
  const totalWorktrees = useMemo(
    () => projectGroups.reduce((sum, g) => sum + g.worktrees.length, 0),
    [projectGroups]
  )

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      setSelectedIds(new Set())
      setFilter('')
      setIsSubmitting(false)
    }
  }, [open])

  const toggleWorktree = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const handleCreateConnection = useCallback(async () => {
    if (selectedIds.size === 0) return
    setIsSubmitting(true)

    try {
      const worktreeIds = [sourceWorktreeId, ...Array.from(selectedIds)]
      await createConnection(worktreeIds)
      onOpenChange(false)
    } finally {
      setIsSubmitting(false)
    }
  }, [selectedIds, sourceWorktreeId, createConnection, onOpenChange])

  const handleAddToExisting = useCallback(
    async (connectionId: string) => {
      // Find worktrees from other projects that aren't already in this connection
      // For "add to existing", we add the source worktree to the connection
      // But source is already in it — so this is about adding selected worktrees
      // Actually, "add to existing connection" means we pick an existing connection
      // and add the source worktree to it (if it's not already there)
      // OR add selected worktrees to it
      setIsSubmitting(true)
      try {
        // Add all selected worktrees to the existing connection
        for (const id of selectedIds) {
          await addMember(connectionId, id)
        }
        onOpenChange(false)
      } finally {
        setIsSubmitting(false)
      }
    },
    [selectedIds, addMember, onOpenChange]
  )

  // Connections the source worktree is NOT part of (for "add to" option)
  const addableConnections = useMemo(() => {
    return connections.filter((c) => !c.members?.some((m) => m.worktree_id === sourceWorktreeId))
  }, [connections, sourceWorktreeId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="connect-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link className="h-4 w-4" />
            {t('dialogs.connect.title')}
          </DialogTitle>
          <DialogDescription>{t('dialogs.connect.description')}</DialogDescription>
        </DialogHeader>

        {/* Existing connections section */}
        {existingConnections.length > 0 && (
          <div className="space-y-2" data-testid="existing-connections">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t('dialogs.connect.existingConnections')}
            </p>
            <div className="space-y-1">
              {existingConnections.map((conn) => (
                <div
                  key={conn.id}
                  className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted/50 text-sm"
                >
                  <Link className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="font-medium truncate">{conn.name}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {conn.members?.map((m) => m.project_name).join(' + ')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add to existing connection section */}
        {addableConnections.length > 0 && selectedIds.size > 0 && (
          <div className="space-y-2" data-testid="addable-connections">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t('dialogs.connect.addToExisting')}
            </p>
            <div className="space-y-1">
              {addableConnections.map((conn) => (
                <button
                  key={conn.id}
                  className={cn(
                    'flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm text-left',
                    'hover:bg-accent hover:text-accent-foreground transition-colors',
                    'focus:bg-accent focus:text-accent-foreground focus:outline-none'
                  )}
                  onClick={() => handleAddToExisting(conn.id)}
                  disabled={isSubmitting}
                  data-testid={`add-to-connection-${conn.id}`}
                >
                  <Plus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="font-medium truncate">{conn.name}</span>
                  <span className="text-xs text-muted-foreground truncate">
                    {conn.members?.map((m) => m.project_name).join(' + ')}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Search/Filter */}
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('dialogs.connect.filterPlaceholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-9"
            data-testid="connect-dialog-filter"
          />
        </div>

        {/* Worktree List grouped by project */}
        <div
          className="max-h-[300px] overflow-y-auto border rounded-md"
          data-testid="worktree-list"
        >
          {totalWorktrees === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('dialogs.connect.noWorktrees')}
              <br />
              {t('dialogs.connect.noWorktreesHint')}
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t('dialogs.connect.noMatches')}
            </div>
          ) : (
            <div className="py-1">
              {filteredGroups.map((group) => (
                <div key={group.projectId}>
                  {/* Project group header */}
                  <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider bg-muted/30 sticky top-0">
                    {group.projectName}
                  </div>
                  {/* Worktrees in this project */}
                  {group.worktrees.map((wt) => (
                    <label
                      key={wt.id}
                      className={cn(
                        'flex items-center gap-2.5 w-full px-3 py-2 text-sm cursor-pointer',
                        'hover:bg-accent/50 transition-colors',
                        selectedIds.has(wt.id) && 'bg-accent/30'
                      )}
                      data-testid={`worktree-option-${wt.id}`}
                    >
                      <Checkbox
                        checked={selectedIds.has(wt.id)}
                        onCheckedChange={() => toggleWorktree(wt.id)}
                        data-testid={`worktree-checkbox-${wt.id}`}
                      />
                      <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <span className="truncate block">{wt.name}</span>
                        <span className="text-xs text-muted-foreground truncate block">
                          {wt.branchName}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer with count and action */}
        <DialogFooter className="flex items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {selectedIds.size > 0
              ? t('dialogs.connect.selectedCount', {
                  count: selectedIds.size,
                  label:
                    selectedIds.size === 1
                      ? t('dialogs.connect.worktreeSingular')
                      : t('dialogs.connect.worktreePlural')
                })
              : t('dialogs.connect.selectedNone')}
          </p>
          <Button
            onClick={handleCreateConnection}
            disabled={selectedIds.size === 0 || isSubmitting}
            data-testid="connect-button"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {t('dialogs.connect.connecting')}
              </>
            ) : (
              <>
                <Link className="h-4 w-4 mr-2" />
                {t('dialogs.connect.connect')}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
