import { ipcMain, BrowserWindow } from 'electron'
import { ptyService } from '../services/pty-service'
import { ghosttyService } from '../services/ghostty-service'
import { parseGhosttyConfig } from '../services/ghostty-config'
import { createLogger } from '../services/logger'
import { getEventBus } from '../../server/event-bus'
import { emitFieldEvent } from '../field/emit'
import {
  feedTerminalInput,
  clearTerminalBuffer
} from '../field/terminal-line-buffer'
import {
  recordCommandEventId,
  clearTerminalOutputWindow,
  subscribeTerminalOutputBus
} from '../field/terminal-output-window'
import { getFieldEventSink } from '../field/sink'
import { getDatabase } from '../db'

const log = createLogger({ component: 'TerminalHandlers' })

// Track listener cleanup functions per worktreeId to prevent duplicate registrations
const listenerCleanups = new Map<string, { removeData: () => void; removeExit: () => void }>()

// Per-worktree data buffers for batching PTY output before IPC send.
// node-pty can fire onData many times in rapid succession (e.g. during shell redraws).
// Sending each chunk as a separate IPC message means xterm.js parses them individually,
// which can split escape sequences across terminal.write() calls and cause visual glitches
// (e.g. cursor-reposition arriving in a different write than the text it precedes).
// Batching with setImmediate collects all data from the current I/O phase into one IPC message.
const dataBuffers = new Map<string, string>()
const flushScheduled = new Set<string>()

/**
 * Phase 21 fix: map from terminal IPC id (e.g. `bt-abc123` for bottom-terminal
 * tabs, or a worktreeId for older call sites) to the *real* worktree id.
 *
 * Historically `terminal:write`'s first arg was named `worktreeId` but the
 * bottom-terminal architecture (multiple terminal tabs per worktree) sends a
 * synthetic terminal id instead. Field events emitted with that synthetic id
 * never matched worktree-scoped queries in the context-builder, so the
 * VISION §4.1.4 "Last Terminal Activity" section was always empty. This map
 * is populated at terminal:create time by callers that know the real
 * worktreeId; callers that don't pass it fall back to using the terminal id
 * itself (backwards-compatible for pre-Phase-21 call sites).
 */
const terminalToWorktree = new Map<string, string>()

function resolveWorktreeId(terminalId: string): string {
  return terminalToWorktree.get(terminalId) ?? terminalId
}

