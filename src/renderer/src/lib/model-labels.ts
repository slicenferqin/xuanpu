import type { UsageAnalyticsSessionSummary } from '@shared/types/usage-analytics'

function uniqueLabels(labels: Array<string | null | undefined>): string[] {
  const result: string[] = []
  for (const label of labels) {
    if (!label) continue
    if (!result.includes(label)) result.push(label)
  }
  return result
}

export function getSessionSummaryModelLabels(
  summary: Pick<UsageAnalyticsSessionSummary, 'model_labels' | 'latest_model_label'> | null
): string[] {
  if (!summary) return []
  return uniqueLabels([...(summary.model_labels ?? []), summary.latest_model_label])
}

export function formatModelLabelSummary(labels: string[]): { short: string; full: string } | null {
  const unique = uniqueLabels(labels)
  if (unique.length === 0) return null
  if (unique.length === 1) {
    return { short: unique[0], full: unique[0] }
  }
  if (unique.length === 2) {
    return { short: `${unique[0]} + ${unique[1]}`, full: unique.join(', ') }
  }
  return {
    short: `${unique[0]} + ${unique[1]} (+${unique.length - 2})`,
    full: unique.join(', ')
  }
}
