import type { Attachment } from '@/components/sessions/AttachmentPreview'
import type { SharedAgentRuntimeId } from '@shared/types/agent-protocol'
import type { MessagePart } from '@shared/types/opencode'

export const isImageMime = (mime: string): boolean => mime.startsWith('image/')

export const MAX_ATTACHMENTS = 10

export const buildMessageParts = (attachments: Attachment[], promptText: string): MessagePart[] => {
  const parts: MessagePart[] = []

  // Data attachments (images, PDFs) -> file parts
  for (const a of attachments) {
    if (a.kind === 'data') {
      parts.push({ type: 'file', mime: a.mime, url: a.dataUrl, filename: a.name })
    }
  }

  // Path attachments -> collected into single XML text block
  const pathAttachments = attachments.filter(
    (a): a is Extract<Attachment, { kind: 'path' }> => a.kind === 'path'
  )
  if (pathAttachments.length > 0) {
    const xmlBlock =
      '<attached_files>\n' +
      pathAttachments.map((a) => `<file path="${a.filePath}">${a.name}</file>`).join('\n') +
      '\n</attached_files>'
    parts.push({ type: 'text', text: xmlBlock })
  }

  // Final text part
  parts.push({ type: 'text', text: promptText })

  return parts
}

type RuntimeAttachment = {
  kind: string
  id: string
  name: string
  mime: string
  dataUrl?: string
  filePath?: string
  [key: string]: unknown
}

export function runtimePersistsAttachmentsAsMetadataOnly(
  runtimeId?: SharedAgentRuntimeId | string | null
): boolean {
  return runtimeId === 'xuanpu-agent'
}

function escapeAttachmentAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export function buildAttachmentSummaryText(attachments: RuntimeAttachment[]): string {
  if (attachments.length === 0) return ''

  const lines = ['<attached_files content="metadata-only">']
  for (const attachment of attachments) {
    const name = escapeAttachmentAttribute(attachment.name || 'unnamed')
    const mime = escapeAttachmentAttribute(attachment.mime || 'unknown')
    if (attachment.kind === 'path') {
      const filePath = escapeAttachmentAttribute(attachment.filePath || '')
      lines.push(
        `  <file kind="path" name="${name}" mime="${mime}" path="${filePath}">content omitted</file>`
      )
    } else {
      lines.push(`  <file kind="data" name="${name}" mime="${mime}">content omitted</file>`)
    }
  }
  lines.push('</attached_files>')
  return lines.join('\n')
}

export function buildRuntimeMessagePayload(
  runtimeId: SharedAgentRuntimeId | string | null | undefined,
  attachments: RuntimeAttachment[],
  promptText: string
): string | MessagePart[] {
  if (attachments.length === 0) return promptText
  if (runtimeId !== 'xuanpu-agent') {
    return buildMessageParts(attachments as Attachment[], promptText)
  }

  const currentTurnImages = attachments.filter(
    (attachment) =>
      attachment.kind === 'data' &&
      typeof attachment.dataUrl === 'string' &&
      isImageMime(attachment.mime)
  )
  if (currentTurnImages.length > 0) {
    const metadataAttachments = attachments.filter(
      (attachment) => !currentTurnImages.includes(attachment)
    )
    const parts: MessagePart[] = currentTurnImages.map((attachment) => ({
      type: 'file',
      mime: attachment.mime,
      url: attachment.dataUrl as string,
      filename: attachment.name
    }))
    const summary = buildAttachmentSummaryText(metadataAttachments)
    if (summary) parts.push({ type: 'text', text: summary })
    parts.push({ type: 'text', text: promptText })
    return parts
  }

  const summary = buildAttachmentSummaryText(attachments)
  if (!summary) return promptText
  return promptText ? `${summary}\n\n${promptText}` : summary
}

export function sanitizeRuntimeQueuedAttachments(
  runtimeId: SharedAgentRuntimeId | string | null | undefined,
  attachments: RuntimeAttachment[]
): RuntimeAttachment[] {
  if (!runtimePersistsAttachmentsAsMetadataOnly(runtimeId)) return attachments

  return attachments.map((attachment) => {
    const sanitized: RuntimeAttachment = {
      kind: attachment.kind,
      id: attachment.id,
      name: attachment.name,
      mime: attachment.mime,
      contentOmitted: true
    }
    if (attachment.kind === 'path' && typeof attachment.filePath === 'string') {
      sanitized.filePath = attachment.filePath
    }
    return sanitized
  })
}
