import { GitFork, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/useI18n'
import { cn } from '@/lib/utils'

interface ForkMessageButtonProps {
  onFork: () => void | Promise<void>
  disabled?: boolean
  isForking?: boolean
  className?: string
  showOnHoverClassName?: string
  unstyled?: boolean
}

export function ForkMessageButton({
  onFork,
  disabled = false,
  isForking = false,
  className,
  showOnHoverClassName = 'group-hover:opacity-100',
  unstyled = false
}: ForkMessageButtonProps) {
  const { t } = useI18n()
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void onFork()
      }}
      disabled={disabled || isForking}
      className={cn(
        unstyled
          ? 'h-6 w-6 p-0 opacity-0 transition-opacity z-10 bg-background/80 backdrop-blur-sm'
          : 'absolute top-2 right-10 h-6 w-6 p-0 opacity-0 transition-opacity z-10 bg-background/80 backdrop-blur-sm',
        showOnHoverClassName,
        className
      )}
      aria-label={t('forkMessageButton.ariaLabel')}
      data-testid="fork-message-button"
    >
      {isForking ? (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      ) : (
        <GitFork className="h-3 w-3 text-muted-foreground" />
      )}
    </Button>
  )
}
