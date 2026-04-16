import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { THEME_PRESETS, DEFAULT_THEME_ID, getThemeById, type ThemePreset } from '@/lib/themes'

const THEME_SETTING_KEY = 'selected_theme'
const FOLLOW_SYSTEM_KEY = 'theme_follow_system'

interface ThemeState {
  themeId: string
  followSystem: boolean
  isLoading: boolean
  setTheme: (id: string) => void
  setFollowSystem: (follow: boolean) => void
  getCurrentTheme: () => ThemePreset
  loadFromDatabase: () => Promise<void>
  previewTheme: (id: string) => void
  cancelPreview: () => void
}

// Migrate removed theme IDs to surviving themes
const REMOVED_DARK_THEMES = new Set([
  'obsidian', 'midnight-blue', 'emerald-night', 'crimson', 'sunset',
  'catppuccin-mocha', 'amethyst'
])
const REMOVED_LIGHT_THEMES = new Set([
  'cloud', 'mint', 'rose', 'catppuccin-latte', 'daylight'
])

function migrateThemeId(id: string): string {
  if (REMOVED_DARK_THEMES.has(id)) return 'mocha'
  if (REMOVED_LIGHT_THEMES.has(id)) return 'latte'
  return id
}

/** Get the theme ID matching the OS color scheme */
function getSystemThemeId(): string {
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
    return 'mocha'
  }
  return 'latte'
}

// Save theme ID to SQLite database
async function saveThemeToDatabase(themeId: string): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      await window.db.setting.set(THEME_SETTING_KEY, themeId)
    }
  } catch (error) {
    console.error('Failed to save theme to database:', error)
  }
}

async function saveFollowSystemToDatabase(follow: boolean): Promise<void> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      await window.db.setting.set(FOLLOW_SYSTEM_KEY, follow ? 'true' : 'false')
    }
  } catch (error) {
    console.error('Failed to save follow-system to database:', error)
  }
}

// Load theme ID from SQLite database
async function loadThemeFromDatabase(): Promise<string | null> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      const value = await window.db.setting.get(THEME_SETTING_KEY)
      if (value) {
        const migrated = migrateThemeId(value)
        if (getThemeById(migrated)) {
          // Persist migration if the ID changed
          if (migrated !== value) await saveThemeToDatabase(migrated)
          return migrated
        }
      }
    }
  } catch (error) {
    console.error('Failed to load theme from database:', error)
  }
  return null
}

async function loadFollowSystemFromDatabase(): Promise<boolean> {
  try {
    if (typeof window !== 'undefined' && window.db?.setting) {
      const value = await window.db.setting.get(FOLLOW_SYSTEM_KEY)
      return value === 'true'
    }
  } catch {
    // ignore
  }
  return false
}

function applyThemePreset(preset: ThemePreset): void {
  const root = window.document.documentElement

  // Set dark/light class
  root.classList.remove('light', 'dark')
  root.classList.add(preset.type)

  // Apply all CSS custom properties
  for (const [key, value] of Object.entries(preset.colors)) {
    root.style.setProperty(`--${key}`, value)
  }
}

function applyThemeById(themeId: string): void {
  const preset = getThemeById(themeId)
  if (preset) {
    applyThemePreset(preset)
  }
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      themeId: DEFAULT_THEME_ID,
      followSystem: false,
      isLoading: true,

      setTheme: (id: string) => {
        const preset = getThemeById(id)
        if (!preset) return
        set({ themeId: id, followSystem: false })
        applyThemePreset(preset)
        saveThemeToDatabase(id)
        saveFollowSystemToDatabase(false)
      },

      setFollowSystem: (follow: boolean) => {
        set({ followSystem: follow })
        saveFollowSystemToDatabase(follow)
        if (follow) {
          const systemId = getSystemThemeId()
          set({ themeId: systemId })
          applyThemeById(systemId)
          saveThemeToDatabase(systemId)
        }
      },

      getCurrentTheme: () => {
        const preset = getThemeById(get().themeId)
        return preset || THEME_PRESETS[0]
      },

      previewTheme: (id: string) => {
        const preset = getThemeById(id)
        if (preset) {
          applyThemePreset(preset)
        }
      },

      cancelPreview: () => {
        applyThemeById(get().themeId)
      },

      loadFromDatabase: async () => {
        const [dbThemeId, followSystem] = await Promise.all([
          loadThemeFromDatabase(),
          loadFollowSystemFromDatabase()
        ])

        if (followSystem) {
          const systemId = getSystemThemeId()
          set({ themeId: systemId, followSystem: true, isLoading: false })
          applyThemeById(systemId)
        } else if (dbThemeId) {
          set({ themeId: dbThemeId, followSystem: false, isLoading: false })
          applyThemeById(dbThemeId)
        } else {
          const currentId = get().themeId
          set({ isLoading: false })
          applyThemeById(currentId)
          await saveThemeToDatabase(currentId)
        }
      }
    }),
    {
      name: 'hive-theme',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ themeId: state.themeId, followSystem: state.followSystem }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          if (state.followSystem) {
            state.themeId = getSystemThemeId()
          } else {
            state.themeId = migrateThemeId(state.themeId)
          }
          applyThemeById(state.themeId)
        }
      }
    }
  )
)

// Listen for OS color scheme changes
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const { followSystem } = useThemeStore.getState()
    if (followSystem) {
      const systemId = getSystemThemeId()
      useThemeStore.setState({ themeId: systemId })
      applyThemeById(systemId)
      saveThemeToDatabase(systemId)
    }
  })
}

// Initialize theme immediately to prevent flicker
if (typeof window !== 'undefined') {
  const storedTheme = localStorage.getItem('hive-theme')
  if (storedTheme) {
    try {
      const parsed = JSON.parse(storedTheme)
      if (parsed.state?.followSystem) {
        applyThemeById(getSystemThemeId())
      } else if (parsed.state?.themeId) {
        applyThemeById(migrateThemeId(parsed.state.themeId))
      } else if (parsed.state?.theme) {
        const oldTheme = parsed.state.theme
        const newId = oldTheme === 'light' ? 'latte' : DEFAULT_THEME_ID
        applyThemeById(newId)
      } else {
        applyThemeById(DEFAULT_THEME_ID)
      }
    } catch {
      applyThemeById(DEFAULT_THEME_ID)
    }
  } else {
    applyThemeById(DEFAULT_THEME_ID)
  }

  // Load from database (source of truth) once IPC is ready
  setTimeout(() => {
    useThemeStore.getState().loadFromDatabase()
  }, 100)
}
