import type { PendingMessagePromptOptions } from '../stores/useSessionRuntimeStore'

type TaskRunAutonomy = NonNullable<PendingMessagePromptOptions['taskRunAutonomy']>

export function inferXuanpuAgentTaskRunAutonomyDirective(
  content: string,
  agentSdk: string | null
): TaskRunAutonomy | null {
  if (agentSdk !== 'xuanpu-agent') return null

  const normalized = content.trim().toLowerCase()
  if (!normalized) return null

  const prefixMatch = normalized.match(
    /^(?:\/|#)?(short|long|overnight)(?:\s+(?:task[-\s]?run|autonomy))?\b/
  )
  if (prefixMatch) return prefixMatch[1] as TaskRunAutonomy

  const naturalMatch = normalized.match(
    /^(?:请按|按|以|用|使用|please\s+use)\s*(short|long|overnight)\s+(?:task[-\s]?run|autonomy)\b/
  )
  return naturalMatch ? (naturalMatch[1] as TaskRunAutonomy) : null
}

export function mergeXuanpuAgentAutonomyDirective(
  content: string,
  agentSdk: string | null,
  promptOptions?: PendingMessagePromptOptions
): PendingMessagePromptOptions | undefined {
  const directive = inferXuanpuAgentTaskRunAutonomyDirective(content, agentSdk)
  if (!directive) return promptOptions
  return { ...(promptOptions ?? {}), taskRunAutonomy: directive }
}
