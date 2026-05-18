import { BrowserWindow, systemPreferences } from 'electron'
import {
  DEFAULT_FUNASR_WS_URL,
  DEFAULT_FUNASR_CONTAINER_PORT,
  type VoiceInputSettings,
  type VoicePermissionStatus,
  type VoiceRuntimeConfig,
  type VoiceRuntimeInfo,
  type VoiceRuntimeProgress
} from '@shared/types/voice'
import { createLogger } from '../logger'
import { DockerRuntime } from './docker-runtime'
import { DockerDesktopInstaller } from './docker-desktop-installer'
import { getFunAsrModelsDir, VoiceRuntimeStore } from './voice-runtime-store'
import { FunAsrClient } from './funasr-client'
import { ManagedFunAsrRuntime } from './managed-funasr-runtime'

const log = createLogger({ component: 'VoiceRuntimeManager' })

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class VoiceRuntimeManager {
  readonly funasr = new FunAsrClient()
  private docker = new DockerRuntime()
  private dockerInstaller = new DockerDesktopInstaller()
  private managedRuntime = new ManagedFunAsrRuntime()
  private store = new VoiceRuntimeStore()
  private mainWindow: BrowserWindow | null = null

  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  getMicrophonePermissionStatus(): VoicePermissionStatus {
    if (process.platform !== 'darwin') return 'unknown'
    return systemPreferences.getMediaAccessStatus('microphone') as VoicePermissionStatus
  }

  async requestMicrophonePermission(): Promise<VoicePermissionStatus> {
    if (process.platform !== 'darwin') return 'unknown'
    await systemPreferences.askForMediaAccess('microphone')
    return this.getMicrophonePermissionStatus()
  }

  async detect(config?: VoiceRuntimeConfig): Promise<VoiceRuntimeInfo> {
    const runtime = this.applyConfig(config)
    const ready = await this.funasr.healthCheck(runtime.wsUrl, 2500)
    if (ready) {
      return this.store.toInfo(runtime, {
        status: 'ready',
        message: 'FunASR runtime is ready'
      })
    }

    if (runtime.provider === 'external') {
      return this.store.toInfo(runtime, {
        status: 'error',
        message: 'External FunASR WebSocket is not reachable',
        error: runtime.wsUrl
      })
    }

    if (runtime.provider === 'managed') {
      return this.store.toInfo(runtime, await this.managedRuntime.detect(runtime))
    }

    return this.detectDocker(runtime)
  }

  async ensureReady(config?: VoiceRuntimeConfig): Promise<VoiceRuntimeInfo> {
    const runtime = this.applyConfig(config)
    this.emitProgress({ status: 'checking', message: 'Checking FunASR runtime' })

    let info = await this.detect(config)
    if (info.status === 'ready') return info

    if (runtime.provider === 'external') return info

    if (runtime.provider === 'managed') {
      try {
        await this.managedRuntime.prepare(runtime, (progress) => this.emitProgress(progress))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('Managed FunASR runtime preparation failed', { error: message })
        return this.store.toInfo(runtime, {
          status: 'error',
          message: 'Failed to prepare local FunASR runtime',
          error: message
        })
      }

      const ready = await this.waitForFunAsr(runtime.wsUrl, 180000)
      if (!ready) {
        const logs = await this.managedRuntime.getLogs()
        log.warn('Managed FunASR runtime did not become ready', { logs })
        return this.store.toInfo(runtime, {
          status: 'error',
          message: 'Local FunASR runtime did not become ready in time',
          error: logs || 'Timeout waiting for WebSocket service'
        })
      }

      info = this.store.toInfo(runtime, {
        status: 'ready',
        message: 'Local FunASR runtime is ready'
      })
      this.store.update({
        provider: runtime.provider,
        lastStartedAt: Date.now(),
        installedAt: runtime.installedAt ?? Date.now()
      })
      this.emitProgress({ status: 'ready', message: 'Local FunASR runtime is ready' })
      return info
    }

    return this.ensureDockerReady(runtime, info)
  }

  private async detectDocker(
    runtime: ReturnType<VoiceRuntimeStore['read']>
  ): Promise<VoiceRuntimeInfo> {
    const dockerInstalled = await this.docker.isDockerInstalled()
    if (!dockerInstalled) {
      return this.store.toInfo(runtime, {
        status: 'docker_missing',
        message: 'Docker is required to run the Docker FunASR runtime'
      })
    }

    const daemonReady = await this.docker.isDockerDaemonReady()
    if (!daemonReady) {
      return this.store.toInfo(runtime, {
        status: 'docker_stopped',
        message: 'Docker is installed but not running'
      })
    }

    const imageExists = await this.docker.imageExists(runtime.image)
    if (!imageExists) {
      return this.store.toInfo(runtime, {
        status: 'image_missing',
        message: 'FunASR runtime image is not installed'
      })
    }

    const exists = await this.docker.containerExists(runtime.containerName)
    if (!exists) {
      return this.store.toInfo(runtime, {
        status: 'creating_container',
        message: 'FunASR container has not been created'
      })
    }

    const running = await this.docker.isContainerRunning(runtime.containerName)
    return this.store.toInfo(runtime, {
      status: running ? 'warming_up' : 'starting_container',
      message: running ? 'FunASR container is starting up' : 'FunASR container is stopped'
    })
  }

  private async ensureDockerReady(
    runtime: ReturnType<VoiceRuntimeStore['read']>,
    currentInfo: VoiceRuntimeInfo
  ): Promise<VoiceRuntimeInfo> {
    let info = currentInfo
    if (info.status === 'docker_missing') {
      if (process.platform !== 'darwin') return info
      return this.prepareDockerDesktopInstaller(runtime)
    }

    if (info.status === 'docker_stopped') {
      this.emitProgress({ status: 'docker_stopped', message: 'Starting Docker Desktop' })
      const opened = await this.docker.openDockerDesktop()
      if (!opened && process.platform === 'darwin') {
        return this.prepareDockerDesktopInstaller(runtime)
      }
      const daemonReady = await this.waitForDockerDaemon(90000)
      if (!daemonReady) return info
    }

    if (!(await this.docker.imageExists(runtime.image))) {
      await this.docker.pullImage(runtime.image, (progress) => this.emitProgress(progress))
    }

    const containerExists = await this.docker.containerExists(runtime.containerName)
    if (containerExists && !(await this.isContainerCurrent(runtime))) {
      this.emitProgress({
        status: 'creating_container',
        message: 'Recreating FunASR runtime container for updated settings'
      })
      await this.docker.removeContainer(runtime.containerName)
    }

    if (!(await this.docker.containerExists(runtime.containerName))) {
      this.emitProgress({
        status: 'creating_container',
        message: 'Creating FunASR runtime container'
      })
      await this.docker.createContainer({
        name: runtime.containerName,
        image: runtime.image,
        hostPort: runtime.hostPort,
        containerPort: DEFAULT_FUNASR_CONTAINER_PORT,
        modelsDir: getFunAsrModelsDir()
      })
    }

    if (!(await this.docker.isContainerRunning(runtime.containerName))) {
      this.emitProgress({
        status: 'starting_container',
        message: 'Starting FunASR runtime container'
      })
      await this.docker.startContainer(runtime.containerName)
      this.store.update({
        lastStartedAt: Date.now(),
        installedAt: runtime.installedAt ?? Date.now()
      })
    }

    this.emitProgress({
      status: 'downloading_models',
      message: 'Waiting for FunASR models and WebSocket service'
    })

    const ready = await this.waitForFunAsr(runtime.wsUrl, 180000)
    if (!ready) {
      const logs = await this.docker.logs(runtime.containerName, 120)
      log.warn('FunASR runtime did not become ready', { logs })
      return this.store.toInfo(runtime, {
        status: 'error',
        message: 'FunASR runtime did not become ready in time',
        error: logs || 'Timeout waiting for WebSocket service'
      })
    }

    info = this.store.toInfo(runtime, {
      status: 'ready',
      message: 'FunASR runtime is ready'
    })
    this.emitProgress({ status: 'ready', message: 'FunASR runtime is ready' })
    return info
  }

  async stopRuntime(): Promise<void> {
    const runtime = this.store.read()
    this.emitProgress({ status: 'stopping_runtime', message: 'Stopping FunASR runtime' })
    if (runtime.provider === 'managed') {
      await this.managedRuntime.stop(runtime)
      return
    }
    if (runtime.provider === 'docker') {
      await this.docker.stopContainer(runtime.containerName)
    }
  }

  async shutdown(): Promise<void> {
    this.funasr.disconnectAll()
    const runtime = this.store.read()
    try {
      await this.managedRuntime.stop(runtime)
    } catch (error) {
      log.warn('Failed to stop managed FunASR runtime during shutdown', {
        error: error instanceof Error ? error.message : String(error)
      })
    }

    if (runtime.provider === 'docker') {
      try {
        await this.docker.stopContainer(runtime.containerName)
      } catch (error) {
        log.warn('Failed to stop Docker FunASR runtime during shutdown', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  async getLogs(): Promise<{ installLog?: string; serverLog?: string }> {
    const runtime = this.store.read()
    const serverLog =
      runtime.provider === 'docker'
        ? await this.docker.logs(runtime.containerName, 240)
        : await this.managedRuntime.getLogs()
    return {
      installLog: runtime.provider === 'managed' ? serverLog : undefined,
      serverLog
    }
  }

  private async waitForDockerDaemon(timeoutMs: number): Promise<boolean> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (await this.docker.isDockerDaemonReady()) return true
      await sleep(2500)
    }
    return false
  }

  private async waitForFunAsr(wsUrl: string, timeoutMs: number): Promise<boolean> {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (await this.funasr.healthCheck(wsUrl, 2500)) return true
      this.emitProgress({
        status: 'warming_up',
        message: 'Waiting for FunASR WebSocket service',
        detail: wsUrl
      })
      await sleep(3000)
    }
    return false
  }

  private emitProgress(progress: VoiceRuntimeProgress): void {
    this.mainWindow?.webContents.send('voice:runtime-progress', progress)
  }

  private async prepareDockerDesktopInstaller(
    runtime: ReturnType<VoiceRuntimeStore['read']>
  ): Promise<VoiceRuntimeInfo> {
    const installerPath = await this.dockerInstaller.prepareInstaller((progress) =>
      this.emitProgress(progress)
    )
    await this.dockerInstaller.openInstaller(installerPath)
    const nextInfo = this.store.toInfo(runtime, {
      status: 'docker_installer_ready',
      message:
        'Docker Desktop installer is open. Finish installation, then click the microphone again.'
    })
    this.emitProgress({
      status: 'docker_installer_ready',
      message: nextInfo.message || 'Docker Desktop installer is open',
      detail: installerPath
    })
    return nextInfo
  }

  private async isContainerCurrent(
    runtime: ReturnType<VoiceRuntimeStore['read']>
  ): Promise<boolean> {
    const config = await this.docker.getContainerConfig(runtime.containerName)
    if (!config) return false
    return config.image === runtime.image && config.hostPort === runtime.hostPort
  }

  private applyConfig(config?: VoiceRuntimeConfig) {
    if (!config) return this.store.read()
    const current = this.store.read()
    const nextProvider = config.runtimeProvider ?? current.provider
    const providerDefault =
      nextProvider !== current.provider
        ? VoiceRuntimeStore.defaultRuntimeForProvider(nextProvider)
        : current
    const patch: {
      provider?: VoiceInputSettings['runtimeProvider']
      image?: string
      hostPort?: number
      wsUrl?: string
    } = {
      provider: nextProvider,
      hostPort: providerDefault.hostPort,
      wsUrl: providerDefault.wsUrl
    }
    if (config.funasr?.image) patch.image = config.funasr.image
    if (config.funasr?.hostPort) patch.hostPort = config.funasr.hostPort
    if (config.funasr?.wsUrl) patch.wsUrl = config.funasr.wsUrl
    if (nextProvider === 'managed' && !patch.wsUrl) patch.wsUrl = DEFAULT_FUNASR_WS_URL
    return this.store.update(patch)
  }
}

export const voiceRuntimeManager = new VoiceRuntimeManager()
