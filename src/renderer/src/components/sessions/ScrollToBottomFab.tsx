import { ArrowDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'

interface ScrollToBottomFabProps {
  onClick: () => void
  visible: boolean
  bottomClass?: string
  count?: number
  style?: React.CSSProperties
}

export function ScrollToBottomFab({
  onClick,
  visible,
  bottomClass = 'bottom-4',
  count,
  style
}: ScrollToBottomFabProps): React.JSX.Element {
  const { t } = useI18n()
  const showCount = typeof count === 'number' && count > 0

  return (
    <button
      onClick={onClick}
      style={style}
      className={cn(
        'absolute right-4 z-10',
        bottomClass,
        showCount ? 'h-8 min-w-[3.25rem] gap-1.5 rounded-full px-2.5' : 'h-8 w-8 rounded-full',
        'bg-muted/80 backdrop-blur-sm border border-border',
        'flex items-center justify-center',
        'shadow-md hover:bg-muted transition-all duration-200',
        'cursor-pointer',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
      )}
      aria-label={t('scrollToBottomFab.ariaLabel')}
      data-testid="scroll-to-bottom-fab"
    >
      <ArrowDown className="h-4 w-4 shrink-0" />
      {showCount && (
        <span className="text-[11px] font-medium leading-none" data-testid="scroll-to-bottom-fab-count">
          {count}
        </span>
      )}
    </button>
  )
}
