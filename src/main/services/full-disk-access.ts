import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { shell } from 'electron'

import { createLogger } from './logger'

const log = createLogger({ component: 'FullDiskAccessService' })

const FULL_DISK_ACCESS_URIS = [
  'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles',
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
]

const FDA_PROBE_PATHS = [
  join(homedir(), 'Library', 'Safari', 'Bookmarks.plist'),
  join(homedir(), 'Library', 'Safari', 'CloudTabs.db'),
  join(
    homedir(),
    'Library',
    'Preferences',
    'com.apple.LaunchServices',
    'com.apple.launchservices.secure.plist'
  )
]

export interface FullDiskAccessStatus {
  supported: boolean
  granted: boolean
}

// In-process cache. The probe reads ~/Library/Safari/Bookmarks.plist and
// CloudTabs.db, which on macOS 14+ surfaces the user-facing
// "<App> wants to access data from other apps" dialog every single time.
// Re-probing on every Settings → Privacy mount caused that popup to spam
// the user. We now cache the result and only re-probe when the renderer
// explicitly asks (force=true), e.g. behind a "Check again" button.
//
// granted=true is sticky for the whole app lifetime — the user can revoke
// in System Settings, but until they do, the answer won't change.
// granted=false stays cached until the user clicks "Check again", at which
// point we re-probe (which will surface the prompt one more time).
let cachedStatus: FullDiskAccessStatus | null = null

function isPermissionDeniedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    message.includes('operation not permitted') ||
    message.includes('permission denied') ||
    message.includes('eacces') ||
    message.includes('eperm')
  )
}

function probeFullDiskAccess(): FullDiskAccessStatus {
  if (process.platform !== 'darwin') {
    return { supported: false, granted: false }
  }

  let denied = false
  let readable = false

  for (const probePath of FDA_PROBE_PATHS) {
    try {
      accessSync(probePath, constants.R_OK)
      readable = true
      break
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        denied = true
        log.info('Full Disk Access probe denied', { probePath })
      } else {
        log.debug('Full Disk Access probe skipped', {
          probePath,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  if (readable) {
    return { supported: true, granted: true }
  }

  if (denied) {
    return { supported: true, granted: false }
  }

  return { supported: true, granted: false }
}

/**
 * Return the Full Disk Access status. Uses a cached result by default to
 * avoid re-prompting the user. Pass `force: true` to bypass the cache —
 * intended only for explicit "Check again" actions in the UI.
 */
export function checkFullDiskAccess(opts: { force?: boolean } = {}): FullDiskAccessStatus {
  if (cachedStatus && !opts.force) {
    return cachedStatus
  }
  cachedStatus = probeFullDiskAccess()
  return cachedStatus
}

export async function openFullDiskAccessSettings(): Promise<{ success: boolean; error?: string }> {
  if (process.platform !== 'darwin') {
    return { success: false, error: 'Full Disk Access settings are only available on macOS' }
  }

  for (const uri of FULL_DISK_ACCESS_URIS) {
    try {
      await shell.openExternal(uri)
      return { success: true }
    } catch (error) {
      log.warn('Failed to open Full Disk Access settings URI', {
        uri,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return {
    success: false,
    error: 'Failed to open macOS Full Disk Access settings'
  }
}
