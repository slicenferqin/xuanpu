import type { TimelineMessage } from '@shared/lib/timeline-types'

export type { StreamingPart, ToolUseInfo } from '@shared/lib/timeline-types'

export type OpenCodeMessage = TimelineMessage

export interface SessionViewState {
  status: 'idle' | 'connecting' | 'connected' | 'error'
  errorMessage?: string
}
