import { create } from 'zustand'
import { api } from '../api/client'

export interface HubDevice {
  id: string
  name: string
  hostname: string
  online: boolean
  lastSeen: number
}

export interface HubSessionListItem {
  hiveSessionId: string
  name: string | null
  status: string
  updatedAt: string
  worktree: { id: string; name: string | null; path: string | null } | null
  project: { id: string; name: string }
  runtimeStatus: 'idle' | 'busy' | 'retry' | 'error'
}

interface SessionsState {
  devices: HubDevice[]
  loadingDevices: boolean
  devicesError: string | null
  /** Per-device session lists. Keyed by deviceId. */
  byDevice: Record<string, HubSessionListItem[]>
  loadingSessionsFor: string | null
  sessionsErrorFor: Record<string, string | null>
  refreshDevices: () => Promise<void>
  refreshSessions: (deviceId: string) => Promise<void>
}

export const useSessions = create<SessionsState>((set) => ({
  devices: [],
  loadingDevices: false,
  devicesError: null,
  byDevice: {},
  loadingSessionsFor: null,
  sessionsErrorFor: {},

  refreshDevices: async () => {
    set({ loadingDevices: true, devicesError: null })
    try {
      const { devices } = await api<{ devices: HubDevice[] }>('/api/devices')
      set({ devices })
    } catch (err) {
      set({ devicesError: err instanceof Error ? err.message : String(err) })
    } finally {
      set({ loadingDevices: false })
    }
  },

  refreshSessions: async (deviceId) => {
    set((s) => ({
      loadingSessionsFor: deviceId,
      sessionsErrorFor: { ...s.sessionsErrorFor, [deviceId]: null }
    }))
    try {
      const { sessions } = await api<{
        device: HubDevice
        sessions: HubSessionListItem[]
      }>(`/api/devices/${encodeURIComponent(deviceId)}/sessions`)
      set((s) => ({ byDevice: { ...s.byDevice, [deviceId]: sessions } }))
    } catch (err) {
      set((s) => ({
        sessionsErrorFor: {
          ...s.sessionsErrorFor,
          [deviceId]: err instanceof Error ? err.message : String(err)
        }
      }))
    } finally {
      set({ loadingSessionsFor: null })
    }
  }
}))
