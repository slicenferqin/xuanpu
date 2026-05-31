import type React from 'react'
import { formatMessageTime } from '@/lib/format-time'
import type { TimelineNode } from '@/lib/session-timeline/view-model'
import { cn } from '@/lib/utils'

export interface TimelineNodeIconConfig {
  icon: React.ElementType
  colorClass: string
  bgClass: string
}

interface TimelineNodeFrameProps {
  node: TimelineNode
  iconConfig?: TimelineNodeIconConfig
  iconClassName?: string
  iconChildren?: React.ReactNode
  renderConnector?: boolean
  showTimestamp?: boolean
  children: React.ReactNode
}

export function TimelineNodeFrame({
  node,
  iconConfig,
  iconClassName,
  iconChildren,
  renderConnector = true,
  showTimestamp = false,
  children
}: TimelineNodeFrameProps): React.JSX.Element {
  const Icon = iconConfig?.icon

  return (
    <div className="relative pl-10 mb-4">
      {renderConnector && (
        <div className="absolute left-[15px] top-0 bottom-0 w-[2px] bg-border opacity-60" />
      )}
      {iconConfig && Icon && (
        <div
          className={cn(
            'absolute left-[4px] top-2.5 w-[24px] h-[24px] rounded-full',
            'flex items-center justify-center z-10',
            iconClassName ?? [iconConfig.bgClass, iconConfig.colorClass]
          )}
        >
          {iconChildren ?? <Icon className="h-3 w-3" />}
        </div>
      )}
      {children}
      {showTimestamp && node.message.timestamp && (
        <div className="mt-1 text-xs text-muted-foreground">
          {formatMessageTime(node.message.timestamp)}
        </div>
      )}
    </div>
  )
}
