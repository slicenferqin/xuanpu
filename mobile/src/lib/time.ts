/** Relative time formatter — falls back to locale string for >1 day. */
export function formatRelativeTime(iso: string | number | null): string {
  if (!iso) return ''
  const ts = typeof iso === 'number' ? iso : new Date(iso).getTime()
  if (!Number.isFinite(ts)) return ''
  const diffSec = (Date.now() - ts) / 1000
  if (diffSec < 60) return '刚刚'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)} 天前`
  return new Date(ts).toLocaleDateString()
}
