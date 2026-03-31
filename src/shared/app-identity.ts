import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const APP_PRODUCT_NAME = '玄圃'
export const APP_BUNDLE_ID = 'com.slicenfer.xuanpu'
export const APP_AUTO_UPDATES_ENABLED = true
export const APP_CLI_NAME = 'xuanpu-server'
export const APP_DATABASE_FILENAME = 'xuanpu.db'
export const LEGACY_DATABASE_FILENAMES = ['hive.db']

export const APP_HOME_DIRNAME = '.xuanpu'
export const LEGACY_HOME_DIRNAMES = ['.hive-cn', '.hive']

export const APP_WORKTREES_DIRNAME = '.xuanpu-worktrees'
export const LEGACY_WORKTREES_DIRNAMES = ['.hive-cn-worktrees', '.hive-worktrees']

export function getAppHomeDir(homeDir: string = homedir()): string {
  return join(homeDir, APP_HOME_DIRNAME)
}

export function getLegacyAppHomeDirs(homeDir: string = homedir()): string[] {
  return LEGACY_HOME_DIRNAMES.map((dir) => join(homeDir, dir))
}

export function getActiveAppHomeDir(homeDir: string = homedir()): string {
  const primaryPath = getAppHomeDir(homeDir)
  // Always use the primary (new) path for creating files/directories.
  // Legacy paths are only used for one-time database migration.
  return primaryPath
}

export function getAppDatabasePath(homeDir: string = homedir()): string {
  return join(getAppHomeDir(homeDir), APP_DATABASE_FILENAME)
}

export function getLegacyAppDatabasePaths(homeDir: string = homedir()): string[] {
  return getLegacyAppHomeDirs(homeDir).flatMap((dir) =>
    LEGACY_DATABASE_FILENAMES.map((filename) => join(dir, filename))
  )
}

export function getActiveAppDatabasePath(homeDir: string = homedir()): string {
  const primaryPath = getAppDatabasePath(homeDir)
  if (existsSync(primaryPath)) return primaryPath

  return getLegacyAppDatabasePaths(homeDir).find((path) => existsSync(path)) ?? primaryPath
}

export function getAppWorktreesBaseDir(homeDir: string = homedir()): string {
  return join(homeDir, APP_WORKTREES_DIRNAME)
}

export function getLegacyWorktreesBaseDirs(homeDir: string = homedir()): string[] {
  return LEGACY_WORKTREES_DIRNAMES.map((dir) => join(homeDir, dir))
}

export function getActiveWorktreesBaseDir(homeDir: string = homedir()): string {
  // Always use the primary (new) path for creating worktrees.
  // Existing worktrees in legacy dirs are referenced by full path in the DB.
  return getAppWorktreesBaseDir(homeDir)
}
