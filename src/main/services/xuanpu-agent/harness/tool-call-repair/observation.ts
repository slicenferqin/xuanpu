import { createHash } from 'node:crypto'

export interface ToolObservationInput {
  traceId: string
  toolName: string
  command: string
  cwd: string
  exitCode: number
  durationMs: number
  timedOut: boolean
  aborted: boolean
  rawOutput: string
  summaryText: string
  beforeBytes: number
  afterBytes: number
  compressionRatio: number
  ruleHits: readonly string[]
}

export interface ToolObservationMetadata {
  rawOutputSha256: string
  rawOutputBytes: number
  summaryBytes: number
  rawRef: string
}

export function computeToolOutputSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function buildToolObservationMetadata(input: {
  traceId: string
  rawOutput: string
  summaryText: string
}): ToolObservationMetadata {
  return {
    rawOutputSha256: computeToolOutputSha256(input.rawOutput),
    rawOutputBytes: Buffer.byteLength(input.rawOutput, 'utf8'),
    summaryBytes: Buffer.byteLength(input.summaryText, 'utf8'),
    rawRef: `command-trace:${input.traceId}`
  }
}

export function formatToolObservation(input: ToolObservationInput): string {
  const metadata = buildToolObservationMetadata({
    traceId: input.traceId,
    rawOutput: input.rawOutput,
    summaryText: input.summaryText
  })
  const reductionPercent = input.beforeBytes > 0 ? Math.round(input.compressionRatio * 100) : 0
  const attrs = [
    `traceId="${escapeAttr(input.traceId)}"`,
    `tool="${escapeAttr(input.toolName)}"`,
    `exitCode="${input.exitCode}"`,
    `durationMs="${input.durationMs}"`,
    `beforeBytes="${input.beforeBytes}"`,
    `afterBytes="${input.afterBytes}"`,
    `rawBytes="${metadata.rawOutputBytes}"`,
    `summaryBytes="${metadata.summaryBytes}"`,
    `rawSha256="${metadata.rawOutputSha256}"`,
    `rawRef="${escapeAttr(metadata.rawRef)}"`,
    input.timedOut ? 'timedOut="true"' : null,
    input.aborted ? 'aborted="true"' : null
  ].filter((attr): attr is string => attr !== null)

  return [
    `<ToolObservation ${attrs.join(' ')}>`,
    `command: ${input.command}`,
    input.cwd ? `cwd: ${input.cwd}` : null,
    `ruleHits: ${input.ruleHits.length > 0 ? input.ruleHits.join(', ') : 'none'}`,
    `compression: ${reductionPercent}% reduction`,
    'summary:',
    input.summaryText,
    '---',
    `Raw output archived at ${metadata.rawRef}.`,
    `Raw output sha256: ${metadata.rawOutputSha256}.`,
    '</ToolObservation>'
  ]
    .filter((line): line is string => line !== null)
    .join('\n')
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
