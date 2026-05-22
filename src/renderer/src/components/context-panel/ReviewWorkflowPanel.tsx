import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Archive,
  ChevronDown,
  FileSearch,
  GitMerge,
  GitPullRequest,
  Loader2,
  X
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'
import { useLayoutStore, type RightReviewTab } from '@/stores/useLayoutStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useGitStore } from '@/stores/useGitStore'
import { useSessionStore } from '@/stores/useSessionStore'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ChangesView } from '@/components/file-tree/ChangesView'
import { BranchDiffView } from '@/components/file-tree/BranchDiffView'
import { DiffCommentsViewer } from '@/components/diff-comments/DiffCommentsViewer'
import { PrReviewViewer } from '@/components/pr-review/PrReviewViewer'
import { toast } from '@/lib/toast'

export interface ConnectionMemberInfo {
  worktree_path: string
  project_name: string
  worktree_branch: string
}

interface ReviewWorkflowPanelProps {
  worktreePath: string | null
  isConnectionMode?: boolean
  connectionMembers?: ConnectionMemberInfo[]
}

type WorktreeRecord =
  ReturnType<typeof useWorktreeStore.getState>['worktreesByProject'] extends Map<
    string,
    Array<infer T>
  >
    ? T
    : never

type RemoteBranch = { name: string; isRemote?: boolean }

type PullRequestListItem = {
  number: number
  title: string
  author: string
  headRefName: string
}

const REVIEW_TABS: Array<{ id: RightReviewTab; labelKey: string }> = [
  { id: 'changes', labelKey: 'fileTree.sidebar.changes' },
  { id: 'diffs', labelKey: 'fileTree.sidebar.diffs' },
  { id: 'comments', labelKey: 'fileTree.sidebar.comments' }
]

function findWorktreeById(
  worktreesByProject: ReturnType<typeof useWorktreeStore.getState>['worktreesByProject'],
  worktreeId: string | null
): WorktreeRecord | null {
  if (!worktreeId) return null
  for (const worktrees of worktreesByProject.values()) {
    const worktree = worktrees.find((item) => item.id === worktreeId)
    if (worktree) return worktree
  }
  return null
}

function getPullRequestUrl(remoteUrl: string, prNumber: number): string {
  const cleanUrl = remoteUrl.replace(/\.git$/, '')
  if (cleanUrl.startsWith('git@github.com:')) {
    return `https://github.com/${cleanUrl.slice('git@github.com:'.length)}/pull/${prNumber}`
  }
  return `${cleanUrl}/pull/${prNumber}`
}

