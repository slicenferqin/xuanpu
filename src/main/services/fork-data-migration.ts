import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getActiveAppHomeDir, getAppHomeDir } from '@shared/app-identity'

export interface ForkDataDirResult {
  created: boolean
  targetPath: string
  activePath: string
  usingLegacyPath: boolean
}

export function ensureForkDataDir(): ForkDataDirResult {
  const targetPath = getAppHomeDir()
  const activePath = getActiveAppHomeDir()

  if (existsSync(activePath)) {
    return {
      created: false,
      targetPath,
      activePath,
      usingLegacyPath: activePath !== targetPath
    }
  }

  mkdirSync(dirname(targetPath), { recursive: true })
  mkdirSync(targetPath, { recursive: true })

  return {
    created: true,
    targetPath,
    activePath: targetPath,
    usingLegacyPath: false
  }
}
