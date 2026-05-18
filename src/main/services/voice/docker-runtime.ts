import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { platform } from 'os'
import { createLogger } from '../logger'
import type { VoiceRuntimeProgress } from '@shared/types/voice'
import { buildFunAsrStartCommand } from '@shared/lib/voice-docker'

const log = createLogger({ component: 'VoiceDockerRuntime' })

interface RunResult {
  stdout: string
  stderr: string
  code: number
}

interface RunOptions {
  timeoutMs?: number
  onOutput?: (chunk: string) => void
}

export interface DockerContainerConfig {
  image: string
  hostPort: number | null
}

export class DockerRuntime {
  private runDocker(args: string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer =
        options.timeoutMs && options.timeoutMs > 0
          ? setTimeout(() => {
              if (settled) return
              settled = true
              child.kill('SIGTERM')
              reject(new Error(`docker ${args.join(' ')} timed out`))
            }, options.timeoutMs)
          : null

      child.stdout.on('data', (data: Buffer) => {
        const text = data.toString()
        stdout += text
        options.onOutput?.(text)
      })

      child.stderr.on('data', (data: Buffer) => {
        const text = data.toString()
        stderr += text
        options.onOutput?.(text)
      })

      child.on('error', (error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        reject(error)
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve({ stdout, stderr, code: code ?? 1 })
      })
    })
  }

  async isDockerInstalled(): Promise<boolean> {
    if (platform() === 'darwin' && existsSync('/Applications/Docker.app')) return true

    try {
      const result = await this.runDocker(['--version'], { timeoutMs: 5000 })
      return result.code === 0
    } catch {
      return false
    }
  }

  async isDockerDaemonReady(): Promise<boolean> {
    try {
      const result = await this.runDocker(['info'], { timeoutMs: 8000 })
      return result.code === 0
    } catch {
      return false
    }
  }

  async openDockerDesktop(): Promise<boolean> {
    if (platform() !== 'darwin' || !existsSync('/Applications/Docker.app')) return false

    try {
      spawn('open', ['-a', 'Docker'], { detached: true, stdio: 'ignore' })
      return true
    } catch (error) {
      log.warn('Failed to open Docker Desktop', {
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    }
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      const result = await this.runDocker(['image', 'inspect', image], { timeoutMs: 10000 })
      return result.code === 0
    } catch {
      return false
    }
  }

  async pullImage(
    image: string,
    onProgress?: (progress: VoiceRuntimeProgress) => void
  ): Promise<void> {
    onProgress?.({
      status: 'pulling_image',
      message: 'Downloading FunASR runtime image',
      detail: image
    })

    const result = await this.runDocker(['pull', image], {
      timeoutMs: 30 * 60 * 1000,
      onOutput: (chunk) => {
        const line = chunk
          .split(/\r?\n/)
          .map((item) => item.trim())
          .filter(Boolean)
          .at(-1)
        if (!line) return
        onProgress?.({
          status: 'pulling_image',
          message: 'Downloading FunASR runtime image',
          detail: line
        })
      }
    })

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `docker pull failed`)
    }
  }

  async containerExists(name: string): Promise<boolean> {
    try {
      const result = await this.runDocker(['container', 'inspect', name], { timeoutMs: 10000 })
      return result.code === 0
    } catch {
      return false
    }
  }

  async isContainerRunning(name: string): Promise<boolean> {
    try {
      const result = await this.runDocker(['inspect', '-f', '{{.State.Running}}', name], {
        timeoutMs: 10000
      })
      return result.code === 0 && result.stdout.trim() === 'true'
    } catch {
      return false
    }
  }

  async getContainerConfig(name: string): Promise<DockerContainerConfig | null> {
    try {
      const result = await this.runDocker(['inspect', name], { timeoutMs: 10000 })
      if (result.code !== 0) return null
      const parsed = JSON.parse(result.stdout) as Array<{
        Config?: { Image?: string }
        HostConfig?: { PortBindings?: Record<string, Array<{ HostPort?: string }> | undefined> }
      }>
      const first = parsed[0]
      const portBindings = first?.HostConfig?.PortBindings ?? {}
      const binding = portBindings['10095/tcp']?.[0]
      return {
        image: first?.Config?.Image ?? '',
        hostPort: binding?.HostPort ? Number(binding.HostPort) : null
      }
    } catch {
      return null
    }
  }

  async removeContainer(name: string): Promise<void> {
    const result = await this.runDocker(['rm', '-f', name], { timeoutMs: 60000 })
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'docker rm failed')
    }
  }

  async createContainer(input: {
    name: string
    image: string
    hostPort: number
    containerPort: number
    modelsDir: string
  }): Promise<void> {
    const startCommand = buildFunAsrStartCommand(input.containerPort)

    const args = [
      'create',
      '--name',
      input.name,
      '-p',
      `${input.hostPort}:${input.containerPort}`,
      '-v',
      `${input.modelsDir}:/workspace/models`,
      input.image,
      'bash',
      '-lc',
      startCommand
    ]

    const result = await this.runDocker(args, { timeoutMs: 60000 })
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'docker create failed')
    }
  }

  async startContainer(name: string): Promise<void> {
    const result = await this.runDocker(['start', name], { timeoutMs: 60000 })
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'docker start failed')
    }
  }

  async stopContainer(name: string): Promise<void> {
    const result = await this.runDocker(['stop', name], { timeoutMs: 60000 })
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'docker stop failed')
    }
  }

  async logs(name: string, tail = 200): Promise<string> {
    try {
      const result = await this.runDocker(['logs', '--tail', String(tail), name], {
        timeoutMs: 10000
      })
      return `${result.stdout}${result.stderr}`.trim()
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
}
