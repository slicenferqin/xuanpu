import { create } from 'zustand'
import { useTerminalStore } from './useTerminalStore'

export interface BottomTerminalTab {
  id: string
  worktreeId: string
  label: string
  cwd: string
}

interface BottomTerminalState {
  tabsByWorktree: Map<string, BottomTerminalTab[]>
  activeTabByWorktree: Map<string, string>
  counterByWorktree: Map<string, number>

  createTab: (worktreeId: string, cwd: string, label?: string) => string
  closeTab: (tabId: string) => void
  closeOtherTabs: (tabId: string) => void
  setActiveTab: (worktreeId: string, tabId: string) => void
  renameTab: (tabId: string, label: string) => void
  ensureDefaultTab: (worktreeId: string, cwd: string) => string
  cleanupWorktree: (worktreeId: string) => void
  getTabsForWorktree: (worktreeId: string) => BottomTerminalTab[]
  getActiveTab: (worktreeId: string) => BottomTerminalTab | undefined
  getActiveTabId: (worktreeId: string) => string | undefined
  nextTab: (worktreeId: string) => void
  prevTab: (worktreeId: string) => void
  /** Clear all tabs and state (used on backend switch) */
  clearAll: () => void
}

function generateTabId(): string {
  return `bt-${crypto.randomUUID().slice(0, 8)}`
}

function findTabWorktree(
  tabsByWorktree: Map<string, BottomTerminalTab[]>,
  tabId: string
): { worktreeId: string; tabs: BottomTerminalTab[]; index: number } | null {
  for (const [worktreeId, tabs] of tabsByWorktree) {
    const index = tabs.findIndex((t) => t.id === tabId)
    if (index !== -1) {
      return { worktreeId, tabs, index }
    }
  }
  return null
}

