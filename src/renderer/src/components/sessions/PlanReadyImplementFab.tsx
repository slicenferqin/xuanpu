import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useI18n } from '@/i18n/useI18n'

function MnemonicLabel({ letter, label }: { letter: string; label: string }): React.JSX.Element {
  const index = label.toLowerCase().indexOf(letter.toLowerCase())
  if (index === -1) return <span>{label}</span>
  return (
    <span>
      {label.slice(0, index)}
      <span className="font-semibold underline underline-offset-2 decoration-2">
        {label[index]}
      </span>
      {label.slice(index + 1)}
    </span>
  )
}

interface PlanReadyImplementFabProps {
  onImplement: () => void
  onHandoff: () => void
  visible: boolean
  onSuperpowers?: () => void
  onSuperpowersLocal?: () => void
  superpowersAvailable?: boolean
  isConnectionSession?: boolean
}

export function PlanReadyImplementFab({
  onImplement,
  onHandoff,
  visible,
  onSuperpowers,
  onSuperpowersLocal,
  superpowersAvailable,
  isConnectionSession
}: PlanReadyImplementFabProps): React.JSX.Element {
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)
  const { t, supportsFirstCharHint } = useI18n()
  const showMnemonic = vimModeEnabled && supportsFirstCharHint

  return (
    <div
      className={cn(
        'absolute bottom-36 right-4 z-30',
        'flex items-center gap-2',
        'transition-all duration-200',
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
      )}
    >
      <button
        onClick={onHandoff}
        className={cn(
          'h-8 rounded-full px-3',
          'text-xs font-medium',
          'bg-muted/80 text-foreground border border-border',
          'shadow-md hover:bg-muted transition-colors duration-200',
          'cursor-pointer',
          visible ? 'opacity-100' : 'opacity-0'
        )}
        aria-label={t('planReadyFab.aria.handoff')}
        data-testid="plan-ready-handoff-fab"
      >
        {showMnemonic ? (
          <MnemonicLabel letter="a" label={t('planReadyFab.labels.handoff')} />
        ) : (
          t('planReadyFab.labels.handoff')
        )}
      </button>
      {superpowersAvailable && !isConnectionSession && onSuperpowersLocal && (
        <button
          onClick={onSuperpowersLocal}
          className={cn(
            'h-8 rounded-full px-3',
            'text-xs font-medium',
            'border border-violet-600 text-violet-600 bg-background hover:bg-violet-100 dark:hover:bg-violet-950',
            'shadow-md transition-colors duration-200',
            'cursor-pointer',
            visible ? 'opacity-100' : 'opacity-0'
          )}
          aria-label={t('planReadyFab.aria.superchargeLocal')}
          data-testid="plan-ready-supercharge-local-fab"
        >
          {showMnemonic ? (
            <MnemonicLabel letter="o" label={t('planReadyFab.labels.superchargeLocal')} />
          ) : (
            t('planReadyFab.labels.superchargeLocal')
          )}
        </button>
      )}
      {superpowersAvailable && onSuperpowers && (
        <button
          onClick={onSuperpowers}
          className={cn(
            'h-8 rounded-full px-3',
            'text-xs font-medium',
            'bg-violet-600 text-white',
            'shadow-md hover:bg-violet-700 transition-colors duration-200',
            'cursor-pointer',
            visible ? 'opacity-100' : 'opacity-0'
          )}
          aria-label={t('planReadyFab.aria.supercharge')}
          data-testid="plan-ready-supercharge-fab"
        >
          {showMnemonic ? (
            <MnemonicLabel letter="u" label={t('planReadyFab.labels.supercharge')} />
          ) : (
            t('planReadyFab.labels.supercharge')
          )}
        </button>
      )}
      <button
        onClick={onImplement}
        className={cn(
          'h-8 rounded-full px-3',
          'text-xs font-medium',
          'bg-primary text-primary-foreground',
          'shadow-md hover:bg-primary/90 transition-colors duration-200',
          'cursor-pointer',
          visible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        )}
        aria-label={t('planReadyFab.aria.implement')}
        data-testid="plan-ready-implement-fab"
      >
        {showMnemonic ? (
          <MnemonicLabel letter="m" label={t('planReadyFab.labels.implement')} />
        ) : (
          t('planReadyFab.labels.implement')
        )}
      </button>
    </div>
  )
}
