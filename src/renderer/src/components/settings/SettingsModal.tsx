import { useEffect } from 'react'
import {
  Settings,
  Palette,
  Monitor,
  Code,
  Terminal,
  Keyboard,
  Download,
  Shield,
  Eye,
  Sparkles,
  BarChart3,
  Archive,
  BookOpen
} from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useGhosttySuppression } from '@/hooks'
import { SettingsAppearance } from './SettingsAppearance'
import { SettingsGeneral } from './SettingsGeneral'
import { SettingsModels } from './SettingsModels'
import { SettingsEditor } from './SettingsEditor'
import { SettingsTerminal } from './SettingsTerminal'
import { SettingsShortcuts } from './SettingsShortcuts'
import { SettingsUpdates } from './SettingsUpdates'
import { SettingsSecurity } from './SettingsSecurity'
import { SettingsPrivacy } from './SettingsPrivacy'
import { SettingsUsage } from './SettingsUsage'
import { SettingsArchivedChats } from './SettingsArchivedChats'
import { SettingsSkills } from './SettingsSkills'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/useI18n'

const SECTIONS = [
  { id: 'appearance', icon: Palette },
  { id: 'general', icon: Monitor },
  { id: 'models', icon: Sparkles },
  { id: 'editor', icon: Code },
  { id: 'terminal', icon: Terminal },
  { id: 'security', icon: Shield },
  { id: 'privacy', icon: Eye },
  { id: 'usage', icon: BarChart3 },
  { id: 'archivedChats', icon: Archive },
  { id: 'skills', icon: BookOpen },
  { id: 'shortcuts', icon: Keyboard },
  { id: 'updates', icon: Download }
] as const

export function SettingsModal(): React.JSX.Element {
  const { isOpen, activeSection, closeSettings, openSettings, setActiveSection } =
    useSettingsStore()
  useGhosttySuppression('settings-modal', isOpen)
  const { t } = useI18n()

  // Listen for the custom event dispatched by keyboard shortcut handler
  useEffect(() => {
    const handleOpenSettings = (): void => {
      openSettings()
    }
    window.addEventListener('hive:open-settings', handleOpenSettings)
    return () => window.removeEventListener('hive:open-settings', handleOpenSettings)
  }, [openSettings])

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) closeSettings()
      }}
    >
      <DialogContent
        className={cn(
          'p-0 gap-0 overflow-hidden',
          activeSection === 'usage' || activeSection === 'archivedChats' || activeSection === 'skills'
            ? 'max-w-[min(96vw,1280px)] h-[88vh]'
            : 'max-w-3xl h-[70vh]'
        )}
        data-testid="settings-modal"
      >
        <div className="flex h-full min-h-0">
          {/* Left navigation */}
          <nav className="w-48 border-r bg-muted/30 p-3 flex flex-col gap-1 shrink-0">
            <div className="flex items-center gap-2 px-2 py-1.5 mb-2">
              <Settings className="h-4 w-4 text-muted-foreground" />
              <DialogTitle className="text-sm font-semibold">{t('settings.title')}</DialogTitle>
            </div>
            {SECTIONS.map((section) => {
              const Icon = section.icon
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors text-left',
                    activeSection === section.id
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  )}
                  data-testid={`settings-nav-${section.id}`}
                >
                  <Icon className="h-4 w-4" />
                  {t(`settings.sections.${section.id}`)}
                </button>
              )
            })}
          </nav>

          {/* Content area */}
          <div className={cn(
            "flex-1 p-6 min-h-0 flex flex-col",
            // Only Skills needs an `overflow-hidden` outer (its inner two-column
            // layout has its own scroll containers). archivedChats / usage
            // render plain vertical lists and rely on the outer scroller.
            activeSection === 'skills'
              ? "overflow-hidden"
              : "overflow-y-auto"
          )}>
            {activeSection === 'appearance' && <SettingsAppearance />}
            {activeSection === 'general' && <SettingsGeneral />}
            {activeSection === 'models' && <SettingsModels />}
            {activeSection === 'editor' && <SettingsEditor />}
            {activeSection === 'terminal' && <SettingsTerminal />}
            {activeSection === 'security' && <SettingsSecurity />}
            {activeSection === 'privacy' && <SettingsPrivacy />}
            {activeSection === 'usage' && <SettingsUsage />}
            {activeSection === 'archivedChats' && <SettingsArchivedChats />}
            {activeSection === 'skills' && <SettingsSkills />}
            {activeSection === 'shortcuts' && <SettingsShortcuts />}
            {activeSection === 'updates' && <SettingsUpdates />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
