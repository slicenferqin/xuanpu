import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, MessageSquarePlus, Paperclip, Pencil, Save, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { clampMonacoLineNumber, normalizeLineNumber } from '@/lib/diff-utils'
import { useI18n } from '@/i18n/useI18n'
import type { DiffComment } from '@shared/types/git'
import type { editor } from 'monaco-editor'

interface LineCommentGroup {
  lineNumber: number
  comments: DiffComment[]
  hasDraft: boolean
}

interface ZoneEntry {
  zoneId: string
  // Monaco keeps this object mutable and expects layoutZone to reuse it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zone: any
  domNode: HTMLDivElement
  group: LineCommentGroup
}

interface DiffCommentGutterProps {
  comments: DiffComment[]
  modifiedEditor: editor.IStandaloneCodeEditor | null
  draftLineNumber: number | null
  onCancelDraft: () => void
  onCreate: (lineNumber: number, body: string) => Promise<void>
  onUpdate: (id: string, body: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onToggleResolved: (comment: DiffComment) => Promise<void>
  onAttach: (comment: DiffComment) => void
}

export function DiffCommentGutter({
  comments,
  modifiedEditor,
  draftLineNumber,
  onCancelDraft,
  onCreate,
  onUpdate,
  onDelete,
  onToggleResolved,
  onAttach
}: DiffCommentGutterProps): React.JSX.Element | null {
  const groups = useLineCommentGroups(comments, draftLineNumber)
  const [portalTargets, setPortalTargets] = useState<
    Array<{ domNode: HTMLDivElement; group: LineCommentGroup }>
  >([])
  const zonesRef = useRef<ZoneEntry[]>([])
  const disposedRef = useRef(false)

  useEffect(() => {
    disposedRef.current = false

    if (!modifiedEditor) return

    if (zonesRef.current.length > 0) {
      modifiedEditor.changeViewZones((acc) => {
        for (const zone of zonesRef.current) acc.removeZone(zone.zoneId)
      })
      zonesRef.current = []
    }

    if (groups.length === 0) {
      setPortalTargets([])
      return
    }

    const newZones: ZoneEntry[] = []
    modifiedEditor.changeViewZones((acc) => {
      for (const group of groups) {
        const domNode = document.createElement('div')
        domNode.style.pointerEvents = 'auto'
        domNode.style.position = 'relative'
        domNode.style.zIndex = '1'

        const safeLineNumber = clampMonacoLineNumber(group.lineNumber, modifiedEditor)
        const zoneGroup =
          safeLineNumber === group.lineNumber
            ? group
            : {
                ...group,
                lineNumber: safeLineNumber
              }
        const bodyLines = group.comments.reduce(
          (sum, comment) => sum + Math.max(1, Math.ceil((comment.body ?? '').length / 80)),
          0
        )
        const draftLines = group.hasDraft ? 6 : 0
        const estimatedHeight = Math.max(
          (group.comments.length * 2.5 + bodyLines + draftLines) * 18,
          56
        )
        const zone = {
          afterLineNumber: safeLineNumber,
          heightInPx: estimatedHeight,
          domNode,
          suppressMouseDown: true
        }
        const zoneId = acc.addZone(zone)
        newZones.push({ zoneId, zone, domNode, group: zoneGroup })
      }
    })

    zonesRef.current = newZones
    setPortalTargets(newZones.map((zone) => ({ domNode: zone.domNode, group: zone.group })))

    const observers = newZones.map((zoneEntry) => {
      const measureAndAdjust = (): void => {
        if (disposedRef.current) return
        const child = zoneEntry.domNode.firstElementChild as HTMLElement | null
        if (!child) return
        const actualHeight = child.offsetHeight
        if (actualHeight > 0 && Math.abs(actualHeight - zoneEntry.zone.heightInPx) > 2) {
          zoneEntry.zone.heightInPx = actualHeight + 6
          const scrollTop = modifiedEditor.getScrollTop()
          modifiedEditor.changeViewZones((acc) => acc.layoutZone(zoneEntry.zoneId))
          modifiedEditor.setScrollTop(scrollTop)
        }
      }

      const mutation = new MutationObserver(measureAndAdjust)
      mutation.observe(zoneEntry.domNode, { childList: true, subtree: true, attributes: true })

      const resize = new ResizeObserver(measureAndAdjust)
      resize.observe(zoneEntry.domNode)

      return { mutation, resize }
    })

    return () => {
      disposedRef.current = true
      observers.forEach((observer) => {
        observer.mutation.disconnect()
        observer.resize.disconnect()
      })
      modifiedEditor.changeViewZones((acc) => {
        for (const zone of newZones) acc.removeZone(zone.zoneId)
      })
    }
  }, [modifiedEditor, groups])

  if (!modifiedEditor || groups.length === 0) return null

  return (
    <>
      {portalTargets.map(({ domNode, group }) =>
        createPortal(
          <LineCommentZone
            key={`${group.lineNumber}:${group.hasDraft ? 'draft' : 'saved'}:${group.comments.map((comment) => comment.id).join(',')}`}
            group={group}
            onCancelDraft={onCancelDraft}
            onCreate={onCreate}
            onUpdate={onUpdate}
            onDelete={onDelete}
            onToggleResolved={onToggleResolved}
            onAttach={onAttach}
          />,
          domNode
        )
      )}
    </>
  )
}

function useLineCommentGroups(
  comments: DiffComment[],
  draftLineNumber: number | null
): LineCommentGroup[] {
  return useMemo(() => {
    const grouped = new Map<number, DiffComment[]>()
    for (const comment of comments) {
      const lineNumber = normalizeLineNumber(comment.lineNumber)
      const lineComments = grouped.get(lineNumber) ?? []
      lineComments.push(comment)
      grouped.set(lineNumber, lineComments)
    }

    if (draftLineNumber != null) {
      const normalizedDraftLine = normalizeLineNumber(draftLineNumber)
      if (!grouped.has(normalizedDraftLine)) {
        grouped.set(normalizedDraftLine, [])
      }
    }

    return Array.from(grouped.entries())
      .map(([lineNumber, lineComments]) => ({
        lineNumber,
        comments: [...lineComments].sort((a, b) => a.createdAt - b.createdAt),
        hasDraft: draftLineNumber === lineNumber
      }))
      .sort((a, b) => a.lineNumber - b.lineNumber)
  }, [comments, draftLineNumber])
}

function LineCommentZone({
  group,
  onCancelDraft,
  onCreate,
  onUpdate,
  onDelete,
  onToggleResolved,
  onAttach
}: {
  group: LineCommentGroup
  onCancelDraft: () => void
  onCreate: (lineNumber: number, body: string) => Promise<void>
  onUpdate: (id: string, body: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onToggleResolved: (comment: DiffComment) => Promise<void>
  onAttach: (comment: DiffComment) => void
}): React.JSX.Element {
  return (
    <div
      className="mx-1 my-1 rounded-md border border-emerald-500/30 bg-emerald-950/20"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {group.comments.map((comment) => (
        <SavedComment
          key={comment.id}
          comment={comment}
          onUpdate={onUpdate}
          onDelete={onDelete}
          onToggleResolved={onToggleResolved}
          onAttach={onAttach}
        />
      ))}
      {group.hasDraft && (
        <DraftComment lineNumber={group.lineNumber} onCancel={onCancelDraft} onCreate={onCreate} />
      )}
    </div>
  )
}

function SavedComment({
  comment,
  onUpdate,
  onDelete,
  onToggleResolved,
  onAttach
}: {
  comment: DiffComment
  onUpdate: (id: string, body: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onToggleResolved: (comment: DiffComment) => Promise<void>
  onAttach: (comment: DiffComment) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const [isSaving, setIsSaving] = useState(false)

  const handleSave = async (): Promise<void> => {
    const body = draft.trim()
    if (!body) return
    setIsSaving(true)
    await onUpdate(comment.id, body)
    setIsSaving(false)
    setIsEditing(false)
  }

  return (
    <div
      className={cn(
        'border-b border-border/40 px-3 py-2 text-xs last:border-b-0',
        comment.resolved && 'opacity-60'
      )}
      data-testid="diff-comment-card"
    >
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className="font-mono text-foreground">:{comment.lineNumber}</span>
        {comment.resolved && (
          <span className="rounded bg-emerald-500/10 px-1 py-px text-[10px] text-emerald-400">
            {t('diffComments.resolved')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            title={t('diffComments.attachToChat')}
            onClick={() => onAttach(comment)}
          >
            <Paperclip className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            title={comment.resolved ? t('diffComments.reopen') : t('diffComments.resolve')}
            onClick={() => onToggleResolved(comment)}
          >
            <Check className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5"
            title={t('diffComments.edit')}
            onClick={() => {
              setDraft(comment.body)
              setIsEditing(true)
            }}
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 text-destructive hover:text-destructive"
            title={t('diffComments.delete')}
            onClick={() => onDelete(comment.id)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {isEditing ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="min-h-[56px] resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-emerald-500/60"
            data-testid="diff-comment-edit-textarea"
          />
          <div className="flex justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setIsEditing(false)}
            >
              <X className="mr-1 h-3 w-3" />
              {t('diffComments.cancel')}
            </Button>
            <Button
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={isSaving || !draft.trim()}
              onClick={handleSave}
            >
              <Save className="mr-1 h-3 w-3" />
              {t('diffComments.save')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap break-words text-foreground">{comment.body}</p>
      )}
    </div>
  )
}

function DraftComment({
  lineNumber,
  onCancel,
  onCreate
}: {
  lineNumber: number
  onCancel: () => void
  onCreate: (lineNumber: number, body: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useI18n()
  const [body, setBody] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  const handleCreate = async (): Promise<void> => {
    const nextBody = body.trim()
    if (!nextBody) return
    setIsSaving(true)
    await onCreate(lineNumber, nextBody)
    setIsSaving(false)
    setBody('')
  }

  return (
    <div className="px-3 py-2" data-testid="diff-comment-draft">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <MessageSquarePlus className="h-3 w-3 text-emerald-400" />
        <span>{t('diffComments.newOnLine', { line: lineNumber })}</span>
      </div>
      <textarea
        value={body}
        autoFocus
        onChange={(event) => setBody(event.target.value)}
        placeholder={t('diffComments.placeholder')}
        className="min-h-[72px] w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-emerald-500/60"
        data-testid="diff-comment-create-textarea"
      />
      <div className="mt-2 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onCancel}>
          <X className="mr-1 h-3 w-3" />
          {t('diffComments.cancel')}
        </Button>
        <Button
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={isSaving || !body.trim()}
          onClick={handleCreate}
        >
          <Save className="mr-1 h-3 w-3" />
          {t('diffComments.save')}
        </Button>
      </div>
    </div>
  )
}
