import { useEffect, useMemo, useState } from 'react'
import { Globe } from 'lucide-react'
import { isMac } from '@/lib/platform'
import { useWorktreeStore } from '@/stores/useWorktreeStore'
import { useLayoutStore } from '@/stores/useLayoutStore'
import type { BottomPanelTab } from '@/stores/useLayoutStore'
import { useScriptStore } from '@/stores/useScriptStore'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { useProjectStore } from '@/stores/useProjectStore'
import { extractDevServerUrl } from '@/lib/format-utils'
import { getOrCreateBuffer } from '@/lib/output-ring-buffer'
import { cn } from '@/lib/utils'
import { SetupTab } from './SetupTab'
import { RunTab } from './RunTab'
import { toast } from '@/lib/toast'
import { useGhosttyPromotion } from '@/hooks/useGhosttyPromotion'
import { useI18n } from '@/i18n/useI18n'
import { TerminalTabBar } from '@/components/terminal/TerminalTabBar'

const tabs: { id: BottomPanelTab; label: string; keybind: string }[] = [
  { id: 'terminal', label: 'Terminal', keybind: 'T' },
  { id: 'run', label: 'Run', keybind: 'R' },
  { id: 'setup', label: 'Setup', keybind: 'S' }
]

interface BottomPanelProps {
  /** TerminalManager rendered by RightSidebar — passed as a slot to keep it alive across sidebar collapse */
  terminalSlot: React.ReactNode
  /** When true, only the terminal tab is shown (setup/run are worktree-specific) */
  isConnectionMode?: boolean
  /** The path of the selected worktree (for terminal tab bar fallback cwd) */
  worktreePath?: string | null
}

