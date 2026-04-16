export interface ThemePreset {
  id: string
  name: string
  type: 'dark' | 'light'
  colors: Record<string, string>
}

export const THEME_PRESETS: ThemePreset[] = [
  // =====================
  // DARK THEME — Catppuccin Mocha
  // https://github.com/catppuccin/catppuccin
  // =====================
  {
    id: 'mocha',
    name: 'Mocha',
    type: 'dark',
    colors: {
      background: 'hsl(240 21% 15%)',         // Base
      foreground: 'hsl(226 64% 88%)',          // Text
      card: 'hsl(240 21% 12%)',                // Mantle
      'card-foreground': 'hsl(226 64% 88%)',   // Text
      popover: 'hsl(240 21% 12%)',             // Mantle
      'popover-foreground': 'hsl(226 64% 88%)',// Text
      primary: 'hsl(232 97% 85%)',             // Lavender
      'primary-foreground': 'hsl(240 23% 9%)', // Crust
      secondary: 'hsl(237 16% 23%)',           // Surface0
      'secondary-foreground': 'hsl(228 24% 72%)', // Subtext0
      muted: 'hsl(237 16% 23%)',               // Surface0
      'muted-foreground': 'hsl(230 13% 55%)',  // Overlay1
      accent: 'hsl(237 16% 23%)',              // Surface0
      'accent-foreground': 'hsl(226 64% 88%)', // Text
      destructive: 'hsl(343 81% 75%)',         // Red
      'destructive-foreground': 'hsl(240 23% 9%)', // Crust
      border: 'hsl(234 13% 31%)',              // Surface1
      input: 'hsl(234 13% 31%)',               // Surface1
      ring: 'hsl(232 97% 85%)',                // Lavender
      sidebar: 'hsl(240 23% 9%)',              // Crust
      'sidebar-foreground': 'hsl(228 24% 72%)',// Subtext0
      'sidebar-primary': 'hsl(232 97% 85%)',   // Lavender
      'sidebar-primary-foreground': 'hsl(240 23% 9%)', // Crust
      'sidebar-accent': 'hsl(237 16% 23%)',    // Surface0
      'sidebar-accent-foreground': 'hsl(226 64% 88%)', // Text
      'sidebar-border': 'hsl(234 13% 31%)',    // Surface1
      'sidebar-ring': 'hsl(232 97% 85%)',      // Lavender
      celadon: 'hsl(170 57% 73%)',             // Teal
      'celadon-foreground': 'hsl(240 23% 9%)'  // Crust
    }
  },

  // =====================
  // LIGHT THEME — Catppuccin Latte
  // https://github.com/catppuccin/catppuccin
  // =====================
  {
    id: 'latte',
    name: 'Latte',
    type: 'light',
    colors: {
      background: 'hsl(220 23% 95%)',          // Base
      foreground: 'hsl(234 16% 35%)',          // Text
      card: 'hsl(220 22% 92%)',                // Mantle
      'card-foreground': 'hsl(234 16% 35%)',   // Text
      popover: 'hsl(220 22% 92%)',             // Mantle
      'popover-foreground': 'hsl(234 16% 35%)',// Text
      primary: 'hsl(231 97% 72%)',             // Lavender
      'primary-foreground': 'hsl(220 23% 95%)',// Base
      secondary: 'hsl(223 16% 83%)',           // Surface0
      'secondary-foreground': 'hsl(233 10% 47%)', // Subtext0
      muted: 'hsl(223 16% 83%)',               // Surface0
      'muted-foreground': 'hsl(231 10% 59%)',  // Overlay1
      accent: 'hsl(223 16% 83%)',              // Surface0
      'accent-foreground': 'hsl(234 16% 35%)', // Text
      destructive: 'hsl(347 87% 44%)',         // Red
      'destructive-foreground': 'hsl(220 23% 95%)', // Base
      border: 'hsl(225 14% 77%)',              // Surface1
      input: 'hsl(225 14% 77%)',               // Surface1
      ring: 'hsl(231 97% 72%)',                // Lavender
      sidebar: 'hsl(220 21% 89%)',             // Crust
      'sidebar-foreground': 'hsl(233 10% 47%)',// Subtext0
      'sidebar-primary': 'hsl(231 97% 72%)',   // Lavender
      'sidebar-primary-foreground': 'hsl(220 23% 95%)', // Base
      'sidebar-accent': 'hsl(223 16% 83%)',    // Surface0
      'sidebar-accent-foreground': 'hsl(234 16% 35%)', // Text
      'sidebar-border': 'hsl(225 14% 77%)',    // Surface1
      'sidebar-ring': 'hsl(231 97% 72%)',      // Lavender
      celadon: 'hsl(183 74% 35%)',             // Teal
      'celadon-foreground': 'hsl(220 23% 95%)' // Base
    }
  }
]

export const DEFAULT_THEME_ID = 'latte'

export function getThemeById(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((preset) => preset.id === id)
}
