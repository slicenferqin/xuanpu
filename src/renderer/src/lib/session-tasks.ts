import { isTodoWriteTool } from '@/components/sessions/tools/todo-utils'
import type { TimelineMessage } from '@shared/lib/timeline-types'

export type SessionTaskStatus = 'pending' | 'in_progress' | 'completed' | 'error'

export interface SessionTask {
  id: string
  content: string
  status: SessionTaskStatus
}

export function extractMissionTasks(messages: TimelineMessage[]): SessionTask[] {
  // Scan from end to find the latest todo-like tool snapshot.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant') continue

    for (const part of msg.parts ?? []) {
      if (part.type !== 'tool_use' || !part.toolUse) continue
      const toolName = part.toolUse.name?.toLowerCase() ?? ''
      if (!isTodoWriteTool(toolName)) continue

      const todos = part.toolUse.input?.todos
      if (!Array.isArray(todos)) continue

      return todos.map((t: Record<string, unknown>, idx: number) => ({
        id: String(t.id ?? `todo-${idx}`),
        content: String(t.content ?? t.subject ?? t.activeForm ?? ''),
        status: (t.status as SessionTaskStatus) ?? 'pending'
      }))
    }
  }

  return []
}
