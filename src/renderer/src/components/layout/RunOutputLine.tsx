import React from 'react'
import Ansi from 'ansi-to-react'
import { parseAnsiSegments } from '@/lib/ansi-utils'
import { hasHttpUrl, linkifyHttpUrls } from '@/lib/url-linkify'

export interface SearchHighlight {
  /** Character offset where the match starts (in the stripped-ANSI plain text) */
  matchStart: number
  /** Character offset where the match ends (in the stripped-ANSI plain text) */
  matchEnd: number
  /** Whether this is the currently focused match (brighter highlight) */
  isCurrent: boolean
}

interface RunOutputLineProps {
  line: string
  highlight?: SearchHighlight
}

// When a search highlight is active, ANSI coloring is intentionally dropped
// in favor of highlight visibility (plain text + yellow mark). This matches
// the behavior of VS Code's terminal search.
function renderHighlightedLine(line: string, highlight: SearchHighlight): React.JSX.Element {
  const segments = parseAnsiSegments(line)
  const parts: React.JSX.Element[] = []
  let offset = 0
  let partKey = 0

  for (const segment of segments) {
    if (segment.text === '') continue

    const segStart = offset
    const segEnd = offset + segment.text.length

    if (segEnd <= highlight.matchStart || segStart >= highlight.matchEnd) {
      // No overlap — plain text
      parts.push(<span key={partKey++}>{segment.text}</span>)
    } else {
      // There is overlap — split at boundaries
      const overlapStart = Math.max(highlight.matchStart, segStart)
      const overlapEnd = Math.min(highlight.matchEnd, segEnd)

      // Text before the match in this segment
      if (overlapStart > segStart) {
        parts.push(<span key={partKey++}>{segment.text.slice(0, overlapStart - segStart)}</span>)
      }

      // The matched portion
      parts.push(
        <mark
          key={partKey++}
          className={highlight.isCurrent ? 'bg-yellow-400/80' : 'bg-yellow-400/40'}
        >
          {segment.text.slice(overlapStart - segStart, overlapEnd - segStart)}
        </mark>
      )

      // Text after the match in this segment
      if (overlapEnd < segEnd) {
        parts.push(<span key={partKey++}>{segment.text.slice(overlapEnd - segStart)}</span>)
      }
    }

    offset = segEnd
  }

  return <div className="whitespace-pre-wrap break-all">{parts}</div>
}

function RunOutputUrl({ text, url }: { text: string; url: string }): React.JSX.Element {
  const [isModifierHover, setIsModifierHover] = React.useState(false)

  const updateModifierHover = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    setIsModifierHover(event.metaKey || event.ctrlKey)
  }, [])

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!event.metaKey && !event.ctrlKey) return

      event.preventDefault()
      event.stopPropagation()
      void window.systemOps.openInChrome(url)
    },
    [url]
  )

  return (
    <button
      type="button"
      className={
        isModifierHover
          ? 'inline break-all cursor-pointer bg-transparent p-0 font-[inherit] text-primary underline'
          : 'inline break-all cursor-text bg-transparent p-0 font-[inherit] text-inherit'
      }
      data-testid="run-output-url"
      onClick={handleClick}
      onContextMenu={(event) => event.stopPropagation()}
      onMouseEnter={updateModifierHover}
      onMouseLeave={() => setIsModifierHover(false)}
      onMouseMove={updateModifierHover}
    >
      {text}
    </button>
  )
}

function renderLinkifiedLine(line: string): React.JSX.Element {
  const parts = linkifyHttpUrls(line)

  return (
    <div className="whitespace-pre-wrap break-all [&_code]:all-unset">
      {parts.map((part, index) => {
        if (part.type === 'url') {
          return <RunOutputUrl key={index} text={part.text} url={part.url} />
        }

        return <Ansi key={index}>{part.text}</Ansi>
      })}
    </div>
  )
}

function RunOutputLineInner({ line, highlight }: RunOutputLineProps): React.JSX.Element {
  // Truncation marker
  if (line.startsWith('\x00TRUNC:')) {
    return (
      <div className="text-muted-foreground text-center text-[10px] py-1 border-b border-border/50">
        {line.slice(7)}
      </div>
    )
  }

  // Command marker
  if (line.startsWith('\x00CMD:')) {
    return <div className="text-muted-foreground font-semibold mt-1">$ {line.slice(5)}</div>
  }

  // Error marker
  if (line.startsWith('\x00ERR:')) {
    return <div className="text-destructive">{line.slice(5)}</div>
  }

  // Normal ANSI line — with or without highlight
  if (highlight) {
    return renderHighlightedLine(line, highlight)
  }

  if (hasHttpUrl(line)) {
    return renderLinkifiedLine(line)
  }

  return (
    <div className="whitespace-pre-wrap break-all [&_code]:all-unset">
      <Ansi>{line}</Ansi>
    </div>
  )
}

export const RunOutputLine = React.memo(RunOutputLineInner)
