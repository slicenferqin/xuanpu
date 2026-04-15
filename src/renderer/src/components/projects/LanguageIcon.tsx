import { useEffect, useState } from 'react'
import { FolderGit2 } from 'lucide-react'
import { useI18n } from '@/i18n/useI18n'

interface LanguageIconProps {
  language: string | null
  customIcon?: string | null
  className?: string
}

/**
 * Demo4-style colored text labels — clean, minimal, no background containers.
 * Each language gets a short abbreviation and a distinct color.
 */
const LANGUAGE_LABELS: Record<string, { label: string; color: string }> = {
  typescript: { label: 'TS', color: 'text-blue-500' },
  javascript: { label: 'JS', color: 'text-yellow-500' },
  python: { label: 'Py', color: 'text-sky-500' },
  go: { label: 'Go', color: 'text-cyan-500' },
  rust: { label: 'Rs', color: 'text-orange-500' },
  ruby: { label: 'Rb', color: 'text-red-500' },
  swift: { label: 'Sw', color: 'text-orange-400' },
  java: { label: 'Jv', color: 'text-red-500' },
  php: { label: 'PH', color: 'text-indigo-400' },
  elixir: { label: 'Ex', color: 'text-purple-500' },
  dart: { label: 'Dt', color: 'text-teal-400' },
  kotlin: { label: 'Kt', color: 'text-violet-500' },
  c: { label: 'C', color: 'text-gray-500' },
  cpp: { label: 'C+', color: 'text-blue-600' },
  csharp: { label: 'C#', color: 'text-green-500' }
}

// Module-level cache for user-override icon data URLs (from DB setting)
let customIconsCache: Record<string, string> | null = null
let customIconsLoading = false
const customIconsListeners: Array<() => void> = []

function loadCustomIcons(): void {
  if (customIconsCache !== null || customIconsLoading) return
  customIconsLoading = true
  window.projectOps
    .loadLanguageIcons()
    .then((icons) => {
      customIconsCache = icons
      customIconsLoading = false
      for (const listener of customIconsListeners) listener()
      customIconsListeners.length = 0
    })
    .catch(() => {
      customIconsCache = {}
      customIconsLoading = false
    })
}

function useCustomIcons(): Record<string, string> {
  const [icons, setIcons] = useState<Record<string, string>>(customIconsCache ?? {})

  useEffect(() => {
    if (customIconsCache !== null) {
      setIcons(customIconsCache)
      return
    }
    loadCustomIcons()
    const listener = (): void => setIcons(customIconsCache ?? {})
    customIconsListeners.push(listener)
  }, [])

  return icons
}

// Module-level cache for resolved project icon paths (filename -> data URL)
const projectIconCache = new Map<string, string>()

function useProjectIconUrl(customIcon: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(
    customIcon ? (projectIconCache.get(customIcon) ?? null) : null
  )

  useEffect(() => {
    if (!customIcon) {
      setUrl(null)
      return
    }

    // Check cache first
    const cached = projectIconCache.get(customIcon)
    if (cached) {
      setUrl(cached)
      return
    }

    // Resolve to data URL via main process
    let cancelled = false
    window.projectOps
      .getProjectIconPath(customIcon)
      .then((dataUrl) => {
        if (cancelled) return
        if (dataUrl) {
          projectIconCache.set(customIcon, dataUrl)
          setUrl(dataUrl)
        }
      })
      .catch(() => {
        // ignore errors
      })

    return () => {
      cancelled = true
    }
  }, [customIcon])

  return url
}

export function LanguageIcon({
  language,
  customIcon,
  className
}: LanguageIconProps): React.JSX.Element {
  const { t } = useI18n()
  const customIcons = useCustomIcons()
  const projectIconUrl = useProjectIconUrl(customIcon)

  // Priority 1: Custom project icon (per-project image file)
  if (customIcon && projectIconUrl) {
    return (
      <img
        src={projectIconUrl}
        alt="project icon"
        title={t('languageIcon.customProjectIcon')}
        className="h-4 w-4 shrink-0 object-contain rounded-sm"
      />
    )
  }

  if (!language) {
    return <FolderGit2 className={className ?? 'h-4 w-4 text-muted-foreground shrink-0'} />
  }

  // Priority 2: User-override language icon (from DB language_icons setting)
  const userOverrideUrl = customIcons[language]
  if (userOverrideUrl) {
    return (
      <img
        src={userOverrideUrl}
        alt={language}
        title={language}
        className="h-4 w-4 shrink-0 object-contain"
      />
    )
  }

  // Priority 3: Colored text label (demo4 style)
  const config = LANGUAGE_LABELS[language]
  if (config) {
    return (
      <span
        className={`shrink-0 text-[11px] font-semibold leading-none ${config.color}`}
        title={language}
      >
        {config.label}
      </span>
    )
  }

  // Fallback: generic folder icon
  return <FolderGit2 className={className ?? 'h-4 w-4 text-muted-foreground shrink-0'} />
}
