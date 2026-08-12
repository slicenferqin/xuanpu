import * as pty from 'node-pty'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { readlink } from 'fs/promises'
import { createLogger } from './logger'

const execFileAsync = promisify(execFile)

const log = createLogger({ component: 'PtyService' })
const KILL_ESCALATION_GRACE_MS = 1500
const EXITED_PID_RETENTION_MS = 60_000
const exitedPtyPids = new Map<number, number>()

function recordPtyExit(pid: number | undefined): void {
  if (!pid) return
  const now = Date.now()
  exitedPtyPids.set(pid, now)
  for (const [oldPid, exitedAt] of exitedPtyPids) {
    if (now - exitedAt > EXITED_PID_RETENTION_MS) exitedPtyPids.delete(oldPid)
  }
}

/**
 * Terminal backend type.
 * - 'node-pty': Uses node-pty + xterm.js for terminal emulation (cross-platform)
 * - 'ghostty': Uses the native Ghostty module for Metal-rendered terminals (macOS only)
 *
 * When using the 'ghostty' backend, the native module handles both the PTY and
 * the terminal rendering. The PtyService is not used for I/O in that case —
 * surface lifecycle is managed entirely through GhosttyService.
 */
export type TerminalBackend = 'node-pty' | 'ghostty'

interface PtyInstance {
  pty: pty.IPty
  cwd: string
  backend: TerminalBackend
  dataListeners: Array<(data: string) => void>
  exitListeners: Array<(code: number, signal: number) => void>
}

export interface PtyCreateOpts {
  cwd: string
  shell?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
  backend?: TerminalBackend
}

class PtyService {
  private ptys: Map<string, PtyInstance> = new Map()