export function ReviewWorkflowPanel({
  worktreePath,
  isConnectionMode,
  connectionMembers
}: ReviewWorkflowPanelProps): React.JSX.Element {
  const { t } = useI18n()
  const projects = useProjectStore((s) => s.projects)
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const selectedWorktree = useMemo(
    () => findWorktreeById(worktreesByProject, selectedWorktreeId),
    [selectedWorktreeId, worktreesByProject]
  )
  const selectedProject = useMemo(
    () =>
      selectedWorktree
        ? projects.find((project) => project.id === selectedWorktree.project_id)
        : null,
    [projects, selectedWorktree]
  )
  const activeReviewTab = useLayoutStore((s) => s.rightReviewTab)
  const setRightReviewTab = useLayoutStore((s) => s.setRightReviewTab)
  const createSession = useSessionStore((s) => s.createSession)
  const updateSessionName = useSessionStore((s) => s.updateSessionName)
  const setPendingMessage = useSessionStore((s) => s.setPendingMessage)
  const remoteInfo = useGitStore((s) =>
    selectedWorktreeId ? s.remoteInfo.get(selectedWorktreeId) : undefined
  )
  const branchInfoByWorktree = useGitStore((s) => s.branchInfoByWorktree)
  const branchInfo = selectedWorktree?.path
    ? branchInfoByWorktree.get(selectedWorktree.path)
    : undefined
  const reviewTargetBranch = useGitStore((s) =>
    selectedWorktreeId ? s.reviewTargetBranch.get(selectedWorktreeId) : undefined
  )
  const setReviewTargetBranch = useGitStore((s) => s.setReviewTargetBranch)
  const prTargetBranch = useGitStore((s) =>
    selectedWorktreeId ? s.prTargetBranch.get(selectedWorktreeId) : undefined
  )
  const setPrTargetBranch = useGitStore((s) => s.setPrTargetBranch)
  const prCreation = useGitStore((s) =>
    selectedWorktreeId ? s.prCreation.get(selectedWorktreeId) : undefined
  )
  const attachedPR = useGitStore((s) =>
    selectedWorktreeId ? s.attachedPR.get(selectedWorktreeId) : undefined
  )
  const setPrCreation = useGitStore((s) => s.setPrCreation)
  const isOperating = useGitStore((s) => s.isPushing || s.isPulling)
  const fileStatuses = useGitStore((s) =>
    selectedWorktree?.path ? s.fileStatusesByWorktree.get(selectedWorktree.path) : undefined
  )
  const isCleanTree = !fileStatuses || fileStatuses.length === 0
  const isGitHub = remoteInfo?.isGitHub ?? false
  const isCreatingPR = prCreation?.creating ?? false
  const hasAttachedPR = !!attachedPR
  const attachedPRNumber = attachedPR?.number
  const effectiveReviewTab =
    !selectedWorktreeId && activeReviewTab === 'comments' ? 'changes' : activeReviewTab
  const [remoteBranches, setRemoteBranches] = useState<RemoteBranch[]>([])
  const [isMergingPR, setIsMergingPR] = useState(false)
  const [isArchivingWorktree, setIsArchivingWorktree] = useState(false)
  const [prPickerOpen, setPrPickerOpen] = useState(false)
  const [prList, setPrList] = useState<PullRequestListItem[]>([])
  const [prListLoading, setPrListLoading] = useState(false)
  const [prLiveState, setPrLiveState] = useState<{
    number?: number
    state?: string
    title?: string
  } | null>(null)
  const currentPRLiveState = prLiveState?.number === attachedPRNumber ? prLiveState : null
  const compareTarget = reviewTargetBranch || branchInfo?.tracking || 'origin/main'
  const prTarget = prTargetBranch || branchInfo?.tracking || 'origin/main'
  const branchName =
    branchInfo?.name || selectedWorktree?.branch_name || t('gitStatusPanel.unknownBranch')
  const attachedPRTitle = currentPRLiveState?.title?.trim() ?? ''
  const prBadgeTitle =
    attachedPRNumber == null
      ? ''
      : attachedPRTitle
        ? `PR #${attachedPRNumber}: ${attachedPRTitle}`
        : `PR #${attachedPRNumber}`

  const refreshAttachedPRState = useCallback(async (): Promise<void> => {
    if (attachedPRNumber == null || !selectedProject?.path || !window.gitOps?.getPRState) {
      setPrLiveState(null)
      return
    }

    try {
      const result = await window.gitOps.getPRState(selectedProject.path, attachedPRNumber)
      if (result.success) {
        setPrLiveState({ number: attachedPRNumber, state: result.state, title: result.title })
      }
    } catch {
      /* non-critical */
    }
  }, [attachedPRNumber, selectedProject?.path])

  useEffect(() => {
    if (!selectedWorktreeId && activeReviewTab === 'comments') {
      setRightReviewTab('changes')
    }
  }, [activeReviewTab, selectedWorktreeId, setRightReviewTab])

  useEffect(() => {
    let cancelled = false

    if (!selectedWorktree?.path || !window.gitOps?.listBranchesWithStatus) {
      setRemoteBranches([])
      return () => {
        cancelled = true
      }
    }

    window.gitOps
      .listBranchesWithStatus(selectedWorktree.path)
      .then((result) => {
        if (cancelled) return
        if (result.success) {
          setRemoteBranches(result.branches.filter((branch) => branch.isRemote))
        } else {
          setRemoteBranches([])
        }
      })
      .catch(() => {
        if (!cancelled) setRemoteBranches([])
      })

    return () => {
      cancelled = true
    }
  }, [selectedWorktree?.path])

  useEffect(() => {
    void refreshAttachedPRState()
  }, [refreshAttachedPRState])

  useEffect(() => {
    if (!prPickerOpen || !selectedProject?.path || !window.gitOps?.listPRs) return
    let cancelled = false
    setPrListLoading(true)

    const fetchPRs = window.gitOps
      .listPRs(selectedProject.path)
      .then((result) => {
        if (cancelled) return
        if (result.success) {
          const sorted = [...result.prs].sort((a, b) => {
            const aMatch = a.headRefName === branchName ? 1 : 0
            const bMatch = b.headRefName === branchName ? 1 : 0
            if (aMatch !== bMatch) return bMatch - aMatch
            return b.number - a.number
          })
          setPrList(sorted)
        } else {
          toast.error(result.error || t('header.toasts.loadPRsError'))
          setPrPickerOpen(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          toast.error(t('header.toasts.loadPRsError'))
          setPrPickerOpen(false)
        }
      })

    Promise.all([fetchPRs, refreshAttachedPRState()]).finally(() => {
      if (!cancelled) setPrListLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [branchName, prPickerOpen, refreshAttachedPRState, selectedProject?.path, t])

  const handleStartReview = useCallback(async () => {
    if (!selectedWorktree || !selectedWorktreeId) {
      toast.error(t('header.toasts.noWorktreeSelected'))
      return
    }

    let reviewTemplate = ''
    try {
      if (window.fileOps?.readPrompt) {
        const result = await window.fileOps.readPrompt('review.md')
        if (result.success && result.content) {
          reviewTemplate = result.content
        }
      }
    } catch {
      // readPrompt failed, use fallback
    }

    const prompt = reviewTemplate
      ? [
          reviewTemplate,
          '',
          '---',
          '',
          `Compare the current branch (${branchName}) against ${compareTarget}.`,
          `Use \`git diff ${compareTarget}...HEAD\` to see all changes.`
        ].join('\n')
      : [
          `Please review the changes on branch "${branchName}" compared to ${compareTarget}.`,
          `Use \`git diff ${compareTarget}...HEAD\` to get the full diff.`,
          'Focus on: bugs, logic errors, and code quality.'
        ].join('\n')

    const result = await createSession(selectedWorktreeId, selectedWorktree.project_id)
    if (!result.success || !result.session) {
      toast.error(t('header.toasts.createReviewSessionError'))
      return
    }

    await updateSessionName(
      result.session.id,
      t('header.sessionNames.review', { branch: branchName, target: compareTarget })
    )
    setPendingMessage(result.session.id, prompt)
  }, [
    branchName,
    compareTarget,
    createSession,
    selectedWorktree,
    selectedWorktreeId,
    setPendingMessage,
    t,
    updateSessionName
  ])

  const handleCreatePR = useCallback(async () => {
    if (!selectedWorktree || !selectedWorktreeId) {
      toast.error(t('header.toasts.noWorktreeSelected'))
      return
    }

    const result = await createSession(selectedWorktreeId, selectedWorktree.project_id)
    if (!result.success || !result.session) {
      toast.error(t('header.toasts.createPRSessionError'))
      return
    }

    await updateSessionName(result.session.id, t('header.sessionNames.pr', { branch: prTarget }))
    setPendingMessage(
      result.session.id,
      [
        `Create a pull request targeting ${prTarget}.`,
        `Use \`gh pr create\` to create the PR.`,
        `Base the PR title and description on the git diff between HEAD and ${prTarget}.`,
        `Make the description comprehensive, summarizing all changes.`
      ].join(' ')
    )

    setPrCreation(selectedWorktreeId, {
      creating: true,
      sessionId: result.session.id
    })
  }, [
    createSession,
    prTarget,
    selectedWorktree,
    selectedWorktreeId,
    setPendingMessage,
    setPrCreation,
    t,
    updateSessionName
  ])

  const handleSelectPR = useCallback(
    (pr: PullRequestListItem) => {
      if (!selectedWorktreeId || !remoteInfo?.url) return
      useGitStore
        .getState()
        .attachPR(selectedWorktreeId, pr.number, getPullRequestUrl(remoteInfo.url, pr.number))
      setPrLiveState({ number: pr.number, state: 'OPEN', title: pr.title })
      setPrPickerOpen(false)
    },
    [remoteInfo?.url, selectedWorktreeId]
  )

  const handleDetachPR = useCallback(() => {
    if (!selectedWorktreeId) return
    useGitStore.getState().detachPR(selectedWorktreeId)
    setPrPickerOpen(false)
    setPrLiveState(null)
  }, [selectedWorktreeId])

  const handleMergePR = useCallback(async () => {
    if (!selectedWorktree?.path || !selectedWorktreeId) return
    const pr = useGitStore.getState().attachedPR.get(selectedWorktreeId)
    if (!pr?.number || !window.gitOps?.prMerge) return

    setIsMergingPR(true)
    try {
      const result = await window.gitOps.prMerge(selectedWorktree.path, pr.number)
      if (result.success) {
        toast.success(t('header.toasts.prMergedSuccess'))
        setPrLiveState({
          number: pr.number,
          state: 'MERGED',
          title: currentPRLiveState?.title
        })
      } else {
        toast.error(t('header.toasts.mergePRErrorWithReason', { error: result.error }))
      }
    } catch {
      toast.error(t('header.toasts.mergePRError'))
    } finally {
      setIsMergingPR(false)
    }
  }, [currentPRLiveState?.title, selectedWorktree?.path, selectedWorktreeId, t])

  const handleArchiveWorktree = useCallback(async () => {
    if (!selectedWorktreeId || !selectedWorktree || !selectedProject) return
    setIsArchivingWorktree(true)
    try {
      const result = await useWorktreeStore
        .getState()
        .archiveWorktree(
          selectedWorktreeId,
          selectedWorktree.path,
          selectedWorktree.branch_name,
          selectedProject.path
        )

      if (!result.success && result.error) {
        toast.error(result.error)
      }
    } finally {
      setIsArchivingWorktree(false)
    }
  }, [selectedProject, selectedWorktree, selectedWorktreeId])

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="context-panel-review">
      <div className="border-b border-sidebar-border/60 px-2.5 py-2">
        <div className="inline-flex min-w-max items-center gap-1 rounded-lg bg-sidebar-accent/40 p-0.5">
          {REVIEW_TABS.map((tab) => {
            if (tab.id === 'comments' && !selectedWorktreeId) return null
            return (
              <button
                key={tab.id}
                type="button"
                className={cn(
                  'shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                  effectiveReviewTab === tab.id
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
                )}
                onClick={() => setRightReviewTab(tab.id)}
                data-testid={`context-panel-review-${tab.id}`}
              >
                {t(tab.labelKey)}
              </button>
            )
          })}
        </div>
      </div>

      {selectedWorktree && (
        <div
          className="space-y-2 border-b border-sidebar-border/60 px-2.5 py-2.5"
          data-testid="context-panel-review-actions"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 min-w-0 flex-1 justify-center rounded-lg px-2 text-[11px] font-medium"
              onClick={handleStartReview}
              disabled={isOperating}
              title={t('contextPanel.review.startReviewTitle')}
              data-testid="review-button"
            >
              <FileSearch className="mr-1 h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{t('contextPanel.review.startReview')}</span>
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 max-w-[140px] rounded-lg px-2 text-[11px] text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                  data-testid="review-target-branch-trigger"
                >
                  <span className="truncate">vs {compareTarget}</span>
                  <ChevronDown className="ml-1 h-3 w-3 shrink-0" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-60 overflow-y-auto">
                {remoteBranches.length === 0 ? (
                  <DropdownMenuItem disabled>
                    {t('header.controls.noRemoteBranches')}
                  </DropdownMenuItem>
                ) : (
                  remoteBranches.map((branch) => (
                    <DropdownMenuItem
                      key={branch.name}
                      onClick={() =>
                        selectedWorktreeId && setReviewTargetBranch(selectedWorktreeId, branch.name)
                      }
                      data-testid={`review-target-branch-${branch.name}`}
                    >
                      {branch.name}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="rounded-lg border border-sidebar-border/60 bg-sidebar-accent/20 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            {t('contextPanel.review.sessionHint')}
          </div>

          {isGitHub && (
            <div className="flex min-w-0 items-center gap-1.5" data-testid="pr-section">
              {hasAttachedPR &&
                currentPRLiveState?.state !== 'MERGED' &&
                currentPRLiveState?.state !== 'CLOSED' &&
                isCleanTree && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 rounded-lg border-emerald-600/30 bg-emerald-600/10 px-2 text-[11px] text-emerald-500 hover:bg-emerald-600/20"
                    onClick={handleMergePR}
                    disabled={isMergingPR}
                    title={t('header.controls.mergePRTitle')}
                    data-testid="pr-merge-button"
                  >
                    {isMergingPR ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <GitMerge className="mr-1 h-3.5 w-3.5" />
                    )}
                    {isMergingPR ? t('header.controls.merging') : t('header.controls.mergePR')}
                  </Button>
                )}

              {hasAttachedPR &&
                currentPRLiveState?.state === 'MERGED' &&
                !selectedWorktree.is_default && (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 rounded-lg px-2 text-[11px]"
                    onClick={handleArchiveWorktree}
                    disabled={isArchivingWorktree}
                    title={t('header.controls.archiveWorktreeTitle')}
                    data-testid="pr-archive-button"
                  >
                    {isArchivingWorktree ? (
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Archive className="mr-1 h-3.5 w-3.5" />
                    )}
                    {isArchivingWorktree
                      ? t('header.controls.archiving')
                      : t('header.controls.archive')}
                  </Button>
                )}

              {hasAttachedPR && !isCreatingPR && (
                <Popover open={prPickerOpen} onOpenChange={setPrPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 min-w-0 flex-1 rounded-lg px-2 text-[11px] font-medium"
                      title={prBadgeTitle}
                      data-testid="pr-badge"
                    >
                      <GitPullRequest className="mr-1 h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">PR #{attachedPR.number}</span>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-80 p-0">
                    <div className="border-b px-3 py-2">
                      <div className="text-xs font-medium text-muted-foreground">
                        {t('header.controls.attached')}: #{attachedPR.number}
                      </div>
                      {currentPRLiveState?.title && (
                        <div className="truncate text-sm">
                          {currentPRLiveState.title}
                          {currentPRLiveState?.state && (
                            <span className="ml-1 text-xs text-muted-foreground">
                              ({currentPRLiveState.state.toLowerCase()})
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                      {prListLoading ? (
                        <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                          <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
                          {t('header.controls.loadingPRs')}
                        </div>
                      ) : prList.length === 0 ? (
                        <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                          {t('header.controls.noOpenPRs')}
                        </div>
                      ) : (
                        prList.map((pr) => (
                          <button
                            key={pr.number}
                            className={cn(
                              'flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent',
                              pr.number === attachedPR.number && 'bg-accent/50'
                            )}
                            onClick={() => handleSelectPR(pr)}
                            data-testid={`pr-picker-item-${pr.number}`}
                          >
                            <span
                              className={cn(
                                'shrink-0 font-mono text-xs',
                                pr.number === attachedPR.number && 'font-bold text-primary'
                              )}
                            >
                              {pr.number === attachedPR.number ? '●' : ' '} #{pr.number}
                            </span>
                            <span className="truncate">{pr.title}</span>
                          </button>
                        ))
                      )}
                    </div>
                    <div className="border-t">
                      <button
                        className="flex w-full cursor-pointer items-center gap-1 px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
                        onClick={handleDetachPR}
                        data-testid="pr-detach-button"
                      >
                        <X className="h-3.5 w-3.5" />
                        {t('header.controls.detachPR')}
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}

              {isCreatingPR && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 min-w-0 flex-1 rounded-lg px-2 text-[11px] font-medium"
                  disabled
                  data-testid="pr-creating-button"
                >
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  PR
                </Button>
              )}

              {!hasAttachedPR && !isCreatingPR && (
                <Popover open={prPickerOpen} onOpenChange={setPrPickerOpen}>
                  <PopoverAnchor asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 min-w-0 flex-1 rounded-lg px-2 text-[11px] font-medium"
                      onClick={handleCreatePR}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        setPrPickerOpen(true)
                      }}
                      disabled={isOperating}
                      title={t('header.controls.createPRTitle')}
                      data-testid="pr-button"
                    >
                      <GitPullRequest className="mr-1 h-3.5 w-3.5 shrink-0" />
                      PR
                    </Button>
                  </PopoverAnchor>
                  <PopoverContent align="end" className="w-80 p-0">
                    <div className="border-b px-3 py-2">
                      <div className="text-xs font-medium text-muted-foreground">
                        {t('header.controls.attachExistingPR')}
                      </div>
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                      {prListLoading ? (
                        <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                          <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
                          {t('header.controls.loadingPRs')}
                        </div>
                      ) : prList.length === 0 ? (
                        <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                          {t('header.controls.noOpenPRs')}
                        </div>
                      ) : (
                        prList.map((pr) => (
                          <button
                            key={pr.number}
                            className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                            onClick={() => handleSelectPR(pr)}
                            data-testid={`pr-picker-item-${pr.number}`}
                          >
                            <span className="shrink-0 font-mono text-xs">#{pr.number}</span>
                            <span className="truncate">{pr.title}</span>
                          </button>
                        ))
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 max-w-[120px] rounded-lg px-2 text-[11px] text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                    data-testid="pr-target-branch-trigger"
                  >
                    <span className="truncate">→ {prTarget}</span>
                    <ChevronDown className="ml-1 h-3 w-3 shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-60 overflow-y-auto">
                  {remoteBranches.length === 0 ? (
                    <DropdownMenuItem disabled>
                      {t('header.controls.noRemoteBranches')}
                    </DropdownMenuItem>
                  ) : (
                    remoteBranches.map((branch) => (
                      <DropdownMenuItem
                        key={branch.name}
                        onClick={() =>
                          selectedWorktreeId && setPrTargetBranch(selectedWorktreeId, branch.name)
                        }
                        data-testid={`pr-target-branch-${branch.name}`}
                      >
                        {branch.name}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {effectiveReviewTab === 'comments' && selectedWorktreeId ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <DiffCommentsViewer
              worktreeId={selectedWorktreeId}
              worktreePath={worktreePath}
              compact={hasAttachedPR}
            />
            {hasAttachedPR && <PrReviewViewer worktreeId={selectedWorktreeId} />}
          </div>
        ) : effectiveReviewTab === 'diffs' ? (
          <BranchDiffView worktreePath={worktreePath} />
        ) : (
          <ChangesView
            worktreePath={worktreePath}
            isConnectionMode={isConnectionMode}
            connectionMembers={connectionMembers}
          />
        )}
      </div>
    </div>
  )
}
