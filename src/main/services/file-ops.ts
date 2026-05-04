import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'
import { app } from 'electron'
import { getImageMimeType } from '@shared/types/file-utils'

const MAX_FILE_SIZE = 1024 * 1024 // 1MB
const MAX_ARCHIVE_SIZE = 50 * 1024 * 1024 // 50MB for Token Saver archives
const ARCHIVE_ROOT = resolve(join(homedir(), '.xuanpu', 'archive'))

export function readFile(filePath: string): {
  success: boolean
  content?: string
  error?: string
} {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'Invalid file path' }
    }
    if (!existsSync(filePath)) {
      return { success: false, error: 'File does not exist' }
    }
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
      return { success: false, error: 'Path is a directory' }
    }
    if (stat.size > MAX_FILE_SIZE) {
      return { success: false, error: 'File too large (max 1MB)' }
    }
    const content = readFileSync(filePath, 'utf-8')
    return { success: true, content }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

/**
 * Read a Token Saver archive file. Behaves like `readFile` but:
 *   - Only permits paths resolving under `~/.xuanpu/archive` (path whitelist)
 *   - Allows up to 50MB (archives can be large — full command output)
 * The path whitelist prevents a compromised renderer from reading arbitrary
 * files via this channel while keeping the expand-original UX working.
 */
export function readArchiveFile(filePath: string): {
  success: boolean
  content?: string
  error?: string
} {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'Invalid file path' }
    }
    const absolute = resolve(filePath)
    if (!absolute.startsWith(ARCHIVE_ROOT + '/') && absolute !== ARCHIVE_ROOT) {
      return { success: false, error: 'Path is outside the archive root' }
    }
    if (!existsSync(absolute)) {
      return { success: false, error: 'Archive file does not exist' }
    }
    const stat = statSync(absolute)
    if (stat.isDirectory()) {
      return { success: false, error: 'Path is a directory' }
    }
    if (stat.size > MAX_ARCHIVE_SIZE) {
      return { success: false, error: 'Archive too large (max 50MB)' }
    }
    const content = readFileSync(absolute, 'utf-8')
    return { success: true, content }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export function readFileAsBase64(filePath: string): {
  success: boolean
  data?: string
  mimeType?: string
  error?: string
} {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'Invalid file path' }
    }
    if (!existsSync(filePath)) {
      return { success: false, error: 'File does not exist' }
    }
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
      return { success: false, error: 'Path is a directory' }
    }
    if (stat.size > MAX_FILE_SIZE) {
      return { success: false, error: 'File too large (max 1MB)' }
    }
    const buffer = readFileSync(filePath)
    const data = buffer.toString('base64')
    const mimeType = getImageMimeType(filePath) ?? undefined
    return { success: true, data, mimeType }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export function readPromptFile(promptName: string): {
  success: boolean
  content?: string
  error?: string
} {
  try {
    if (!promptName || typeof promptName !== 'string') {
      return { success: false, error: 'Invalid prompt name' }
    }
    const appPath = app.getAppPath()
    let promptPath = join(appPath, 'prompts', promptName)
    if (!existsSync(promptPath)) {
      const resourcesPath = join(appPath, '..', 'prompts', promptName)
      if (existsSync(resourcesPath)) {
        promptPath = resourcesPath
      } else {
        return { success: false, error: 'Prompt file not found' }
      }
    }
    const content = readFileSync(promptPath, 'utf-8')
    return { success: true, content }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export function writeFile(filePath: string, content: string): { success: boolean; error?: string } {
  try {
    if (!filePath || typeof filePath !== 'string') {
      return { success: false, error: 'Invalid file path' }
    }
    if (typeof content !== 'string') {
      return { success: false, error: 'Invalid content' }
    }
    if (existsSync(filePath)) {
      const stat = statSync(filePath)
      if (stat.isDirectory()) {
        return { success: false, error: 'Path is a directory' }
      }
    } else {
      const parentDir = dirname(filePath)
      if (!existsSync(parentDir)) {
        return { success: false, error: 'Parent directory does not exist' }
      }

      const parentStat = statSync(parentDir)
      if (!parentStat.isDirectory()) {
        return { success: false, error: 'Parent path is not a directory' }
      }
    }

    writeFileSync(filePath, content, 'utf-8')
    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}
