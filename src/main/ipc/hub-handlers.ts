/**
 * hub-handlers: IPC surface for the desktop renderer's Hub settings panel.
 *
 * All channels are `hub:*`. They delegate to a HubController instance owned
 * by `src/main/index.ts`. Events pushed back to the renderer:
 *
 *   hub:status-changed        HubStatusSnapshot
 *   hub:confirmation-requested PendingConfirmation
 */

import { ipcMain, type BrowserWindow } from 'electron'
import { createLogger } from '../services/logger'
import type {
  HubController,
  HubStatusSnapshot,
  PendingConfirmation
} from '../services/hub/hub-controller'
import type { HubAuthMode } from '../services/hub/hub-server'
import { genToken, hashToken, tokenPrefix } from '../services/hub/hub-auth'
import { getDatabase } from '../db/database'

const log = createLogger({ component: 'HubHandlers' })

export const HUB_CHANNELS = {
  getStatus: 'hub:getStatus',
  start: 'hub:start',
  stop: 'hub:stop',
  tunnelStart: 'hub:tunnel:start',
  tunnelStop: 'hub:tunnel:stop',
  setAuthMode: 'hub:setAuthMode',
  setCfAccessEmails: 'hub:setCfAccessEmails',
  setRequireDesktopConfirm: 'hub:setRequireDesktopConfirm',
  createUser: 'hub:createUser',
  changePassword: 'hub:changePassword',
  listTokens: 'hub:listTokens',
  createToken: 'hub:createToken',
  revokeToken: 'hub:revokeToken',
  pendingConfirmations: 'hub:pendingConfirmations',
  respondConfirmation: 'hub:respondConfirmation',
  getCfAccessEmails: 'hub:getCfAccessEmails',
  eventStatusChanged: 'hub:status-changed',
  eventConfirmationRequested: 'hub:confirmation-requested'
} as const

export function registerHubHandlers(
  mainWindow: BrowserWindow,
  controller: HubController
): void {
  const send = (channel: string, payload: unknown): void => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }

  controller.on('status', (s: HubStatusSnapshot) => {
    send(HUB_CHANNELS.eventStatusChanged, s)
  })
  controller.on('confirmation', (c: PendingConfirmation) => {
    send(HUB_CHANNELS.eventConfirmationRequested, c)
  })

  ipcMain.handle(HUB_CHANNELS.getStatus, () => controller.getStatus())

  ipcMain.handle(HUB_CHANNELS.start, async () => {
    try {
      await controller.start()
      return { success: true, status: controller.getStatus() }
    } catch (err) {
      log.error('hub:start failed', err instanceof Error ? err : new Error(String(err)))
      return {
        success: false,
        error: err instanceof Error ? err.message : 'start failed'
      }
    }
  })

  ipcMain.handle(HUB_CHANNELS.stop, async () => {
    try {
      await controller.stop()
      return { success: true, status: controller.getStatus() }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'stop failed'
      }
    }
  })

  ipcMain.handle(HUB_CHANNELS.tunnelStart, () => {
    const t = controller.startTunnel()
    return { success: t.state !== 'error', tunnel: t }
  })

  ipcMain.handle(HUB_CHANNELS.tunnelStop, async () => {
    await controller.stopTunnel()
    return { success: true }
  })

  ipcMain.handle(
    HUB_CHANNELS.setAuthMode,
    (_e, mode: HubAuthMode) => {
      controller.setAuthMode(mode)
      return { success: true }
    }
  )

  ipcMain.handle(
    HUB_CHANNELS.setCfAccessEmails,
    (_e, emails: string[]) => {
      controller.setCfAccessEmails(emails)
      return { success: true }
    }
  )

  ipcMain.handle(HUB_CHANNELS.getCfAccessEmails, () => {
    const db = getDatabase().getDb()
    const row = db
      .prepare('SELECT value FROM hub_settings WHERE key = ?')
      .get('cf_access_emails') as { value: string } | undefined
    if (!row) return { emails: [] as string[] }
    try {
      const arr = JSON.parse(row.value)
      return {
        emails: Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
      }
    } catch {
      return { emails: [] as string[] }
    }
  })

  ipcMain.handle(
    HUB_CHANNELS.setRequireDesktopConfirm,
    (_e, value: boolean) => {
      controller.setRequireDesktopConfirm(value)
      return { success: true }
    }
  )

  ipcMain.handle(
    HUB_CHANNELS.createUser,
    async (
      _e,
      args: { setupKey: string; username: string; password: string }
    ) => controller.createInitialAdmin(args)
  )

  ipcMain.handle(
    HUB_CHANNELS.changePassword,
    async (
      _e,
      args: { username: string; oldPassword: string; newPassword: string }
    ) => controller.changePassword(args)
  )

  ipcMain.handle(HUB_CHANNELS.pendingConfirmations, () => ({
    confirmations: controller.pendingConfirmations()
  }))

  ipcMain.handle(
    HUB_CHANNELS.respondConfirmation,
    (_e, args: { confirmId: string; approve: boolean; reason?: string }) => ({
      success: controller.respondConfirmation(args.confirmId, args.approve, args.reason)
    })
  )

  // ── tokens (M2-scoped; implemented now so the UI can hide behind a flag) ──

  ipcMain.handle(HUB_CHANNELS.listTokens, () => {
    const db = getDatabase().getDb()
    const rows = db
      .prepare(
        `SELECT id, name, prefix, created_at as createdAt, last_used as lastUsed,
                last_device_id as lastDeviceId, disabled
           FROM hub_tokens ORDER BY created_at DESC`
      )
      .all() as Array<{
      id: number
      name: string
      prefix: string
      createdAt: number
      lastUsed: number | null
      lastDeviceId: string | null
      disabled: number
    }>
    return {
      tokens: rows.map((r) => ({ ...r, disabled: !!r.disabled }))
    }
  })

  ipcMain.handle(
    HUB_CHANNELS.createToken,
    (_e, args: { name: string }) => {
      const name = (args.name ?? '').trim()
      if (!name) return { success: false, error: 'name required' }
      const db = getDatabase().getDb()
      try {
        const plain = genToken()
        db.prepare(
          'INSERT INTO hub_tokens(name, hash, prefix, created_at) VALUES(?, ?, ?, ?)'
        ).run(name, hashToken(plain), tokenPrefix(plain), Date.now())
        return { success: true, name, token: plain, prefix: tokenPrefix(plain) }
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : 'insert failed'
        }
      }
    }
  )

  ipcMain.handle(
    HUB_CHANNELS.revokeToken,
    (_e, args: { id: number }) => {
      const db = getDatabase().getDb()
      const result = db
        .prepare('UPDATE hub_tokens SET disabled = 1 WHERE id = ?')
        .run(args.id)
      return { success: result.changes > 0 }
    }
  )
}
