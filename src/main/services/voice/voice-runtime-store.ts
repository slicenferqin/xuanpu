import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  DEFAULT_DOCKER_FUNASR_HOST_PORT,
  DEFAULT_DOCKER_FUNASR_WS_URL,
  DEFAULT_FUNASR_CONTAINER_NAME,
  DEFAULT_FUNASR_HOST_PORT,
  DEFAULT_FUNASR_IMAGE,
  DEFAULT_FUNASR_WS_URL,
  type VoiceRuntimeProvider,
  type VoiceRuntimeInfo
} from '@shared/types/voice'

export interface StoredVoiceRuntime {
  provider: VoiceRuntimeProvider
  image: string
  containerName: string
  hostPort: number
  wsUrl: string
  installedAt?: number
  lastStartedAt?: number
}

export function getVoiceRootDir(): string {
  return join(app.getPath('home'), '.xuanpu', 'voice')
}

export function getFunAsrRootDir(): string {
  return join(getVoiceRootDir(), 'funasr')
}

export function getFunAsrModelsDir(): string {
  return join(getFunAsrRootDir(), 'models')
}

export function getFunAsrLogsDir(): string {
  return join(getFunAsrRootDir(), 'logs')
}

export function getFunAsrRuntimeDir(): string {
  return join(getFunAsrRootDir(), 'runtime')
}

export function getFunAsrVenvDir(): string {
  return join(getFunAsrRuntimeDir(), 'venv')
}

export function getFunAsrSourceDir(): string {
  return join(getFunAsrRuntimeDir(), 'FunASR')
}

export function getFunAsrServerLogFile(): string {
  return join(getFunAsrLogsDir(), 'managed-runtime.log')
}

export class VoiceRuntimeStore {
  private runtimeFile(): string {
    return join(getFunAsrRootDir(), 'runtime.json')
  }

  ensureDirs(): void {
    mkdirSync(getFunAsrModelsDir(), { recursive: true })
    mkdirSync(getFunAsrLogsDir(), { recursive: true })
    mkdirSync(getFunAsrRuntimeDir(), { recursive: true })
  }

  read(): StoredVoiceRuntime {
    this.ensureDirs()
    const file = this.runtimeFile()
    if (!existsSync(file)) return this.defaultRuntime()

    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<StoredVoiceRuntime>
      return {
        ...this.defaultRuntime(),
        ...parsed,
        provider: parsed.provider || this.defaultRuntime().provider
      }
    } catch {
      return this.defaultRuntime()
    }
  }

  write(runtime: StoredVoiceRuntime): void {
    this.ensureDirs()
    const file = this.runtimeFile()
    const tmp = `${file}.tmp`
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(runtime, null, 2))
    renameSync(tmp, file)
  }

  update(patch: Partial<StoredVoiceRuntime>): StoredVoiceRuntime {
    const next = { ...this.read(), ...patch }
    this.write(next)
    return next
  }

  toInfo(runtime: StoredVoiceRuntime, patch: Partial<VoiceRuntimeInfo> = {}): VoiceRuntimeInfo {
    return {
      provider: runtime.provider,
      status: 'idle',
      wsUrl: runtime.wsUrl,
      image: runtime.image,
      containerName: runtime.containerName,
      hostPort: runtime.hostPort,
      ...patch
    }
  }

  private defaultRuntime(): StoredVoiceRuntime {
    return {
      provider: 'managed',
      image: DEFAULT_FUNASR_IMAGE,
      containerName: DEFAULT_FUNASR_CONTAINER_NAME,
      hostPort: DEFAULT_FUNASR_HOST_PORT,
      wsUrl: DEFAULT_FUNASR_WS_URL
    }
  }

  static defaultRuntimeForProvider(provider: VoiceRuntimeProvider): StoredVoiceRuntime {
    const base: StoredVoiceRuntime = {
      provider,
      image: DEFAULT_FUNASR_IMAGE,
      containerName: DEFAULT_FUNASR_CONTAINER_NAME,
      hostPort: DEFAULT_FUNASR_HOST_PORT,
      wsUrl: DEFAULT_FUNASR_WS_URL
    }

    if (provider === 'docker') {
      return {
        ...base,
        hostPort: DEFAULT_DOCKER_FUNASR_HOST_PORT,
        wsUrl: DEFAULT_DOCKER_FUNASR_WS_URL
      }
    }

    return base
  }
}
