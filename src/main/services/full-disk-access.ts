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

function isPermissionDeniedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  return (
    message.includes('operation not permitted') ||
    message.includes('permission denied') ||
    message.includes('eacces') ||
    message.includes('eperm')
  )
}

export function checkFullDiskAccess(): FullDiskAccessStatus {
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