export function BottomPanel({
  terminalSlot,
  isConnectionMode,
  worktreePath
}: BottomPanelProps): React.JSX.Element {
  const { t, supportsFirstCharHint } = useI18n()
  const activeTab = useLayoutStore((s) => s.bottomPanelTab)
  const effectiveTab = isConnectionMode ? 'terminal' : activeTab
  useGhosttyPromotion(effectiveTab === 'terminal')
  const setActiveTab = useLayoutStore((s) => s.setBottomPanelTab)
  const selectedWorktreeId = useWorktreeStore((s) => s.selectedWorktreeId)
  const worktreesByProject = useWorktreeStore((s) => s.worktreesByProject)
  const projects = useProjectStore((s) => s.projects)

  const projectScripts = useMemo(() => {
    if (!selectedWorktreeId) return { hasSetupScript: false, hasRunScript: false }

    for (const [projectId, worktrees] of worktreesByProject) {
      if (worktrees.some((w) => w.id === selectedWorktreeId)) {
        const project = projects.find((p) => p.id === projectId)
        return {
          hasSetupScript: !!project?.setup_script,
          hasRunScript: !!project?.run_script
        }
      }
    }

    return { hasSetupScript: false, hasRunScript: false }
  }, [selectedWorktreeId, worktreesByProject, projects])

  const visibleTabs = useMemo(() => {
    if (isConnectionMode) {
      return tabs.filter((t) => t.id === 'terminal')
    }

    return tabs.filter((tab) => {
      if (tab.id === 'setup') return projectScripts.hasSetupScript
      if (tab.id === 'run') return projectScripts.hasRunScript
      return true
    })
  }, [isConnectionMode, projectScripts])

  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.id === effectiveTab)) {
      setActiveTab('terminal')
    }
  }, [effectiveTab, visibleTabs, setActiveTab])

  // Open in Chrome state
  const scriptState = useScriptStore((s) =>
    selectedWorktreeId ? (s.scriptStates[selectedWorktreeId] ?? null) : null
  )
  const runOutputVersion = useScriptStore((s) =>
    selectedWorktreeId ? (s.scriptStates[selectedWorktreeId]?.runOutputVersion ?? 0) : 0
  )
  const customChromeCommand = useSettingsStore((s) => s.customChromeCommand)
  const vimModeEnabled = useSettingsStore((s) => s.vimModeEnabled)

  // Per-worktree detected URLs so switching worktrees shows the correct port instantly.
  const [detectedUrls, setDetectedUrls] = useState<Record<string, string>>({})
  const detectedUrl = selectedWorktreeId ? (detectedUrls[selectedWorktreeId] ?? null) : null

  // Scan for dev server URL only while running and not yet found.
  // Once a URL is detected for a worktree, scanning stops (zero cost per subsequent version bump).
  // When runRunning becomes false, the URL for that worktree is cleared so the next run can detect a new one.
  useEffect(() => {
    if (!selectedWorktreeId || !scriptState?.runRunning) {
      if (selectedWorktreeId) {
        setDetectedUrls((prev) => {
          if (!(selectedWorktreeId in prev)) return prev
          const rest = { ...prev }
          delete rest[selectedWorktreeId]
          return rest
        })
      }
      return
    }
    // Already found for this worktree — stop scanning
    if (detectedUrl) return

    const output = getOrCreateBuffer(selectedWorktreeId).toRecentArray(80)
    if (!output.length) return
    const url = extractDevServerUrl(output)
    if (url) setDetectedUrls((prev) => ({ ...prev, [selectedWorktreeId]: url }))
  }, [selectedWorktreeId, scriptState?.runRunning, runOutputVersion, detectedUrl])

  const [chromeConfigOpen, setChromeConfigOpen] = useState(false)
  const [chromeCommandInput, setChromeCommandInput] = useState(customChromeCommand)
  const showPanelHeader = visibleTabs.length > 1 || !!detectedUrl

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent" data-testid="bottom-panel">
      {showPanelHeader && (
        <div
          className="flex items-center gap-2 border-b border-border/60 bg-background/58 px-2.5 py-2"
          data-testid="bottom-panel-tabs"
        >
          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="inline-flex min-w-max items-center gap-1 rounded-lg bg-background/35 p-0.5">
              {visibleTabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'shrink-0 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors',
                    effectiveTab === tab.id
                      ? 'bg-background/90 text-foreground'
                      : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
                  )}
                  data-testid={`bottom-panel-tab-${tab.id}`}
                  data-active={effectiveTab === tab.id}
                >
                  {vimModeEnabled && supportsFirstCharHint ? (
                    <>
                      <span className="text-primary">{tab.keybind}</span>
                      {tab.label.slice(1)}
                    </>
                  ) : (
                    t(`bottomPanel.tabs.${tab.id}`)
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Spacer + Open in Chrome button */}
          {detectedUrl && (
            <div className="relative ml-auto shrink-0">
              <button
                onClick={() => {
                  window.systemOps.openInChrome(detectedUrl, customChromeCommand || undefined)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setChromeCommandInput(customChromeCommand)
                  setChromeConfigOpen(true)
                }}
                className="flex items-center gap-1 rounded-md border border-border/70 bg-background/74 px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                title={t('bottomPanel.chrome.openTitle', { url: detectedUrl })}
                data-testid="open-in-chrome"
              >
                <Globe className="h-3.5 w-3.5" />
                <span className="text-[11px]">{detectedUrl}</span>
              </button>
              {chromeConfigOpen && (
                <div className="absolute right-0 top-full z-50 mt-2 w-80 rounded-xl border border-border bg-popover p-3 shadow-lg">
                  <label className="text-xs font-medium block mb-1">
                    {t('bottomPanel.chrome.customCommand')}
                  </label>
                  <p className="text-[10px] text-muted-foreground mb-2">
                    {t('bottomPanel.chrome.placeholderHelp')}
                  </p>
                  <input
                    value={chromeCommandInput}
                    onChange={(e) => setChromeCommandInput(e.target.value)}
                    placeholder={isMac() ? 'open -a "Google Chrome" {url}' : 'start chrome {url}'}
                    className="mb-2 w-full rounded-lg border bg-background px-2 py-1 text-xs"
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                  <div className="flex justify-end gap-1">
                    <button
                      onClick={() => setChromeConfigOpen(false)}
                      className="rounded-md px-2 py-1 text-xs hover:bg-accent"
                    >
                      {t('bottomPanel.chrome.cancel')}
                    </button>
                    <button
                      onClick={() => {
                        useSettingsStore
                          .getState()
                          .updateSetting('customChromeCommand', chromeCommandInput)
                        setChromeConfigOpen(false)
                        toast.success(t('bottomPanel.chrome.saved'))
                      }}
                      className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90"
                    >
                      {t('bottomPanel.chrome.save')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div
        className={cn(
          'flex-1 min-h-0 overflow-hidden bg-background/24',
          !showPanelHeader && 'bg-transparent'
        )}
        data-testid="bottom-panel-content"
      >
        {effectiveTab === 'run' && <RunTab worktreeId={selectedWorktreeId} />}
        {effectiveTab === 'setup' && <SetupTab worktreeId={selectedWorktreeId} />}
        {/* Terminal slot is always rendered but hidden when not active, preserving PTY state */}
        <div className={effectiveTab === 'terminal' ? 'h-full w-full flex flex-col' : 'hidden'}>
          {selectedWorktreeId && worktreePath && (
            <TerminalTabBar
              worktreeId={selectedWorktreeId}
              worktreeCwd={worktreePath}
            />
          )}
          <div className="flex-1 min-h-0">
            {terminalSlot}
          </div>
        </div>
      </div>
    </div>
  )
}
