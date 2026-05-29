export interface ThemePreset {
  id: string
  name: string
  type: 'dark' | 'light'
  colors: Record<string, string>
}

export const THEME_PRESETS: ThemePreset[] = [
  // =====================
  // DARK THEME — Nordic Night Tech
  // =====================
  {
    id: 'mocha',
    name: 'Nordic Night',
    type: 'dark',
    colors: {
      background: '#101827',
      foreground: '#C3CBE0',
      card: '#151F2F',
      'card-foreground': '#C3CBE0',
      popover: '#151F2F',
      'popover-foreground': '#C3CBE0',
      primary: '#7AA7FF',
      'primary-foreground': '#08111F',
      secondary: '#1A2436',
      'secondary-foreground': '#A9B3C8',
      muted: '#1A2436',
      'muted-foreground': '#8994AA',
      accent: '#22304A',
      'accent-foreground': '#C3CBE0',
      destructive: '#FB7185',
      'destructive-foreground': '#2A0712',
      border: '#2A364A',
      input: '#334155',
      ring: '#7AA7FF',
      sidebar: '#0F1724',
      'sidebar-foreground': '#A9B3C8',
      'sidebar-primary': '#7AA7FF',
      'sidebar-primary-foreground': '#08111F',
      'sidebar-accent': '#151F2F',
      'sidebar-accent-foreground': '#C3CBE0',
      'sidebar-border': '#263247',
      'sidebar-ring': '#7AA7FF',
      celadon: '#2DD4BF',
      'celadon-foreground': '#08111F',
      'agent-canvas': '#101827',
      'agent-sheet': '#121C2B',
      'agent-card': '#151F2F',
      'agent-card-muted': '#1A2436',
      'agent-hover': '#253247',
      'agent-shadow-rgb': '0 0 0',
      'code-block-bg': '#131C2B',
      'code-block-header': '#101827',
      'code-block-border': '#263247',
      'code-block-text': '#CBD5E1',
      'code-block-muted': '#8492A8',
      'code-block-accent': '#8BC7FF',
      'code-block-warm': '#F6D36B',
      ink: '#C3CBE0',
      steel: '#8994AA',
      'tech-blue': '#7AA7FF',
      'tech-blue-soft': '#172A48',
      'neon-mint': '#2DD4BF',
      'neon-mint-soft': '#123834',
      'neon-pink': '#FB7185',
      'neon-pink-soft': '#3F1725',
      'neon-violet': '#B29DFF',
      'neon-violet-soft': '#30294B'
    }
  },

  // =====================
  // LIGHT THEME — Nordic Crisp Tech
  // =====================
  {
    id: 'latte',
    name: 'Nordic',
    type: 'light',
    colors: {
      background: '#F1F5F9', // Soft slate canvas, less glare than white
      foreground: '#4B526B', // Soft slate-lavender ink
      card: '#FFFFFF', // Floating sheet
      'card-foreground': '#4B526B',
      popover: '#FFFFFF',
      'popover-foreground': '#4B526B',
      primary: '#2563EB', // Calmer electric blue
      'primary-foreground': '#FFFFFF',
      secondary: '#F8FAFC',
      'secondary-foreground': '#5C657A',
      muted: '#F1F5F9',
      'muted-foreground': '#6B7488',
      accent: '#EFF6FF',
      'accent-foreground': '#4B526B',
      destructive: '#E11D48', // Instrument red, readable without glare
      'destructive-foreground': '#FFFFFF',
      border: '#E2E8F0',
      input: '#CBD5E1',
      ring: '#2563EB',
      sidebar: '#F1F5F9',
      'sidebar-foreground': '#5C657A',
      'sidebar-primary': '#2563EB',
      'sidebar-primary-foreground': '#FFFFFF',
      'sidebar-accent': '#FFFFFF',
      'sidebar-accent-foreground': '#4B526B',
      'sidebar-border': '#E2E8F0',
      'sidebar-ring': '#2563EB',
      celadon: '#0FBEA7',
      'celadon-foreground': '#FFFFFF',
      'agent-canvas': '#F1F5F9',
      'agent-sheet': '#FFFFFF',
      'agent-card': '#FFFFFF',
      'agent-card-muted': '#F8FAFC',
      'agent-hover': '#E8EEF7',
      'agent-shadow-rgb': '15 23 42',
      'code-block-bg': '#1E293B',
      'code-block-header': '#172033',
      'code-block-border': '#334155',
      'code-block-text': '#E2E8F0',
      'code-block-muted': '#94A3B8',
      'code-block-accent': '#7DD3FC',
      'code-block-warm': '#FCD34D',
      ink: '#4B526B',
      steel: '#6B7488',
      'tech-blue': '#2563EB',
      'tech-blue-soft': '#EFF6FF',
      'neon-mint': '#0FBEA7',
      'neon-mint-soft': '#E9FBF7',
      'neon-pink': '#E11D48',
      'neon-pink-soft': '#FFEBF0',
      'neon-violet': '#6D5BD0',
      'neon-violet-soft': '#F1EDFF'
    }
  },

  // =====================
  // LIGHT THEME — Xuanpu Calm
  // =====================
  {
    id: 'calm',
    name: 'Xuanpu Calm',
    type: 'light',
    colors: {
      background: '#F5F6F3',
      foreground: '#3A4048',
      card: '#FCFCFA',
      'card-foreground': '#3A4048',
      popover: '#FCFCFA',
      'popover-foreground': '#3A4048',
      primary: '#526F9E',
      'primary-foreground': '#FFFFFF',
      secondary: '#EEF0EB',
      'secondary-foreground': '#4E5660',
      muted: '#EEF0EB',
      'muted-foreground': '#737B84',
      accent: '#E7EDF4',
      'accent-foreground': '#364253',
      destructive: '#B35C66',
      'destructive-foreground': '#FFFFFF',
      border: '#E1E4DD',
      input: '#D6DBD2',
      ring: '#526F9E',
      sidebar: '#EEF0EB',
      'sidebar-foreground': '#5A626B',
      'sidebar-primary': '#526F9E',
      'sidebar-primary-foreground': '#FFFFFF',
      'sidebar-accent': '#FCFCFA',
      'sidebar-accent-foreground': '#3A4048',
      'sidebar-border': '#E1E4DD',
      'sidebar-ring': '#526F9E',
      celadon: '#5D8E81',
      'celadon-foreground': '#FFFFFF',
      'agent-canvas': '#F5F6F3',
      'agent-sheet': '#FAFAF7',
      'agent-card': '#FCFCFA',
      'agent-card-muted': '#F1F2EE',
      'agent-hover': '#E9ECE6',
      'agent-shadow-rgb': '52 58 66',
      'code-block-bg': '#1E293B',
      'code-block-header': '#172033',
      'code-block-border': '#334155',
      'code-block-text': '#E2E8F0',
      'code-block-muted': '#94A3B8',
      'code-block-accent': '#7DD3FC',
      'code-block-warm': '#FCD34D',
      ink: '#343A42',
      steel: '#737B84',
      'tech-blue': '#526F9E',
      'tech-blue-soft': '#E7EDF4',
      'neon-mint': '#5D8E81',
      'neon-mint-soft': '#E7F0EC',
      'neon-pink': '#B35C66',
      'neon-pink-soft': '#F3E4E7',
      'neon-violet': '#6C668F',
      'neon-violet-soft': '#ECEAF3'
    }
  }
]

export const DEFAULT_THEME_ID = 'latte'

export function getThemeById(id: string): ThemePreset | undefined {
  return THEME_PRESETS.find((preset) => preset.id === id)
}
