import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'

type AvailableSdk = 'opencode' | 'claude-code' | 'codex'

const SDK_INFO: Record<AvailableSdk, { label: string; description: string }> = {
  opencode: { label: 'OpenCode', description: 'Open-source AI coding agent' },
  'claude-code': { label: 'Claude Code', description: "Anthropic's coding assistant" },
  codex: { label: 'Codex', description: "OpenAI's coding agent" }
}

interface AgentPickerDialogProps {
  available: AvailableSdk[]
  onSelect: (sdk: AvailableSdk) => void
}

export function AgentPickerDialog({ available, onSelect }: AgentPickerDialogProps): React.JSX.Element {
  const count = available.length
  const desc = count === 2
    ? `${SDK_INFO[available[0]].label} and ${SDK_INFO[available[1]].label} are`
    : `${available.map((s) => SDK_INFO[s].label).join(', ')} are`

  return (
    <AlertDialog open={true}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Bot className="size-5" />
            Choose Your AI Agent
          </AlertDialogTitle>
          <AlertDialogDescription>
            {desc} installed. Choose which one to use as the default for
            new sessions. You can change this later in Settings.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex gap-3 pt-2">
          {available.map((sdk) => (
            <button
              key={sdk}
              onClick={() => onSelect(sdk)}
              className={cn(
                'flex-1 px-4 py-3 rounded-lg border-2 border-border',
                'hover:border-primary hover:bg-accent/50 transition-colors',
                'text-center cursor-pointer'
              )}
            >
              <div className="text-sm font-medium">{SDK_INFO[sdk].label}</div>
              <div className="text-xs text-muted-foreground mt-1">{SDK_INFO[sdk].description}</div>
            </button>
          ))}
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
