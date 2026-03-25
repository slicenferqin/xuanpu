import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/useI18n'

interface ExternalChangesBannerProps {
  onReload: () => void
  onKeepMine: () => void
}

export function ExternalChangesBanner({
  onReload,
  onKeepMine
}: ExternalChangesBannerProps): React.JSX.Element {
  const { t } = useI18n()

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-amber-500/30
        bg-amber-500/10 text-amber-300"
      data-testid="external-changes-banner"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
      <span className="flex-1">{t('fileViewer.externalChanges.message')}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onKeepMine}>
          {t('fileViewer.externalChanges.keepMine')}
        </Button>
        <Button size="sm" className="h-6 px-2 text-xs" onClick={onReload}>
          {t('fileViewer.externalChanges.reload')}
        </Button>
      </div>
    </div>
  )
}
