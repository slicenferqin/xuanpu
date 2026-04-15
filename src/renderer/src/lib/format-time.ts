/**
 * Format a message timestamp for display in the timeline.
 * Returns HH:mm format using the user's locale.
 */
export function formatMessageTime(isoString: string): string {
  const date = new Date(isoString)
  if (isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
