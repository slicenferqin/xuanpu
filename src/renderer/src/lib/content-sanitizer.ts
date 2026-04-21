/**
 * Utilities for detecting and stripping system notification content
 * (e.g. `<task-notification>…</task-notification>`) from message text.
 */

const TASK_NOTIFICATION_PATTERN = /<task-notification>\s*([\s\S]*?)\s*<\/task-notification>/gi

/** Extract the inner text of every `<task-notification>` block in `content`. */
export function extractTaskNotifications(content: string): string[] {
  const matches: string[] = []
  const re = new RegExp(TASK_NOTIFICATION_PATTERN.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) matches.push(m[1].trim())
  return matches
}

/** Strip all `<task-notification>…</task-notification>` blocks from text. */
export function stripTaskNotifications(content: string): string {
  return content.replace(new RegExp(TASK_NOTIFICATION_PATTERN.source, 'gi'), '').trim()
}

/**
 * Simplify a raw task-notification body into a concise label.
 *
 * Input examples:
 *   "Background agent a472316ca520ff2ad (Rebrand all translated READMEs) completed successfully."
 *   "Background agent a6373eed285038e76 (Fix test Hive assertions) completed successfully."
 *
 * Output:
 *   "Rebrand all translated READMEs"
 *   "Fix test Hive assertions"
 */
export function simplifyTaskNotification(raw: string): {
  label: string
  status: 'completed' | 'failed' | 'unknown'
} {
  // Newer SDK format embeds an XML-ish payload with a <summary> field whose
  // body looks like:  Background command "Rebuild and restart" completed (exit code 0)
  // Prefer the quoted command name from <summary> over the legacy
  // parenthesised "(name)" format used by old background-agent notifications.
  const summaryMatch = raw.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/i)
  const summaryBody = summaryMatch?.[1]?.trim() ?? ''

  let label = ''
  if (summaryBody) {
    const quoted = summaryBody.match(/["“]([^"”]+)["”]/)
    if (quoted) {
      label = quoted[1].trim()
    } else {
      label = summaryBody.replace(/\s*\(exit code [^)]*\)\s*$/i, '').replace(/\.$/, '').trim()
    }
  }

  if (!label) {
    // Legacy format: "Background agent xxx (Task name) completed successfully."
    const nameMatch = raw.match(/\(([^)]+)\)/)
    label = nameMatch ? nameMatch[1].trim() : raw.replace(/\.$/, '').trim()
  }

  const lower = (summaryBody || raw).toLowerCase()
  const status: 'completed' | 'failed' | 'unknown' = lower.includes('failed') || lower.includes('fail')
    ? 'failed'
    : lower.includes('completed') || lower.includes('success')
      ? 'completed'
      : 'unknown'

  return { label, status }
}
