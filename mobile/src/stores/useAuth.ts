import { create } from 'zustand'
import { api, ApiError, onAuthError } from '../api/client'

interface MeResponse {
  via: 'cookie' | 'cf_access'
  username: string | null
  email: string | null
}

interface AuthState {
  authed: boolean
  username: string | null
  via: 'cookie' | 'cf_access' | null
  /** True until the first /api/me roundtrip resolves. */
  checking: boolean
  error: string | null
  refresh: () => Promise<void>
  login: (username: string, password: string) => Promise<boolean>
  logout: () => Promise<void>
}

let bouncerInstalled = false

export const useAuth = create<AuthState>((set) => {
  if (!bouncerInstalled) {
    bouncerInstalled = true
    onAuthError(() => {
      set({ authed: false, username: null, via: null })
    })
  }
  return {
    authed: false,
    username: null,
    via: null,
    checking: true,
    error: null,

    refresh: async () => {
      try {
        const me = await api<MeResponse>('/api/me')
        set({ authed: true, username: me.username, via: me.via, checking: false, error: null })
      } catch {
        set({ authed: false, username: null, via: null, checking: false })
      }
    },

    login: async (username, password) => {
      try {
        await api('/api/login', {
          method: 'POST',
          body: { username, password }
        })
        set({ authed: true, username, via: 'cookie', error: null })
        return true
      } catch (err) {
        const msg =
          err instanceof ApiError ? err.message : err instanceof Error ? err.message : '登录失败'
        set({ error: msg })
        return false
      }
    },

    logout: async () => {
      try {
        await api('/api/logout', { method: 'POST' })
      } catch {
        /* ignore */
      }
      set({ authed: false, username: null, via: null })
    }
  }
})
