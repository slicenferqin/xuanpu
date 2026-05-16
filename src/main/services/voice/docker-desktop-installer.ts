import { net, shell } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'
import { arch } from 'os'
import type { IncomingMessage } from 'http'
import type { VoiceRuntimeProgress } from '@shared/types/voice'
import { getDockerDesktopMacDownloadUrl } from '@shared/lib/voice-docker'
import { createLogger } from '../logger'
import { getVoiceRootDir } from './voice-runtime-store'

const log = createLogger({ component: 'DockerDesktopInstaller' })

interface DownloadResult {
  filePath: string
  reused: boolean
}

export class DockerDesktopInstaller {
  private installerPath(): string {
    const suffix = arch() === 'arm64' ? 'arm64' : 'amd64'
    return join(getVoiceRootDir(), 'installers', `Docker-${suffix}.dmg`)
  }

  async prepareInstaller(onProgress?: (progress: VoiceRuntimeProgress) => void): Promise<string> {
    const result = await this.downloadInstaller(onProgress)
    onProgress?.({
      status: 'docker_installer_ready',
      message: result.reused
        ? 'Docker Desktop installer is ready'
        : 'Docker Desktop installer downloaded',
      detail: result.filePath
    })
    return result.filePath
  }

  async openInstaller(filePath: string): Promise<void> {
    const error = await shell.openPath(filePath)
    if (error) {
      throw new Error(error)
    }
  }

  private async downloadInstaller(
    onProgress?: (progress: VoiceRuntimeProgress) => void
  ): Promise<DownloadResult> {
    const filePath = this.installerPath()
    if (this.isUsableInstaller(filePath)) return { filePath, reused: true }

    mkdirSync(dirname(filePath), { recursive: true })
    const tmpPath = `${filePath}.download`
    if (existsSync(tmpPath)) unlinkSync(tmpPath)

    const url = getDockerDesktopMacDownloadUrl(arch())
    onProgress?.({
      status: 'downloading_docker',
      message: 'Downloading Docker Desktop installer',
      detail: url
    })

    await this.downloadToFile(url, tmpPath, onProgress)
    renameSync(tmpPath, filePath)
    return { filePath, reused: false }
  }

  private isUsableInstaller(filePath: string): boolean {
    if (!existsSync(filePath)) return false
    try {
      return statSync(filePath).size > 100 * 1024 * 1024
    } catch {
      return false
    }
  }

  private async downloadToFile(
    url: string,
    filePath: string,
    onProgress?: (progress: VoiceRuntimeProgress) => void,
    redirects = 0
  ): Promise<void> {
    if (redirects > 5) throw new Error('Too many redirects while downloading Docker Desktop')

    await new Promise<void>((resolve, reject) => {
      const request = net.request({ method: 'GET', url })

      request.on('response', (response: IncomingMessage) => {
        const location = this.headerValue(response.headers.location)
        if (
          response.statusCode &&
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          location
        ) {
          request.abort()
          this.downloadToFile(new URL(location, url).toString(), filePath, onProgress, redirects + 1)
            .then(resolve)
            .catch(reject)
          return
        }

        if (response.statusCode !== 200) {
          request.abort()
          reject(new Error(`Docker Desktop download failed with status ${response.statusCode}`))
          return
        }

        const totalBytes = Number(this.headerValue(response.headers['content-length']) || 0)
        let receivedBytes = 0
        const output = createWriteStream(filePath)

        response.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.byteLength
          if (!totalBytes) return
          onProgress?.({
            status: 'downloading_docker',
            percent: Math.round((receivedBytes / totalBytes) * 100),
            message: 'Downloading Docker Desktop installer',
            detail: `${Math.round(receivedBytes / 1024 / 1024)}MB / ${Math.round(
              totalBytes / 1024 / 1024
            )}MB`
          })
        })

        response.on('error', (error) => {
          output.destroy()
          reject(error)
        })

        output.on('error', reject)
        output.on('finish', () => resolve())
        response.pipe(output)
      })

      request.on('error', (error) => {
        log.warn('Docker Desktop installer download failed', {
          error: error instanceof Error ? error.message : String(error)
        })
        reject(error)
      })

      request.end()
    }).catch((error) => {
      if (existsSync(filePath)) unlinkSync(filePath)
      throw error
    })
  }

  private headerValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value
  }
}
