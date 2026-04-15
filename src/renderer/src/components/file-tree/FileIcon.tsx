import { cn } from '@/lib/utils'
import { getFileIconInfo } from '@/lib/file-icons'

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

  const Icon = info.icon
  return (
    <span
      className={cn(
        'inline-flex h-4 w-4 flex-shrink-0 items-center justify-center',
        className
      )}
      aria-hidden="true"
    >
      <Icon className={cn('h-[14px] w-[14px]', info.colorClass)} />
    </span>
  )
}
