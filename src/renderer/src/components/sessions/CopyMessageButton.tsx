import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n/useI18n'
import { cn } from '@/lib/utils'

interface CopyMessageButtonProps {
  content: string
  className?: string
  showOnHoverClassName?: string
  onCopy?: () => void
  unstyled?: boolean
}

export function CopyMessageButton({
  content,
  className,
  showOnHoverClassName = 'group-hover:opacity-100',
  onCopy,
  unstyled = false
}: CopyMessageButtonProps) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  if (!content.trim()) return null

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      onCopy?.()
      toast.success(t('copyMessageButton.toasts.copied'))
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('copyMessageButton.toasts.copyError'))
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      className={cn(
        unstyled
          ? 'h-6 w-6 p-0 opacity-0 transition-opacity z-10 bg-background/80 backdrop-blur-sm'
          : 'absolute top-2 right-2 h-6 w-6 p-0 opacity-0 transition-opacity z-10 bg-background/80 backdrop-blur-sm',
        showOnHoverClassName,
        className
      )}
      aria-label={t('copyMessageButton.ariaLabel')}
      data-testid="copy-message-button"
    >
      {copied ? (
        <Check className="h-3 w-3 text-green-500" />
      ) : (
        <Copy className="h-3 w-3 text-muted-foreground" />
      )}
    </Button>
  )
}
