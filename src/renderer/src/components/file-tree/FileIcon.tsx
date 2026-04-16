import { cn } from '@/lib/utils'
import { getFileIconInfo, getCatppuccinIcon } from '@/lib/file-icons'
import { Icon, addCollection } from '@iconify/react'
import catppuccinIcons from '@iconify-json/catppuccin/icons.json'

// Register Catppuccin icons locally so @iconify/react doesn't need API calls
addCollection(catppuccinIcons)

interface FileIconProps {
  name: string
  extension: string | null
  isDirectory: boolean
  isExpanded?: boolean
  className?: string
}

export function FileIcon({
  name,
  extension,
  isDirectory,
  isExpanded = false,
  className
}: FileIconProps): React.JSX.Element {
  // Try Catppuccin icon first
  const catIcon = getCatppuccinIcon(name, extension, isDirectory, isExpanded)
  if (catIcon) {
    return (
      <span
        className={cn(
          'inline-flex h-4 w-4 flex-shrink-0 items-center justify-center catppuccin-icon',
          className
        )}
        aria-hidden="true"
      >
        <Icon icon={catIcon} width={16} height={16} />
      </span>
    )
  }

  // Fallback to legacy text labels / lucide icons
  const info = getFileIconInfo(name, extension, isDirectory, isExpanded)

  if (info.type === 'text') {
    return (
      <span
        className={cn(
          'inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-[10px] font-bold leading-none',
          info.colorClass,
          className
        )}
        aria-hidden="true"
      >
        {info.label}
      </span>
    )
  }

  const LucideIcon = info.icon
  return (
    <span
      className={cn(
        'inline-flex h-4 w-4 flex-shrink-0 items-center justify-center',
        className
      )}
      aria-hidden="true"
    >
      <LucideIcon className={cn('h-[14px] w-[14px]', info.colorClass)} />
    </span>
  )
}
