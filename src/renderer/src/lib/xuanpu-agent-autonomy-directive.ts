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

  const chineseDirective = inferChineseAutonomyDirective(normalized)
  if (chineseDirective) return chineseDirective

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

function inferChineseAutonomyDirective(text: string): TaskRunAutonomy | null {
  const compact = text.replace(/\s+/g, '')

  if (
    /^(?:请)?(?:按|用|使用|以)?短任务(?:执行|模式|跑|推进|处理|继续)?/.test(compact) ||
    /(?:按|用|使用|以|切到|改成|作为)短任务/.test(compact)
  ) {
    return 'short'
  }

  if (
    /^(?:请)?(?:按|用|使用|以)?(?:隔夜|过夜|overnight)任务(?:执行|模式|跑|推进|处理|继续)?/.test(
      compact
    ) ||
    /(?:按|用|使用|以|切到|改成|作为)(?:隔夜|过夜)任务/.test(compact)
  ) {
    return 'overnight'
  }

  if (
    /^(?:请)?(?:按|用|使用|以)?长任务(?:执行|模式|跑|推进|处理|继续)?/.test(compact) ||
    /(?:按|用|使用|以|切到|改成|作为)长任务/.test(compact) ||
    /继续.*长任务(?:执行|模式|跑|推进|处理)?/.test(compact)
  ) {
    return 'long'
  }

  return null
}
