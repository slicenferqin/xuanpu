import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { useI18n } from '@/i18n/useI18n'

interface AgentPickerDialogProps {
  onSelect: (sdk: 'opencode' | 'claude-code' | 'codex') => void
  availableSdks: { opencode: boolean; claude: boolean; codex: boolean }
}

export function AgentPickerDialog({
  onSelect,
  availableSdks
}: AgentPickerDialogProps): React.JSX.Element {
  const { t } = useI18n()

  return (
    <AlertDialog open={true}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Bot className="size-5" />
            {t('agentPicker.title')}
          </AlertDialogTitle>
          <AlertDialogDescription>{t('agentPicker.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex gap-3 pt-2">
          {availableSdks.opencode && (
            <button
              onClick={() => onSelect('opencode')}
              className={cn(
                'flex-1 px-4 py-3 rounded-lg border-2 border-border',
                'hover:border-primary hover:bg-accent/50 transition-colors',
                'text-center cursor-pointer'
              )}
            >
              <div className="text-sm font-medium">{t('agentPicker.agents.opencode.title')}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {t('agentPicker.agents.opencode.description')}
              </div>
            </button>
          )}
          {availableSdks.claude && (
            <button
              onClick={() => onSelect('claude-code')}
              className={cn(
                'flex-1 px-4 py-3 rounded-lg border-2 border-border',
                'hover:border-primary hover:bg-accent/50 transition-colors',
                'text-center cursor-pointer'
              )}
            >
              <div className="text-sm font-medium">{t('agentPicker.agents.claude.title')}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {t('agentPicker.agents.claude.description')}
              </div>
            </button>
          )}
          {availableSdks.codex && (
            <button
              onClick={() => onSelect('codex')}
              className={cn(
                'flex-1 px-4 py-3 rounded-lg border-2 border-border',
                'hover:border-primary hover:bg-accent/50 transition-colors',
                'text-center cursor-pointer'
              )}
            >
              <div className="text-sm font-medium">{t('agentPicker.agents.codex.title')}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {t('agentPicker.agents.codex.description')}
              </div>
            </button>
          )}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
