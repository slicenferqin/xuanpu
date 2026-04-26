/**
 * useHubStore: renderer-side mirror of the Hub controller.
 *
 * Status comes from IPC events (`hub:status-changed`) pushed by the main
 * process. Actions proxy through `window.hubOps`.
 *
 * The store is **not** persisted — status is ephemeral; the main process is
 * source of truth and resends snapshots on reconnect / refresh via
 * `refresh()`.
 */

import { create } from 'zustand'
import { toast } from '@/lib/toast'

const DEFAULT_STATUS: HubStatusSnapshot = {
  enabled: false,
  port: null,
  host: null,
  authMode: 'password',
  tunnel: { state: 'stopped' },
  hasAdmin: false,
  setupKey: null
}

interface HubStoreState {
  /** Last known snapshot from main. */
  status: HubStatusSnapshot
  cfAccessEmails: string[]
  /** True while any action is in-flight (hides double-clicks). */
  loading: boolean

  /** Pull latest from main and subscribe to push updates. Idempotent. */
  init: () => Promise<() => void>
  refresh: () => Promise<void>
  refreshCfAccessEmails: () => Promise<void>

  start: () => Promise<boolean>
  stop: () => Promise<boolean>
  startTunnel: () => Promise<boolean>
  stopTunnel: () => Promise<boolean>
  setAuthMode: (mode: HubAuthMode) => Promise<boolean>
  setCfAccessEmails: (emails: string[]) => Promise<boolean>
  createUser: (args: {
    setupKey: string
    username: string
    password: string
  }) => Promise<{ success: boolean; error?: string }>
  changePassword: (args: {
    username: string
    oldPassword: string
    newPassword: string
  }) => Promise<{ success: boolean; error?: string }>
}

export const useHubStore = create<HubStoreState>((set, get) => {
  let initialized = false
  let unsubscribers: Array<() => void> = []

  const wrap = async <T>(
    fn: () => Promise<T>,
    errLabel: string
  ): Promise<T | null> => {
    set({ loading: true })
    try {
      return await fn()
    } catch (err) {
      toast.error(`${errLabel}: ${err instanceof Error ? err.message : String(err)}`)
      return null
    } finally {
      set({ loading: false })
    }
  }

  return {
    status: DEFAULT_STATUS,
    cfAccessEmails: [],
    loading: false,

    init: async () => {
      if (initialized) {
        return () => {
          /* already subscribed — no-op cleanup returned to satisfy signature */
        }
      }
      initialized = true

      const statusUnsub = window.hubOps.onStatusChanged((status) => {
        set({ status })
      })
      unsubscribers.push(statusUnsub)

      await Promise.all([get().refresh(), get().refreshCfAccessEmails()])

      return () => {
        for (const u of unsubscribers) u()
        unsubscribers = []
        initialized = false
      }
    },

    refresh: async () => {
      const status = await window.hubOps.getStatus()
      set({ status })
    },

    refreshCfAccessEmails: async () => {
      const { emails } = await window.hubOps.getCfAccessEmails()
      set({ cfAccessEmails: emails })
    },

    start: async () => {
      const result = await wrap(() => window.hubOps.start(), '启动 Hub 失败')
      if (!result) return false
      if (!result.success) {
        toast.error(result.error ?? '启动失败')
        return false
      }
      if (result.status) set({ status: result.status })
      return true
    },

    stop: async () => {
      const result = await wrap(() => window.hubOps.stop(), '停止 Hub 失败')
      if (!result) return false
      if (!result.success) {
        toast.error(result.error ?? '停止失败')
        return false
      }
      if (result.status) set({ status: result.status })
      return true
    },

    startTunnel: async () => {
      const result = await wrap(() => window.hubOps.startTunnel(), '开启公网访问失败')
      if (!result) return false
      if (!result.success) {
        const msg =
          result.tunnel.state === 'error' ? result.tunnel.message : '开启失败'
        toast.error(msg)
        return false
      }
      set((s) => ({ status: { ...s.status, tunnel: result.tunnel } }))
      return true
    },

    stopTunnel: async () => {
      const result = await wrap(() => window.hubOps.stopTunnel(), '停止公网访问失败')
      return !!result?.success
    },

    setAuthMode: async (mode) => {
      const result = await wrap(() => window.hubOps.setAuthMode(mode), '切换鉴权模式失败')
      if (!result?.success) return false
      set((s) => ({ status: { ...s.status, authMode: mode } }))
      return true
    },

    setCfAccessEmails: async (emails) => {
      const result = await wrap(
        () => window.hubOps.setCfAccessEmails(emails),
        '保存邮箱白名单失败'
      )
      if (!result?.success) return false
      set({ cfAccessEmails: emails })
      return true
    },

    createUser: async (args) => {
      const result = await wrap(() => window.hubOps.createUser(args), '创建管理员失败')
      if (!result) return { success: false, error: 'ipc error' }
      if (result.success) {
        await get().refresh()
        toast.success('管理员已创建')
      } else {
        toast.error(result.error ?? '创建失败')
      }
      return result
    },

    changePassword: async (args) => {
      const result = await wrap(() => window.hubOps.changePassword(args), '修改密码失败')
      if (!result) return { success: false, error: 'ipc error' }
      if (result.success) toast.success('密码已更新')
      else toast.error(result.error ?? '修改失败')
      return result
    }
  }
})