  create(id: string, opts: PtyCreateOpts): { cols: number; rows: number } {
    // If using the ghostty backend, the native module handles the PTY internally.
    // We don't create a node-pty process — surface lifecycle is managed by GhosttyService.
    if (opts.backend === 'ghostty') {
      log.info('Skipping node-pty creation for ghostty backend', { id })
      return { cols: opts.cols || 80, rows: opts.rows || 24 }
    }

    // If a PTY already exists for this id, return its dimensions
    const existing = this.ptys.get(id)
    if (existing) {
      log.info('PTY already exists, reusing', { id })
      return {
        cols: existing.pty.cols,
        rows: existing.pty.rows
      }
    }

    const shell =
      opts.shell ||
      process.env.SHELL ||
      (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')
    const cols = opts.cols || 80
    const rows = opts.rows || 24

    const env: Record<string, string> = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...opts.env
    } as Record<string, string>

    log.info('Creating PTY', { id, shell, cwd: opts.cwd, cols, rows })

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env
    })

    if (ptyProcess.pid) exitedPtyPids.delete(ptyProcess.pid)

    const instance: PtyInstance = {
      pty: ptyProcess,
      cwd: opts.cwd,
      backend: opts.backend || 'node-pty',
      dataListeners: [],
      exitListeners: []
    }

    // Wire up data events
    ptyProcess.onData((data) => {
      for (const listener of instance.dataListeners) {
        try {
          listener(data)
        } catch (err) {
          log.error(
            'Error in PTY data listener',
            err instanceof Error ? err : new Error(String(err)),
            { id }
          )
        }
      }
    })

    // Wire up exit events
    ptyProcess.onExit(({ exitCode, signal }) => {
      const code = exitCode ?? -1
      const sig = signal ?? 0
      log.info('PTY exited', { id, exitCode: code, signal: sig })
      recordPtyExit(ptyProcess.pid)
      for (const listener of instance.exitListeners) {
        try {
          listener(code, sig)
        } catch (err) {
          log.error(
            'Error in PTY exit listener',
            err instanceof Error ? err : new Error(String(err)),
            { id }
          )
        }
      }
      this.ptys.delete(id)
    })

    this.ptys.set(id, instance)

    return { cols, rows }
  }

  write(id: string, data: string): void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for write', { id })
      return
    }
    instance.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for resize', { id })
      return
    }
    try {
      instance.pty.resize(cols, rows)
    } catch (err) {
      log.error('Error resizing PTY', err instanceof Error ? err : new Error(String(err)), {
        id,
        cols,
        rows
      })
    }
  }

  destroy(id: string): void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for destroy', { id })
      return
    }
    log.info('Destroying PTY', { id })
    const pid = instance.pty.pid
    const groupSnapshot =
      pid && process.platform !== 'win32'
        ? this.listGroupMembers(pid)
        : Promise.resolve(new Set<number>())
    try {
      instance.pty.kill()
    } catch (err) {
      log.error('Error killing PTY', err instanceof Error ? err : new Error(String(err)), { id })
    }
    this.ptys.delete(id)
    this.scheduleKillEscalation(id, pid, groupSnapshot)
  }

  private listGroupMembers(pgid: number): Promise<Set<number>> {
    return new Promise((resolve) => {
      execFile('pgrep', ['-g', String(pgid)], { timeout: 2000 }, (error, stdout) => {
        if (error) {
          resolve(new Set())
          return
        }
        const pids = stdout
          .split('\n')
          .map((line) => Number(line.trim()))
          .filter((pid) => Number.isInteger(pid) && pid > 0)
        resolve(new Set(pids))
      })
    })
  }

  private scheduleKillEscalation(
    id: string,
    pid: number | undefined,
    groupSnapshot: Promise<Set<number>>
  ): void {
    if (!pid || process.platform === 'win32') return
    const timer = setTimeout(() => {
      void groupSnapshot.then((members) => this.reapSurvivors(id, pid, members))
    }, KILL_ESCALATION_GRACE_MS)
    timer.unref?.()
  }

  private isCurrentPtyPid(pid: number): boolean {
    for (const instance of this.ptys.values()) {
      if (instance.pty.pid === pid) return true
    }
    return false
  }

  private async reapSurvivors(id: string, pid: number, groupSnapshot: Set<number>): Promise<void> {
    if (this.isCurrentPtyPid(pid)) return

    const exitedAt = exitedPtyPids.get(pid)
    if (exitedAt !== undefined && Date.now() - exitedAt > EXITED_PID_RETENTION_MS) {
      exitedPtyPids.delete(pid)
    }
    const directPidValid = !exitedPtyPids.has(pid)

    let leaderAlive = false
    if (directPidValid) {
      try {
        process.kill(pid, 0)
        leaderAlive = true
      } catch {
        // 直属进程已经退出。
      }
    }

    let groupAlive = false
    try {
      process.kill(-pid, 0)
      groupAlive = true
    } catch {
      // 进程组已经退出。
    }
    if (!leaderAlive && !groupAlive) return

    if (!leaderAlive && groupAlive) {
      if (groupSnapshot.size > 0) {
        const currentMembers = await this.listGroupMembers(pid)
        const stillOwned = [...currentMembers].some(
          (member) => member !== pid && groupSnapshot.has(member)
        )
        if (!stillOwned) {
          log.warn('Skipping SIGKILL because the process group no longer belongs to the PTY', {
            id,
            pid
          })
          return
        }
      } else if (!directPidValid) {
        log.warn('Skipping SIGKILL because the exited PTY has no ownership evidence', { id, pid })
        return
      }
    }

    log.warn('PTY process survived graceful shutdown, escalating to SIGKILL', { id, pid })
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (groupError) {
      if (!leaderAlive) {
        log.warn('Failed to kill surviving PTY process group', {
          id,
          pid,
          error: groupError instanceof Error ? groupError.message : String(groupError)
        })
        return
      }
      try {
        process.kill(pid, 'SIGKILL')
      } catch (processError) {
        log.warn('Failed to kill surviving PTY process', {
          id,
          pid,
          error: processError instanceof Error ? processError.message : String(processError)
        })
      }
    }
  }

  destroyAll(): void {
    log.info('Destroying all PTYs', { count: this.ptys.size })
    for (const [id] of this.ptys) {
      this.destroy(id)
    }
  }

  async destroyAllAndReap(graceMs = 300): Promise<void> {
    const targets: Array<{ id: string; pid: number; snapshot: Promise<Set<number>> }> = []
    if (process.platform !== 'win32') {
      for (const [id, instance] of this.ptys) {
        const pid = instance.pty.pid
        if (pid) targets.push({ id, pid, snapshot: this.listGroupMembers(pid) })
      }
    }

    this.destroyAll()
    if (targets.length === 0) return

    await new Promise((resolve) => setTimeout(resolve, graceMs))
    for (const { id, pid, snapshot } of targets) {
      await this.reapSurvivors(id, pid, await snapshot)
    }
  }

  onData(id: string, callback: (data: string) => void): () => void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for onData', { id })
      return () => {}
    }
    instance.dataListeners.push(callback)
    return () => {
      const idx = instance.dataListeners.indexOf(callback)
      if (idx !== -1) {
        instance.dataListeners.splice(idx, 1)
      }
    }
  }

  onExit(id: string, callback: (code: number, signal: number) => void): () => void {
    const instance = this.ptys.get(id)
    if (!instance) {
      log.warn('PTY not found for onExit', { id })
      return () => {}
    }
    instance.exitListeners.push(callback)
    return () => {
      const idx = instance.exitListeners.indexOf(callback)
      if (idx !== -1) {
        instance.exitListeners.splice(idx, 1)
      }
    }
  }

  /**
   * Get an existing PTY or create a new one. Alias for `create()` which
   * already returns existing PTY dimensions if one exists for this id.
   */
  getOrCreate(id: string, opts: PtyCreateOpts): { cols: number; rows: number } {
    return this.create(id, opts)
  }

  has(id: string): boolean {
    return this.ptys.has(id)
  }

  getBackend(id: string): TerminalBackend | undefined {
    return this.ptys.get(id)?.backend
  }

  getIds(): string[] {
    return Array.from(this.ptys.keys())
  }

  /**
   * Get the current working directory of a PTY's child process.
   * Uses platform-specific methods to resolve the actual cwd (not just the initial cwd).
   * Falls back to the initial cwd if the platform method fails.
   */
  async getCwd(id: string): Promise<string | null> {
    const instance = this.ptys.get(id)
    if (!instance) return null

    const pid = instance.pty.pid
    try {
      if (process.platform === 'darwin') {
        // macOS: use lsof to find the cwd of the process (with 2s timeout to avoid blocking)
        const { stdout } = await execFileAsync('lsof', ['-a', '-d', 'cwd', '-p', String(pid), '-Fn'], { timeout: 2000 })
        // lsof -Fn outputs lines like: p<pid>\nn<path>
        const lines = stdout.split('\n')
        for (const line of lines) {
          if (line.startsWith('n') && line.length > 1) {
            return line.slice(1)
          }
        }
      } else if (process.platform === 'linux') {
        // Linux: readlink /proc/<pid>/cwd
        return await readlink(`/proc/${pid}/cwd`)
      }
    } catch (err) {
      log.warn('Failed to get PTY cwd, falling back to initial cwd', {
        id,
        pid,
        error: err instanceof Error ? err.message : String(err)
      })
    }

    // Fallback: return the initial cwd from creation time
    return instance.cwd
  }

  /**
   * Destroy all PTYs whose IDs are NOT in the given set of valid IDs.
   * Useful for cleaning up terminals when worktrees are deleted.
   */
  destroyExcept(validIds: Set<string>): void {
    for (const [id] of this.ptys) {
      if (!validIds.has(id)) {
        log.info('Destroying orphaned PTY', { id })
        this.destroy(id)
      }
    }
  }
}

export const ptyService = new PtyService()
