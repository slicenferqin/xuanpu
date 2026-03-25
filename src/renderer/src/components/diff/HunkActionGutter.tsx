import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, Minus, Undo2 } from 'lucide-react'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { useGitStore } from '@/stores/useGitStore'
import type { Hunk } from '@/lib/diff-utils'
import { createHunkPatch } from '@/lib/diff-utils'
import type { editor } from 'monaco-editor'
import { useI18n } from '@/i18n/useI18n'

interface HunkActionGutterProps {
  hunks: Hunk[]
  staged: boolean
  worktreePath: string
  filePath: string
  originalContent: string
  modifiedContent: string
  modifiedEditor: editor.IStandaloneCodeEditor | null
  onContentChanged: () => void
}

interface HunkPosition {
  hunk: Hunk
  top: number
}

export function HunkActionGutter({
  hunks,
  staged,
  worktreePath,
  filePath,
  originalContent,
  modifiedContent,
  modifiedEditor,
  onContentChanged
}: HunkActionGutterProps): React.JSX.Element | null {
  const { t } = useI18n()
  const [positions, setPositions] = useState<HunkPosition[]>([])
  const [loading, setLoading] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const originalLines = originalContent.split('\n')
  const modifiedLines = modifiedContent.split('\n')

  // Calculate hunk positions based on Monaco editor's line positions
  const updatePositions = useCallback(() => {
    if (!modifiedEditor) return

    const newPositions: HunkPosition[] = hunks.map((hunk) => {
      // For additions and modifications, use modified side line number
      // For deletions, use the modified side anchor point
      const lineNumber =
        hunk.type === 'delete' ? Math.max(1, hunk.modifiedStartLine || 1) : hunk.modifiedStartLine

      const top = modifiedEditor.getTopForLineNumber(lineNumber)
      const scrollTop = modifiedEditor.getScrollTop()

      return {
        hunk,
        top: top - scrollTop
      }
    })

    setPositions(newPositions)
  }, [modifiedEditor, hunks])

  // Update positions on scroll and layout changes
  useEffect(() => {
    if (!modifiedEditor) return

    const disposables = [
      modifiedEditor.onDidScrollChange(() => updatePositions()),
      modifiedEditor.onDidLayoutChange(() => updatePositions())
    ]

    // Initial position calculation
    updatePositions()

    return () => disposables.forEach((d) => d.dispose())
  }, [modifiedEditor, updatePositions])

  // Recalculate when hunks change
  useEffect(() => {
    updatePositions()
  }, [hunks, updatePositions])

  const handleStageHunk = useCallback(
    async (hunk: Hunk) => {
      setLoading(hunk.index)
      try {
        const patch = createHunkPatch(filePath, originalLines, modifiedLines, hunk)
        const result = await window.gitOps.stageHunk(worktreePath, patch)
        if (result.success) {
          toast.success(t('diffUi.toasts.hunkStaged'))
          useGitStore.getState().refreshStatuses(worktreePath)
          onContentChanged()
        } else {
          toast.error(result.error || t('diffUi.errors.stageHunk'))
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('diffUi.errors.stageHunk'))
      } finally {
        setLoading(null)
      }
    },
    [filePath, originalLines, modifiedLines, worktreePath, onContentChanged, t]
  )

  const handleUnstageHunk = useCallback(
    async (hunk: Hunk) => {
      setLoading(hunk.index)
      try {
        const patch = createHunkPatch(filePath, originalLines, modifiedLines, hunk)
        const result = await window.gitOps.unstageHunk(worktreePath, patch)
        if (result.success) {
          toast.success(t('diffUi.toasts.hunkUnstaged'))
          useGitStore.getState().refreshStatuses(worktreePath)
          onContentChanged()
        } else {
          toast.error(result.error || t('diffUi.errors.unstageHunk'))
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('diffUi.errors.unstageHunk'))
      } finally {
        setLoading(null)
      }
    },
    [filePath, originalLines, modifiedLines, worktreePath, onContentChanged, t]
  )

  const handleRevertHunk = useCallback(
    async (hunk: Hunk) => {
      setLoading(hunk.index)
      try {
        const patch = createHunkPatch(filePath, originalLines, modifiedLines, hunk)
        const result = await window.gitOps.revertHunk(worktreePath, patch)
        if (result.success) {
          toast.success(t('diffUi.toasts.hunkReverted'))
          useGitStore.getState().refreshStatuses(worktreePath)
          onContentChanged()
        } else {
          toast.error(result.error || t('diffUi.errors.revertHunk'))
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('diffUi.errors.revertHunk'))
      } finally {
        setLoading(null)
      }
    },
    [filePath, originalLines, modifiedLines, worktreePath, onContentChanged, t]
  )

  if (!modifiedEditor || hunks.length === 0) return null

  return (
    <div
      ref={containerRef}
      className="absolute right-2 top-0 bottom-0 z-10 pointer-events-none"
      style={{ width: 32 }}
    >
      {positions.map(({ hunk, top }) => (
        <div
          key={hunk.index}
          className="absolute pointer-events-auto flex flex-col gap-0.5"
          style={{ top: top, right: 0 }}
        >
          {staged ? (
            // Staged diff: show Unstage button
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5 bg-orange-500/20 hover:bg-orange-500/40 border border-orange-500/30"
              onClick={() => handleUnstageHunk(hunk)}
              disabled={loading === hunk.index}
              title={t('diffUi.actions.unstageChange')}
            >
              <Minus className="h-3 w-3 text-orange-400" />
            </Button>
          ) : (
            // Unstaged diff: show Stage + Revert buttons
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 bg-green-500/20 hover:bg-green-500/40 border border-green-500/30"
                onClick={() => handleStageHunk(hunk)}
                disabled={loading === hunk.index}
                title={t('diffUi.actions.stageChange')}
              >
                <Plus className="h-3 w-3 text-green-400" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 bg-red-500/20 hover:bg-red-500/40 border border-red-500/30"
                onClick={() => handleRevertHunk(hunk)}
                disabled={loading === hunk.index}
                title={t('diffUi.actions.revertChange')}
              >
                <Undo2 className="h-3 w-3 text-red-400" />
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
