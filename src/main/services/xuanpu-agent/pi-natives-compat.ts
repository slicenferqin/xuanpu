import { isXuanpuAgentNativeProcessControlEnabled } from './tool-policy'

export enum ProcessStatus {
  Running = 'running',
  Exited = 'exited'
}

export class Process {
  static fromPid(pid: number): Process | null {
    return Number.isInteger(pid) && pid > 0 ? new Process(pid) : null
  }

  static fromPath(_path: string): Process[] {
    return []
  }

  private constructor(readonly pid: number) {}

  get ppid(): number | null {
    return null
  }

  args(): string[] {
    return []
  }

  killTree(signal?: number | NodeJS.Signals): number {
    if (!isXuanpuAgentNativeProcessControlEnabled()) {
      void signal
      return 0
    }

    try {
      process.kill(this.pid, signal ?? 'SIGKILL')
      return 1
    } catch {
      return 0
    }
  }

  async terminate(options?: { signal?: AbortSignal; gracefulMs?: number }): Promise<boolean> {
    if (!isXuanpuAgentNativeProcessControlEnabled()) return false
    if (options?.signal?.aborted) return false

    try {
      process.kill(this.pid, 'SIGTERM')
    } catch {
      return false
    }

    if ((options?.gracefulMs ?? 1000) < 0) {
      return true
    }

    return this.waitForExit({ signal: options?.signal, timeoutMs: options?.gracefulMs ?? 1000 })
  }

  async waitForExit(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<boolean> {
    const startedAt = Date.now()
    const timeoutMs = options?.timeoutMs

    while (this.status() === ProcessStatus.Running) {
      if (options?.signal?.aborted) return false
      if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs) return false
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    return true
  }

  groupId(): number | null {
    return null
  }

  children(): Process[] {
    return []
  }

  status(): ProcessStatus {
    try {
      process.kill(this.pid, 0)
      return ProcessStatus.Running
    } catch {
      return ProcessStatus.Exited
    }
  }
}

export function countTokens(input: string | string[]): number {
  const text = Array.isArray(input) ? input.join('\n') : input
  return Math.ceil(text.length / 3)
}
