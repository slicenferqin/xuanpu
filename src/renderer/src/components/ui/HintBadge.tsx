import { HintMode } from '@/stores/useHintStore'

interface HintBadgeProps {
  code: string
  mode: HintMode
  pendingChar: string | null
}

export function HintBadge({ code, mode, pendingChar }: HintBadgeProps) {
  const isMatch = mode === 'pending' && pendingChar && code[0] === pendingChar

  const baseClasses =
    'inline-flex items-center font-mono text-[10px] px-1 py-0.5 rounded bg-muted/60 border border-border/50 text-muted-foreground shrink-0 select-none'

  if (mode === 'idle') {
    return (
      <span className={baseClasses}>
        <span>{code[0]}</span>
        <span>{code[1]}</span>
      </span>
    )
  }

  if (isMatch) {
    return (
      <span
        className={`${baseClasses} bg-primary/20 border-primary/60`}
      >
        <span className="text-primary font-bold">{code[0]}</span>
        <span className="text-foreground font-medium">{code[1]}</span>
      </span>
    )
  }

  // pending but no match
  return (
    <span className={`${baseClasses} opacity-25`}>
      <span>{code[0]}</span>
      <span>{code[1]}</span>
    </span>
  )
}
