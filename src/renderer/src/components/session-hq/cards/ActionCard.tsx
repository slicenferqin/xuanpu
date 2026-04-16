/**
 * ActionCard — Base wrapper for all timeline action cards.
 *
 * Provides a consistent card shell with optional header and collapsible body.
 * Every specific card (BashCard, FileReadCard, etc.) composes this.
 */

import React, { useState } from 'react'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight } from 'lucide-react'

export interface ActionCardProps {
  /** Card header left content (icon + label) */
  headerLeft: React.ReactNode
  /** Card header right content (meta info / status) */
  headerRight?: React.ReactNode
  /** Card body content (collapsible) */
  children?: React.ReactNode
  /** Whether body is collapsible (default: true when children exist) */
  collapsible?: boolean
  /** Whether body starts expanded (default: false) */
  defaultExpanded?: boolean
  /** Extra border color class for accent cards (plan, ask) */
  accentClass?: string
  /** Extra header background class */
  headerClass?: string
  className?: string
}

export function ActionCard({
  headerLeft,
  headerRight,
  children,
  collapsible = !!children,
  defaultExpanded = false,
  accentClass,
  headerClass,
  className
}: ActionCardProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(defaultExpanded)

  return (
    <div
      className={cn(
        'rounded-lg border border-border/50 bg-card/80 overflow-hidden',
        accentClass,
        className
      )}
    >
      {/* Header */}
      <div
        className={cn(
          'flex items-center justify-between px-3.5 py-2.5',
          'border-b border-border/40 text-sm font-semibold',
          collapsible && 'cursor-pointer select-none',
          headerClass
        )}
        onClick={collapsible ? () => setExpanded((v) => !v) : undefined}
      >
        <div className="flex items-center gap-2 min-w-0">
          {collapsible && (
            <span className="text-muted-foreground">
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </span>
          )}
          {headerLeft}
        </div>
        {headerRight && (
          <div className="flex items-center gap-2 text-xs font-normal text-muted-foreground font-mono shrink-0 ml-3">
            {headerRight}
          </div>
        )}
      </div>

      {/* Body */}
      {children && expanded && (
        <div className="px-3.5 py-3 text-sm text-muted-foreground leading-relaxed">
          {children}
        </div>
      )}
    </div>
  )
}
