import { useMemo } from 'react'
import { Sparkles } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'
import { parseTokenSaverFooter, formatBytes } from '@/lib/token-saver-footer'
import type { OpenCodeMessage } from './SessionView'

interface SessionTokenSaverBannerProps {
  messages: OpenCodeMessage[]
}

interface SessionStats {
  beforeBytes: number
  afterBytes: number
  savedBytes: number
  hits: number
}

/**
 * Walk the session's message stream and aggregate Token Saver footer stats
 * across every assistant tool result that came through `mcp__xuanpu__bash`.
 *
 * We deliberately scan only `parts[].toolUse.output` strings — the footer is
 * appended to the tool result body, never to assistant text. This keeps the
 * scan cheap (typically a few dozen tool calls per session) and avoids false
 * positives when an assistant happens to type the literal string in prose.
 */
function aggregateStats(messages: OpenCodeMessage[]): SessionStats {
  let beforeBytes = 0
  let afterBytes = 0
  let hits = 0

  for (const m of messages) {
    if (m.role !== 'assistant' || !m.parts) continue
    for (const part of m.parts) {
      if (part.type !== 'tool_use') continue
      const output = part.toolUse?.output
      if (typeof output !== 'string') continue
      const parsed = parseTokenSaverFooter(output)
      if (!parsed) continue
      beforeBytes += parsed.beforeBytes
      afterBytes += parsed.afterBytes
      hits += 1
    }
  }

  return {
    beforeBytes,
    afterBytes,
    savedBytes: Math.max(0, beforeBytes - afterBytes),
    hits
  }
}

/**
 * Compact banner showing how much Token Saver has compressed in this session.
 * Renders nothing when no compression has happened yet (avoids visual noise
 * for sessions where the toggle is off or no Bash calls fired yet).
 */
export function SessionTokenSaverBanner({
  messages
}: SessionTokenSaverBannerProps): React.JSX.Element | null {
  const { t } = useI18n()
  const stats = useMemo(() => aggregateStats(messages), [messages])

  if (stats.hits === 0 || stats.savedBytes === 0) return null

  const percent =
    stats.beforeBytes > 0
      ? Math.round((stats.savedBytes / stats.beforeBytes) * 100)
      : 0

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-emerald-950/30 border border-emerald-900/40 text-[11px] text-emerald-200"
      title={t('sessionView.tokenSaverBanner.tooltip', {
        before: formatBytes(stats.beforeBytes),
        after: formatBytes(stats.afterBytes),
        hits: stats.hits
      })}
      data-testid="session-token-saver-banner"
    >
      <Sparkles className="h-3 w-3 text-emerald-400" />
      <span className="font-medium">
        {t('sessionView.tokenSaverBanner.label', {
          saved: formatBytes(stats.savedBytes),
          percent
        })}
      </span>
    </div>
  )
}
