import { create } from 'zustand'
import type { ModelProfile, ModelProfileCreate, ModelProfileUpdate } from '@shared/types/model-profile'

interface ModelProfileState {
  profiles: ModelProfile[]
  loading: boolean

  loadProfiles: () => Promise<void>
  createProfile: (data: ModelProfileCreate) => Promise<ModelProfile>
  updateProfile: (id: string, data: ModelProfileUpdate) => Promise<void>
  deleteProfile: (id: string) => Promise<void>
  setDefaultProfile: (id: string) => Promise<void>
  getDefaultProfile: () => ModelProfile | undefined
}

export const useModelProfileStore = create<ModelProfileState>()((set, get) => ({
  profiles: [],
  loading: false,

  loadProfiles: async () => {
    set({ loading: true })
    try {
      const profiles = await window.modelProfileOps.list()
      set({ profiles })
    } finally {
      set({ loading: false })
    }
  },

  createProfile: async (data) => {
    const profile = await window.modelProfileOps.create(data)
    await get().loadProfiles()
    return profile
  },

  updateProfile: async (id, data) => {
    await window.modelProfileOps.update(id, data)
    await get().loadProfiles()
  },

  deleteProfile: async (id) => {
    await window.modelProfileOps.delete(id)
    await get().loadProfiles()
  },

  setDefaultProfile: async (id) => {
    await window.modelProfileOps.setDefault(id)
    await get().loadProfiles()
  },

  getDefaultProfile: () => {
    return get().profiles.find((p) => p.is_default)
  }
}))
