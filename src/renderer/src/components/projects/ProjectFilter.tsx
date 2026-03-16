import { useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'

interface ProjectFilterProps {
  value: string
  onChange: (value: string) => void
}

export function ProjectFilter({ value, onChange }: ProjectFilterProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleFocus = (): void => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('hive:focus-project-filter', handleFocus)
    return () => {
      window.removeEventListener('hive:focus-project-filter', handleFocus)
    }
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      onChange('')
      inputRef.current?.blur()
    }
  }

  return (
    <div className="relative flex items-center">
      <Search className="absolute left-3.5 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Filter projects..."
        className="h-8 w-full text-sm px-2 pl-8 pr-12 rounded-md border border-input bg-transparent placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        data-testid="project-filter-input"
      />
      {value ? (
        <button
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
          className="absolute right-3.5 h-3.5 w-3.5 flex items-center justify-center text-muted-foreground hover:text-foreground"
          data-testid="project-filter-clear"
        >
          <X className="h-3 w-3" />
        </button>
      ) : (
        <kbd className="absolute right-2 pointer-events-none text-[10px] text-muted-foreground/60 bg-muted/50 border border-border/50 rounded px-1 py-0.5 font-sans">
          ⌘G
        </kbd>
      )}
    </div>
  )
}