export const useBottomTerminalStore = create<BottomTerminalState>((set, get) => ({
  tabsByWorktree: new Map(),
  activeTabByWorktree: new Map(),
  counterByWorktree: new Map(),

  createTab: (worktreeId: string, cwd: string, label?: string): string => {
    const id = generateTabId()
    const counter = (get().counterByWorktree.get(worktreeId) ?? 0) + 1
    const tabLabel = label ?? `Terminal ${counter}`

    const tab: BottomTerminalTab = { id, worktreeId, label: tabLabel, cwd }

    set((state) => {
      const tabsByWorktree = new Map(state.tabsByWorktree)
      const existing = tabsByWorktree.get(worktreeId) ?? []
      tabsByWorktree.set(worktreeId, [...existing, tab])

      const activeTabByWorktree = new Map(state.activeTabByWorktree)
      activeTabByWorktree.set(worktreeId, id)

      const counterByWorktree = new Map(state.counterByWorktree)
      counterByWorktree.set(worktreeId, counter)

      return { tabsByWorktree, activeTabByWorktree, counterByWorktree }
    })

    return id
  },

  closeTab: (tabId: string): void => {
    const state = get()
    const found = findTabWorktree(state.tabsByWorktree, tabId)
    if (!found) return

    const { worktreeId, tabs, index } = found

    // Destroy the PTY for this tab (goes through useTerminalStore to clean up terminal state)
    useTerminalStore.getState().destroyTerminal(tabId)

    const remainingTabs = tabs.filter((t) => t.id !== tabId)

    if (remainingTabs.length === 0) {
      // Last tab closed — auto-create a new default tab
      const defaultCwd = tabs[0]?.cwd ?? '/'
      const newId = generateTabId()
      const counter = (state.counterByWorktree.get(worktreeId) ?? 0) + 1
      const newTab: BottomTerminalTab = {
        id: newId,
        worktreeId,
        label: `Terminal ${counter}`,
        cwd: defaultCwd
      }

      set((s) => {
        const tabsByWorktree = new Map(s.tabsByWorktree)
        tabsByWorktree.set(worktreeId, [newTab])

        const activeTabByWorktree = new Map(s.activeTabByWorktree)
        activeTabByWorktree.set(worktreeId, newId)

        const counterByWorktree = new Map(s.counterByWorktree)
        counterByWorktree.set(worktreeId, counter)

        return { tabsByWorktree, activeTabByWorktree, counterByWorktree }
      })
      return
    }

    // Update active tab if the closed one was active
    const currentActive = state.activeTabByWorktree.get(worktreeId)
    let newActiveId = currentActive
    if (currentActive === tabId) {
      // Activate the next tab, or the previous if we closed the last
      const newIndex = Math.min(index, remainingTabs.length - 1)
      newActiveId = remainingTabs[newIndex].id
    }

    set((s) => {
      const tabsByWorktree = new Map(s.tabsByWorktree)
      tabsByWorktree.set(worktreeId, remainingTabs)

      const activeTabByWorktree = new Map(s.activeTabByWorktree)
      if (newActiveId) activeTabByWorktree.set(worktreeId, newActiveId)

      return { tabsByWorktree, activeTabByWorktree }
    })
  },

  closeOtherTabs: (tabId: string): void => {
    const state = get()
    const found = findTabWorktree(state.tabsByWorktree, tabId)
    if (!found) return

    const { worktreeId, tabs } = found

    // Destroy PTYs for all other tabs
    for (const tab of tabs) {
      if (tab.id !== tabId) {
        useTerminalStore.getState().destroyTerminal(tab.id)
      }
    }

    const keptTab = tabs.find((t) => t.id === tabId)
    if (!keptTab) return

    set((s) => {
      const tabsByWorktree = new Map(s.tabsByWorktree)
      tabsByWorktree.set(worktreeId, [keptTab])

      const activeTabByWorktree = new Map(s.activeTabByWorktree)
      activeTabByWorktree.set(worktreeId, tabId)

      return { tabsByWorktree, activeTabByWorktree }
    })
  },

  setActiveTab: (worktreeId: string, tabId: string): void => {
    set((state) => {
      const activeTabByWorktree = new Map(state.activeTabByWorktree)
      activeTabByWorktree.set(worktreeId, tabId)
      return { activeTabByWorktree }
    })
  },

  renameTab: (tabId: string, label: string): void => {
    const state = get()
    const found = findTabWorktree(state.tabsByWorktree, tabId)
    if (!found) return

    const { worktreeId, tabs } = found

    set((s) => {
      const tabsByWorktree = new Map(s.tabsByWorktree)
      tabsByWorktree.set(
        worktreeId,
        tabs.map((t) => (t.id === tabId ? { ...t, label } : t))
      )
      return { tabsByWorktree }
    })
  },

  ensureDefaultTab: (worktreeId: string, cwd: string): string => {
    const existing = get().tabsByWorktree.get(worktreeId)
    if (existing && existing.length > 0) {
      return get().activeTabByWorktree.get(worktreeId) ?? existing[0].id
    }

    // Create the first default tab
    return get().createTab(worktreeId, cwd)
  },

  cleanupWorktree: (worktreeId: string): void => {
    const tabs = get().tabsByWorktree.get(worktreeId) ?? []

    // Destroy all PTYs for this worktree
    for (const tab of tabs) {
      useTerminalStore.getState().destroyTerminal(tab.id)
    }

    set((state) => {
      const tabsByWorktree = new Map(state.tabsByWorktree)
      tabsByWorktree.delete(worktreeId)

      const activeTabByWorktree = new Map(state.activeTabByWorktree)
      activeTabByWorktree.delete(worktreeId)

      const counterByWorktree = new Map(state.counterByWorktree)
      counterByWorktree.delete(worktreeId)

      return { tabsByWorktree, activeTabByWorktree, counterByWorktree }
    })
  },

  getTabsForWorktree: (worktreeId: string): BottomTerminalTab[] => {
    return get().tabsByWorktree.get(worktreeId) ?? []
  },

  getActiveTab: (worktreeId: string): BottomTerminalTab | undefined => {
    const activeId = get().activeTabByWorktree.get(worktreeId)
    if (!activeId) return undefined
    const tabs = get().tabsByWorktree.get(worktreeId) ?? []
    return tabs.find((t) => t.id === activeId)
  },

  getActiveTabId: (worktreeId: string): string | undefined => {
    return get().activeTabByWorktree.get(worktreeId)
  },

  nextTab: (worktreeId: string): void => {
    const state = get()
    const tabs = state.tabsByWorktree.get(worktreeId) ?? []
    if (tabs.length <= 1) return

    const activeId = state.activeTabByWorktree.get(worktreeId)
    const currentIndex = tabs.findIndex((t) => t.id === activeId)
    const nextIndex = (currentIndex + 1) % tabs.length

    get().setActiveTab(worktreeId, tabs[nextIndex].id)
  },

  prevTab: (worktreeId: string): void => {
    const state = get()
    const tabs = state.tabsByWorktree.get(worktreeId) ?? []
    if (tabs.length <= 1) return

    const activeId = state.activeTabByWorktree.get(worktreeId)
    const currentIndex = tabs.findIndex((t) => t.id === activeId)
    const prevIndex = (currentIndex - 1 + tabs.length) % tabs.length

    get().setActiveTab(worktreeId, tabs[prevIndex].id)
  },

  clearAll: (): void => {
    // Destroy all PTYs across all worktrees
    const state = get()
    for (const [, tabs] of state.tabsByWorktree) {
      for (const tab of tabs) {
        useTerminalStore.getState().destroyTerminal(tab.id)
      }
    }

    set({
      tabsByWorktree: new Map(),
      activeTabByWorktree: new Map(),
      counterByWorktree: new Map()
    })
  }
}))
