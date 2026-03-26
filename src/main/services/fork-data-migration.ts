import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { getAppHomeDir } from '@shared/app-identity'

export interface ForkDataDirResult {
  created: boolean
  targetPath: string
}

export function ensureForkDataDir(): ForkDataDirResult {
  const targetPath = getAppHomeDir()

  if (existsSync(targetPath)) {
    return {
      created: false,
      targetPath
    }
  }

  mkdirSync(dirname(targetPath), { recursive: true })
  mkdirSync(targetPath, { recursive: true })

  return {
    created: true,
    targetPath
  }
}
