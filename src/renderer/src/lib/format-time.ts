/**
 * Format a message timestamp for display in the timeline.
 * Uses 24-hour local time and adds enough date context for older messages:
 *   - today: HH:mm
 *   - same month: D HH:mm
 *   - same year: MM-DD HH:mm
 *   - older year: YYYY-MM-DD HH:mm
 */
export function formatMessageTime(isoString: string, now: Date = new Date()): string {
  const date = new Date(isoString)
  if (isNaN(date.getTime())) return ''

  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const time = `${hours}:${minutes}`

  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time
  }

  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
    return `${date.getDate()} ${time}`
  }

  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  if (date.getFullYear() === now.getFullYear()) {
    return `${month}-${day} ${time}`
  }

  return `${date.getFullYear()}-${month}-${day} ${time}`
}
