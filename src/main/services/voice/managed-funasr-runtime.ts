import { spawn } from 'child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { Socket } from 'net'
import { createLogger } from '../logger'
import {
  getFunAsrLogsDir,
  getFunAsrModelsDir,
  getFunAsrRuntimeDir,
  getFunAsrServerLogFile,
  getFunAsrSourceDir,
  getFunAsrVenvDir,
  type StoredVoiceRuntime
} from './voice-runtime-store'
import type { VoiceRuntimeProgress } from '@shared/types/voice'

const log = createLogger({ component: 'ManagedFunAsrRuntime' })

const FUNASR_REPO_URL = 'https://github.com/modelscope/FunASR.git'
const INSTALL_MARKER = 'xuanpu-managed-runtime-v1'
const LOCAL_PROXY_PORT = 6244
const LOCAL_PROXY_URL = `http://127.0.0.1:${LOCAL_PROXY_PORT}`

interface RunResult {
  stdout: string
  stderr: string
  code: number
}

interface RunOptions {
  cwd?: string
  timeoutMs?: number
  onOutput?: (chunk: string) => void
}

function appendRuntimeLog(message: string): void {
  mkdirSync(getFunAsrLogsDir(), { recursive: true })
  appendFileSync(getFunAsrServerLogFile(), `[${new Date().toISOString()}] ${message}\n`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class ManagedFunAsrRuntime {
  private serverProcessPidFile(): string {
    return join(getFunAsrRuntimeDir(), 'server.pid')
  }

  private venvPython(): string {
    return join(getFunAsrVenvDir(), 'bin', 'python')
  }

  private installMarker(): string {
    return join(getFunAsrRuntimeDir(), '.installed')
  }

  private serverScript(): string {
    return join(getFunAsrSourceDir(), 'runtime', 'python', 'websocket', 'funasr_wss_server.py')
  }

  private serverCwd(): string {
    return join(getFunAsrSourceDir(), 'runtime', 'python', 'websocket')
  }

  async detect(runtime: StoredVoiceRuntime): Promise<{
    status: VoiceRuntimeProgress['status']
    message: string
    detail?: string
  }> {
    if (!(await this.findPythonCommand())) {
      return {
        status: 'python_missing',
        message: 'Python 3 is required to prepare the local FunASR runtime'
      }
    }

    if (!this.isRuntimeInstalled()) {
      if (!(await this.findGitCommand())) {
        return {
          status: 'git_missing',
          message: 'Git is required to download the local FunASR runtime'
        }
      }

      return {
        status: 'runtime_missing',
        message: 'Local FunASR runtime has not been downloaded yet',
        detail: getFunAsrRuntimeDir()
      }
    }

    const pid = this.readServerPid()
    if (pid && this.isProcessAlive(pid)) {
      return {
        status: 'warming_up',
        message: 'Local FunASR runtime process is starting',
        detail: runtime.wsUrl
      }
    }

    return {
      status: 'starting_runtime',
      message: 'Local FunASR runtime is installed but not running',
      detail: runtime.wsUrl
    }
  }

  async prepare(
    runtime: StoredVoiceRuntime,
    onProgress: (progress: VoiceRuntimeProgress) => void
  ): Promise<void> {
    mkdirSync(getFunAsrRuntimeDir(), { recursive: true })
    mkdirSync(getFunAsrModelsDir(), { recursive: true })
    mkdirSync(getFunAsrLogsDir(), { recursive: true })

    const python = await this.findPythonCommand()
    if (!python) {
      throw new Error('Python 3 is required to prepare the local FunASR runtime')
    }

    if (!existsSync(getFunAsrSourceDir())) {
      const git = await this.findGitCommand()
      if (!git) {
        throw new Error('Git is required to download the local FunASR runtime')
      }

      onProgress({
        status: 'downloading_runtime',
        message: 'Downloading local FunASR runtime',
        detail: FUNASR_REPO_URL
      })
      appendRuntimeLog(`Cloning ${FUNASR_REPO_URL}`)
      await this.run(git, ['clone', '--depth', '1', FUNASR_REPO_URL, getFunAsrSourceDir()], {
        timeoutMs: 15 * 60 * 1000,
        onOutput: (chunk) => {
          appendRuntimeLog(chunk.trimEnd())
          this.emitLatestLine(
            onProgress,
            'downloading_runtime',
            'Downloading local FunASR runtime',
            chunk
          )
        }
      })
    }

    if (!existsSync(this.venvPython())) {
      onProgress({
        status: 'installing_runtime',
        message: 'Creating local Python runtime',
        detail: getFunAsrVenvDir()
      })
      await this.run(python, ['-m', 'venv', getFunAsrVenvDir()], {
        timeoutMs: 5 * 60 * 1000,
        onOutput: (chunk) => appendRuntimeLog(chunk.trimEnd())
      })
    }

    if (!this.isRuntimeInstalled()) {
      onProgress({
        status: 'installing_runtime',
        message: 'Installing FunASR runtime dependencies',
        detail: getFunAsrVenvDir()
      })
      await this.run(this.venvPython(), ['-m', 'pip', 'install', '--upgrade', 'pip'], {
        timeoutMs: 10 * 60 * 1000,
        onOutput: (chunk) => {
          appendRuntimeLog(chunk.trimEnd())
          this.emitLatestLine(
            onProgress,
            'installing_runtime',
            'Installing Python package manager',
            chunk
          )
        }
      })
      await this.run(
        this.venvPython(),
        ['-m', 'pip', 'install', '--upgrade', 'modelscope', 'funasr'],
        {
          timeoutMs: 30 * 60 * 1000,
          onOutput: (chunk) => {
            appendRuntimeLog(chunk.trimEnd())
            this.emitLatestLine(
              onProgress,
              'installing_runtime',
              'Installing FunASR packages',
              chunk
            )
          }
        }
      )

      const requirements = join(this.serverCwd(), 'requirements_server.txt')
      if (existsSync(requirements)) {
        await this.run(this.venvPython(), ['-m', 'pip', 'install', '-r', requirements], {
          timeoutMs: 30 * 60 * 1000,
          onOutput: (chunk) => {
            appendRuntimeLog(chunk.trimEnd())
            this.emitLatestLine(
              onProgress,
              'installing_runtime',
              'Installing FunASR WebSocket server dependencies',
              chunk
            )
          }
        })
      }

      writeFileSync(this.installMarker(), INSTALL_MARKER)
    }

    await this.start(runtime, onProgress)
  }

  async start(
    runtime: StoredVoiceRuntime,
    onProgress: (progress: VoiceRuntimeProgress) => void
  ): Promise<void> {
    const pid = this.readServerPid()
    if (pid && this.isProcessAlive(pid)) return

    if (!existsSync(this.serverScript())) {
      throw new Error(`FunASR WebSocket server script not found: ${this.serverScript()}`)
    }

    onProgress({
      status: 'starting_runtime',
      message: 'Starting local FunASR runtime',
      detail: runtime.wsUrl
    })
    appendRuntimeLog(`Starting FunASR WebSocket server at ${runtime.wsUrl}`)

    const networkEnv = await this.getNetworkEnv()
    const logFd = openSync(getFunAsrServerLogFile(), 'a')
    const child = spawn(
      this.venvPython(),
      [
        this.serverScript(),
        '--host',
        '127.0.0.1',
        '--port',
        String(runtime.hostPort),
        '--ngpu',
        '0',
        '--device',
        'cpu',
        '--ncpu',
        '4',
        '--certfile',
        '',
        '--keyfile',
        ''
      ],
      {
        cwd: this.serverCwd(),
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: {
          ...networkEnv,
          HF_HOME: getFunAsrModelsDir(),
          MODELSCOPE_CACHE: getFunAsrModelsDir(),
          PYTHONUNBUFFERED: '1',
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost'
        }
      }
    )

    if (child.pid == null) {
      closeSync(logFd)
      throw new Error('Failed to start local FunASR runtime process')
    }

    writeFileSync(this.serverProcessPidFile(), String(child.pid))
    child.unref()
    closeSync(logFd)
    await this.assertProcessSurvivesStartup(child, 1500)
  }

  async stop(): Promise<void> {
    const pid = this.readServerPid()
    if (pid && this.isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // The process may have exited between the liveness check and the signal.
      }
      await sleep(1200)
      if (this.isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Ignore races with natural process exit.
        }
      }
    }
    try {
      rmSync(this.serverProcessPidFile(), { force: true })
    } catch {
      // Ignore stale PID-file cleanup failures; the runtime has already been stopped.
    }
  }

  async getLogs(): Promise<string> {
    try {
      return readFileSync(getFunAsrServerLogFile(), 'utf-8').split(/\r?\n/).slice(-240).join('\n')
    } catch {
      return ''
    }
  }

  private isRuntimeInstalled(): boolean {
    try {
      return (
        existsSync(this.serverScript()) &&
        existsSync(this.venvPython()) &&
        existsSync(this.installMarker()) &&
        readFileSync(this.installMarker(), 'utf-8').trim() === INSTALL_MARKER
      )
    } catch {
      return false
    }
  }

  private async findPythonCommand(): Promise<string | null> {
    for (const command of ['python3', '/usr/bin/python3', '/opt/homebrew/bin/python3']) {
      try {
        const result = await this.run(command, ['--version'], { timeoutMs: 5000 })
        if (result.code === 0) return command
      } catch {
        // Try the next common Python location.
      }
    }
    return null
  }

  private async findGitCommand(): Promise<string | null> {
    for (const command of ['git', '/usr/bin/git', '/opt/homebrew/bin/git']) {
      try {
        const result = await this.run(command, ['--version'], { timeoutMs: 5000 })
        if (result.code === 0) return command
      } catch {
        // Try the next common Git location.
      }
    }
    return null
  }

  private readServerPid(): number | null {
    try {
      const value = Number(readFileSync(this.serverProcessPidFile(), 'utf-8').trim())
      return Number.isFinite(value) && value > 0 ? value : null
    } catch {
      return null
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private emitLatestLine(
    onProgress: (progress: VoiceRuntimeProgress) => void,
    status: VoiceRuntimeProgress['status'],
    message: string,
    chunk: string
  ): void {
    const detail = chunk
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean)
      .at(-1)
    if (!detail) return
    onProgress({ status, message, detail })
  }

  private run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    return this.getNetworkEnv().then(
      (env) =>
        new Promise((resolve, reject) => {
          const child = spawn(command, args, {
            cwd: options.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env
          })
          let stdout = ''
          let stderr = ''
          let settled = false
          const timer =
            options.timeoutMs && options.timeoutMs > 0
              ? setTimeout(() => {
                  if (settled) return
                  settled = true
                  child.kill('SIGTERM')
                  reject(new Error(`${command} ${args.join(' ')} timed out`))
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
            const result = { stdout, stderr, code: code ?? 1 }
            if (result.code !== 0) {
              log.warn('Managed FunASR command failed', {
                command,
                args,
                stdout: stdout.slice(-1000),
                stderr: stderr.slice(-1000)
              })
              reject(new Error(stderr.trim() || stdout.trim() || `${command} failed`))
              return
            }
            resolve(result)
          })
        })
    )
  }

  private assertProcessSurvivesStartup(
    child: ReturnType<typeof spawn>,
    startupMs: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup()
        reject(
          new Error(
            `Local FunASR runtime exited during startup (${code == null ? signal : `code ${code}`})`
          )
        )
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, startupMs)

      child.once('error', onError)
      child.once('exit', onExit)
    })
  }

  private async getNetworkEnv(): Promise<NodeJS.ProcessEnv> {
    const env = {
      ...process.env,
      NO_PROXY: this.withLocalNoProxy(process.env.NO_PROXY),
      no_proxy: this.withLocalNoProxy(process.env.no_proxy)
    }
    if (env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy) return env
    if (!(await this.isLocalProxyAvailable())) return env

    appendRuntimeLog(`Using local proxy ${LOCAL_PROXY_URL} for FunASR runtime setup`)
    return {
      ...env,
      HTTP_PROXY: LOCAL_PROXY_URL,
      HTTPS_PROXY: LOCAL_PROXY_URL,
      ALL_PROXY: LOCAL_PROXY_URL,
      http_proxy: LOCAL_PROXY_URL,
      https_proxy: LOCAL_PROXY_URL,
      all_proxy: LOCAL_PROXY_URL
    }
  }

  private withLocalNoProxy(value: string | undefined): string {
    const parts = new Set(
      (value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    )
    parts.add('127.0.0.1')
    parts.add('localhost')
    return Array.from(parts).join(',')
  }

  private isLocalProxyAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new Socket()
      let settled = false
      const finish = (available: boolean): void => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(available)
      }

      socket.setTimeout(350)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
      socket.connect(LOCAL_PROXY_PORT, '127.0.0.1')
    })
  }
}