export function registerTerminalHandlers(mainWindow: BrowserWindow): void {
  // Set main window reference on the Ghostty service
  ghosttyService.setMainWindow(mainWindow)

  // Phase 21: begin accumulating terminal.output windows from the existing
  // EventBus `terminal:data` / `terminal:exit` fan-out. Idempotent — safe to
  // call on re-registration.
  subscribeTerminalOutputBus()

  // -----------------------------------------------------------------------
  // node-pty (xterm.js backend) handlers
  // -----------------------------------------------------------------------

  // Create a PTY for a worktree
  ipcMain.handle(
    'terminal:create',
    async (
      _event,
      terminalId: string,
      cwd: string,
      shell?: string,
      worktreeId?: string
    ) => {
      // `terminalId` may be a synthetic bottom-terminal id (bt-*) distinct from
      // the worktree id; `worktreeId` (when supplied) carries the real one for
      // Phase 21 field-event correlation. See terminalToWorktree map above.
      if (worktreeId) {
        terminalToWorktree.set(terminalId, worktreeId)
      }
      log.info('IPC: terminal:create', { terminalId, worktreeId, cwd, shell })
      try {
        // Check if PTY already exists before creating — if it does, skip listener registration
        const alreadyExists = ptyService.has(terminalId)
        const { cols, rows } = ptyService.create(terminalId, { cwd, shell: shell || undefined })

        if (alreadyExists) {
          log.info('PTY already exists, skipping listener registration', { terminalId })
          return { success: true, cols, rows }
        }

        // Clean up any stale listeners for this terminal (shouldn't happen, but defensive)
        const existing = listenerCleanups.get(terminalId)
        if (existing) {
          existing.removeData()
          existing.removeExit()
          listenerCleanups.delete(terminalId)
        }

        // Bus events carry the REAL worktree id so Phase 21 field events
        // (terminal.output, episodic grouping) key by worktree, not terminal tab.
        // IPC data/exit channel names remain scoped to terminalId because the
        // renderer subscribes with its local terminalId.
        const busWorktreeId = worktreeId ?? terminalId

        // Wire PTY output to renderer (batched via setImmediate)
        const removeData = ptyService.onData(terminalId, (data) => {
          if (mainWindow.isDestroyed()) return

          // Accumulate into buffer
          const existing = dataBuffers.get(terminalId)
          dataBuffers.set(terminalId, existing ? existing + data : data)

          // Schedule a flush if one isn't already pending
          if (!flushScheduled.has(terminalId)) {
            flushScheduled.add(terminalId)
            setImmediate(() => {
              flushScheduled.delete(terminalId)
              const buffered = dataBuffers.get(terminalId)
              dataBuffers.delete(terminalId)
              if (buffered && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send(`terminal:data:${terminalId}`, buffered)
                try {
                  getEventBus().emit('terminal:data', busWorktreeId, buffered)
                } catch {
                  /* EventBus not available */
                }
              }
            })
          }
        })

        // Wire PTY exit to renderer
        const removeExit = ptyService.onExit(terminalId, (code) => {
          if (!mainWindow.isDestroyed()) {
            mainWindow.webContents.send(`terminal:exit:${terminalId}`, code)
            try {
              getEventBus().emit('terminal:exit', busWorktreeId, code)
            } catch {
              /* EventBus not available */
            }
          }
          // Clean up listener tracking on exit
          listenerCleanups.delete(terminalId)
        })

        listenerCleanups.set(terminalId, { removeData, removeExit })

        return { success: true, cols, rows }
      } catch (error) {
        log.error(
          'IPC: terminal:create failed',
          error instanceof Error ? error : new Error(String(error)),
          { terminalId, worktreeId }
        )
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  )

  // Write data to a PTY (fire-and-forget — no response needed for keystrokes)
  ipcMain.on('terminal:write', (_event, terminalId: string, data: string) => {
    ptyService.write(terminalId, data)

    // Phase 21: best-effort terminal.command capture. See terminal-line-buffer.ts
    // for the known limitations of this approach.
    try {
      // Resolve bottom-terminal tab ids (bt-*) to their real worktree id so
      // field events can be grouped by worktree. Falls back to the terminal id
      // itself for legacy callers that happened to pass a worktreeId.
      const worktreeId = resolveWorktreeId(terminalId)
      const lines = feedTerminalInput(worktreeId, data, () => {
        getFieldEventSink().incrementCounter('dropped_overflow')
      })
      if (lines.length > 0) {
        const projectId = getDatabase().getWorktree(worktreeId)?.project_id ?? null
        for (const command of lines) {
          const eventId = emitFieldEvent({
            type: 'terminal.command',
            worktreeId,
            projectId,
            sessionId: null,
            relatedEventId: null,
            payload: { command }
          })
          if (eventId) {
            // Correlate subsequent terminal.output events to this command.
            // This also closes any in-progress output window so output doesn't
            // leak across commands.
            recordCommandEventId(worktreeId, eventId)
          }
        }
      }
    } catch (err) {
      // Never let field instrumentation break the terminal
      log.warn('field: terminal.command emit failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    }
  })

  // Resize a PTY
  ipcMain.handle('terminal:resize', (_event, terminalId: string, cols: number, rows: number) => {
    ptyService.resize(terminalId, cols, rows)
  })

  // Destroy a PTY
  ipcMain.handle('terminal:destroy', (_event, terminalId: string) => {
    log.info('IPC: terminal:destroy', { terminalId })
    const worktreeId = resolveWorktreeId(terminalId)
    // Clean up listener tracking
    const cleanup = listenerCleanups.get(terminalId)
    if (cleanup) {
      cleanup.removeData()
      cleanup.removeExit()
      listenerCleanups.delete(terminalId)
    }
    // Discard any pending buffered data
    dataBuffers.delete(terminalId)
    flushScheduled.delete(terminalId)
    clearTerminalBuffer(worktreeId)
    clearTerminalOutputWindow(worktreeId)
    terminalToWorktree.delete(terminalId)
    ptyService.destroy(terminalId)
  })

  // Get the current working directory of a PTY's child process
  ipcMain.handle('terminal:getCwd', async (_event, id: string) => {
    log.info('IPC: terminal:getCwd', { id })
    try {
      return await ptyService.getCwd(id)
    } catch (error) {
      log.error(
        'IPC: terminal:getCwd failed',
        error instanceof Error ? error : new Error(String(error)),
        { id }
      )
      return null
    }
  })

  // Get Ghostty config for terminal theming
  ipcMain.handle('terminal:getConfig', () => {
    log.info('IPC: terminal:getConfig')
    try {
      return parseGhosttyConfig()
    } catch (error) {
      log.error(
        'IPC: terminal:getConfig failed',
        error instanceof Error ? error : new Error(String(error))
      )
      return {}
    }
  })

  // -----------------------------------------------------------------------
  // Native Ghostty backend handlers
  // -----------------------------------------------------------------------

  // Initialize the Ghostty runtime (loads native addon + calls ghostty_init)
  ipcMain.handle('terminal:ghostty:init', () => {
    log.info('IPC: terminal:ghostty:init')
    return ghosttyService.init()
  })

  // Check if the native Ghostty backend is available
  ipcMain.handle('terminal:ghostty:isAvailable', () => {
    // Attempt to load the addon if not already loaded
    ghosttyService.loadAddon()
    return {
      available: ghosttyService.isAvailable(),
      initialized: ghosttyService.isInitialized(),
      platform: process.platform
    }
  })

  // Create a native Ghostty surface for a worktree
  ipcMain.handle(
    'terminal:ghostty:createSurface',
    (
      _event,
      worktreeId: string,
      rect: { x: number; y: number; w: number; h: number },
      opts?: { cwd?: string; shell?: string; scaleFactor?: number; fontSize?: number }
    ) => {
      log.info('IPC: terminal:ghostty:createSurface', { worktreeId, rect })
      return ghosttyService.createSurface(worktreeId, rect, opts || {})
    }
  )

  // Update the native view frame (position + size)
  ipcMain.handle(
    'terminal:ghostty:setFrame',
    (_event, worktreeId: string, rect: { x: number; y: number; w: number; h: number }) => {
      ghosttyService.setFrame(worktreeId, rect)
    }
  )

  // Update surface size in pixels
  ipcMain.handle(
    'terminal:ghostty:setSize',
    (_event, worktreeId: string, width: number, height: number) => {
      ghosttyService.setSize(worktreeId, width, height)
    }
  )

  // Forward a keyboard event to the Ghostty surface
  ipcMain.handle(
    'terminal:ghostty:keyEvent',
    (
      _event,
      worktreeId: string,
      keyEvent: {
        action: number
        keycode: number
        mods: number
        consumedMods?: number
        text?: string
        unshiftedCodepoint?: number
        composing?: boolean
      }
    ) => {
      return ghosttyService.keyEvent(worktreeId, keyEvent)
    }
  )

  // Forward a mouse button event
  ipcMain.handle(
    'terminal:ghostty:mouseButton',
    (_event, worktreeId: string, state: number, button: number, mods: number) => {
      ghosttyService.mouseButton(worktreeId, state, button, mods)
    }
  )

  // Forward a mouse position event
  ipcMain.handle(
    'terminal:ghostty:mousePos',
    (_event, worktreeId: string, x: number, y: number, mods: number) => {
      ghosttyService.mousePos(worktreeId, x, y, mods)
    }
  )

  // Forward a mouse scroll event
  ipcMain.handle(
    'terminal:ghostty:mouseScroll',
    (_event, worktreeId: string, dx: number, dy: number, mods: number) => {
      ghosttyService.mouseScroll(worktreeId, dx, dy, mods)
    }
  )

  // Set focus state for a surface
  ipcMain.handle('terminal:ghostty:setFocus', (_event, worktreeId: string, focused: boolean) => {
    ghosttyService.setFocus(worktreeId, focused)
  })

  // Destroy a Ghostty surface for a worktree
  ipcMain.handle('terminal:ghostty:destroySurface', (_event, worktreeId: string) => {
    log.info('IPC: terminal:ghostty:destroySurface', { worktreeId })
    ghosttyService.destroySurface(worktreeId)
  })

  // Shut down the Ghostty runtime entirely
  ipcMain.handle('terminal:ghostty:shutdown', () => {
    log.info('IPC: terminal:ghostty:shutdown')
    ghosttyService.shutdown()
  })

  log.info('Terminal IPC handlers registered')
}

export function cleanupTerminals(): void {
  log.info('Cleaning up all terminals')
  // Clean up all listener tracking
  for (const [, cleanup] of listenerCleanups) {
    cleanup.removeData()
    cleanup.removeExit()
  }
  listenerCleanups.clear()
  // Discard all pending buffered data
  dataBuffers.clear()
  flushScheduled.clear()
  ptyService.destroyAll()
  ghosttyService.shutdown()
}
