import React from 'react'
import { cn } from '@/lib/utils'
import { ReadableMarkdownRenderer } from './ReadableMarkdownRenderer'

interface ReadableMessageProps {
  content: string
  isStreaming?: boolean
  className?: string
}

export function ReadableMessage({
  content,
  isStreaming = false,
  className
}: ReadableMessageProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'xp-readable-message',
        'w-full max-w-full',
        'text-xp-reader-text',
        'text-[length:var(--xp-reader-font-size)]',
        'leading-[var(--xp-reader-line-height)]',
        className
      )}
    >
      <ReadableMarkdownRenderer content={content} />
      {isStreaming && <StreamingCursor />}
    </div>
  )
}

function StreamingCursor(): React.JSX.Element {
  return (
    <span className="inline-block w-[3px] h-[1.1em] bg-xp-reader-text/60 ml-0.5 align-text-bottom animate-pulse" />
  )
}
