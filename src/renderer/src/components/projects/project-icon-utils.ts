import { useEffect, useState } from 'react'

// Module-level cache for resolved project icon paths (filename -> data URL)
const projectIconCache = new Map<string, string>()

export function resetProjectIconCacheForTests(): void {
  projectIconCache.clear()
}

export function useProjectIconUrl(customIcon: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(
    customIcon ? (projectIconCache.get(customIcon) ?? null) : null
  )

  useEffect(() => {
    if (!customIcon) {
      setUrl(null)
      return
    }

    const cached = projectIconCache.get(customIcon)
    if (cached) {
      setUrl(cached)
      return
    }

    let cancelled = false
    window.projectOps
      .getProjectIconPath(customIcon)
      .then((dataUrl) => {
        if (cancelled || !dataUrl) return
        projectIconCache.set(customIcon, dataUrl)
        setUrl(dataUrl)
      })
      .catch(() => {
        // Ignore icon resolution failures and fall back to the text avatar.
      })

    return () => {
      cancelled = true
    }
  }, [customIcon])

  return url
}
