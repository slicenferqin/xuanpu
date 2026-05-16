import { Loader2, Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { VoiceInputState } from '@/hooks/useVoiceInput'
import type { VoiceRuntimeProgress } from '@shared/types/voice'

interface VoiceRecorderButtonProps {
  state: VoiceInputState
  partialText: string
  progress: VoiceRuntimeProgress | null
  disabled?: boolean
  onStart: () => void
  onStop: () => void
}

export function VoiceRecorderButton({
  state,
  partialText,
  progress,
  disabled,
  onStart,
  onStop
}: VoiceRecorderButtonProps): React.JSX.Element {
  const active = state === 'recording'
  const preparing = state === 'preparing' || state === 'stopping'
  const title =
    state === 'recording'
      ? partialText || 'Recording. Click to stop, or release Ctrl if using push-to-talk.'
      : progress?.message || 'Voice input. Click once to record, or hold Ctrl to speak.'

  return (
    <div className="relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(
          'h-8 w-8 rounded-full border border-border/70 px-0 transition-[color,background-color,border-color,box-shadow]',
          active &&
            'border-cyan-300/70 bg-cyan-500/10 text-cyan-700 shadow-[0_0_0_1px_rgba(103,232,249,0.24),0_0_18px_rgba(6,182,212,0.24)] hover:bg-cyan-500/15 hover:text-cyan-800 dark:border-cyan-300/40 dark:text-cyan-200',
          preparing &&
            'border-cyan-300/50 bg-cyan-500/10 text-cyan-700 dark:border-cyan-300/35 dark:text-cyan-200'
        )}
        disabled={disabled || preparing}
        onClick={active ? onStop : onStart}
        title={title}
        aria-label={active ? 'Stop voice input' : 'Start voice input'}
        data-testid="composer-voice-button"
      >
        {preparing ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : active ? (
          <Square className="h-3.5 w-3.5" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
      </Button>
    </div>
  )
}
