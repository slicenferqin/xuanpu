/**
 * TextCard — Renders plain assistant text content (non-tool, non-reasoning).
 *
 * Now delegates to ReadableMessage for the Session HQ visual system v2.
 * Kept as a compatibility wrapper — new code should import ReadableMessage directly.
 */

import React from 'react'
import { ReadableMessage } from '../readable/ReadableMessage'

interface TextCardProps {
  content: string
  isStreaming?: boolean
}

export function TextCard({ content, isStreaming = false }: TextCardProps): React.JSX.Element {
  return <ReadableMessage content={content} isStreaming={isStreaming} />
}
