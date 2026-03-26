import { existsSync, cpSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { getAppHomeDir, getLegacyAppHomeDir } from '@shared/app-identity'

export interface ForkDataMigrationResult {
  copied: boolean
  sourcePath: string
  targetPath: string
}

export function bootstrapForkDataDir(): ForkDataMigrationResult {
  const sourcePath = getLegacyAppHomeDir()
  const targetPath = getAppHomeDir()

  if (!existsSync(sourcePath) || existsSync(targetPath)) {
    return {
      copied: false,
      sourcePath,
      targetPath
    }
  }

  mkdirSync(dirname(targetPath), { recursive: true })
  cpSync(sourcePath, targetPath, { recursive: true })

  return {
    copied: true,
    sourcePath,
    targetPath
  }
}
