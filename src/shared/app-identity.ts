import { homedir } from 'node:os'
import { join } from 'node:path'

export const APP_PRODUCT_NAME = 'Hive CN'
export const APP_BUNDLE_ID = 'com.slicenfer.hivecn'
export const APP_AUTO_UPDATES_ENABLED = false

export const APP_HOME_DIRNAME = '.hive-cn'
export const LEGACY_HOME_DIRNAME = '.hive'

export const APP_WORKTREES_DIRNAME = '.hive-cn-worktrees'
export const LEGACY_WORKTREES_DIRNAME = '.hive-worktrees'

export function getAppHomeDir(homeDir: string = homedir()): string {
  return join(homeDir, APP_HOME_DIRNAME)
}

export function getLegacyAppHomeDir(homeDir: string = homedir()): string {
  return join(homeDir, LEGACY_HOME_DIRNAME)
}

export function getAppWorktreesBaseDir(homeDir: string = homedir()): string {
  return join(homeDir, APP_WORKTREES_DIRNAME)
}

export function getLegacyWorktreesBaseDir(homeDir: string = homedir()): string {
  return join(homeDir, LEGACY_WORKTREES_DIRNAME)
}
