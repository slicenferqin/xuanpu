import { useState } from 'react'
import { X, FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'

export type Attachment =
  | { kind: 'data'; id: string; name: string; mime: string; dataUrl: string }
  | { kind: 'path'; id: string; name: string; mime: string; filePath: string }

interface AttachmentPreviewProps {
  attachments: Attachment[]
  onRemove: (id: string) => void
}

interface PreviewTarget {
  id: string
  name: string
  src: string
}

export function AttachmentPreview({ attachments, onRemove }: AttachmentPreviewProps) {
  // v1.4.3: image attachments are now clickable. Selected item drives a
  // simple Dialog-based lightbox so users can actually read screenshots
  // they pasted into the Composer (the 64x64 thumb was unreadable).
  const [previewing, setPreviewing] = useState<PreviewTarget | null>(null)

  if (attachments.length === 0) return null

  return (
    <>
      <div className="flex gap-2 px-3 py-2 overflow-x-auto" data-testid="attachment-preview">
        {attachments.map((attachment) => {
          const isImage =
            attachment.kind === 'data' && attachment.mime.startsWith('image/')

          return (
            <div
              key={attachment.id}
              className="relative flex-shrink-0 group"
              data-testid="attachment-item"
              title={attachment.kind === 'path' ? attachment.filePath : undefined}
            >
              {isImage ? (
                <button
                  type="button"
                  onClick={() =>
                    setPreviewing({
                      id: attachment.id,
                      name: attachment.name,
                      src: (attachment as Extract<Attachment, { kind: 'data' }>).dataUrl
                    })
                  }
                  className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
                  aria-label={`Preview ${attachment.name}`}
                  data-testid="attachment-image-preview-trigger"
                >
                  <img
                    src={(attachment as Extract<Attachment, { kind: 'data' }>).dataUrl}
                    alt={attachment.name}
                    className="h-16 w-16 object-cover rounded border border-border cursor-zoom-in"
                  />
                </button>
              ) : (
                <div className="h-16 w-16 flex flex-col items-center justify-center gap-1 rounded border border-border bg-muted">
                  <FileText className="h-5 w-5 text-muted-foreground" />
                  <span className="text-[10px] text-muted-foreground truncate max-w-[56px] px-1">
                    {attachment.name}
                  </span>
                </div>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="absolute -top-1.5 -right-1.5 h-5 w-5 p-0 rounded-full bg-background border border-border shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => onRemove(attachment.id)}
                aria-label={`Remove ${attachment.name}`}
                data-testid="attachment-remove"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          )
        })}
      </div>

      {/* Lightbox — sized to 90vw / 80vh so portrait + landscape both fit
          without distortion. Closes on overlay click, ESC, or the explicit
          close button. */}
      <Dialog
        open={previewing !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewing(null)
        }}
      >
        <DialogContent
          className="!p-0 !max-w-[90vw] w-auto bg-background/95 border-border"
          data-testid="attachment-image-preview-dialog"
        >
          {previewing && (
            <div className="flex flex-col">
              <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 text-xs text-muted-foreground">
                <span className="truncate">{previewing.name}</span>
              </div>
              <div className="flex items-center justify-center bg-black/40 p-2">
                <img
                  src={previewing.src}
                  alt={previewing.name}
                  className="max-w-full max-h-[80vh] object-contain rounded"
                />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
