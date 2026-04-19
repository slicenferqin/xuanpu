import { create } from 'zustand'
import type {
  AddHubResult,
  HubId,
  InstalledSkill,
  RefreshHubResult,
  RemoveHubResult,
  Skill,
  SkillHub,
  SkillScope,
  SkillScopeKey
} from '@shared/types/skill'
import { scopeKey } from '@shared/types/skill'

interface SkillState {
  hubs: SkillHub[]
  selectedHubId: HubId | null
  /** Skills keyed by hubId. */
  skillsByHub: Record<HubId, Skill[]>
  installedByScope: Record<SkillScopeKey, InstalledSkill[]>
  selectedSkillId: string | null
  scope: SkillScope
  loading: boolean
  refreshing: boolean
  error: string | null

  setScope: (scope: SkillScope) => void
  selectHub: (hubId: HubId) => void
  selectSkill: (id: string | null) => void

  loadHubs: () => Promise<void>
  loadSkills: (hubId: HubId) => Promise<void>
  loadInstalled: (scope: SkillScope) => Promise<void>

  addHub: (args: { repo: string; ref?: string; name?: string }) => Promise<AddHubResult>
  removeHub: (hubId: string) => Promise<RemoveHubResult>
  refreshHub: (hubId: HubId) => Promise<RefreshHubResult>

  install: (
    hubId: HubId,
    skillId: string,
    scope: SkillScope,
    overwrite?: boolean
  ) => Promise<{ success: boolean; error?: string; message?: string }>
  uninstall: (
    skillId: string,
    scope: SkillScope
  ) => Promise<{ success: boolean; error?: string; message?: string }>
}

export const useSkillStore = create<SkillState>((set, get) => ({
  hubs: [],
  selectedHubId: null,
  skillsByHub: {} as Record<HubId, Skill[]>,
  installedByScope: {} as Record<SkillScopeKey, InstalledSkill[]>,
  selectedSkillId: null,
  scope: { kind: 'user' },
  loading: false,
  refreshing: false,
  error: null,

  setScope: (scope) => set({ scope }),
  selectHub: (hubId) => set({ selectedHubId: hubId, selectedSkillId: null }),
  selectSkill: (id) => set({ selectedSkillId: id }),

  loadHubs: async () => {
    set({ loading: true, error: null })
    try {
      const res = await window.skillOps.listHubs()
      if (!res.success) {
        set({ loading: false, error: res.error ?? 'Failed to list hubs' })
        return
      }
      const hubs = res.hubs
      const current = get().selectedHubId
      const stillValid = current && hubs.some((h) => h.id === current)
      // Prefer the default remote hub as initial selection over bundled.
      const initial = hubs.find((h) => h.kind === 'remote' && h.builtin) ?? hubs[0]
      set({
        hubs,
        loading: false,
        selectedHubId: stillValid ? current : (initial?.id ?? null)
      })
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Unknown error' })
    }
  },

  loadSkills: async (hubId) => {
    try {
      const res = await window.skillOps.listSkills(hubId)
      if (!res.success) return
      set((state) => ({
        skillsByHub: { ...state.skillsByHub, [hubId]: res.skills }
      }))
    } catch {
      // non-fatal
    }
  },

  loadInstalled: async (scope) => {
    try {
      const res = await window.skillOps.listInstalled(scope)
      if (!res.success) return
      const key = scopeKey(scope)
      set((state) => ({
        installedByScope: { ...state.installedByScope, [key]: res.skills }
      }))
    } catch {
      // non-fatal
    }
  },

  addHub: async (args) => {
    const res = await window.skillOps.addHub(args)
    if (res.success) {
      await get().loadHubs()
      if (res.hub) {
        get().selectHub(res.hub.id)
        // Auto-refresh so the new hub has content.
        await get().refreshHub(res.hub.id)
      }
    }
    return res
  },

  removeHub: async (hubId) => {
    const res = await window.skillOps.removeHub(hubId)
    if (res.success) {
      await get().loadHubs()
      set((state) => {
        const next = { ...state.skillsByHub }
        delete next[hubId]
        return { skillsByHub: next }
      })
    }
    return res
  },

  refreshHub: async (hubId) => {
    set({ refreshing: true, error: null })
    try {
      const res = await window.skillOps.refreshHub(hubId)
      if (res.success) {
        await get().loadHubs()
        await get().loadSkills(hubId)
      } else {
        set({ error: res.message ?? res.error ?? 'Refresh failed' })
      }
      return res
    } finally {
      set({ refreshing: false })
    }
  },

  install: async (hubId, skillId, scope, overwrite = false) => {
    const res = await window.skillOps.install(hubId, skillId, scope, overwrite)
    if (res.success) {
      await get().loadInstalled(scope)
    }
    return res
  },

  uninstall: async (skillId, scope) => {
    const res = await window.skillOps.uninstall(skillId, scope)
    if (res.success) {
      await get().loadInstalled(scope)
    }
    return res
  }
}))
