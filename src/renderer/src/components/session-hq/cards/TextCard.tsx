/**
 * TextCard — Renders plain assistant text content (non-tool, non-reasoning).
 *
 * Renders inline without the ActionCard wrapper — text is the main content
 * flow and should not look like a "card action".
 */

import React from 'react'
import { MarkdownRenderer } from '../../sessions/MarkdownRenderer'

interface TextCardProps {
  content: string
  isStreaming?: boolean
}

export function TextCard({ content, isStreaming = false }: TextCardProps): React.JSX.Element {
  return (
    <div className="rounded-xl bg-agent-card/80 px-4 py-3">
      <div className="prose prose-sm dark:prose-invert crisp-readable max-w-none text-sm text-foreground">
        <MarkdownRenderer content={content} />
        {isStreaming && (
          <span className="inline-block w-[3px] h-[1.1em] bg-foreground/60 ml-0.5 align-text-bottom animate-pulse" />
        )}
      </div>
    </div>
  )
}
