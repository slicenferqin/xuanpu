export interface ThemePreset {
  id: string
  name: string
  type: 'dark' | 'light'
  colors: Record<string, string>
}

export const THEME_PRESETS: ThemePreset[] = [
  // =====================
  // DARK THEME — demo4 [data-theme="dark"]
  // bg-app:#0A0A0A  bg-sidebar:#121212  bg-panel:#18181B
  // bg-hover:#27272A  text-main:#F4F4F5  text-muted:#A1A1AA
  // border-light:#27272A  border-strong:#3F3F46  accent:#3B82F6
  // =====================
  {
    id: 'amethyst',
    name: 'Dark',
    type: 'dark',
    colors: {
      background: 'hsl(0 0% 4%)',
      foreground: 'hsl(240 5% 96%)',
      card: 'hsl(240 4% 10%)',
      'card-foreground': 'hsl(240 5% 96%)',
      popover: 'hsl(240 4% 10%)',
      'popover-foreground': 'hsl(240 5% 96%)',
      primary: 'hsl(217 91% 60%)',
      'primary-foreground': 'hsl(0 0% 100%)',
      secondary: 'hsl(240 4% 16%)',
      'secondary-foreground': 'hsl(240 5% 96%)',
      muted: 'hsl(240 4% 16%)',
      'muted-foreground': 'hsl(240 5% 65%)',
      accent: 'hsl(240 4% 16%)',
      'accent-foreground': 'hsl(240 5% 96%)',
      destructive: 'hsl(0 84% 60%)',
      'destructive-foreground': 'hsl(0 0% 100%)',
      border: 'hsl(240 4% 16%)',
      input: 'hsl(240 4% 16%)',
      ring: 'hsl(217 91% 60%)',
      sidebar: 'hsl(0 0% 7%)',
      'sidebar-foreground': 'hsl(240 5% 65%)',
      'sidebar-primary': 'hsl(217 91% 60%)',
      'sidebar-primary-foreground': 'hsl(0 0% 100%)',
      'sidebar-accent': 'hsl(240 4% 16%)',
      'sidebar-accent-foreground': 'hsl(240 5% 96%)',
      'sidebar-border': 'hsl(240 4% 16%)',
      'sidebar-ring': 'hsl(217 91% 60%)',
      celadon: 'hsl(160 25% 55%)',
      'celadon-foreground': 'hsl(0 0% 100%)'
    }
  },

  // =====================
  // LIGHT THEME — demo4 :root
  // bg-app:#FFFFFF  bg-sidebar:#F9FAFB  bg-panel:#FFFFFF
  // bg-hover:#F3F4F6  text-main:#111827  text-muted:#9CA3AF
  // border-light:#E5E7EB  border-strong:#D1D5DB  accent:#3B82F6
  // =====================
  {
    id: 'daylight',
    name: 'Light',
    type: 'light',
    colors: {
      background: 'hsl(0 0% 100%)',
      foreground: 'hsl(221 39% 11%)',
      card: 'hsl(0 0% 100%)',
      'card-foreground': 'hsl(221 39% 11%)',
      popover: 'hsl(0 0% 100%)',
      'popover-foreground': 'hsl(221 39% 11%)',
      primary: 'hsl(217 91% 60%)',
      'primary-foreground': 'hsl(0 0% 100%)',
      secondary: 'hsl(220 14% 96%)',
      'secondary-foreground': 'hsl(215 16% 47%)',
      muted: 'hsl(220 14% 96%)',
      'muted-foreground': 'hsl(218 11% 65%)',
      accent: 'hsl(220 14% 96%)',
      'accent-foreground': 'hsl(221 39% 11%)',
      destructive: 'hsl(0 84% 60%)',
      'destructive-foreground': 'hsl(0 0% 100%)',
      border: 'hsl(220 13% 91%)',
      input: 'hsl(220 13% 91%)',
      ring: 'hsl(217 91% 60%)',
      sidebar: 'hsl(210 20% 98%)',
      'sidebar-foreground': 'hsl(215 16% 47%)',
      'sidebar-primary': 'hsl(217 91% 60%)',
      'sidebar-primary-foreground': 'hsl(0 0% 100%)',
      'sidebar-accent': 'hsl(220 14% 96%)',
      'sidebar-accent-foreground': 'hsl(221 39% 11%)',
      'sidebar-border': 'hsl(220 13% 91%)',
      'sidebar-ring': 'hsl(217 91% 60%)',
      celadon: 'hsl(160 30% 38%)',
      'celadon-foreground': 'hsl(0 0% 100%)'
    }
  }
]

export const DEFAULT_THEME_ID = 'daylight'

export function getThemeById(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((preset) => preset.id === id)
}
