/**
 * ThinkingCard — Renders the agent's reasoning/thinking process.
 *
 * Default: collapsed to 4 lines. If content overflows, a "Show more"
 * toggle expands to full height.
 */

import React, { useState, useRef, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ThinkingCardProps {
  content: string
}

export function ThinkingCard({ content }: ThinkingCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [isOverflowing, setIsOverflowing] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (expanded) return
    const el = contentRef.current
    if (!el) return
    setIsOverflowing(el.scrollHeight > el.clientHeight + 2)
  }, [content, expanded])

  return (
    <div className="border-l-[3px] border-border pl-3.5 py-1">
      <div className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1.5">
        Thinking Process
      </div>
      <div
        ref={contentRef}
        className={cn(
          'text-sm text-muted-foreground italic leading-relaxed',
          !expanded && 'line-clamp-4'
        )}
      >
        {content}
      </div>
      {(isOverflowing || expanded) && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-muted-foreground/60 hover:text-muted-foreground mt-1.5 cursor-pointer select-none flex items-center gap-1 transition-colors"
        >
          <ChevronDown
            className={cn(
              'h-3 w-3 transition-transform duration-200',
              expanded && 'rotate-180'
            )}
          />
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  )
}
