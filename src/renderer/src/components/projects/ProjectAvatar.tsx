import { cn } from '@/lib/utils'
import { useProjectIconUrl } from '@/components/projects/project-icon-utils'
import {
  getProjectAvatarColorClass,
  getProjectAvatarInitials
} from '@/components/projects/project-avatar-utils'

interface ProjectAvatarProps {
  name: string | null | undefined
  customIcon?: string | null
  className?: string
}

export function ProjectAvatar({
  name,
  customIcon,
  className
}: ProjectAvatarProps): React.JSX.Element {
  const projectIconUrl = useProjectIconUrl(customIcon)

  if (customIcon && projectIconUrl) {
    return (
      <img
        src={projectIconUrl}
        alt="project icon"
        title={name ?? 'project icon'}
        data-testid="project-avatar-image"
        className={cn(
          'h-5 w-5 shrink-0 rounded-md object-contain ring-1 ring-black/10',
          className
        )}
      />
    )
  }

  const initials = getProjectAvatarInitials(name)
  const colorClass = getProjectAvatarColorClass(name)

  return (
    <span
      title={name ?? initials}
      data-testid="project-avatar"
      data-avatar-initials={initials}
      className={cn(
        'flex h-5 w-5 shrink-0 select-none items-center justify-center rounded-md',
        'text-[9px] font-semibold uppercase leading-none tracking-[0.04em] text-white',
        'ring-1 ring-black/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]',
        colorClass,
        className
      )}
    >
      {initials}
    </span>
  )
}
